// The old DailyNewsReport V2 cannot be reconstructed from the new publication model.
// Keep its read-only response on the old service, and expose the frozen fallback separately.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { REPO_ROOT } from "@aihot/backend/config";
import { sendProblem } from "../http/respond.ts";

const ARCHIVE_SHA256 = "38cbdbbd00865a735ba01095d26a1bdfccdcea959dd5fbbd4c2c8f1e40af9f36";
const ARCHIVE_PATH = "public/daily-news.json";
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 5_000;

type ArchivedStory = { id: string; itemId: string; evidence: Array<{ candidateId: string; [key: string]: unknown }>; [key: string]: unknown };
type ArchivedItem = { id: string; [key: string]: unknown };
type ArchivedReport = { version: number; generatedAt: string; stories: ArchivedStory[]; items: ArchivedItem[]; dailyEdition?: unknown };

interface Archive {
  bytes: Buffer;
  report: ArchivedReport;
}

function legacyOrigin(value: string | undefined): URL | null {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("LEGACY_NEWS_BASE_URL must be an HTTPS origin without credentials, path, query or fragment");
  }
  return url;
}

function legacyQuery(rawUrl: string): string | null {
  const query = rawUrl.indexOf("?");
  const params = new URLSearchParams(query < 0 ? "" : rawUrl.slice(query + 1));
  if ([...params.keys()].some((key) => key !== "view" && key !== "reload")) return null;
  if (params.getAll("view").length > 1 || params.getAll("reload").length > 1) return null;
  if (params.has("view") && params.get("view") !== "web") return null;
  if (params.has("reload") && (params.get("reload") !== "1" || params.get("view") !== "web")) return null;
  return query < 0 ? "" : rawUrl.slice(query);
}

async function boundedBody(response: Response): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_UPSTREAM_BYTES) throw new Error("legacy response too large");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPSTREAM_BYTES) throw new Error("legacy response too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function loadArchive(): Promise<Archive> {
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, "reference/baselines/daily-news-v1.json"), "utf8")) as {
    files: Array<{ path: string; sha256: string }>;
  };
  const expected = manifest.files.find((entry) => entry.path === ARCHIVE_PATH)?.sha256;
  if (expected !== ARCHIVE_SHA256) throw new Error("frozen archive manifest changed");
  const bytes = await readFile(path.join(REPO_ROOT, ARCHIVE_PATH));
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("frozen archive content changed");
  const report = JSON.parse(bytes.toString("utf8")) as ArchivedReport;
  if (report.version !== 2 || !Number.isFinite(Date.parse(report.generatedAt)) || !Array.isArray(report.stories) || !Array.isArray(report.items)) {
    throw new Error("frozen archive format changed");
  }
  return { bytes, report };
}

function archiveMeta(archive: Archive) {
  return {
    kind: "historical_fallback",
    live: false,
    scope: "tracked_fallback_only",
    source: ARCHIVE_PATH,
    sha256: ARCHIVE_SHA256,
    generatedAt: archive.report.generatedAt,
  };
}

function archiveReply(reply: FastifyReply, value: unknown) {
  return reply.header("Cache-Control", "public, max-age=31536000, immutable").send(value);
}

export function registerLegacyNews(
  app: FastifyInstance,
  options: { baseUrl?: string; fetcher?: typeof fetch } = {},
) {
  const origin = legacyOrigin(options.baseUrl ?? process.env.LEGACY_NEWS_BASE_URL);
  const fetcher = options.fetcher ?? fetch;

  app.all("/api/news", async (req, reply) => {
    if (req.method !== "GET") {
      reply.header("Allow", "GET");
      return sendProblem(req, reply, { status: 405, code: "method_not_allowed", detail: "The legacy news endpoint supports GET only." });
    }
    const query = legacyQuery(req.raw.url ?? "/api/news");
    if (query === null) return sendProblem(req, reply, { status: 400, code: "invalid_legacy_query", detail: "Only view=web and view=web&reload=1 are supported." });
    if (!origin) return sendProblem(req, reply, {
      status: 503, code: "legacy_schema_unavailable",
      detail: "旧版 DailyNewsReport V2 未配置代理；新接口见 /api/v1/items，历史资料见 /api/legacy/archive。历史快照不是实时新闻。",
    });
    try {
      const response = await fetcher(`${origin.origin}/api/news${query}`, {
        method: "GET", headers: { Accept: "application/json" }, credentials: "omit", redirect: "manual",
        cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (response.status >= 500 || (response.status >= 300 && response.status < 400) || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        throw new Error("legacy upstream failed, redirected or returned non-JSON response");
      }
      const body = await boundedBody(response);
      const cacheControl = response.status === 200 ? response.headers.get("cache-control") ?? "no-store" : "no-store";
      reply.code(response.status).header("Content-Type", response.headers.get("content-type")!).header("Cache-Control", cacheControl);
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) reply.header("Retry-After", retryAfter);
      return reply.send(body);
    } catch {
      return sendProblem(req, reply, { status: 503, code: "legacy_upstream_unavailable", detail: "旧版新闻服务暂不可用；不会以历史快照充当实时响应。" });
    }
  });

  const gone = (req: FastifyRequest, reply: FastifyReply) => sendProblem(req, reply, {
    status: 410, code: "legacy_write_endpoint_gone", detail: "旧版刷新入口已停用；不能映射到新系统管理接口。",
  });
  app.all("/api/refresh", gone);
  app.all("/api/cron", gone);

  app.get("/api/legacy/archive", async (req, reply) => {
    try {
      const archive = await loadArchive();
      return archiveReply(reply, { ...archiveMeta(archive), storyCount: archive.report.stories.length, itemCount: archive.report.items.length,
        report: "/api/legacy/archive/report", stories: "/api/legacy/archive/stories/:id", candidates: "/api/legacy/archive/candidates/:id" });
    } catch {
      return sendProblem(req, reply, { status: 503, code: "legacy_archive_unavailable", detail: "冻结历史资料未通过校验。" });
    }
  });

  app.get("/api/legacy/archive/report", async (req, reply) => {
    try {
      const archive = await loadArchive();
      return archiveReply(reply.header("Content-Type", "application/json; charset=utf-8")
        .header("X-Legacy-Archive-SHA256", ARCHIVE_SHA256).header("X-Legacy-Archive-Generated-At", archive.report.generatedAt), archive.bytes);
    } catch {
      return sendProblem(req, reply, { status: 503, code: "legacy_archive_unavailable", detail: "冻结历史资料未通过校验。" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/legacy/archive/stories/:id", async (req, reply) => {
    try {
      const archive = await loadArchive();
      const story = archive.report.stories.find((entry) => entry.id === req.params.id);
      if (!story) return sendProblem(req, reply, { status: 404, code: "legacy_id_not_archived", detail: "此旧事件 ID 不在冻结历史快照中。" });
      const item = archive.report.items.find((entry) => entry.id === story.itemId) ?? null;
      return archiveReply(reply, { archive: archiveMeta(archive), story, item });
    } catch {
      return sendProblem(req, reply, { status: 503, code: "legacy_archive_unavailable", detail: "冻结历史资料未通过校验。" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/legacy/archive/candidates/:id", async (req, reply) => {
    try {
      const archive = await loadArchive();
      const item = archive.report.items.find((entry) => entry.id === req.params.id) ?? null;
      const evidence = archive.report.stories.flatMap((story) => story.evidence.filter((entry) => entry.candidateId === req.params.id)
        .map((entry) => ({ storyId: story.id, evidence: entry })));
      if (!item && evidence.length === 0) return sendProblem(req, reply, { status: 404, code: "legacy_id_not_archived", detail: "此旧候选 ID 不在冻结历史快照中。" });
      return archiveReply(reply, { archive: archiveMeta(archive), candidateId: req.params.id, item, evidence });
    } catch {
      return sendProblem(req, reply, { status: 503, code: "legacy_archive_unavailable", detail: "冻结历史资料未通过校验。" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/legacy/archive/dailies/:id", (req, reply) => sendProblem(req, reply, {
    status: 404, code: "legacy_id_not_archived", detail: "冻结历史快照没有旧版日报版次。",
  }));
}
