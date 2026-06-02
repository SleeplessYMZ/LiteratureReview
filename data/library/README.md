# Monthly Library

本目录保存从 24 本目标期刊中自动筛选出的月度候选文献。

## 筛选规则

文章标题和 Crossref 摘要必须同时命中以下三个关键词大类：

1. 社会与自然环境
2. 居民健康
3. 地理学相关方法

如果 Crossref 没有提供摘要，则仅根据标题判断。CSV 中的 `abstract_available` 字段会标明摘要是否可用于筛选。

月度 CSV 仅保存文章元数据、DOI、命中的主题和关键词，不保存完整摘要。自动筛选结果仍需人工复核。

## 更新方式

默认抓取从 2026 年 1 月至上一个完整月份的数据：

```bash
node scripts/fetch-crossref.mjs
```

也可以指定月份范围：

```bash
node scripts/fetch-crossref.mjs --from 2026-01 --to 2026-05
```

`scripts/fetch_monthly_library.rb` 是同一流程的 Ruby 版本，可作为备用脚本。
