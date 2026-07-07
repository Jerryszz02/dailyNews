import { describe, expect, it } from "vitest";
import { inferPublishedDateFromUrl } from "./newsService";

describe("inferPublishedDateFromUrl", () => {
  it("reads ChinaNews year/month-day URLs as China-local dates", () => {
    expect(inferPublishedDateFromUrl("https://www.chinanews.com.cn/gn/2026/06-29/10649512.shtml")).toBe(
      "2026-06-28T16:00:00.000Z",
    );
  });

  it("reads compact date URLs", () => {
    expect(inferPublishedDateFromUrl("http://finance.people.com.cn/n1/2026/0629/c1004-40749146.html")).toBe(
      "2026-06-28T16:00:00.000Z",
    );
  });

  it("ignores URLs without a reliable date", () => {
    expect(inferPublishedDateFromUrl("https://www.bbc.com/news/articles/cpq3yy48zglo")).toBeUndefined();
  });
});
