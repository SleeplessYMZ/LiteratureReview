#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const JOURNALS_PATH = path.join(ROOT, "config", "journals.yml");
const KEYWORDS_PATH = path.join(ROOT, "config", "keywords.yml");
const LIBRARY_DIR = path.join(ROOT, "data", "library");
const INDEX_PATH = path.join(LIBRARY_DIR, "index.csv");
const USER_AGENT = process.env.CROSSREF_USER_AGENT || "LiteratureReview/1.0 (mailto:research@example.com)";
const REQUIRED_GROUPS = ["social_and_natural_environment", "resident_health", "geographical_methods"];
const CSV_HEADERS = [
  "month",
  "journal_category",
  "journal",
  "journal_short_name",
  "issn",
  "title",
  "publication_date",
  "date_basis",
  "doi",
  "doi_url",
  "abstract_available",
  "social_and_natural_environment_topics",
  "social_and_natural_environment_keywords",
  "resident_health_topics",
  "resident_health_keywords",
  "geographical_methods_topics",
  "geographical_methods_keywords",
  "screening_rule",
];

function usage() {
  return `Usage: node scripts/fetch-crossref.mjs [options]

Options:
  --from YYYY-MM   First month to fetch (default: 2026-01)
  --to YYYY-MM     Last month to fetch (default: previous complete month)
  --help           Show this help text
`;
}

function parseArgs(argv) {
  const options = { from: "2026-01", to: previousCompleteMonth() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--from" || arg === "--to") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires YYYY-MM`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function previousCompleteMonth() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // previous month in 1-based terms
  const previous = new Date(Date.UTC(year, month - 1, 1));
  return formatMonth(previous);
}

function parseMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error(`Invalid month ${value}; expected YYYY-MM`);
  const [year, month] = value.split("-").map(Number);
  if (month < 1 || month > 12) throw new Error(`Invalid month ${value}; month must be 01-12`);
  return new Date(Date.UTC(year, month - 1, 1));
}

function formatMonth(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function nextMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function monthEnd(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function parseYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseJournalsYaml(text) {
  const journals = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const category = line.match(/^  - category:\s*(.+)$/);
    if (category) {
      current = { category: parseYamlScalar(category[1]) };
      journals.push(current);
      continue;
    }

    const field = line.match(/^    (name|short_name|issn):\s*(.+)$/);
    if (field && current) current[field[1]] = parseYamlScalar(field[2]);
  }

  const missing = journals.filter((journal) => !journal.category || !journal.name || !journal.short_name || !journal.issn);
  if (missing.length) throw new Error(`Invalid journals.yml: ${missing.length} incomplete journal entries`);
  return journals;
}

function parseKeywordsYaml(text) {
  const groups = [];
  let currentGroup = null;
  let currentTopic = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const groupId = line.match(/^  - id:\s*(.+)$/);
    if (groupId) {
      currentGroup = { id: parseYamlScalar(groupId[1]), name: "", topics: [] };
      groups.push(currentGroup);
      currentTopic = null;
      continue;
    }

    const groupName = line.match(/^    name:\s*(.+)$/);
    if (groupName && currentGroup && !currentTopic) {
      currentGroup.name = parseYamlScalar(groupName[1]);
      continue;
    }

    const topicId = line.match(/^      - id:\s*(.+)$/);
    if (topicId) {
      if (!currentGroup) throw new Error("Invalid keywords.yml: topic without keyword group");
      currentTopic = { id: parseYamlScalar(topicId[1]), name: "", keywords: [] };
      currentGroup.topics.push(currentTopic);
      continue;
    }

    const topicName = line.match(/^        name:\s*(.+)$/);
    if (topicName && currentTopic) {
      currentTopic.name = parseYamlScalar(topicName[1]);
      continue;
    }

    const keyword = line.match(/^          -\s*(.+)$/);
    if (keyword && currentTopic) currentTopic.keywords.push(parseYamlScalar(keyword[1]));
  }

  const configured = new Set(groups.map((group) => group.id));
  const missing = REQUIRED_GROUPS.filter((groupId) => !configured.has(groupId));
  if (missing.length) throw new Error(`Missing keyword groups: ${missing.join(", ")}`);
  return groups;
}

function decodeHtml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)));
}

function cleanText(value) {
  return decodeHtml(String(value || ""))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dateParts(value) {
  const parts = value?.["date-parts"]?.[0];
  if (!parts?.length) return "";
  const [year, month = 1, day = 1] = parts;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthDateBasis(item, startDate, endDate, allowCreatedProxy) {
  const start = formatDate(startDate);
  const end = formatDate(endDate);
  const candidates = [
    ["published-online", dateParts(item["published-online"])],
    ["published", dateParts(item.published)],
    ["issued", dateParts(item.issued)],
    ["published-print", dateParts(item["published-print"])],
  ];
  const direct = candidates.find(([, date]) => date && date >= start && date <= end);
  if (direct) return { dateBasis: direct[0], publicationDate: direct[1] };

  const created = dateParts(item.created);
  if (allowCreatedProxy && created && created >= start && created <= end) {
    return { dateBasis: "created-proxy", publicationDate: created };
  }
  return null;
}

function isEnglishKeyword(keyword) {
  return /^[\x00-\x7F]+$/.test(keyword);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordMatches(text, keyword) {
  const escaped = escapeRegex(keyword.toLowerCase());
  if (isEnglishKeyword(keyword) && /^[a-z0-9_.+-]+$/i.test(keyword)) {
    return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, "i").test(text);
  }
  return new RegExp(escaped, "i").test(text);
}

function matchedGroups(text, keywordGroups) {
  const result = {};
  for (const group of keywordGroups) {
    result[group.id] = [];
    for (const topic of group.topics) {
      const matches = topic.keywords.filter((keyword) => keywordMatches(text, keyword));
      if (!matches.length) continue;
      result[group.id].push({
        id: topic.id,
        name: topic.name,
        keywords: [...new Set(matches)],
      });
    }
  }
  return result;
}

function joinTopicNames(topics) {
  return topics.map((topic) => topic.name).join(" | ");
}

function joinKeywords(topics) {
  return [...new Set(topics.flatMap((topic) => topic.keywords))].join(" | ");
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

async function writeCsv(filePath, headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function retryableFetchJson(url, attempts = 4) {
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (response.status === 429 || response.status >= 500) {
      throw new Error(`Crossref returned ${response.status}: ${url}`);
    }
    if (!response.ok) {
      throw new Error(`Crossref returned ${response.status}: ${url}\n${await response.text()}`);
    }
    return response.json();
  } catch (error) {
    if (attempts <= 1) throw error;
    console.warn(`Retrying after error: ${error.message}`);
    await sleep(1000 + (4 - attempts) * 1500);
    return retryableFetchJson(url, attempts - 1);
  }
}

async function fetchItems(issn, filter) {
  const items = [];
  let cursor = "*";
  let pageCount = 0;

  while (cursor) {
    pageCount += 1;
    if (pageCount > 50) throw new Error(`Crossref pagination exceeded 50 pages for ${issn} with ${filter}`);
    const params = new URLSearchParams({
      filter,
      rows: "1000",
      cursor,
      select: "DOI,title,abstract,type,published-online,published-print,published,issued,created,URL,volume,issue,page",
    });
    const payload = await retryableFetchJson(`https://api.crossref.org/journals/${issn}/works?${params}`);
    const message = payload.message;
    const pageItems = message.items || [];
    items.push(...pageItems);
    if (items.length >= (message["total-results"] || 0) || pageItems.length === 0) break;
    cursor = message["next-cursor"];
    await sleep(80);
  }

  return items;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fromDate = parseMonth(options.from);
  const toDate = parseMonth(options.to);
  if (toDate < fromDate) throw new Error("--to must not be earlier than --from");

  const journals = parseJournalsYaml(await fs.readFile(JOURNALS_PATH, "utf8"));
  const keywordGroups = parseKeywordsYaml(await fs.readFile(KEYWORDS_PATH, "utf8"));
  await fs.mkdir(LIBRARY_DIR, { recursive: true });

  const summaries = [];
  for (let date = fromDate; date <= toDate; date = nextMonth(date)) {
    const month = formatMonth(date);
    const endDate = monthEnd(date);
    const works = new Map();
    console.log(`Fetching ${month}...`);

    for (const [index, journal] of journals.entries()) {
      const filters = [
        `from-online-pub-date:${formatDate(date)},until-online-pub-date:${formatDate(endDate)},type:journal-article`,
        `from-pub-date:${formatDate(date)},until-pub-date:${formatDate(endDate)},type:journal-article`,
        `from-created-date:${formatDate(date)},until-created-date:${formatDate(endDate)},type:journal-article`,
      ];

      for (const filter of filters) {
        const allowCreatedProxy = filter.startsWith("from-created-date:");
        for (const item of await fetchItems(journal.issn, filter)) {
          if (item.type !== "journal-article") continue;
          const basis = monthDateBasis(item, date, endDate, allowCreatedProxy);
          if (!basis) continue;

          const doi = cleanText(item.DOI).toLowerCase();
          if (!doi) continue;

          const title = cleanText(item.title?.[0]);
          const abstract = cleanText(item.abstract);
          const text = `${title} ${abstract}`.toLowerCase();
          const groups = matchedGroups(text, keywordGroups);
          if (!REQUIRED_GROUPS.every((groupId) => groups[groupId]?.length)) continue;

          const environmentTopics = groups.social_and_natural_environment;
          const healthTopics = groups.resident_health;
          const methodTopics = groups.geographical_methods;
          works.set(doi, [
            month,
            journal.category,
            journal.name,
            journal.short_name,
            journal.issn,
            title,
            basis.publicationDate,
            basis.dateBasis,
            doi,
            `https://doi.org/${doi}`,
            abstract ? "yes" : "no",
            joinTopicNames(environmentTopics),
            joinKeywords(environmentTopics),
            joinTopicNames(healthTopics),
            joinKeywords(healthTopics),
            joinTopicNames(methodTopics),
            joinKeywords(methodTopics),
            "Must match all 3 keyword groups in Crossref title or abstract",
          ]);
        }
      }

      console.log(`  ${String(index + 1).padStart(2, "0")}/${journals.length} ${journal.short_name.padEnd(28)} candidates=${works.size}`);
      await sleep(80);
    }

    const rows = [...works.values()].sort((a, b) => {
      const left = `${a[2]}|${a[6]}|${a[5]}`;
      const right = `${b[2]}|${b[6]}|${b[5]}`;
      return left.localeCompare(right);
    });
    const outputPath = path.join(LIBRARY_DIR, `${month}.csv`);
    await writeCsv(outputPath, CSV_HEADERS, rows);
    summaries.push([month, rows.length, new Date().toISOString()]);
    console.log(`Wrote ${rows.length} candidates to ${outputPath}`);
  }

  await writeCsv(INDEX_PATH, ["month", "matched_articles", "generated_at"], summaries);
  console.log(`Wrote index to ${INDEX_PATH}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
