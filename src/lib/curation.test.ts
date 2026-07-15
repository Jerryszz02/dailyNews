import { describe, expect, it } from "vitest";
import { defaultPreferences } from "../config/preferences";
import type { Category, RankedNewsItem, RawNewsItem } from "../types";
import {
  applyCandidateQualityGate,
  buildCurationFields,
  isStoryActiveWithin,
  storyActivityTimestamp,
} from "./curation";
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

function rankedCandidate(item: RawNewsItem): RankedNewsItem {
  const primaryCategory = item.primaryCategory ?? item.categories[0] ?? "international";
  return {
    ...item,
    primaryCategory,
    sourceIds: [item.sourceId],
    sourceNames: [item.sourceName],
    relatedUrls: [item.url],
    primaryCategoryVotes: [primaryCategory],
    score_breakdown: {
      final_score: 100,
      public_importance: 100,
      user_preference: 0,
      timeliness: 100,
      source_confidence: 100,
      content_quality: 100,
      ranking_reason: "核心发布方配额回归测试",
    },
    trust: {
      score: 100,
      level: "high",
      shouldShow: true,
      reasons: [],
    },
  };
}

function coreCandidate(
  id: string,
  sourceId: string,
  primaryCategory: Category,
  title: string,
  publishedAt = new Date(now.getTime() - 3 * 60 * 60_000).toISOString(),
): RawNewsItem {
  return candidate({
    id,
    title,
    url: `https://example.com/${id}`,
    sourceId,
    sourceName: sourceId,
    categories: [primaryCategory],
    primaryCategory,
    summary: `${id} 对应事件披露了具体范围、阶段数据和后续安排，内容完整且与其他测试事件不重合。`,
    publishedAt,
  });
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

  it("reserves fresh core slots without dropping older high-impact stories", () => {
    const report = buildDailyReport(
      [
        candidate({
          id: "older-conflict",
          title: "全球战争冲突升级并触发紧急制裁措施",
          url: "https://www.news.cn/world/older-conflict.html",
          categories: ["international"],
          primaryCategory: "international",
          summary: "全球冲突升级后，多国宣布紧急制裁和处置措施，影响范围仍在扩大。",
          publishedAt: new Date(now.getTime() - 30 * 60 * 60_000).toISOString(),
        }),
        candidate({
          id: "fresh-policy",
          title: "央行发布全国性金融监管新规",
          url: "https://www.news.cn/politics/fresh-policy.html",
          summary: "央行发布全国性金融监管新规，明确执行时间、适用机构和后续检查安排。",
          publishedAt: new Date(now.getTime() - 60 * 60_000).toISOString(),
        }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.topStories.map((story) => story.title)).toEqual([
      "央行发布全国性金融监管新规",
      "全球战争冲突升级并触发紧急制裁措施",
    ]);
  });

  it("uses the latest independent evidence as activity time while preserving the event start", () => {
    const oldPublishedAt = new Date(now.getTime() - 30 * 60 * 60_000).toISOString();
    const freshPublishedAt = new Date(now.getTime() - 60 * 60_000).toISOString();
    const report = buildDailyReport(
      [
        candidate({ publishedAt: oldPublishedAt }),
        candidate({
          id: "ap-policy-update",
          title: "全国性金融监管新规公布并确定执行时间",
          url: "https://apnews.com/article/policy-update",
          sourceId: "ap",
          sourceName: "Associated Press",
          region: "global",
          summary: "相关部门公布全国性金融监管新规，文件列明执行时间、适用机构和监管安排。",
          publishedAt: freshPublishedAt,
        }),
      ],
      defaultPreferences,
      now,
    );
    const story = report.stories[0];

    expect(story.publishedAt).toBe(oldPublishedAt);
    expect(new Date(storyActivityTimestamp(story)).toISOString()).toBe(freshPublishedAt);
    expect(isStoryActiveWithin(story, now, 120)).toBe(true);
    expect(
      isStoryActiveWithin(
        { ...story, updatedAt: new Date(now.getTime() - 120 * 60_000 - 1).toISOString(), evidence: [] },
        now,
        120,
      ),
    ).toBe(false);
  });

  it("keeps fresh unverified leads out of the core and reports independent-source metrics", () => {
    const report = buildDailyReport(
      [
        candidate({
          id: "fresh-social-lead",
          title: "消息人士称一笔重要球员交易正在推进",
          url: "https://x.com/ShamsCharania/status/2",
          sourceId: "x-shams",
          sourceName: "Shams Charania",
          region: "us",
          categories: ["sports"],
          primaryCategory: "sports",
          summary: "单一社交账号称一笔重要球员交易正在推进，目前没有第二个独立来源确认。",
          publishedAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
        }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.topStories).toHaveLength(0);
    expect(report.importantStories).toHaveLength(0);
    expect(report.watchlist[0]?.status).toBe("unverified");
    expect(report.quality.singleIndependentSourceEventShare).toBe(1);
    expect(report.quality.maxPrimaryPublisherShare).toBe(0);
  });

  it("shares the primary-publisher cap across both core tiers while preserving capacity and freshness", () => {
    const mustKnow = [
      coreCandidate("amber", "xinhua", "policy", "Amber 全国重大政策战争处置措施正式生效"),
      coreCandidate("birch", "xinhua", "international", "Birch 全球重大政策战争处置措施正式生效"),
      coreCandidate("cedar", "people", "china", "Cedar 全国重大政策战争处置措施正式生效"),
      coreCandidate("delta", "cctv", "society", "Delta 全国重大政策战争处置措施正式生效"),
      coreCandidate("ember", "chinanews", "finance", "Ember 全国重大政策战争处置措施正式生效"),
      coreCandidate("frost", "caixin", "science", "Frost 全国重大政策战争处置措施正式生效"),
      coreCandidate("grove", "nba", "technology", "Grove 全国重大政策战争处置措施正式生效"),
      coreCandidate("harbor", "fifa", "ai", "Harbor 全国重大政策战争处置措施正式生效"),
    ];
    const important = [
      coreCandidate("iris", "xinhua", "policy", "Iris 公共事务阶段数据公布"),
      coreCandidate("juniper", "xinhua", "international", "Juniper 经济数据阶段进展公布"),
      coreCandidate("kelp", "fiba", "china", "Kelp 民生项目阶段数据公布"),
      coreCandidate("larch", "bbc-sport", "finance", "Larch 经济市场阶段数据公布"),
      coreCandidate("maple", "people", "ai", "Maple 全国研究结果公布"),
      coreCandidate("north", "cctv", "technology", "North 全国研究结果公布"),
      coreCandidate("olive", "chinanews", "society", "Olive 地震灾害处置进展公布"),
      coreCandidate("pine", "caixin", "science", "Pine 全国研究结果公布"),
      coreCandidate(
        "quartz-fresh",
        "nba",
        "china",
        "Quartz 民生项目阶段数据公布",
        new Date(now.getTime() - 30 * 60_000).toISOString(),
      ),
    ];
    const rawItems = [...mustKnow, ...important];
    const report = buildCurationFields(rawItems, rawItems.map(rankedCandidate), {}, now);
    const coreStories = [...report.topStories, ...report.importantStories];
    const xinhuaCoreStories = coreStories.filter((story) => story.evidence[0]?.sourceId === "xinhua");

    expect(report.topStories).toHaveLength(8);
    expect(report.importantStories).toHaveLength(8);
    expect(coreStories).toHaveLength(16);
    expect(report.topStories.filter((story) => story.evidence[0]?.sourceId === "xinhua")).toHaveLength(2);
    expect(report.importantStories.filter((story) => story.evidence[0]?.sourceId === "xinhua")).toHaveLength(1);
    expect(xinhuaCoreStories).toHaveLength(3);
    expect(report.quality.maxPrimaryPublisherShare).toBe(0.188);
    expect(report.quality.maxPrimaryPublisherShare).toBeLessThanOrEqual(0.2);
    expect(coreStories.some((story) => story.itemId === "quartz-fresh")).toBe(true);
    expect(coreStories.every((story) => story.status === "confirmed")).toBe(true);
  });
});
