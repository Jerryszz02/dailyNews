# 原信源恢复状态

本记录以本地实际配置快照为准。来源适配通过、配置启用、一次采集成功、模型分析完成和新闻公开可读，是不同状态；候选条目数量不等于启用来源数量。

## 当前边界与数量

核对时间：**2026-10-10T18:59:54.428Z**。原配置包含 **169 个来源身份、187 个栏目记录**，本轮沿用这些身份和原域名/路径边界，没有新增外部信源。

| 状态 | 栏目数 | 说明 |
| --- | --- | --- |
| 已启用栏目 | 84 | 原先32 + 本轮恢复52；84项均有本轮成功采集记录，当前健康 |
| 原启用意图的X栏目 | 67 | 缺 DAILY_NEWS_X_BEARER_TOKEN，官方X开关关闭；全部未启用 |
| 原禁用栏目 | 14 | 保持禁用；不因恢复过程自动开放 |
| 其余未恢复栏目 | 22 | 13项访问失败，9项材料或入口限制；逐项列在下方 |
| 合计 | 187 | 栏目记录总数；不能与169个来源身份混算 |

新京报两个栏目使用稿件自身短文或视频简介作为 **source_summary**，已验证样本为186、156、194字；正文仍为 unconfirmed，不能称为完整正文。其他恢复栏目验证了带自身发布时间的正文样本。来源恢复不保证以后每篇文章都可读；视频无转录、付费墙、访问限制和材料不足仍需按篇保留明确状态。

本轮不调整原 DeepSeek Flash 配置、中文摘要及AI评分的模型选择，也不改变十个唯一主分类。原非AI确定性规则保持独立。网页和API未因信源配置应用而重启，用户可以继续使用本地页面和标注页。

## 真实更新与历史导入

- 原32个栏目刷新：32次采集全部成功，产生5条正常新增；这5条已完成分析与分组。证据为 `.data/source-restoration/existing-round-evidence.json`。
- 恢复来源首批47个：46次采集成功；国家统计局的一次任务中断，需要重试。发现891个列表候选，只形成309条首次历史导入，**该首轮正常新增为0**。证据为 `.data/source-restoration/new-sources-first-round-evidence.json`。
- 最后5个栏目已完成CLI验证及配置应用；它们不在上述首批47次采集数字里。
- 18:53 的国家统计局重试因旧任务锁仍有效而跳过，未当作成功。18:58:12 开始的最终完整刷新：84 个任务、84 个对应采集记录全部成功。新入库12条，其中统计局首次导入9条历史、真正新增3条；三方入库计数一致，12条均完成分析并公开。3条正常新增均晚于来源初始化时间，入库到公开为3.026–3.587秒。
- 本轮复采确认642条内容未变、0条修订，另有2569条因初始化时间或历史导入范围被过滤；两者分开计数。旧中断记录161依据已失败的worker任务、无持久采集材料等证据审计校正为失败；新任务253完整保留。最终没有残留中断记录或待处理采集批次。

原文发布时间、首次采集入库时间、分析时间和更新测试窗口分别记录。历史导入不计入正常新增窗口；0条正常新增并不意味着没有拿到历史资料，也不能把旧文章按采集当天算成当天新闻。

2026-10-10T18:59:54.428Z只读快照中共619条文章：610条历史、9条正常；584条符合 `listedCondition` 公开口径，63条符合精选可读口径。这是当时总量，不是这次刷新全部新增数量，也不是仅凭原始 publication flag 计算。它会随后台处理继续变化。另35条仍未通过中文、分类或事实检查（26条中文待补、5条分类待确认、4条预测限定语检查未过），未绕过公开门槛；这不是全量内容已经验收的结论。

## 全部可用栏目

以下84项是实际 `enabled=true` 的栏目，不是待接入候选。当前列表按原32项与新增52项分开，保存原入口及适配后的实际入口；“正文样本通过”不代表全站全文覆盖。

### 原32项

| 来源与栏目 | 稳定ID | 原入口 | 当前入口 | 验证材料 |
| --- | --- | --- | --- | --- |
| Anthropic · News | dn-anthropic-46ed46f2e57d | https://www.anthropic.com/sitemap.xml | https://www.anthropic.com/news | 既有启用；本轮刷新成功 |
| 苹果新闻室 Apple Newsroom · Newsroom | dn-apple-newsroom-678029df2ef0 | https://www.apple.com/newsroom/ | https://www.apple.com/newsroom/rss-feed.rss | 既有启用；本轮刷新成功 |
| arXiv 论文预印本 · cs.AI | dn-arxiv-765b8f0964e9 | https://arxiv.org/ | https://rss.arxiv.org/rss/cs.AI | 既有启用；本轮刷新成功 |
| BBC · World | dn-bbc-25b2d27a78f1 | https://www.bbc.com/news/world | https://feeds.bbci.co.uk/news/world/rss.xml | 既有启用；本轮刷新成功 |
| 中国科学院 · 科研 | dn-cas-e787b896b68f | https://www.cas.cn/ | https://www.cas.cn/ | 既有启用；本轮刷新成功 |
| 中国新闻网 · 财经 | dn-chinanews-9536d2d7c183 | https://www.chinanews.com.cn/finance/ | https://www.chinanews.com.cn/rss/finance.xml | 既有启用；本轮刷新成功 |
| 中国新闻网 · 社会 | dn-chinanews-e34894180204 | https://www.chinanews.com.cn/society/ | https://www.chinanews.com.cn/rss/society.xml | 既有启用；本轮刷新成功 |
| 亚洲新闻台 CNA · Asia | dn-cna-b4dcb6e6cf3f | https://www.channelnewsasia.com/ | https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511 | 既有启用；本轮刷新成功 |
| CNBC · Business | dn-cnbc-e49c9082deca | https://www.cnbc.com/world/ | https://www.cnbc.com/id/100727362/device/rss/rss.html | 既有启用；本轮刷新成功 |
| CNN · World | dn-cnn-2c835545d85b | https://www.cnn.com/world | https://www.cnn.com/sitemap/news.xml | 既有启用；本轮刷新成功 |
| Deadline 影视行业新闻 · Film | dn-deadline-804da737cff2 | https://deadline.com/ | https://deadline.com/feed/ | 既有启用；本轮刷新成功 |
| 德国之声 DW · Top Stories | dn-dw-fc231c4551bc | https://www.dw.com/en/top-stories/s-9097 | https://rss.dw.com/rdf/rss-en-all | 既有启用；本轮刷新成功 |
| 欧洲央行 · Policy | dn-ecb-a5ca532de413 | https://www.ecb.europa.eu/ | https://www.ecb.europa.eu/rss/press.html | 既有启用；本轮刷新成功 |
| 欧洲央行 · Monetary Policy | dn-ecb-c91425ba62aa | https://www.ecb.europa.eu/ | https://www.ecb.europa.eu/rss/press.html | 既有启用；本轮刷新成功 |
| 美联储 · Monetary Policy | dn-fed-68f197e99052 | https://www.federalreserve.gov/ | https://www.federalreserve.gov/feeds/press_all.xml | 既有启用；本轮刷新成功 |
| 美联储 · Press Releases | dn-fed-b3a7beab67c0 | https://www.federalreserve.gov/ | https://www.federalreserve.gov/feeds/press_all.xml | 既有启用；本轮刷新成功 |
| Google AI · Blog | dn-google-ai-c6d3cf2c1f9c | https://blog.google/innovation-and-ai/technology/ai/ | https://blog.google/innovation-and-ai/technology/ai/rss/ | 既有启用；本轮刷新成功 |
| Google DeepMind · Blog | dn-google-deepmind-641e9aef719f | https://deepmind.google/discover/blog/ | https://deepmind.google/blog/rss.xml | 既有启用；本轮刷新成功 |
| 中国政府网 · 政策 | dn-gov-cn-57fefc2bc972 | https://www.gov.cn/ | https://www.gov.cn/ | 既有启用；本轮刷新成功 |
| Hugging Face · Blog | dn-hugging-face-0e9808a5b85b | https://huggingface.co/blog | https://huggingface.co/blog/feed.xml | 既有启用；本轮刷新成功 |
| IT之家 · 科技 | dn-ithome-1019f540ec62 | https://www.ithome.com/ | https://www.ithome.com/rss/ | 既有启用；本轮刷新成功 |
| Microsoft AI · Blog | dn-microsoft-ai-0002b490e4db | https://news.microsoft.com/source/topics/ai/ | https://news.microsoft.com/source/topics/ai/feed/ | 既有启用；本轮刷新成功 |
| MIT Technology Review · AI | dn-mit-tech-review-95784fda96af | https://www.technologyreview.com/topic/artificial-intelligence/ | https://www.technologyreview.com/topic/artificial-intelligence/feed/ | 既有启用；本轮刷新成功 |
| NASA 美国航天局 · News | dn-nasa-ac6925c021ac | https://www.nasa.gov/news/ | https://www.nasa.gov/news-release/feed/ | 既有启用；本轮刷新成功 |
| Nature 新闻 · News | dn-nature-news-c1f4bec7f709 | https://www.nature.com/news | https://www.nature.com/nature.rss | 既有启用；本轮刷新成功 |
| NBA官网 · NBA News | dn-nba-533ef335b03c | https://www.nba.com/news | https://www.nba.com/news | 既有启用；本轮刷新成功 |
| 量子位 · AI | dn-qbitai-31dd73b95c93 | https://www.qbitai.com/ | https://www.qbitai.com/ | 既有启用；本轮刷新成功 |
| 通义千问 Qwen · 官方发布 | dn-qwen-3bd13fab628b | https://qwenlm.github.io/ | https://qwenlm.github.io/ | 既有启用；本轮刷新成功 |
| Science News 科学新闻 · Science | dn-science-news-7baedd900d1c | https://www.sciencenews.org/ | https://www.sciencenews.org/feed | 既有启用；本轮刷新成功 |
| 好莱坞报道 The Hollywood Reporter · Film | dn-thr-fac341557850 | https://www.hollywoodreporter.com/ | https://www.hollywoodreporter.com/feed/ | 既有启用；本轮刷新成功 |
| Wired · Science | dn-wired-c465b48c1ddf | https://www.wired.com/category/science/ | https://www.wired.com/feed/category/science/latest/rss | 既有启用；本轮刷新成功 |
| 新华网 · 要闻 | dn-xinhua-f77f0b3178db | https://www.news.cn/ | https://www.news.cn/ | 既有启用；本轮刷新成功 |

### 本轮恢复52项

| 来源与栏目 | 稳定ID | 原入口 | 当前入口 | 验证材料 |
| --- | --- | --- | --- | --- |
| 21世纪经济报道 · 财经 | dn-21jingji-2da9280bfa25 | https://www.21jingji.com/ | https://www.21jingji.com/ | 已验证正文样本 |
| 非洲新闻台 Africanews · News | dn-africanews-e1769e1a236f | https://www.africanews.com/ | https://www.africanews.com/ | 已验证正文样本 |
| 巴西国家通讯社 · News | dn-agencia-brasil-d4da197d8e53 | https://agenciabrasil.ebc.com.br/ | https://agenciabrasil.ebc.com.br/ | 已验证正文样本 |
| Al Jazeera · News | dn-aljazeera-704843f21d8b | https://www.aljazeera.com/news/ | https://www.aljazeera.com/news/ | 已验证正文样本 |
| Ars Technica · Tech | dn-ars-technica-9d74c257c86f | https://arstechnica.com/ | https://arstechnica.com/ | 已验证正文样本 |
| BBC体育 · Sport | dn-bbc-sport-8865a371aa01 | https://www.bbc.com/sport | https://www.bbc.com/sport | 已验证正文样本 |
| 公告牌 Billboard · Music | dn-billboard-6d8b657e4db2 | https://www.billboard.com/ | https://www.billboard.com/ | 已验证正文样本 |
| 新京报 · 社会 | dn-bjnews-16e6e253e20e | https://www.bjnews.com.cn/ | https://www.bjnews.com.cn/ | 来源摘要；正文未确认 |
| 新京报 · 要闻 | dn-bjnews-e8d88f7e013a | https://www.bjnews.com.cn/ | https://www.bjnews.com.cn/ | 来源摘要；正文未确认 |
| CBS体育 NBA · NBA | dn-cbs-sports-nba-b0696340bd6f | https://www.cbssports.com/nba/ | https://www.cbssports.com/nba/ | 已验证正文样本 |
| 央视网 · 体育 | dn-cctv-6f9501b3e5b9 | https://sports.cctv.com/ | https://sports.cctv.com/ | 已验证正文样本 |
| 央视网 · 新闻 | dn-cctv-f085fa6f18a0 | https://news.cctv.com/ | https://news.cctv.com/ | 已验证正文样本 |
| 中国日报网 · 新闻 | dn-china-daily-96c3ce64ccff | https://cn.chinadaily.com.cn/ | https://cn.chinadaily.com.cn/ | 已验证正文样本 |
| 中国新闻网 · 体育 | dn-chinanews-2cfdc1b8582c | https://www.chinanews.com.cn/ty/ | https://www.chinanews.com.cn/ | 已验证正文样本 |
| 中国新闻网 · 国际 | dn-chinanews-3c0f866729aa | https://www.chinanews.com.cn/gj/ | https://www.chinanews.com.cn/ | 已验证正文样本 |
| 中国新闻网 · 即时 | dn-chinanews-c3e2a8830e6c | https://www.chinanews.com.cn/ | https://www.chinanews.com.cn/ | 已验证正文样本 |
| 中国青年报 · 新闻 | dn-cyol-bd2d419c522e | https://news.cyol.com/ | https://news.cyol.com/ | 已验证正文样本 |
| ESPN · NBA | dn-espn-3794a4d18732 | https://www.espn.com/nba/ | https://www.espn.com/nba/ | 已验证正文样本 |
| 欧盟委员会 · Press | dn-eu-commission-fe824504780e | https://commission.europa.eu/news-and-media/news_en | https://commission.europa.eu/news-and-media/news_en | 已验证正文样本 |
| F1 世界一级方程式 · Latest | dn-f1-7750ee74725b | https://www.formula1.com/en/latest | https://www.formula1.com/en/latest | 已验证正文样本 |
| FIBA官网 · FIBA News | dn-fiba-df168038d131 | https://www.fiba.basketball/en/news | https://www.fiba.basketball/en/news | 已验证正文样本 |
| 法国24电视台 · News | dn-france24-6b1bed250f9f | https://www.france24.com/en/ | https://www.france24.com/en/ | 已验证正文样本 |
| GitHub 官方博客 · Blog | dn-github-blog-fd7ad6745256 | https://github.blog/ | https://github.blog/ | 已验证正文样本 |
| The Guardian · World | dn-guardian-601090a31fd7 | https://www.theguardian.com/world | https://www.theguardian.com/world | 已验证正文样本 |
| 爱范儿 · 科技 | dn-ifanr-b77ecc7ad564 | https://www.ifanr.com/ | https://www.ifanr.com/ | 已验证正文样本 |
| 界面新闻 · 快讯 | dn-jiemian-be9c481f85ca | https://www.jiemian.com/ | https://www.jiemian.com/ | 已验证正文样本 |
| 雷峰网 · 科技 | dn-leiphone-b51224306af1 | https://www.leiphone.com/ | https://www.leiphone.com/ | 已验证正文样本 |
| Meta AI · Blog | dn-meta-ai-7936e5a59ad1 | https://ai.meta.com/blog/ | https://ai.meta.com/blog/ | 已验证正文样本 |
| 工业和信息化部 · 政策发布 | dn-miit-e7095178568c | https://www.miit.gov.cn/ | https://www.miit.gov.cn/ | 已验证正文样本 |
| 财政部 · 政策发布 | dn-mof-1730fbf08c22 | https://www.mof.gov.cn/ | https://www.mof.gov.cn/index.htm | 已验证正文样本 |
| 时光网 · 影视 | dn-mtime-4a3f764c5d47 | https://news.mtime.com/ | https://news.mtime.com/ | 已验证正文样本 |
| 国家统计局 · 统计数据 | dn-nbs-318ba075a489 | https://www.stats.gov.cn/ | https://www.stats.gov.cn/ | 已验证正文样本 |
| 国家发展改革委 · 政策发布 | dn-ndrc-ec9c232a74a6 | https://www.ndrc.gov.cn/ | https://www.ndrc.gov.cn/ | 已验证正文样本 |
| NVIDIA AI · Blog | dn-nvidia-ai-cc11e7fa00ca | https://blogs.nvidia.com/blog/category/deep-learning/ | https://blogs.nvidia.com/blog/category/deep-learning/ | 已验证正文样本 |
| 中国人民银行 · 政策公告 | dn-pboc-538caa3a0cd0 | https://www.pbc.gov.cn/ | https://www.pbc.gov.cn/ | 已验证正文样本 |
| 中国人民银行 · 货币政策 | dn-pboc-5e98b22ee40c | https://www.pbc.gov.cn/ | https://www.pbc.gov.cn/ | 已验证正文样本 |
| 红星新闻 · 新闻 | dn-redstar-a7a028814042 | https://www.cdsb.com/ | https://www.cdsb.com/ | 已验证正文样本 |
| 科学网 · 科学 | dn-sciencenet-2dfffbf8b647 | https://news.sciencenet.cn/ | https://news.sciencenet.cn/ | 已验证正文样本 |
| 上海证券交易所 · 市场公告 | dn-sse-d9db55a08730 | https://www.sse.com.cn/ | https://www.sse.com.cn/ | 已验证正文样本 |
| 深圳证券交易所 · 市场公告 | dn-szse-24be40934438 | https://www.szse.cn/ | https://www.szse.cn/ | 已验证正文样本 |
| TechCrunch · Startups | dn-techcrunch-f02b9e03728c | https://techcrunch.com/ | https://techcrunch.com/ | 已验证正文样本 |
| The Verge · Tech | dn-the-verge-9a677dd9cd97 | https://www.theverge.com/tech | https://www.theverge.com/tech | 已验证正文样本 |
| 钛媒体 · 科技 | dn-tmtpost-6573fce41442 | https://www.tmtpost.com/ | https://www.tmtpost.com/ | 已验证正文样本 |
| 综艺 Variety · Entertainment | dn-variety-8b0e06e28fd6 | https://variety.com/ | https://variety.com/ | 已验证正文样本 |
| 世界卫生组织 WHO · News | dn-who-8c8f4a455fc1 | https://www.who.int/news | https://www.who.int/news-room | 已验证正文样本 |
| 世界田联 · News | dn-world-athletics-26d86174d8ec | https://worldathletics.org/ | https://worldathletics.org/ | 已验证正文样本 |
| WTA 女子网球协会 · News | dn-wta-6e07cccbd569 | https://www.wtatennis.com/news | https://www.wtatennis.com/news | 已验证正文样本 |
| 新华网 · 国际 | dn-xinhua-0bd773b290aa | https://www.news.cn/world/ | https://www.news.cn/world/ | 已验证正文样本 |
| 新华网 · 科技 | dn-xinhua-b3451a86d549 | https://www.news.cn/tech/ | https://www.news.cn/tech/ | 已验证正文样本 |
| 新华网 · 体育 | dn-xinhua-ffb98927d061 | https://sports.news.cn/ | https://sports.news.cn/ | 已验证正文样本 |
| 雅虎体育 NBA · NBA | dn-yahoo-sports-nba-1dde5c41fd3a | https://sports.yahoo.com/nba/ | https://sports.yahoo.com/nba/ | 已验证正文样本 |
| 第一财经 · 财经 | dn-yicai-ab7a5c4ddf07 | https://www.yicai.com/ | https://www.yicai.com/ | 已验证正文样本 |

## 仍未恢复的22项

### 访问失败13项

| 来源与栏目 | 稳定ID | 原入口 | 具体状态 | 原因 |
| --- | --- | --- | --- | --- |
| 36氪 · 科技 | dn-36kr-db6a080627da | https://36kr.com/ | 访问验证页 | 原入口 HTTP 200 实际为 __waf_verification_challenge；没有新闻列表，未绕过验证。 |
| Associated Press · Top News | dn-ap-f32738779711 | https://apnews.com/ | HTTP 403 | 原列表拒绝公开访问。 |
| ATP 男子网球协会 · News | dn-atp-fd9319bfd4c0 | https://www.atptour.com/en/news | HTTP 403 | Cloudflare Just a moment 验证页；未绕过验证。 |
| 央视网 · 文娱 | dn-cctv-a4ddf8aefe33 | https://ent.cctv.com/ | 跨原边界跳转 | 原入口仅返回 392 字节空页，meta refresh 指向 http://www.cctv.com/；保留原 hosts 边界，未扩域。 |
| DeepSeek 深度求索 · 官方发布 | dn-deepseek-bb028b804fbc | https://www.deepseek.com/ | HTTP 403 | 原官网转向 chat.deepseek.com，返回 CloudFront 错误；没有新闻列表。与项目使用 DeepSeek API 无关。 |
| 日本NHK国际广播 · World | dn-nhk-e79238c5c11b | https://www3.nhk.or.jp/nhkworld/en/news/ | 网络请求失败 | 原 URL 重试仍 fetch failed，未得到可验证材料。 |
| NPR · News | dn-npr-d3d778d1d1ac | https://www.npr.org/sections/news/ | 正文网络请求失败 | RSS 可访问，实抓三篇原域文章均 fetch failed；仅 RSS 条目不能证明正文可读。 |
| 国际奥委会 Olympics · News | dn-olympics-02974a87c802 | https://www.olympics.com/en/ | 正文 HTTP 403 | 列表可解析，实抓三篇正文均 Access Denied。 |
| OpenAI · News | dn-openai-d7c663cc6e40 | https://openai.com/news/ | 正文 HTTP 403 | RSS 可访问，实抓三篇原域正文均被拒绝；没有得到可读正文。 |
| 人民网 · 要闻 | dn-people-ac5b9321e065 | https://www.people.com.cn/ | 协议或 TLS 依赖 | 原主页文章为 HTTP；原准入只接收 HTTPS。同域官方 politics HTTPS 入口报 ERR_TLS_CERT_ALTNAME_INVALID，未关闭 TLS 校验。 |
| 澎湃新闻 · 新闻 | dn-the-paper-0b058aafe158 | https://www.thepaper.cn/ | HTTP 403 | 原列表拒绝公开访问；没有绕过验证或扩大域名边界。 |
| 澎湃新闻 · 社会 | dn-the-paper-4b78f1e11f98 | https://www.thepaper.cn/ | HTTP 403 | 原列表拒绝公开访问；没有绕过验证或扩大域名边界。 |
| 澎湃新闻 · 文艺 | dn-the-paper-b9718b399595 | https://www.thepaper.cn/ | HTTP 403 | 原列表拒绝公开访问；没有绕过验证或扩大域名边界。 |

### 材料或入口限制9项

| 来源与栏目 | 稳定ID | 原入口 | 具体状态 | 原因 |
| --- | --- | --- | --- | --- |
| 财新 · 经济 | dn-caixin-34878b3fb524 | https://www.caixin.com/ | 付费摘要限制 | 前三篇仅 251–292 字的公开预览，未证明完整正文；保持未启用。 |
| 央视网 · 国际 | dn-cctv-418c2a618d0c | https://news.cctv.com/world/ | 视频材料不足 | 精确列表有一条带日期的稿件，但正文容器为空；没有自身可验证的文字正文或转录。 |
| 中国新闻网 · 文娱 | dn-chinanews-0524a860a661 | https://www.chinanews.com.cn/yl/ | 原列表受拒且替代入口无对应新闻 | 原文娱 URL 为 HTTP 403；同原域首页可访问，但精确 /yl/ 新闻选择器为空，未借其他栏目凑数。 |
| FIFA官网 · FIFA News | dn-fifa-ea59f421914a | https://www.fifa.com/en/news | 客户端列表待适配 | 原页 HTTP 200，但为客户端 React 壳；原 HTML 没有新闻列表，未找到可直接使用的普通公开数据。 |
| 香港交易所 · 市场公告 | dn-hkex-8e9be25afd34 | https://www.hkexnews.hk/ | 公告查询入口待适配 | 原页为 TITLE/CONTENT SEARCH 和动态 includeHTML 查询入口，未得到可解析的新闻条目。 |
| 南方周末 · 社会 | dn-infzm-5a01d1854fd7 | https://www.infzm.com/ | 阅读权限限制 | 可看到预览，页面要求“登录获取更多阅读权限”；未作为完整正文启用。 |
| 南方周末 · 新闻 | dn-infzm-ba3bc7feccc7 | https://www.infzm.com/ | 阅读权限限制 | 可看到预览，页面要求“登录获取更多阅读权限”；未作为完整正文启用。 |
| 机器之心 · 人工智能 | dn-jiqizhixin-a9793bf3d886 | https://www.jiqizhixin.com/ | 原站用途改变 | 原域现在是“机器之心·数据服务”联系入口，没有新闻链接或嵌入新闻数据。 |
| 智谱 Z.ai · 官方发布 | dn-z-ai-156024a52a01 | https://z.ai/ | 原入口为聊天应用 | 原 URL 转向 chat.z.ai 的客户端应用壳；没有新闻链接或可验证的文章日期。 |

## 67项X栏目完整清单

这些原本有启用意图的X来源都保留原身份，实际仍未启用。共同阻塞为缺 `DAILY_NEWS_X_BEARER_TOKEN` 且官方X采集开关关闭；本次没有获取凭证、启用付费采集或绕过登录。清单仅含原公开来源名称和链接，不记录凭证值或私有查询标签。

| 公开来源与栏目 | 稳定ID | 原公开入口 | 实际状态 |
| --- | --- | --- | --- |
| Jason Wei X 动态 · X | dn-x-_jasonwei-dcd7bfae32c6 | https://x.com/_jasonwei | 未启用：令牌缺失、开关关闭 |
| Addy Osmani X 动态 · X | dn-x-addyosmani-78b9eb442f6a | https://x.com/addyosmani | 未启用：令牌缺失、开关关闭 |
| 法新社 AFP 新闻 X 动态 · X | dn-x-afp-4229f69a7303 | https://x.com/AFP | 未启用：令牌缺失、开关关闭 |
| Meta AI X 动态 · X | dn-x-aiatmeta-647a10fe26a7 | https://x.com/AIatMeta | 未启用：令牌缺失、开关关闭 |
| Qwen X 动态 · X | dn-x-alibaba_qwen-b75abe2b1cde | https://x.com/Alibaba_Qwen | 未启用：令牌缺失、开关关闭 |
| Andrew Ng（吴恩达） X 动态 · X | dn-x-andrewyng-0ea7eca9331b | https://x.com/AndrewYNg | 未启用：令牌缺失、开关关闭 |
| Anthropic X · X | dn-x-anthropic-25d2798d80c2 | https://x.com/AnthropicAI | 未启用：令牌缺失、开关关闭 |
| Associated Press X 动态 · X | dn-x-ap-63c670b6a01b | https://x.com/AP | 未启用：令牌缺失、开关关闭 |
| Arena X 动态 · X | dn-x-arena-fde6ef0d638a | https://x.com/arena | 未启用：令牌缺失、开关关闭 |
| ATP Tour X 动态 · X | dn-x-atptour-f1478b64f427 | https://x.com/atptour | 未启用：令牌缺失、开关关闭 |
| BBC World X 动态 · X | dn-x-bbcworld-ae061e619e33 | https://x.com/BBCWorld | 未启用：令牌缺失、开关关闭 |
| Boris Cherny X 动态 · X | dn-x-bcherny-b13a7b67e20c | https://x.com/bcherny | 未启用：令牌缺失、开关关闭 |
| Billboard X 动态 · X | dn-x-billboard-6bb996fcfb15 | https://x.com/billboard | 未启用：令牌缺失、开关关闭 |
| 央视新闻 X 动态 · X | dn-x-cctvnews-9f2a7d76ae40 | https://x.com/CCTVNews | 未启用：令牌缺失、开关关闭 |
| CNA X 动态 · X | dn-x-channelnewsasia-76f27241077b | https://x.com/ChannelNewsAsia | 未启用：令牌缺失、开关关闭 |
| China Daily X 动态 · X | dn-x-chinadaily-fc29a9c3785f | https://x.com/ChinaDaily | 未启用：令牌缺失、开关关闭 |
| Clément Delangue X 动态 · X | dn-x-clementdelangue-30256d5934ef | https://x.com/ClementDelangue | 未启用：令牌缺失、开关关闭 |
| Dario Amodei X 动态 · X | dn-x-darioamodei-e32803a90247 | https://x.com/DarioAmodei | 未启用：令牌缺失、开关关闭 |
| Deadline X 动态 · X | dn-x-deadline-47a1f31d425c | https://x.com/DEADLINE | 未启用：令牌缺失、开关关闭 |
| Google DeepMind X · X | dn-x-deepmind-5774e3cbab62 | https://x.com/GoogleDeepMind | 未启用：令牌缺失、开关关闭 |
| DeepSeek X 动态 · X | dn-x-deepseek_ai-e3062ddc1388 | https://x.com/deepseek_ai | 未启用：令牌缺失、开关关闭 |
| Demis Hassabis X 动态 · X | dn-x-demishassabis-3cb75cfee9c0 | https://x.com/demishassabis | 未启用：令牌缺失、开关关闭 |
| Derrick Choi X 动态 · X | dn-x-derrickcchoi-5fbf7899a5f7 | https://x.com/derrickcchoi | 未启用：令牌缺失、开关关闭 |
| Fei-Fei Li（李飞飞） X 动态 · X | dn-x-drfeifei-0dbf50caaa26 | https://x.com/drfeifei | 未启用：令牌缺失、开关关闭 |
| DW News X 动态 · X | dn-x-dwnews-bc8cfe7833c0 | https://x.com/dwnews | 未启用：令牌缺失、开关关闭 |
| European Central Bank X 动态 · X | dn-x-ecb-16dd172fb320 | https://x.com/ecb | 未启用：令牌缺失、开关关闭 |
| Elon Musk X 动态 · X | dn-x-elonmusk-31272669e3e9 | https://x.com/elonmusk | 未启用：令牌缺失、开关关闭 |
| ESA X 动态 · X | dn-x-esa-2f31f22a05a9 | https://x.com/esa | 未启用：令牌缺失、开关关闭 |
| European Commission X 动态 · X | dn-x-eu_commission-83b232594256 | https://x.com/EU_Commission | 未启用：令牌缺失、开关关闭 |
| Formula 1 X 动态 · X | dn-x-f1-d149d3c24fd5 | https://x.com/F1 | 未启用：令牌缺失、开关关闭 |
| Fabrizio Romano X 动态 · X | dn-x-fabrizioromano-877b992324d1 | https://x.com/FabrizioRomano | 未启用：令牌缺失、开关关闭 |
| François Chollet X 动态 · X | dn-x-fchollet-1587dc77b452 | https://x.com/fchollet | 未启用：令牌缺失、开关关闭 |
| Federal Reserve X 动态 · X | dn-x-federalreserve-114840cacdc0 | https://x.com/federalreserve | 未启用：令牌缺失、开关关闭 |
| FIBA X 动态 · X | dn-x-fiba-9e278d5aeeaa | https://x.com/FIBA | 未启用：令牌缺失、开关关闭 |
| FIFA X 动态 · X | dn-x-fifacom-f9c74299058d | https://x.com/FIFAcom | 未启用：令牌缺失、开关关闭 |
| Google AI X 动态 · X | dn-x-googleai-7ace2f4ebdc8 | https://x.com/GoogleAI | 未启用：令牌缺失、开关关闭 |
| Greg Brockman X · X | dn-x-greg-brockman-58dcd2c0fc59 | https://x.com/gdb | 未启用：令牌缺失、开关关闭 |
| Hugging Face X 动态 · X | dn-x-huggingface-e13b0cc4521d | https://x.com/huggingface | 未启用：令牌缺失、开关关闭 |
| IMF X 动态 · X | dn-x-imfnews-16c8efdd8f0a | https://x.com/IMFNews | 未启用：令牌缺失、开关关闭 |
| Junyang Lin（林俊旸） X 动态 · X | dn-x-justinlin610-be393bb20206 | https://x.com/JustinLin610 | 未启用：令牌缺失、开关关闭 |
| Andrej Karpathy X · X | dn-x-karpathy-efa490ef4d4e | https://x.com/karpathy | 未启用：令牌缺失、开关关闭 |
| 数字生命卡兹克 X 动态 · X | dn-x-khazix0918-f9e4afb9b5a7 | https://x.com/Khazix0918 | 未启用：令牌缺失、开关关闭 |
| Microsoft AI X 动态 · X | dn-x-microsoftai-2855427b4e80 | https://x.com/MicrosoftAI | 未启用：令牌缺失、开关关闭 |
| NASA X 动态 · X | dn-x-nasa-53a9f9f4a956 | https://x.com/NASA | 未启用：令牌缺失、开关关闭 |
| Nature X 动态 · X | dn-x-nature-aa40b182c1a9 | https://x.com/nature | 未启用：令牌缺失、开关关闭 |
| NBA X 动态 · X | dn-x-nba-36e074bd218e | https://x.com/NBA | 未启用：令牌缺失、开关关闭 |
| NVIDIA AI X 动态 · X | dn-x-nvidiaai-55a4a990d217 | https://x.com/NVIDIAAI | 未启用：令牌缺失、开关关闭 |
| Olympics X 动态 · X | dn-x-olympics-e0995d200787 | https://x.com/Olympics | 未启用：令牌缺失、开关关闭 |
| OpenAI X · X | dn-x-openai-eb5a42503b9f | https://x.com/OpenAI | 未启用：令牌缺失、开关关闭 |
| Noam Brown X 动态 · X | dn-x-polynoamial-ad7208c577b4 | https://x.com/polynoamial | 未启用：令牌缺失、开关关闭 |
| Sam Altman X · X | dn-x-sam-altman-56eecd019f34 | https://x.com/sama | 未启用：令牌缺失、开关关闭 |
| Science Magazine X 动态 · X | dn-x-sciencemagazine-ebfbe9a69ce7 | https://x.com/sciencemagazine | 未启用：令牌缺失、开关关闭 |
| Science News X 动态 · X | dn-x-sciencenews-1f40ee053ba3 | https://x.com/ScienceNews | 未启用：令牌缺失、开关关闭 |
| Shams Charania · X | dn-x-shams-0f36ea0e17d0 | https://x.com/ShamsCharania | 未启用：令牌缺失、开关关闭 |
| The Hollywood Reporter X 动态 · X | dn-x-thr-1b153ac613d2 | https://x.com/THR | 未启用：令牌缺失、开关关闭 |
| Tibo（Thibault Sottiaux） X 动态 · X | dn-x-thsottiaux-f0176ed83f5c | https://x.com/thsottiaux | 未启用：令牌缺失、开关关闭 |
| tianyi X 动态 · X | dn-x-tianyi-991a892879b9 | https://x.com/tianyi | 未启用：令牌缺失、开关关闭 |
| UN News X 动态 · X | dn-x-un_news_centre-71d665cbe1b6 | https://x.com/UN_News_Centre | 未启用：令牌缺失、开关关闭 |
| Variety X 动态 · X | dn-x-variety-ea9715befc97 | https://x.com/Variety | 未启用：令牌缺失、开关关闭 |
| WHO X 动态 · X | dn-x-who-6604430370e6 | https://x.com/WHO | 未启用：令牌缺失、开关关闭 |
| World Athletics X 动态 · X | dn-x-worldathletics-28ec29772b5b | https://x.com/WorldAthletics | 未启用：令牌缺失、开关关闭 |
| World Bank X 动态 · X | dn-x-worldbank-340570c2776a | https://x.com/WorldBank | 未启用：令牌缺失、开关关闭 |
| WTA X 动态 · X | dn-x-wta-549526cda2c8 | https://x.com/WTA | 未启用：令牌缺失、开关关闭 |
| 新华网 X 动态 · X | dn-x-xhnews-0b2079c8e72c | https://x.com/XHNews | 未启用：令牌缺失、开关关闭 |
| Yann LeCun X 动态 · X | dn-x-ylecun-71badb0407d9 | https://x.com/ylecun | 未启用：令牌缺失、开关关闭 |
| Z.ai X 动态 · X | dn-x-zai_org-ddb0106bf8fd | https://x.com/Zai_org | 未启用：令牌缺失、开关关闭 |
| Zixuan Li X 动态 · X | dn-x-zixuanli_-61ce17c0d49b | https://x.com/ZixuanLi_ | 未启用：令牌缺失、开关关闭 |

## 原禁用14项

这些来源的禁用决定沿用原配置；五个网页来源因原文访问或付费墙不可靠，九个X来源因来源可验证性尚未确认。未因本轮可访问性调查擅自启用。

| 来源与栏目 | 稳定ID | 原入口 | 保留的禁用原因 |
| --- | --- | --- | --- |
| Bloomberg · Markets | dn-bloomberg-48e93eec3e0c | https://www.bloomberg.com/markets | 旧站禁用：原文访问或付费墙不可靠 |
| Financial Times · World | dn-ft-29cce1739224 | https://www.ft.com/world | 旧站禁用：原文访问或付费墙不可靠 |
| Reuters · World | dn-reuters-8845b58dfce8 | https://www.reuters.com/world/ | 旧站禁用：原文访问或付费墙不可靠 |
| The Athletic NBA · NBA | dn-the-athletic-nba-15f14e488eba | https://www.nytimes.com/athletic/nba/ | 旧站禁用：原文访问或付费墙不可靠 |
| Wall Street Journal · World | dn-wsj-3c4b0a6b3315 | https://www.wsj.com/news/world | 旧站禁用：原文访问或付费墙不可靠 |
| Grok X 动态 · X | dn-x-grok-767dc1b56845 | https://x.com/grok | 旧站禁用：来源可验证性尚未确认 |
| Guodong Zhang（张国栋） X 动态 · X | dn-x-guodzh-70b6debb0e42 | https://x.com/Guodzh | 旧站禁用：来源可验证性尚未确认 |
| Igor Babuschkin X 动态 · X | dn-x-ibab-d946f114adda | https://x.com/ibab | 旧站禁用：来源可验证性尚未确认 |
| Jimmy Ba X 动态 · X | dn-x-jimmybajimmyba-c06555d443e7 | https://x.com/jimmybajimmyba | 旧站禁用：来源可验证性尚未确认 |
| xAI（官网当前社交入口） X 动态 · X | dn-x-spacexai-d4d65538e710 | https://x.com/SpaceXAI | 旧站禁用：来源可验证性尚未确认 |
| Greg Yang X 动态 · X | dn-x-thegregyang-563f6a150bf9 | https://x.com/TheGregYang | 旧站禁用：来源可验证性尚未确认 |
| Toby Pohlen X 动态 · X | dn-x-tobyphln-f4aabeb57487 | https://x.com/TobyPhln | 旧站禁用：来源可验证性尚未确认 |
| Yuhuai (Tony) Wu X 动态 · X | dn-x-yuhu_ai_-1e1be309b2f2 | https://x.com/Yuhu_ai_ | 旧站禁用：来源可验证性尚未确认 |
| Zihang Dai X 动态 · X | dn-x-zihangdai-db345ba157d5 | https://x.com/ZihangDai | 旧站禁用：来源可验证性尚未确认 |

## 修复、验证和运行边界

- 实际配置：`.data/source-restoration/source-snapshot.json`；文章公开口径及处理状态：`.data/source-restoration/current-snapshot.json`。
- 三组逐项调查：`.data/source-restoration/china/results.json`、`.data/source-restoration/world/results.json`、`.data/source-restoration/institutions-sports/results.json`；最后实际启用状态以配置快照覆盖早期调查状态。例如雅虎NBA已通过后续窄正文修复并启用，不能继续引用早期 parse_gap。
- 恢复配置保持原 source ID、allowedHosts、allowedPathPrefixes 和原禁用决定；仅调整已验证的公开入口、列表形状、日期解析或明确材料范围。
- 最终84项完整刷新：`.data/source-restoration/final-round-evidence.json`；中断修复审计：`interrupted-run-reconciled.json`；严格发布日期验证后的84/84结果：本机数据目录 `local-quality/sources-all-1791658711572.json`。
- 正文修复：保留 `no-sidebar` / `article-with-sidebar` 等实际文章布局，仍清除真实侧栏；精确还原雅虎公开HTML中的自身文章片段及红星公开加载模板，不执行网页脚本。web_list只协商HTML，避免红星返回JSON编码HTML造成空列表；支持界面新闻明确标注的epoch发布时间。
- worker中断：未保存采集材料的任务记为中断失败并释放本次来源锁，不增加源站失败计数；已有持久采集材料则保留恢复能力。独立子进程回归覆盖这两种情况。
- 信源验证必须有可信发布时间，权威详情日期缺失时不借列表日期通过。原域名、路径、身份、首导范围和禁用决定均保留。
- 全新隔离 `_ci` 库完整后端测试818/818通过；随后新增日期证据门槛测试，相关4/4通过。另39个网页测试、类型检查、构建、31项smoke通过；最新PR头仍需以CI实际状态为准。
- 40个现有任务快照及22条既有答案修订逐条hash核对一致，首批20个任务已完成、第二批20个待标注。未把模型结果或自动测试答案写成人工答案。
- 19:00 UTC一致性备份包含619篇文章、40个标注任务和22条答案修订，已恢复到独立 `_test` 库，计数及约束一致。备份为本机 `backups/dailynews-quality-20261010T190013568.dump`，验证记录为 `.data/local-quality/backup-restore.json`；正文缓存等外部文件不在数据库快照范围内。
- 当前worker运行产品提交 `73fe378`；web/API继续运行 `f29159c`，本轮未改前台或标注API，因此没有重启用户正在使用的页面服务。工作目录仍为独立实施worktree，PR #22保持开放，未合并或部署云端。
- 服务继续按原轮询周期采集。100条正常新增、真实北京时间08:00日报及200条人工验收仍未完成；电脑睡眠或停机期间不保证覆盖。
