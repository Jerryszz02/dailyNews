# 固定基准

- AIHOT：`3343fe2b20db4be7269113752d82d3992fc52b6b`（[上游](https://github.com/KKKKhazix/AIHOT/tree/3343fe2b20db4be7269113752d82d3992fc52b6b)）。`aihot.json` 记录 549 个导入文件的原始 SHA-256，不是改造后文件的当前校验值；保留根 LICENSE / NOTICE。不自动同步上游。
- Daily News：`8519831714b0d6c8183336c81e8190dceddf7843`，文档交接提交 `ce3f9263c3901839a85794aecea8bc55e67bf0e4`。`daily-news-v1.json` 记录 111 个旧文件校验值；旧根依赖保存在 `legacy-package*.json`，源码仍保留在原路径。需要旧运行环境时从该 Git commit 创建独立 checkout，不覆盖当前环境。
- `aihot-rules/` 是原始 AI prompts、taxonomy 和 selection 的冻结副本。实际 Daily News 分类与策略变化应有独立版本，不能改写此基准。
- `legacy-sources.json` 从旧基准 `newsSources` 静态导出：169 个来源、187 个栏目、155 个 enabled。旧栏目无 ID，此清单用 `[name,url,primaryCategory]` 的 SHA-256 前 12 位派生稳定 sectionId。历史候选没有栏目字段，不虚构回溯对应关系。

本目录不含环境变量值、数据库导出、实时新闻或付费调用回执。`public/daily-news.json` 是历史 fallback，不能作为新系统实时数据。
