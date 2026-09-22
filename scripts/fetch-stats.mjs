// scripts/fetch-stats.mjs
//
// Fetches live GitHub data and renders it into custom SVGs:
//   1. Telemetry panel      — language distribution (REST API)
//   2. GitHub stats panel   — stars, commits, PRs, issues, contributed-to
//                             + language-by-repo bars (GraphQL API)
//   3. Contribution graph   — 12-month commit bar chart (GraphQL API)
//
// REST calls use the auto-provided GITHUB_TOKEN from Actions — no setup needed.
// GraphQL calls need at least `read:user` scope. If GITHUB_TOKEN fails on the
// GraphQL step with a permissions error, create a fine-grained Personal Access
// Token (Settings → Developer settings → Fine-grained tokens, read:user scope),
// add it as a repo secret (e.g. GH_STATS_TOKEN), and use that instead in the
// workflow's env block.
//
// IMPORTANT: this script always reads from assets/templates/*.template.svg
// (placeholders intact) and writes rendered output elsewhere. Never point a
// template read at the same file the script writes to.
//
// Run with: GITHUB_TOKEN=xxx GITHUB_USERNAME=yourname node scripts/fetch-stats.mjs

import fs from "node:fs/promises";

const USERNAME = process.env.GITHUB_USERNAME;
const TOKEN = process.env.GITHUB_TOKEN;

if (!USERNAME || !TOKEN) {
  console.error("Missing GITHUB_USERNAME or GITHUB_TOKEN env vars.");
  process.exit(1);
}

const API = "https://api.github.com";
const GRAPHQL_API = "https://api.github.com/graphql";
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

const MAX_LANGUAGE_ROWS = 5;

const TELEMETRY_TARGETS = [
  {
    template: "assets/templates/telemetry-light.template.svg",
    output: "assets/telemetry.svg",
  },
  {
    template: "assets/templates/telemetry-dark.template.svg",
    output: "assets/dark/telemetry.svg",
  },
];

const GITHUB_STATS_TARGETS = [
  {
    template: "assets/templates/github-stats-light.template.svg",
    output: "assets/github-stats.svg",
  },
  {
    template: "assets/templates/github-stats-dark.template.svg",
    output: "assets/dark/github-stats.svg",
  },
];

const CONTRIBUTION_TARGETS = [
  {
    template: "assets/templates/contribution-graph-light.template.svg",
    output: "assets/contribution-graph.svg",
  },
  {
    template: "assets/templates/contribution-graph-dark.template.svg",
    output: "assets/dark/contribution-graph.svg",
  },
];

// ---------- REST: repos + languages (unchanged approach) ----------

async function getAllRepos() {
  let repos = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${API}/users/${USERNAME}/repos?per_page=100&page=${page}&type=owner`,
      { headers }
    );
    if (!res.ok) throw new Error(`Failed to fetch repos: ${res.status}`);
    const batch = await res.json();
    if (batch.length === 0) break;
    repos = repos.concat(batch);
    page++;
  }
  return repos.filter((r) => !r.fork);
}

async function getLanguagesForRepo(repoName) {
  const res = await fetch(`${API}/repos/${USERNAME}/${repoName}/languages`, {
    headers,
  });
  if (!res.ok) {
    console.warn(`  ! skipped ${repoName} (${res.status})`);
    return {};
  }
  return res.json();
}

function toPercentages(totals) {
  const totalBytes = Object.values(totals).reduce((a, b) => a + b, 0);
  const sorted = Object.entries(totals)
    .map(([lang, bytes]) => ({
      lang,
      pct: Math.round((bytes / totalBytes) * 1000) / 10,
    }))
    .sort((a, b) => b.pct - a.pct);

  const top = sorted.slice(0, MAX_LANGUAGE_ROWS);
  const otherPct =
    Math.round(
      sorted.slice(MAX_LANGUAGE_ROWS).reduce((sum, l) => sum + l.pct, 0) * 10
    ) / 10;
  if (otherPct > 0) top.push({ lang: "other", pct: otherPct });
  return top;
}

// ---------- GraphQL: stars, commits, PRs, issues, contributed-to, calendar ----------

async function graphql(query) {
  const res = await fetch(GRAPHQL_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(
      `GraphQL error: ${JSON.stringify(json.errors)} — if this is a permissions ` +
        `error, your token likely needs the read:user scope. See the comment ` +
        `at the top of this script.`
    );
  }
  return json.data;
}

async function getGithubStats() {
  const now = new Date();
  const from = new Date(now.getFullYear(), 0, 1).toISOString(); // Jan 1 this year
  const to = now.toISOString();

  const query = `
    query {
      user(login: "${USERNAME}") {
        pullRequests { totalCount }
        openIssues: issues(states: OPEN) { totalCount }
        closedIssues: issues(states: CLOSED) { totalCount }
        repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, PULL_REQUEST, ISSUE]) {
          totalCount
        }
        contributionsCollection(from: "${from}", to: "${to}") {
          totalCommitContributions
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;

  const data = await graphql(query);
  const u = data.user;

  return {
    totalCommits: u.contributionsCollection.totalCommitContributions,
    totalPRs: u.pullRequests.totalCount,
    totalIssues: u.openIssues.totalCount + u.closedIssues.totalCount,
    contributedTo: u.repositoriesContributedTo.totalCount,
    calendarDays: u.contributionsCollection.contributionCalendar.weeks.flatMap(
      (w) => w.contributionDays
    ),
  };
}

function monthlyTotalsFromCalendar(days) {
  // Bucket each day's contribution count into its calendar month (last 12 months of data present)
  const buckets = {}; // "2026-01" -> count
  for (const day of days) {
    const month = day.date.slice(0, 7); // "YYYY-MM"
    buckets[month] = (buckets[month] || 0) + day.contributionCount;
  }
  const months = Object.keys(buckets).sort();
  const last12 = months.slice(-12);
  return last12.map((m) => ({ month: m, count: buckets[m] }));
}

// ---------- Rendering ----------

function buildLanguageRowsTelemetry(languages) {
  const MAX_BAR_WIDTH = 220;
  const MIN_BAR_WIDTH = 4;
  const topPct = Math.max(...languages.map((l) => l.pct));

  let bars = "";
  let yLabel = 108;
  let yBar = 116;
  let yPct = 123;
  const ROW_HEIGHT = 38;

  for (let i = 0; i < languages.length; i++) {
    const { lang, pct } = languages[i];
    const width = Math.max(
      MIN_BAR_WIDTH,
      Math.round((pct / topPct) * MAX_BAR_WIDTH)
    );
    const fillVar = i === 0 ? "var(--accent)" : "var(--bone)";
    const barClass = `g${i + 1}`;
    bars += `    <text fill="var(--bone)" x="48" y="${yLabel}">${lang.toLowerCase()}</text>       <rect class="bar ${barClass}" x="48" y="${yBar}" width="${width}" height="6" fill="${fillVar}"/><text fill="var(--muted)" x="${
      48 + width + 10
    }" y="${yPct}" font-size="10">${pct}%</text>\n`;
    yLabel += ROW_HEIGHT;
    yBar += ROW_HEIGHT;
    yPct += ROW_HEIGHT;
  }
  return bars.trim();
}

function buildLanguageBarsForStatsPanel(languages) {
  // Horizontal bars in the "LANGUAGES BY REPOSITORY" panel, x=660..930 (270px wide)
  const MAX_BAR_WIDTH = 270;
  const topPct = Math.max(...languages.map((l) => l.pct));

  let rows = "";
  let y = 105; // label baseline
  let yRect = 94; // bar top
  const ROW_HEIGHT = 36;

  for (let i = 0; i < languages.length; i++) {
    const { lang, pct } = languages[i];
    const width = Math.max(4, Math.round((pct / topPct) * MAX_BAR_WIDTH));
    const growClass = i === 0 ? "grow" : `grow g${i + 1}`;
    rows += `    <text x="548" y="${y}" font-size="10">${lang.toUpperCase()}</text><rect class="bar" x="660" y="${yRect}" width="${MAX_BAR_WIDTH}" height="12"/><rect class="fill ${growClass}" x="660" y="${yRect}" width="${width}" height="12"/>\n`;
    y += ROW_HEIGHT;
    yRect += ROW_HEIGHT;
  }
  return rows.trim();
}

function buildContributionBars(monthly) {
  // Simple bar chart across x=48..952, scaled to the busiest month
  const CHART_LEFT = 48;
  const CHART_RIGHT = 952;
  const CHART_TOP = 60;
  const CHART_BOTTOM = 180;
  const maxCount = Math.max(1, ...monthly.map((m) => m.count));
  const slot = (CHART_RIGHT - CHART_LEFT) / monthly.length;
  const barWidth = slot * 0.55;

  let bars = "";
  monthly.forEach((m, i) => {
    const height = Math.round(
      ((CHART_BOTTOM - CHART_TOP) * m.count) / maxCount
    );
    const x = CHART_LEFT + i * slot + (slot - barWidth) / 2;
    const y = CHART_BOTTOM - height;
    const label = m.month.slice(5, 7); // "MM"
    bars += `    <rect class="bar" x="${x.toFixed(
      1
    )}" y="${y}" width="${barWidth.toFixed(
      1
    )}" height="${height}" fill="var(--ink)" style="transform-origin:${x.toFixed(
      1
    )}px ${CHART_BOTTOM}px"/>\n`;
    bars += `    <text x="${(x + barWidth / 2).toFixed(
      1
    )}" y="${CHART_BOTTOM + 16}" text-anchor="middle" fill="var(--dim)">${label}</text>\n`;
  });
  return bars.trim();
}

async function renderFromTemplate(templatePath, outputPath, replacements) {
  let svg = await fs.readFile(templatePath, "utf8");
  for (const [placeholder, value] of Object.entries(replacements)) {
    svg = svg.replaceAll(placeholder, value);
  }
  const dir = outputPath.split("/").slice(0, -1).join("/") || ".";
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(outputPath, svg);
  console.log(`Wrote ${outputPath}`);
}

// ---------- Main ----------

async function main() {
  console.log(`Fetching repos for ${USERNAME}...`);
  const repos = await getAllRepos();
  console.log(`Found ${repos.length} public, non-fork repos.`);

  const languageTotals = {};
  let totalStars = 0;
  for (const repo of repos) {
    totalStars += repo.stargazers_count || 0;
    const langs = await getLanguagesForRepo(repo.name);
    for (const [lang, bytes] of Object.entries(langs)) {
      languageTotals[lang] = (languageTotals[lang] || 0) + bytes;
    }
  }
  const languages = toPercentages(languageTotals);

  console.log("Fetching GitHub stats via GraphQL...");
  const ghStats = await getGithubStats();
  const monthly = monthlyTotalsFromCalendar(ghStats.calendarDays);

  const stats = {
    generatedAt: new Date().toISOString(),
    repoCount: repos.length,
    totalStars,
    languages,
    totalCommits: ghStats.totalCommits,
    totalPRs: ghStats.totalPRs,
    totalIssues: ghStats.totalIssues,
    contributedTo: ghStats.contributedTo,
    monthlyContributions: monthly,
  };

  console.log("Computed stats:", JSON.stringify(stats, null, 2));

  await fs.mkdir("assets", { recursive: true });
  await fs.writeFile("assets/stats.json", JSON.stringify(stats, null, 2));

  // 1. Telemetry panel
  const telemetryBars = buildLanguageRowsTelemetry(languages);
  for (const t of TELEMETRY_TARGETS) {
    await renderFromTemplate(t.template, t.output, {
      "<!-- LANGUAGE_ROWS -->": telemetryBars,
      "{{REPO_COUNT}}": String(stats.repoCount),
    });
  }

  // 2. GitHub stats panel
  const statsLangBars = buildLanguageBarsForStatsPanel(languages);
  for (const t of GITHUB_STATS_TARGETS) {
    await renderFromTemplate(t.template, t.output, {
      "{{TOTAL_STARS}}": String(stats.totalStars),
      "{{TOTAL_COMMITS}}": String(stats.totalCommits),
      "{{TOTAL_PRS}}": String(stats.totalPRs),
      "{{TOTAL_ISSUES}}": String(stats.totalIssues),
      "{{CONTRIBUTED_TO}}": String(stats.contributedTo),
      "<!-- LANGUAGE_BAR_ROWS -->": statsLangBars,
    });
  }

  // 3. Contribution graph
  const contributionBars = buildContributionBars(monthly);
  for (const t of CONTRIBUTION_TARGETS) {
    await renderFromTemplate(t.template, t.output, {
      "<!-- CONTRIBUTION_BARS -->": contributionBars,
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
