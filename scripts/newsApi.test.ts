import { afterEach, describe, expect, it, vi } from "vitest";
import { handleHealthRequest, handleNewsRequest, handleRefreshRequest } from "./newsApi";

const originalVercel = process.env.VERCEL;

afterEach(() => {
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
  delete process.env.DAILY_NEWS_REFRESH_TOKEN;
  vi.restoreAllMocks();
});

describe("serverless report API", () => {
  it("serves last-known-good without making a network request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = handleNewsRequest(new Request("https://example.com/api/news"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.version).toBe(2);
    expect(body.items.length).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the readable snapshot independently from refresh health", async () => {
    const response = handleHealthRequest(new Request("https://example.com/api/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reportAvailable).toBe(true);
    expect(body.itemCount).toBeGreaterThan(0);
  });

  it("does not expose an unconfigured refresh endpoint on Vercel", async () => {
    process.env.VERCEL = "1";
    const response = await handleRefreshRequest(
      new Request("https://example.com/api/refresh", { method: "POST" }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "Refresh is not configured" });
  });

  it("rejects an incorrect configured refresh token as unauthorized", async () => {
    process.env.VERCEL = "1";
    process.env.DAILY_NEWS_REFRESH_TOKEN = "configured-token";
    const response = await handleRefreshRequest(
      new Request("https://example.com/api/refresh", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "Unauthorized" });
  });
});
