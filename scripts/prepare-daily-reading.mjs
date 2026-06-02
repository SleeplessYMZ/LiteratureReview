#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LIBRARY_DIR = path.join(ROOT, "data", "library");
const STATE_PATH = path.join(ROOT, "data", "reading", "daily-state.json");
const DAILY_DIR = path.join(ROOT, "reading", "daily");
const USER_AGENT = process.env.OPENALEX_USER_AGENT || "LiteratureReview/1.0 (mailto:research@example.com)";

function usage() {
  return `Usage: node scripts/prepare-daily-reading.mjs [options]

Options:
  --count N                 Number of papers to select (default: 3)
  --date YYYY-MM-DD         Reading-pack date (default: today, local time)
  --download-open-access    Download OA PDFs when OpenAlex exposes a PDF URL
  --dry-run                 Print selected papers without writing files
  --help                    Show this help text
`;
}

function parseArgs(argv) {
  const options = {
    count: 3,
    date: localDateString(new Date()),
    downloadOpenAccess: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--download-open-access") {
      options.downloadOpenAccess = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--count") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error("--count must be an integer from 1 to 10");
      options.count = value;
      index += 1;
      continue;
    }
    if (arg === "--date") {
      const value = argv[index + 1];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("--date must be YYYY-MM-DD");
      options.date = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows
    .filter((values) => values.some((value) => value.length))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

async function loadLibrary() {
  const entries = await fs.readdir(LIBRARY_DIR, { withFileTypes: true });
  const csvFiles = entries
    .filter((entry) => entry.isFile() && /^20\d{2}-\d{2}\.csv$/.test(entry.name))
    .map((entry) => path.join(LIBRARY_DIR, entry.name))
    .sort();

  const papers = [];
  for (const file of csvFiles) {
    const text = await fs.readFile(file, "utf8");
    papers.push(...parseCsv(text));
  }

  const byDoi = new Map();
  for (const paper of papers) {
    if (!paper.doi) continue;
    const existing = byDoi.get(paper.doi);
    if (!existing || paper.month < existing.month) byDoi.set(paper.doi, paper);
  }
  return [...byDoi.values()];
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
  } catch {
    return { deliveredDois: [], deliveries: [] };
  }
}

function scorePaper(paper) {
  let score = 0;
  const text = [
    paper.journal_short_name,
    paper.journal,
    paper.title,
    paper.resident_health_keywords,
    paper.social_and_natural_environment_keywords,
    paper.geographical_methods_keywords,
  ].join(" ").toLowerCase();

  if (/epidemiology|international journal of epidemiology|lancet|environmental health perspectives/.test(text)) score += 8;
  if (/urban studies|landscape and urban planning|pnas/.test(text)) score += 5;
  if (/remote sensing/.test(text)) score -= 2;

  if (/mortality|vaccination|cognitive aging|well-being|physical activity|public health|human health|health risk/.test(text)) score += 6;
  if (/income|poverty|education|housing|neighborhood|green space|air pollution|water pollution|drinking water|nighttime lighting|artificial light/.test(text)) score += 5;
  if (/causal inference|natural experiment|longitudinal study|spatial analysis|geospatial/.test(text)) score += 3;

  // Keep broad keywords, but rank papers that only hit ecological/agricultural senses lower.
  if (/leaf mass|crop|wheat|corn|cotton|avian|mangrove|shrub|savanna|litterfall|soil organic carbon/.test(text)) score -= 6;
  return score;
}

function selectPapers(papers, state, count) {
  const delivered = new Set(state.deliveredDois || []);
  return papers
    .filter((paper) => !delivered.has(paper.doi))
    .map((paper) => ({ ...paper, priority_score: scorePaper(paper) }))
    .sort((a, b) => b.priority_score - a.priority_score || a.month.localeCompare(b.month) || a.title.localeCompare(b.title))
    .slice(0, count);
}

async function fetchOpenAlex(doi) {
  const url = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`;
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) return null;
    const work = await response.json();
    const primary = work.primary_location || {};
    const best = work.best_oa_location || {};
    return {
      isOpenAccess: Boolean(work.open_access?.is_oa),
      oaStatus: work.open_access?.oa_status || "",
      landingPageUrl: best.landing_page_url || primary.landing_page_url || "",
      pdfUrl: best.pdf_url || primary.pdf_url || "",
      openAlexUrl: work.id || "",
    };
  } catch {
    return null;
  }
}

function safeFileName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

async function downloadPdf(url, destination) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`PDF download failed ${response.status}: ${url}`);
  const contentType = response.headers.get("content-type") || "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!contentType.includes("pdf") && bytes.length < 1000) {
    throw new Error(`Downloaded content does not look like a PDF: ${url}`);
  }
  await fs.writeFile(destination, bytes);
}

function markdownForPaper(paper, oa, pdfPath) {
  const lines = [
    `### ${paper.title}`,
    "",
    `- 期刊：${paper.journal}`,
    `- 月份：${paper.month}`,
    `- 发表日期：${paper.publication_date} (${paper.date_basis})`,
    `- DOI：<${paper.doi_url}>`,
    `- 相关性评分：${paper.priority_score}`,
    `- 社会与自然环境：${paper.social_and_natural_environment_topics} (${paper.social_and_natural_environment_keywords})`,
    `- 居民健康：${paper.resident_health_topics} (${paper.resident_health_keywords})`,
    `- 地理学方法：${paper.geographical_methods_topics} (${paper.geographical_methods_keywords})`,
    `- 摘要可用：${paper.abstract_available}`,
  ];

  if (oa) {
    lines.push(`- 开放获取状态：${oa.isOpenAccess ? `是 (${oa.oaStatus || "unknown"})` : "未确认"}`);
    if (oa.landingPageUrl) lines.push(`- 全文页：<${oa.landingPageUrl}>`);
    if (oa.pdfUrl) lines.push(`- OA PDF：<${oa.pdfUrl}>`);
    if (oa.openAlexUrl) lines.push(`- OpenAlex：<${oa.openAlexUrl}>`);
  } else {
    lines.push("- 开放获取状态：未能从 OpenAlex 确认");
  }

  if (pdfPath) lines.push(`- 已下载开放获取 PDF：${pdfPath}`);

  lines.push(
    "",
    "精读提示：",
    "",
    "1. 这篇文章的核心研究问题是什么？",
    "2. 它如何定义社会/自然环境暴露？",
    "3. 它测量了哪些居民健康结果或健康行为？",
    "4. 它使用的地理学方法是否可复用到你的研究？",
    "5. 主要局限是什么，是否存在因果解释风险？",
    ""
  );
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const papers = await loadLibrary();
  const state = await loadState();
  const selected = selectPapers(papers, state, options.count);

  if (!selected.length) {
    console.log("No unread papers left in data/library.");
    return;
  }

  if (options.dryRun) {
    for (const paper of selected) {
      console.log(`${paper.priority_score}\t${paper.doi}\t${paper.title}`);
    }
    return;
  }

  const outputDir = path.join(DAILY_DIR, options.date);
  const pdfDir = path.join(outputDir, "pdfs");
  await fs.mkdir(pdfDir, { recursive: true });

  const sections = [];
  const deliveredToday = [];
  for (const paper of selected) {
    const oa = await fetchOpenAlex(paper.doi);
    let downloadedPdfPath = "";
    if (options.downloadOpenAccess && oa?.isOpenAccess && oa.pdfUrl) {
      const pdfName = `${safeFileName(paper.doi)}.pdf`;
      const pdfPath = path.join(pdfDir, pdfName);
      try {
        await downloadPdf(oa.pdfUrl, pdfPath);
        downloadedPdfPath = path.relative(ROOT, pdfPath);
      } catch (error) {
        downloadedPdfPath = `下载失败：${error.message}`;
      }
    }
    sections.push(markdownForPaper(paper, oa, downloadedPdfPath));
    deliveredToday.push(paper.doi);
  }

  const markdown = [
    `# ${options.date} 每日精读包`,
    "",
    "本文件由 `scripts/prepare-daily-reading.mjs` 生成。全文获取遵循版权限制：自动下载仅限 OpenAlex 标记为开放获取且提供 PDF URL 的文章；其他文章提供 DOI 或全文页链接，需通过合法渠道访问。",
    "",
    `今日推荐：${selected.length} 篇`,
    "",
    ...sections,
  ].join("\n");

  await fs.writeFile(path.join(outputDir, "README.md"), markdown, "utf8");
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  const nextState = {
    deliveredDois: [...new Set([...(state.deliveredDois || []), ...deliveredToday])],
    deliveries: [
      ...(state.deliveries || []),
      { date: options.date, dois: deliveredToday, generatedAt: new Date().toISOString() },
    ],
  };
  await fs.writeFile(STATE_PATH, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.join(outputDir, "README.md")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
