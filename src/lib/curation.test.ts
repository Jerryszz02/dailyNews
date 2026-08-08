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
    startedAt: item.publishedAt ?? item.extractedAt,
    updatedAt: item.updatedAt ?? item.publishedAt ?? item.extractedAt,
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
          title: "多部门发布全国性金融监管新规并明确执行时间",
          url: "https://apnews.com/article/policy",
          sourceId: "ap",
          sourceName: "Associated Press",
          region: "global",
          summary: "新规明确了金融机构的执行范围、时间安排和后续监管要求，将影响全国相关市场主体。",
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

  it("keeps generic fallback summaries as degraded candidates instead of dropping them", () => {
    const result = applyCandidateQualityGate([
      candidate({ summary: "相关报道聚焦“测试标题”，具体背景、影响和后续进展以原文披露为准。" }),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({ qualityStatus: "degraded", rejectionReasons: ["template_summary"] });
    expect(result.rejectionReasons).toEqual({});
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
          url: "https://news.cn/sports-ranking",
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
    const oldPublishedAt = new Date(now.getTime() - 20 * 60 * 60_000).toISOString();
    const freshPublishedAt = new Date(now.getTime() - 60 * 60_000).toISOString();
    const report = buildDailyReport(
      [
        candidate({ publishedAt: oldPublishedAt }),
        candidate({
          id: "ap-policy-update",
          title: "多部门发布全国性金融监管新规并明确执行时间",
          url: "https://apnews.com/article/policy-update",
          sourceId: "ap",
          sourceName: "Associated Press",
          region: "global",
          summary: "新规明确了金融机构的执行范围、时间安排和后续监管要求，将影响全国相关市场主体。",
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

  it("uses publisher diversity as a soft reorder and then restores full core capacity", () => {
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
    expect(report.importantStories).toHaveLength(9);
    expect(coreStories).toHaveLength(17);
    expect(report.topStories.filter((story) => story.evidence[0]?.sourceId === "xinhua")).toHaveLength(2);
    expect(report.importantStories.filter((story) => story.evidence[0]?.sourceId === "xinhua")).toHaveLength(2);
    expect(xinhuaCoreStories).toHaveLength(4);
    expect(report.quality.maxPrimaryPublisherShare).toBe(0.235);
    expect(coreStories.some((story) => story.itemId === "quartz-fresh")).toBe(true);
    expect(coreStories.every((story) => story.status === "confirmed")).toBe(true);
  });

  it("keeps every accepted event in stories and the 24-hour latest feed regardless of tier", () => {
    const report = buildDailyReport(
      [
        candidate({
          id: "low-impact",
          title: "周末地方球队比赛前景排名与观点盘点",
          url: "https://sports.news.cn/low-impact.html",
          categories: ["sports"],
          primaryCategory: "sports",
          summary: "报道对地方球队的比赛前景进行排名和观点盘点，没有公布新的比赛结果或规则变化。",
          publishedAt: new Date(now.getTime() - 23 * 60 * 60_000).toISOString(),
        }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.stories).toHaveLength(1);
    expect(report.stories[0].tier).toBe("noise");
    expect(report.latestStories?.map((story) => story.id)).toEqual([report.stories[0].id]);
    expect(report.quality.latestEventCount).toBe(1);
    expect(report.quality.unmappedCandidateCount).toBe(0);
  });

  it("falls back to all events within 72 hours only when the 24-hour latest window is empty", () => {
    const report = buildDailyReport(
      [
        candidate({
          id: "older-one",
          title: "全国空间研究项目公布轨道观测阶段结果",
          url: "https://www.news.cn/science/older-one.html",
          categories: ["science"],
          primaryCategory: "science",
          publishedAt: new Date(now.getTime() - 30 * 60 * 60_000).toISOString(),
        }),
        candidate({
          id: "older-two",
          title: "全国海洋研究项目公布深海采样阶段结果",
          url: "https://www.news.cn/science/older-two.html",
          categories: ["science"],
          primaryCategory: "science",
          summary: "全国海洋研究项目公布深海采样的阶段数据、实验范围和后续分析安排。",
          publishedAt: new Date(now.getTime() - 48 * 60 * 60_000).toISOString(),
        }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.latestStories?.map((story) => story.itemId)).toEqual(["older-one", "older-two"]);
  });

  it("accepts missing summary and publication time as degraded instead of dropping the candidate", () => {
    const result = applyCandidateQualityGate([
      candidate({ id: "degraded", summary: "", publishedAt: "not-a-date", discoveredAt: now.toISOString() }),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      qualityStatus: "degraded",
      rejectionReasons: ["missing_published_at", "insufficient_summary"],
      timeStatus: "estimated",
      publishedAt: undefined,
    });
    expect(result.rejectionReasons).toEqual({});
  });

  it("does not let source trust change the selected importance tier", () => {
    const base = candidate({
      id: "high-trust",
      title: "全国重大政策正式发布并明确执行时间",
      url: "https://www.news.cn/politics/trust-neutral.html",
    });
    const highTrustReport = buildDailyReport([base], defaultPreferences, now);
    const lowTrustReport = buildDailyReport(
      [
        {
          ...base,
          id: "low-trust",
          url: "https://x.com/ShamsCharania/status/trust-neutral",
          sourceId: "x-shams",
          sourceName: "Shams Charania",
        },
      ],
      defaultPreferences,
      now,
    );

    expect(highTrustReport.items[0].trust.level).not.toBe(lowTrustReport.items[0].trust.level);
    expect(lowTrustReport.items[0].trust.shouldShow).toBe(true);
    expect(lowTrustReport.stories[0].tier).toBe(highTrustReport.stories[0].tier);
  });

  it("rejects candidates from unknown sources or outside an approved source domain", () => {
    const report = buildDailyReport(
      [
        candidate({ id: "unknown", sourceId: "unknown-source", url: "https://unknown.example/story" }),
        candidate({ id: "off-domain", sourceId: "xinhua", url: "https://example.com/story" }),
        candidate({ id: "navigation", sourceId: "xinhua", url: "https://www.news.cn/" }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.stories).toEqual([]);
    expect(report.quality.rejectionReasons).toEqual({
      unapproved_source: 1,
      source_url_out_of_scope: 1,
      navigation_page: 1,
    });
  });

  it("keeps approved candidates publishable when collection is technically disabled", () => {
    const report = buildDailyReport(
      [
        candidate({
          id: "approved-disabled",
          sourceId: "reuters",
          sourceName: "Reuters",
          url: "https://reuters.com/world/approved-disabled",
        }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.stories).toHaveLength(1);
    expect(report.quality.unmappedCandidateCount).toBe(0);
  });

  it("assigns unique stable IDs to independent same-title events", () => {
    const sharedTitle = "国务院新闻发布会";
    const report = buildDailyReport(
      [
        candidate({
          id: "same-title-one",
          title: sharedTitle,
          url: "https://www.news.cn/politics/same-title-one.html",
          summary: "发布会介绍财政预算执行、地方债安排、专项资金投向和下一阶段公开计划。",
          publishedAt: "2026-08-03T01:00:00.000Z",
        }),
        candidate({
          id: "same-title-two",
          title: sharedTitle,
          url: "https://www.news.cn/politics/same-title-two.html",
          summary: "发布会介绍防汛救灾部署、应急队伍调度、受灾群众安置和天气风险预警。",
          publishedAt: "2026-08-03T02:00:00.000Z",
        }),
      ],
      defaultPreferences,
      now,
    );

    expect(report.stories).toHaveLength(2);
    expect(new Set(report.stories.map((story) => story.id)).size).toBe(2);
  });

  it("keeps the event ID stable when the same URL is translated later", () => {
    const original = candidate({
      id: "translation-stable",
      title: "New policy announcement",
      summary: "The agency announced a policy implementation schedule and next steps.",
      url: "https://www.news.cn/politics/translation-stable.html",
      language: "en-US",
      translationStatus: "pending",
    });
    const translated = {
      ...original,
      title: "新政策公布实施时间表",
      summary: "有关机构公布政策实施时间表、适用范围以及下一阶段安排。",
      language: "zh-CN" as const,
      translationStatus: "translated" as const,
    };

    const originalId = buildDailyReport([original], defaultPreferences, now).stories[0]?.id;
    const translatedId = buildDailyReport([translated], defaultPreferences, now).stories[0]?.id;
    expect(translatedId).toBe(originalId);
  });

  it("keeps advertising-policy news while rejecting explicit sponsored calls to action", () => {
    const result = applyCandidateQualityGate([
      candidate({
        id: "advertising-policy",
        title: "市场监管总局发布互联网广告新规",
        url: "https://www.news.cn/politics/advertising-policy.html",
        summary: "新规明确互联网广告标识、平台责任、监管程序和正式实施时间。",
      }),
      candidate({
        id: "sponsored-offer",
        title: "赞助内容：限时活动",
        url: "https://www.news.cn/politics/sponsored-offer.html",
        summary: "立即领取优惠券并点击购买。",
      }),
    ]);

    expect(result.accepted.map((item) => item.id)).toEqual(["advertising-policy"]);
    expect(result.rejectionReasons).toEqual({ promotional: 1 });
  });
});
