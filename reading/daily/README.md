# Daily Reading

本目录用于保存每日精读包。每个日期一个文件夹，例如：

```text
reading/daily/2026-06-02/README.md
```

每日精读包由以下命令生成：

```bash
node scripts/prepare-daily-reading.mjs --count 3 --download-open-access
```

脚本会从 `data/library/*.csv` 中选择尚未推送过的候选文献，优先推荐与居民健康更直接相关的文章，并尝试通过 OpenAlex 获取开放获取全文链接。自动 PDF 下载仅限开放获取 PDF；付费或受版权保护的全文不会被自动下载。
