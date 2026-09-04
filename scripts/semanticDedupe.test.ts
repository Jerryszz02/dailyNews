import { describe, expect, it, vi } from "vitest";
import { clusterNews } from "../src/lib/dedupe";
import type { RawNewsItem } from "../src/types";
import { resolveAmbiguousEventRelations } from "./semanticDedupe";

const now = new Date("2026-09-04T03:00:00.000Z");

function item(id: string, sourceId: string, title: string, summary: string, hour: number): RawNewsItem {
  return {
    id,
    sourceId,
    sourceName: sourceId,
    title,
    summary,
    url: `https://www.news.cn/${id}.html`,
    language: "zh-CN",
    region: "china",
    categories: ["ai"],
    primaryCategory: "ai",
    publishedAt: `2026-09-04T0${hour}:00:00.000Z`,
    extractedAt: now.toISOString(),
  };
}

describe("semantic event dedupe", () => {
  it("asks the model only for an ambiguous pair and persists a conservative same-event anchor", async () => {
    const anchor = item(
      "anchor",
      "xinhua",
      "OpenAI 发布 GPT-6 模型并开放 API",
      "OpenAI 今天宣布新一代 GPT-6 模型，并向开发者开放 API。",
      1,
    );
    const candidate = item(
      "candidate",
      "people",
      "GPT-6 正式推出，OpenAI 同步开放开发者接口",
      "这家公司推出 GPT-6，开发者现在可以通过新的接口使用。",
      2,
    );
    const decide = vi.fn().mockResolvedValue({
      relation: "same_event" as const,
      confidence: 0.91,
      reason: "主体、动作和发布时间一致",
    });

    const result = await resolveAmbiguousEventRelations([candidate, anchor], {
      candidateIds: new Set([candidate.id]),
      now,
      decide,
    });

    expect(decide).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ evaluatedPairCount: 1, modelCallCount: 1, mergedPairCount: 1 });
    expect(new Set(result.items.map((entry) => entry.semanticEventId)).size).toBe(1);
    expect(result.items.find((entry) => entry.id === candidate.id)?.semanticRelation).toMatchObject({
      anchorCandidateId: anchor.id,
      confidence: 0.91,
      model: "test-resolver",
    });
    expect(clusterNews(result.items)).toHaveLength(1);
  });

  it("does not call the model for clearly unrelated or cross-category reports", async () => {
    const left = item("left", "xinhua", "OpenAI 发布新模型", "OpenAI 发布面向开发者的新模型。", 1);
    const right = {
      ...item("right", "people", "全国多地迎来强降雨", "气象部门发布暴雨预警并提醒公众出行安全。", 2),
      categories: ["society" as const],
      primaryCategory: "society" as const,
    };
    const decide = vi.fn();

    const result = await resolveAmbiguousEventRelations([left, right], {
      candidateIds: new Set([right.id]),
      now,
      decide,
    });

    expect(decide).not.toHaveBeenCalled();
    expect(result.modelCallCount).toBe(0);
    expect(result.items.every((entry) => !entry.semanticEventId)).toBe(true);
  });

  it("honors the per-refresh model-call ceiling", async () => {
    const variants = [
      ["OpenAI 发布 GPT-6 模型并开放 API", "OpenAI 宣布新模型，并向开发者开放接口。"],
      ["GPT-6 正式推出，OpenAI 同步开放开发者接口", "这家公司公布新产品和首批可用地区。"],
      ["开发者现可调用 GPT-6，OpenAI 公布接入安排", "开发平台更新了调用方式、限制和上线节奏。"],
      ["OpenAI 新模型 GPT-6 上线，API 使用范围确认", "官方页面说明企业客户的接入范围和后续安排。"],
      ["GPT-6 接口开始提供服务，OpenAI 更新产品文档", "产品文档新增模型能力、计费单位和迁移说明。"],
    ];
    const reports = variants.map(([title, summary], index) =>
      item(`candidate-${index}`, `source-${index}`, title!, summary!, Math.min(index + 1, 9)),
    );
    const decide = vi.fn().mockResolvedValue({ relation: "different_event", confidence: 0.9, reason: "不同进展" });

    const result = await resolveAmbiguousEventRelations(reports, {
      candidateIds: new Set([reports[0]!.id]),
      now,
      maxCalls: 2,
      decide,
    });

    expect(result.modelCallCount).toBe(2);
    expect(decide).toHaveBeenCalledTimes(2);
  });
});
