#!/usr/bin/env ruby

require "cgi"
require "csv"
require "date"
require "fileutils"
require "json"
require "net/http"
require "optparse"
require "time"
require "uri"
require "yaml"

$stdout.sync = true

ROOT = File.expand_path("..", __dir__)
JOURNALS_PATH = File.join(ROOT, "config", "journals.yml")
KEYWORDS_PATH = File.join(ROOT, "config", "keywords.yml")
LIBRARY_DIR = File.join(ROOT, "data", "library")
INDEX_PATH = File.join(LIBRARY_DIR, "index.csv")
USER_AGENT = ENV.fetch("CROSSREF_USER_AGENT", "LiteratureReview/1.0 (mailto:research@example.com)")

def month_start(value)
  Date.strptime("#{value}-01", "%Y-%m-%d")
rescue Date::Error
  raise OptionParser::InvalidArgument, "invalid month: #{value.inspect}; expected YYYY-MM"
end

def next_month(date)
  date.next_month
end

def month_end(date)
  next_month(date) - 1
end

def date_parts(value)
  parts = value&.dig("date-parts", 0)
  return nil if parts.nil? || parts.empty?

  Date.new(parts[0], parts[1] || 1, parts[2] || 1)
rescue Date::Error
  nil
end

def clean_text(value)
  CGI.unescapeHTML(value.to_s.gsub(/<[^>]+>/, " ").gsub(/\s+/, " ").strip)
end

def month_date_basis(item, start_date, end_date, allow_created_proxy:)
  candidates = [
    ["published-online", date_parts(item["published-online"])],
    ["published", date_parts(item["published"])],
    ["issued", date_parts(item["issued"])],
    ["published-print", date_parts(item["published-print"])],
  ]
  direct = candidates.find { |_, date| date && date >= start_date && date <= end_date }
  return direct if direct

  created = date_parts(item["created"])
  return ["created-proxy", created] if allow_created_proxy && created && created >= start_date && created <= end_date

  nil
end

def retryable_get(uri, attempts: 4)
  request = Net::HTTP::Get.new(uri)
  request["User-Agent"] = USER_AGENT

  response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https", open_timeout: 15, read_timeout: 45) do |http|
    http.request(request)
  end

  if response.code.to_i >= 500 || response.code.to_i == 429
    raise "Crossref returned #{response.code}: #{uri}"
  end
  raise "Crossref returned #{response.code}: #{uri}\n#{response.body}" unless response.is_a?(Net::HTTPSuccess)

  JSON.parse(response.body)
rescue StandardError => error
  raise if attempts <= 1

  warn "Retrying after error: #{error.message}"
  sleep(1.0 + (4 - attempts) * 1.5)
  retryable_get(uri, attempts: attempts - 1)
end

def fetch_items(issn, filter)
  items = []
  cursor = "*"
  page_count = 0

  loop do
    page_count += 1
    raise "Crossref pagination exceeded 50 pages for #{issn} with #{filter}" if page_count > 50

    uri = URI("https://api.crossref.org/journals/#{issn}/works")
    uri.query = URI.encode_www_form(
      filter: filter,
      rows: 1000,
      cursor: cursor,
      select: "DOI,title,abstract,type,published-online,published-print,published,issued,created,URL,volume,issue,page"
    )
    payload = retryable_get(uri)
    message = payload.fetch("message")
    page_items = message.fetch("items", [])
    items.concat(page_items)
    break if items.length >= message.fetch("total-results", 0) || page_items.empty?

    cursor = message.fetch("next-cursor")
    sleep(0.08)
  end

  items
end

def english_keyword?(keyword)
  keyword.match?(/\A[\x00-\x7F]+\z/)
end

def keyword_match?(text, keyword)
  escaped = Regexp.escape(keyword.downcase)
  expression =
    if english_keyword?(keyword) && keyword.match?(/\A[[:alnum:]_.+-]+\z/)
      /(?<![[:alnum:]_])#{escaped}(?![[:alnum:]_])/i
    else
      /#{escaped}/i
    end
  text.match?(expression)
end

def matched_groups(text, keyword_groups)
  keyword_groups.to_h do |group|
    topics = group.fetch("topics").each_with_object([]) do |topic, matches_by_topic|
      matches = topic.fetch("keywords").select { |keyword| keyword_match?(text, keyword) }
      next if matches.empty?

      matches_by_topic << {
        "id" => topic.fetch("id"),
        "name" => topic.fetch("name"),
        "keywords" => matches.uniq,
      }
    end
    [group.fetch("id"), topics]
  end
end

def join_topic_names(topics)
  topics.map { |topic| topic.fetch("name") }.join(" | ")
end

def join_keywords(topics)
  topics.flat_map { |topic| topic.fetch("keywords") }.uniq.join(" | ")
end

def csv_headers
  [
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
  ]
end

def write_month_csv(month, rows)
  path = File.join(LIBRARY_DIR, "#{month}.csv")
  CSV.open(path, "w", write_headers: true, headers: csv_headers, force_quotes: true) do |csv|
    rows.each { |row| csv << row }
  end
  path
end

def write_index(summaries)
  CSV.open(INDEX_PATH, "w", write_headers: true, headers: %w[month matched_articles generated_at], force_quotes: true) do |csv|
    summaries.each { |summary| csv << summary }
  end
end

options = {
  from: "2026-01",
  to: (Date.today << 1).strftime("%Y-%m"),
}
OptionParser.new do |parser|
  parser.banner = "Usage: ruby scripts/fetch_monthly_library.rb [options]"
  parser.on("--from YYYY-MM", "First month to fetch (default: 2026-01)") { |value| options[:from] = value }
  parser.on("--to YYYY-MM", "Last month to fetch (default: previous complete month)") { |value| options[:to] = value }
end.parse!

from_date = month_start(options[:from])
to_date = month_start(options[:to])
raise OptionParser::InvalidArgument, "--to must not be earlier than --from" if to_date < from_date

journals = YAML.load_file(JOURNALS_PATH).fetch("journals")
keyword_groups = YAML.load_file(KEYWORDS_PATH).fetch("keyword_groups")
required_groups = %w[social_and_natural_environment resident_health geographical_methods]
configured_groups = keyword_groups.map { |group| group.fetch("id") }
missing_groups = required_groups - configured_groups
raise "Missing keyword groups: #{missing_groups.join(", ")}" unless missing_groups.empty?

FileUtils.mkdir_p(LIBRARY_DIR)
summaries = []
date = from_date

while date <= to_date
  month = date.strftime("%Y-%m")
  end_date = month_end(date)
  works = {}
  puts "Fetching #{month}..."

  journals.each_with_index do |journal, index|
    filters = [
      "from-online-pub-date:#{date},until-online-pub-date:#{end_date},type:journal-article",
      "from-pub-date:#{date},until-pub-date:#{end_date},type:journal-article",
      "from-created-date:#{date},until-created-date:#{end_date},type:journal-article",
    ]

    filters.each do |filter|
      allow_created_proxy = filter.start_with?("from-created-date:")
      fetch_items(journal.fetch("issn"), filter).each do |item|
        next unless item["type"] == "journal-article"

        basis_and_date = month_date_basis(item, date, end_date, allow_created_proxy: allow_created_proxy)
        next unless basis_and_date

        doi = clean_text(item["DOI"]).downcase
        next if doi.empty?

        date_basis, publication_date = basis_and_date
        title = clean_text(item.dig("title", 0))
        abstract = clean_text(item["abstract"])
        text = "#{title} #{abstract}".downcase
        groups = matched_groups(text, keyword_groups)
        next unless required_groups.all? { |group_id| groups.fetch(group_id).any? }

        environment_topics = groups.fetch("social_and_natural_environment")
        health_topics = groups.fetch("resident_health")
        method_topics = groups.fetch("geographical_methods")
        works[doi] = [
          month,
          journal.fetch("category"),
          journal.fetch("name"),
          journal.fetch("short_name"),
          journal.fetch("issn"),
          title,
          publication_date.iso8601,
          date_basis,
          doi,
          "https://doi.org/#{doi}",
          abstract.empty? ? "no" : "yes",
          join_topic_names(environment_topics),
          join_keywords(environment_topics),
          join_topic_names(health_topics),
          join_keywords(health_topics),
          join_topic_names(method_topics),
          join_keywords(method_topics),
          "Must match all 3 keyword groups in Crossref title or abstract",
        ]
      end
    end

    puts format("  %02d/%02d %-28s candidates=%d", index + 1, journals.length, journal.fetch("short_name"), works.length)
    sleep(0.08)
  end

  rows = works.values.sort_by { |row| [row[2], row[6], row[5]] }
  output = write_month_csv(month, rows)
  generated_at = Time.now.utc.iso8601
  summaries << [month, rows.length, generated_at]
  puts "Wrote #{rows.length} candidates to #{output}"
  date = next_month(date)
end

write_index(summaries)
puts "Wrote index to #{INDEX_PATH}"
