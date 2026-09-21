// scripts/fetch-stats.mjs
//
// Fetches this user's public, non-fork repos from the GitHub API,
// aggregates language byte-counts across all of them, computes
// percentages, and writes the results into the SVG template.
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
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

// How many languages to show as individual bars before collapsing
// the rest into "other". Matches your 6-row SVG layout.
const MAX_LANGUAGE_ROWS = 5;

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
  // Exclude forks so someone else's code doesn't skew your language stats
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

async function main() {
  console.log(`Fetching repos for ${USERNAME}...`);
  const repos = await getAllRepos();
  console.log(`Found ${repos.length} public, non-fork repos.`);

  const totals = {};
  for (const repo of repos) {
    const langs = await getLanguagesForRepo(repo.name);
    for (const [lang, bytes] of Object.entries(langs)) {
      totals[lang] = (totals[lang] || 0) + bytes;
    }
  }

  const totalBytes = Object.values(totals).reduce((a, b) => a + b, 0);
  const sorted = Object.entries(totals)
    .map(([lang, bytes]) => ({
      lang,
      pct: Math.round((bytes / totalBytes) * 1000) / 10, // one decimal
    }))
    .sort((a, b) => b.pct - a.pct);

  const topLanguages = sorted.slice(0, MAX_LANGUAGE_ROWS);
  const otherPct =
    Math.round(
      sorted.slice(MAX_LANGUAGE_ROWS).reduce((sum, l) => sum + l.pct, 0) * 10
    ) / 10;
  if (otherPct > 0) {
    topLanguages.push({ lang: "other", pct: otherPct });
  }

  const stats = {
    generatedAt: new Date().toISOString(),
    repoCount: repos.length,
    languages: topLanguages,
  };

  console.log("Computed stats:", JSON.stringify(stats, null, 2));

  await fs.mkdir("assets", { recursive: true });
  await fs.writeFile("assets/stats.json", JSON.stringify(stats, null, 2));

  await renderSvg(stats);
}

async function renderSvg(stats) {
  const lightTemplate = await fs.readFile("assets/telemetry.svg", "utf8");
  const darkTemplate = await fs.readFile("assets/dark/telemetry.svg", "utf8");

  // Max bar width in your original design (swift's 230px was ~27%)
  // so px-per-percent ≈ 230 / 27 ≈ 8.5
  const PX_PER_PCT = 8.5;

  let bars = "";
  let yLabel = 108;
  let yBar = 116;
  let yPct = 123;
  const ROW_HEIGHT = 38;

  for (let i = 0; i < stats.languages.length; i++) {
    const { lang, pct } = stats.languages[i];
    const width = Math.max(4, Math.round(pct * PX_PER_PCT));
    const fillVar = i === 0 ? "var(--accent)" : "var(--bone)";
    const barClass = `g${i + 1}`;
    bars += `    <text fill="var(--bone)" x="48" y="${yLabel}">${lang.toLowerCase()}</text>       <rect class="bar ${barClass}" x="48" y="${yBar}" width="${width}" height="6" fill="${fillVar}"/><text fill="var(--muted)" x="${
      48 + width + 10
    }" y="${yPct}" font-size="10">${pct}%</text>\n`;
    yLabel += ROW_HEIGHT;
    yBar += ROW_HEIGHT;
    yPct += ROW_HEIGHT;
  }

  let svg = lightTemplate
    .replace("<!-- LANGUAGE_ROWS -->", bars.trim())
    .replace("{{REPO_COUNT}}", stats.repoCount);

  await fs.mkdir("assets", { recursive: true });
  await fs.writeFile("assets/telemetry.svg", svg);
  console.log("Wrote assets/telemetry.svg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
