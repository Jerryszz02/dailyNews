import { describe, expect, it } from "vitest";
import { defaultPreferences } from "../config/preferences";
import type { RawNewsItem } from "../types";
import { applyCandidateQualityGate } from "./curation";
import { buildDailyReport } from "./newsPipeline";

const now = new Date("2026-07-10T08:00:00.000Z");

function candidate(overrides: Partial<RawNewsItem> = {}): RawNewsItem {
  return {
    id: "xinhua-policy",
    title: "多部门发布全国性金融监管新规并明确执行时间",
    url: "https://www.news.cn/politics/20260710/policy.html",
    sourceId: "xinhua",
    sourceName: "新华网",
    language: "zh-CN",
    region: "china",
    categories: ["policy", "china", "finance"],
    primaryCategory: "policy",
    summary: "新规明确了金融机构的执行范围、时间安排和后续监管要求，将影响全国相关市场主体。",
    publishedAt: "2026-07-10T06:00:00.000Z",
    extractedAt: now.toISOString(),
    ...overrides,
  };
}

describe("event-level curation", () => {
  it("creates one confirmed event with a multi-source evidence chain", () => {
    const report = buildDailyReport(
      [
        candidate(),
        candidate({
          id: "ap-policy",
          title: "全国性金融监管新规公布并确定执行时间",
          url: "https://apnews.com/article/policy",
          sourceId: "ap",
          sourceName: "Associated Press",
          region: "global",
          summary: "相关部门公布全国性金融监管新规，文件列明执行时间、适用机构和监管安排。",
        }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.version).toBe(2);
    expect(report.items).toHaveLength(1);
    expect(report.topStories).toHaveLength(1);
    expect(report.topStories[0].status).toBe("confirmed");
    expect(report.topStories[0].evidence).toHaveLength(2);
    expect(report.topStories[0].whyItMatters).not.toContain("偏好加分");
  });

  it("keeps must-know selection independent from user preference", () => {
    const rawItems = [candidate()];
    const defaultReport = buildDailyReport(rawItems, defaultPreferences, now);
    const changedReport = buildDailyReport(
      rawItems,
      { ...defaultPreferences, topicWeights: { policy: "not-preferred", sports: "preferred" } },
      now,
    );

    expect(defaultReport.topStories.map((story) => story.id)).toEqual(changedReport.topStories.map((story) => story.id));
  });

  it("routes single-source social leads to the watchlist instead of core stories", () => {
    const report = buildDailyReport(
      [
        candidate({
          id: "social-lead",
          title: "消息人士称一笔重要球员交易正在推进",
          url: "https://x.com/ShamsCharania/status/1",
          sourceId: "x-shams",
          sourceName: "Shams Charania",
          region: "us",
          categories: ["sports"],
          primaryCategory: "sports",
          summary: "单一社交账号称一笔重要球员交易正在推进，目前没有第二个独立来源确认。",
        }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.topStories).toHaveLength(0);
    expect(report.importantStories).toHaveLength(0);
    expect(report.watchlist[0]?.status).toBe("unverified");
  });

  it("rejects generic fallback summaries before ranking", () => {
    const result = applyCandidateQualityGate([
      candidate({ summary: "相关报道聚焦“测试标题”，具体背景、影响和后续进展以原文披露为准。" }),
    ]);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejectionReasons.template_summary).toBe(1);
  });

  it("does not promote a low-impact international curiosity into core stories", () => {
    const report = buildDailyReport(
      [
        candidate({
          id: "local-candidate",
          title: "地方选区一名喜剧候选人公布竞选口号",
          url: "https://example.com/local-candidate",
          sourceId: "aljazeera",
          sourceName: "Al Jazeera",
          region: "europe",
          categories: ["international", "policy"],
          primaryCategory: "international",
          summary: "一名喜剧演员在地方选区补选中公布竞选口号，这次活动主要影响当地选民。",
        }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.topStories).toHaveLength(0);
    expect(report.importantStories).toHaveLength(0);
  });

  it("does not let sports predictions become must-know through freshness and evidence alone", () => {
    const report = buildDailyReport(
      [
        candidate({
          id: "sports-ranking",
          title: "世界杯八强夺冠前景排名",
          url: "https://example.com/sports-ranking",
          sourceId: "xinhua",
          sourceName: "新华网",
          categories: ["sports"],
          primaryCategory: "sports",
          summary: "报道对八支球队的夺冠前景进行排名和评论，没有新的比赛结果或规则变化。",
        }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.topStories).toHaveLength(0);
    expect(report.stories).toHaveLength(1);
    expect(report.stories[0].tier).toBe("special_interest");
  });
});
