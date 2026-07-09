import { describe, expect, it } from "vitest";
import { extractPublishedDateFromHtml, inferPrimaryCategory, inferPublishedDateFromUrl, parsePublishedDate } from "./newsService";

describe("inferPublishedDateFromUrl", () => {
  it("reads slash-separated article dates", () => {
    expect(inferPublishedDateFromUrl("https://news.cctv.com/2026/07/09/ARTI5D1UsNbahAJfm69osc6K260709.shtml")).toBe(
      "2026-07-08T16:00:00.000Z",
    );
  });

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

describe("parsePublishedDate", () => {
  it("normalizes ISO dates with explicit timezones", () => {
    expect(parsePublishedDate("2026-07-09T10:30:00+08:00")).toBe("2026-07-09T02:30:00.000Z");
  });

  it("reads Chinese local publish timestamps", () => {
    expect(parsePublishedDate("发布时间：2026年07月09日 10:30")).toBe("2026-07-09T02:30:00.000Z");
  });
});

describe("extractPublishedDateFromHtml", () => {
  it("reads article meta publish dates", () => {
    expect(
      extractPublishedDateFromHtml('<html><head><meta property="article:published_time" content="2026-07-09T10:30:00+08:00"></head></html>'),
    ).toBe("2026-07-09T02:30:00.000Z");
  });

  it("reads inline Chinese publish dates", () => {
    expect(extractPublishedDateFromHtml("<main>来源：测试 发布时间：2026年07月09日 10:30 作者：编辑</main>")).toBe(
      "2026-07-09T02:30:00.000Z",
    );
  });

  it("prefers visible clock time over date-only meta values", () => {
    expect(
      extractPublishedDateFromHtml(
        '<meta name="publishdate" content="2026-07-09"><span class="year"><em>2026</em></span><span class="day"><em>07</em>/<em>09</em></span><span class="time">08:03:37</span>',
      ),
    ).toBe("2026-07-09T00:03:37.000Z");
  });

  it("reads compact script publish timestamps", () => {
    expect(extractPublishedDateFromHtml('var publishDate ="20260709093554 ";')).toBe("2026-07-09T01:35:54.000Z");
  });
});

describe("inferPrimaryCategory", () => {
  it("uses article URL and text to correct broad source sections", () => {
    expect(
      inferPrimaryCategory(
        {
          title: "银川国际青年足球锦标赛：中国U17队不敌坦桑尼亚U17队",
          summary: "赛事新闻",
          url: "http://www.news.cn/sports/20260709/50a4854f161e4c768d0eb7cf91af4fca/c.html",
        },
        { primaryCategory: "china", categories: ["china", "policy", "international"] },
      ),
    ).toBe("sports");
  });
});
