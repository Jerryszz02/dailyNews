import { describe, expect, it } from "vitest";
import { defaultPreferences } from "../config/preferences";
import type { NewsCluster, RawNewsItem } from "../types";
import { clusterNews } from "./dedupe";
import { allocateClusterPrimaryCategories, buildDailyReport } from "./newsPipeline";
import { scoreNewsItem } from "./scoring";

const now = new Date("2026-06-29T12:00:00.000Z");

function cluster(item: RawNewsItem): NewsCluster {
  return {
    ...item,
    primaryCategory: item.primaryCategory ?? item.categories[0],
    sourceIds: [item.sourceId],
    sourceNames: [item.sourceName],
    relatedUrls: [item.url],
    primaryCategoryVotes: [item.primaryCategory ?? item.categories[0]],
  };
}

describe("scoring", () => {
  it("keeps public importance ahead of pure preference boosts", () => {
    const majorPolicy = cluster({
      id: "major-policy",
      title: "Global central banks announce emergency rate cut after market stress",
      url: "https://example.com/major-policy",
      sourceId: "reuters",
      sourceName: "Reuters",
      language: "en-US",
      region: "global",
      categories: ["finance", "international", "policy"],
      primaryCategory: "finance",
      summary: "Major central banks coordinated an emergency rate cut after market stress, with broad implications for currencies, bonds and households.",
      publishedAt: "2026-06-29T10:00:00.000Z",
      extractedAt: now.toISOString(),
    });

    const nicheAi = cluster({
      id: "niche-ai",
      title: "AI startup launches a small meeting notes assistant",
      url: "https://example.com/niche-ai",
      sourceId: "techcrunch",
      sourceName: "TechCrunch",
      language: "en-US",
      region: "us",
      categories: ["ai", "technology"],
      primaryCategory: "ai",
      summary: "A startup launched a narrow productivity feature for meeting notes and internal document search.",
      publishedAt: "2026-06-29T11:30:00.000Z",
      extractedAt: now.toISOString(),
    });

    const majorScore = scoreNewsItem(majorPolicy, defaultPreferences, now).final_score;
    const aiScore = scoreNewsItem(nicheAi, defaultPreferences, now).final_score;

    expect(majorScore).toBeGreaterThan(aiScore);
  });

  it("moves preferred technology stories upward when public importance is close", () => {
    const report = buildDailyReport(
      [
        {
          id: "tech",
          title: "AI model regulation proposal affects enterprise deployments",
          url: "https://example.com/tech",
          sourceId: "techcrunch",
          sourceName: "TechCrunch",
          language: "en-US",
          region: "us",
          categories: ["ai", "technology", "policy"],
          primaryCategory: "ai",
          summary: "A new proposal could change enterprise AI deployment requirements and compliance timelines.",
          publishedAt: "2026-06-29T09:00:00.000Z",
          extractedAt: now.toISOString(),
        },
        {
          id: "society",
          title: "City announces new transit schedule for summer",
          url: "https://example.com/transit",
          sourceId: "bbc",
          sourceName: "BBC",
          language: "en-US",
          region: "global",
          categories: ["society", "international"],
          primaryCategory: "society",
          summary: "A large city announced a summer transit schedule, affecting local commuters and visitors.",
          publishedAt: "2026-06-29T09:00:00.000Z",
          extractedAt: now.toISOString(),
        },
      ],
      defaultPreferences,
      now,
    );

    expect(report.items[0].id).toBe("tech");
  });

  it("reacts to changed topic preferences", () => {
    const rawItems: RawNewsItem[] = [
      {
        id: "ai",
        title: "AI model platform launches a new coding workflow",
        url: "https://example.com/ai",
        sourceId: "techcrunch",
        sourceName: "TechCrunch",
        language: "en-US",
        region: "us",
        categories: ["ai", "technology"],
        primaryCategory: "ai",
        summary: "A new AI model platform focuses on coding agents, workflow automation and software development.",
        publishedAt: "2026-06-29T09:00:00.000Z",
        extractedAt: now.toISOString(),
      },
      {
        id: "finance",
        title: "Central bank rules change enterprise financing plans",
        url: "https://example.com/finance",
        sourceId: "cnbc",
        sourceName: "CNBC",
        language: "en-US",
        region: "global",
        categories: ["finance", "policy"],
        primaryCategory: "finance",
        summary: "New central bank rules changed financing plans for enterprise technology investments and debt markets.",
        publishedAt: "2026-06-29T09:00:00.000Z",
        extractedAt: now.toISOString(),
      },
    ];

    const defaultReport = buildDailyReport(rawItems, defaultPreferences, now);
    const sportsReport = buildDailyReport(
      rawItems,
      {
        ...defaultPreferences,
        topicWeights: {
          ...defaultPreferences.topicWeights,
          ai: "not-preferred",
          technology: "not-preferred",
          finance: "preferred",
          policy: "preferred",
        },
        boostedKeywords: [],
      },
      now,
    );

    expect(defaultReport.items[0].id).toBe("ai");
    expect(sportsReport.items[0].id).toBe("finance");
  });

  it("marks official and multi-source stories as high trust", () => {
    const report = buildDailyReport(
      [
        {
          id: "openai",
          title: "OpenAI announces a new model release for developers",
          url: "https://openai.com/news/model",
          sourceId: "openai",
          sourceName: "OpenAI",
          language: "en-US",
          region: "us",
          categories: ["ai", "technology"],
          primaryCategory: "ai",
          summary: "OpenAI announced a new model release for developers with availability details and product context.",
          publishedAt: "2026-06-29T10:00:00.000Z",
          extractedAt: now.toISOString(),
        },
        {
          id: "reuters-openai",
          title: "OpenAI announces new model release for developers",
          url: "https://reuters.com/example/openai",
          sourceId: "reuters",
          sourceName: "Reuters",
          language: "en-US",
          region: "global",
          categories: ["ai", "technology"],
          primaryCategory: "ai",
          summary: "Reuters reported that OpenAI announced a new model release for developers with availability details.",
          publishedAt: "2026-06-29T10:00:00.000Z",
          extractedAt: now.toISOString(),
        },
      ],
      defaultPreferences,
      now,
    );

    expect(report.items[0].trust.level).toBe("high");
  });

  it("keeps social single-source stories visible but low trust", () => {
    const report = buildDailyReport(
      [
        {
          id: "shams",
          title: "Shams reports a major NBA trade is being finalized",
          url: "https://x.com/ShamsCharania/status/1",
          sourceId: "x-shams",
          sourceName: "Shams Charania",
          language: "en-US",
          region: "us",
          categories: ["sports"],
          primaryCategory: "sports",
          summary: "A single social post says a major NBA trade is being finalized, with no second source yet.",
          publishedAt: "2026-06-29T10:00:00.000Z",
          extractedAt: now.toISOString(),
        },
      ],
      defaultPreferences,
      now,
    );

    expect(report.items).toHaveLength(1);
    expect(report.items[0].trust.level).toBe("low");
  });

  it("treats a concise Chinese summary as information-complete", () => {
    const report = buildDailyReport(
      [
        {
          id: "chinese-summary",
          title: "监管部门发布新规并明确全国执行时间",
          url: "https://www.news.cn/politics/chinese-summary.html",
          sourceId: "xinhua",
          sourceName: "新华网",
          language: "zh-CN",
          region: "china",
          categories: ["policy", "china"],
          primaryCategory: "policy",
          summary: "新规明确适用范围、执行时间和后续监管安排，将影响全国相关市场主体。",
          publishedAt: now.toISOString(),
          extractedAt: now.toISOString(),
        },
      ],
      defaultPreferences,
      now,
    );

    expect(report.items).toHaveLength(1);
    expect(report.items[0].trust.reasons).toContain("摘要信息完整");
  });

  it("filters out invalid stories with missing title or url", () => {
    const report = buildDailyReport(
      [
        {
          id: "invalid",
          title: "",
          url: "",
          sourceId: "x-shams",
          sourceName: "Shams Charania",
          language: "en-US",
          region: "us",
          categories: ["sports"],
          primaryCategory: "sports",
          summary: "Missing title and URL should not appear.",
          extractedAt: now.toISOString(),
        },
      ],
      defaultPreferences,
      now,
    );

    expect(report.items).toHaveLength(0);
  });
});

describe("dedupe", () => {
  it("does not merge unrelated stories that share the conservative summary template", () => {
    const topics = [
      ["政策", "国务院公布新的行政服务办法"],
      ["社会", "沿海地区启动防汛应急响应"],
      ["财经", "多家银行调整部分服务安排"],
      ["科技", "国产芯片企业发布新产品"],
      ["科学", "科研团队完成深海观测任务"],
      ["体育", "篮球联赛公布总决赛赛程"],
      ["娱乐", "动画电影发布首支预告片"],
    ] as const;
    const clusters = clusterNews(
      topics.map(([label, title], index) => ({
        id: `template-${index}`,
        title,
        url: `https://example.com/template-${index}`,
        sourceId: "xinhua",
        sourceName: "新华网",
        language: "zh-CN" as const,
        region: "china" as const,
        categories: [(["policy", "society", "finance", "technology", "science", "sports", "entertainment"] as const)[index]],
        primaryCategory: (["policy", "society", "finance", "technology", "science", "sports", "entertainment"] as const)[index],
        summary: `“${title}”已有新的公开信息，详细事实、影响范围和后续进展以来源页面为准。`,
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      })),
    );

    expect(clusters).toHaveLength(topics.length);
  });

  it("allocates a conflicted event to an uncovered voted category without duplicating it", () => {
    const clusters = clusterNews([
      {
        id: "china-general",
        title: "国内综合新闻",
        url: "https://example.com/china-general",
        sourceId: "xinhua",
        sourceName: "新华网",
        language: "zh-CN",
        region: "china",
        categories: ["china"],
        primaryCategory: "china",
        summary: "国内综合新闻包含明确事实和后续安排。",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
      {
        id: "emergency",
        title: "国家防总部署重点地区防汛救灾工作",
        url: "https://example.com/emergency",
        sourceId: "mem",
        sourceName: "应急管理部",
        language: "zh-CN",
        region: "china",
        categories: ["society", "china", "policy"],
        primaryCategory: "society",
        summary: "应急管理部门部署重点地区防汛救灾和公共安全工作。",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
      {
        id: "emergency-confirmation",
        title: "重点地区防汛救灾工作持续推进",
        url: "https://example.com/emergency-confirmation",
        sourceId: "xinhua",
        sourceName: "新华网",
        language: "zh-CN",
        region: "china",
        categories: ["china", "society"],
        primaryCategory: "china",
        summary: "国家防总持续调度重点地区防汛救灾和应急处置工作。",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
    ]);
    const allocated = allocateClusterPrimaryCategories(clusters);

    expect(allocated).toHaveLength(clusters.length);
    expect(allocated.filter((cluster) => cluster.primaryCategory === "society")).toHaveLength(1);
    expect(allocated.filter((cluster) => cluster.primaryCategory === "china").length).toBeGreaterThanOrEqual(1);
  });

  it("clusters the same event from multiple sources", () => {
    const items: RawNewsItem[] = [
      {
        id: "one",
        title: "Advanced AI chip supply chain regulation intensifies",
        url: "https://example.com/one",
        sourceId: "reuters",
        sourceName: "Reuters",
        language: "en-US",
        region: "global",
        categories: ["ai", "technology", "policy"],
        primaryCategory: "ai",
        summary: "Governments are increasing regulation of advanced AI chip supply chains and cloud computing access.",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
      {
        id: "two",
        title: "Advanced AI chip supply chain rules intensify",
        url: "https://example.com/two",
        sourceId: "bbc",
        sourceName: "BBC",
        language: "en-US",
        region: "global",
        categories: ["ai", "technology", "international"],
        primaryCategory: "ai",
        summary: "New rules target advanced AI chip supply chains and related computing infrastructure.",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
    ];

    const clusters = clusterNews(items);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].sourceNames).toEqual(["Reuters", "BBC"]);
    expect(clusters[0].relatedUrls).toHaveLength(2);
  });

  it("clusters a breaking event with a differently worded follow-up", () => {
    const clusters = clusterNews([
      {
        id: "fire-main",
        title: "习近平对福建泉州晋江市一鞋厂火灾事故作出重要指示",
        url: "https://example.com/fire-main",
        sourceId: "xinhua",
        sourceName: "新华网",
        language: "zh-CN",
        region: "china",
        categories: ["policy", "china", "society"],
        primaryCategory: "policy",
        summary: "福建泉州晋江市一鞋厂发生火灾并造成人员伤亡，应急管理部派工作组赶赴现场处置。",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
      {
        id: "fire-follow-up",
        title: "应急管理部派联合工作组赴晋江",
        url: "https://example.com/fire-follow-up",
        sourceId: "chinanews",
        sourceName: "中国新闻网",
        language: "zh-CN",
        region: "china",
        categories: ["china", "society"],
        primaryCategory: "china",
        summary: "福建晋江一鞋厂发生火灾并造成人员伤亡，应急管理部和消防救援部门派工作组到现场指导救援处置。",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].relatedUrls).toHaveLength(2);
  });

  it("assigns NBA stories to sports as the single primary category", () => {
    const clusters = clusterNews([
      {
        id: "nba",
        title: "NBA Finals injury update changes the series outlook",
        url: "https://www.nba.com/news/finals-injury",
        sourceId: "nba",
        sourceName: "NBA官网",
        language: "en-US",
        region: "us",
        categories: ["sports", "international"],
        primaryCategory: "sports",
        summary: "The NBA published a Finals injury update that changes the basketball series outlook.",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
    ]);

    expect(clusters[0].primaryCategory).toBe("sports");
  });

  it("keeps a unanimous vertical primary category despite auxiliary keyword hits", () => {
    const clusters = clusterNews([
      {
        id: "emergency",
        title: "应急管理部发布全国防汛政策通知",
        url: "https://www.mem.gov.cn/xw/bndt/202607/t20260710_1.shtml",
        sourceId: "mem",
        sourceName: "应急管理部",
        language: "zh-CN",
        region: "china",
        categories: ["society", "china", "policy"],
        primaryCategory: "society",
        summary: "通知部署全国多地防汛救灾、公共安全和应急响应工作。",
        publishedAt: now.toISOString(),
        extractedAt: now.toISOString(),
      },
    ]);

    expect(clusters[0].primaryCategory).toBe("society");
  });
});
