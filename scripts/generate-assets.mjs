// Generates the animated SVG cards used by the profile README.
//
// Everything is self-hosted: the cards are written to ./assets and committed by
// the GitHub Action, so the profile never depends on third-party image services.
// Only public data is read. No dependencies (Node 18+).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://api.github.com/graphql";
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const DAYS = 30;
const WIDTH = 840;
const MAX_LANGUAGES = 6;
const FALLBACK_COLOR = "#8b949e";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const THEMES = {
  dark: { card: "#0d1117", border: "#30363d", text: "#e6edf3", muted: "#8b949e", grid: "#21262d", a: "#58a6ff", b: "#a371f7" },
  light: { card: "#ffffff", border: "#d0d7de", text: "#1f2328", muted: "#656d76", grid: "#eaeef2", a: "#0969da", b: "#8250df" },
};

const LANGS = "languages(first: 8, orderBy: {field: SIZE, direction: DESC}) { edges { size node { name color } } }";
const REPO_FIELDS = `totalCount nodes { stargazerCount ${LANGS} }`;
const QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    followers { totalCount }
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalPullRequestContributions
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) { ${REPO_FIELDS} }
    organizations(first: 10) {
      nodes { repositories(first: 100, isFork: false, privacy: PUBLIC) { ${REPO_FIELDS} } }
    }
  }
}`;

const escapeXml = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function fetchUser(token, login) {
  const today = new Date();
  const from = new Date(today.getTime() - 364 * 86_400_000);
  const variables = {
    login,
    from: `${from.toISOString().slice(0, 10)}T00:00:00Z`,
    to: `${today.toISOString().slice(0, 10)}T23:59:59Z`,
  };
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables }),
  });
  if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
  const payload = await response.json();
  if (payload.errors) throw new Error(JSON.stringify(payload.errors));
  return payload.data.user;
}

function collectLanguages(repos) {
  const totals = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages.edges) {
      const previous = totals.get(node.name)?.size ?? 0;
      totals.set(node.name, { size: previous + size, color: node.color ?? FALLBACK_COLOR });
    }
  }
  return [...totals].map(([name, v]) => ({ name, ...v })).sort((x, y) => y.size - x.size);
}

/** Reduce the API response to the plain numbers the cards need. */
function collect(user) {
  const repos = [
    ...user.repositories.nodes,
    ...user.organizations.nodes.flatMap((org) => org.repositories.nodes),
  ];
  const { contributionCalendar: calendar, ...totals } = user.contributionsCollection;
  const today = new Date().toISOString().slice(0, 10);
  const days = calendar.weeks.flatMap((week) => week.contributionDays).filter((d) => d.date <= today);
  return {
    yearTotal: calendar.totalContributions,
    commits: totals.totalCommitContributions,
    pullRequests: totals.totalPullRequestContributions,
    repos: repos.length,
    stars: repos.reduce((sum, repo) => sum + repo.stargazerCount, 0),
    recent: days.slice(-DAYS),
    languages: collectLanguages(repos),
  };
}

function svgOpen(width, height, theme, extraCss = "") {
  const t = THEMES[theme];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" fill="none" role="img">` +
    `<style>text{font-family:${FONT}}` +
    `.title{font-size:16px;font-weight:600;fill:${t.text}}` +
    `.muted{font-size:12px;fill:${t.muted}}` +
    `@keyframes fade{to{opacity:1}}${extraCss}</style>` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${t.card}" stroke="${t.border}"/>`
  );
}

function statsSvg(data, theme) {
  const t = THEMES[theme];
  const tiles = [
    ["Contribuições", data.yearTotal, "no último ano"],
    ["Commits", data.commits, "no último ano"],
    ["Pull requests", data.pullRequests, "no último ano"],
    ["Repositórios", data.repos, `${data.stars} estrelas`],
  ];
  const column = WIDTH / tiles.length;
  const out = [
    svgOpen(WIDTH, 120, theme, ".tile{opacity:0;animation:fade .7s ease forwards}"),
    `<defs><linearGradient id="n" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.a}"/>` +
      `<stop offset="1" stop-color="${t.b}"/></linearGradient></defs>`,
  ];
  tiles.forEach(([label, value, hint], index) => {
    const x = column * index + column / 2;
    if (index) {
      out.push(`<line x1="${column * index}" y1="28" x2="${column * index}" y2="92" stroke="${t.grid}"/>`);
    }
    out.push(
      `<g class="tile" style="animation-delay:${(0.15 * index).toFixed(2)}s" text-anchor="middle">` +
        `<text x="${x}" y="58" font-size="34" font-weight="700" fill="url(#n)">${value}</text>` +
        `<text x="${x}" y="78" class="title" style="font-size:13px">${escapeXml(label)}</text>` +
        `<text x="${x}" y="96" class="muted">${escapeXml(hint)}</text></g>`,
    );
  });
  out.push("</svg>");
  return out.join("");
}

function smoothPath(points) {
  const segments = points.slice(1).map(([x1, y1], i) => {
    const [x0, y0] = points[i];
    const mid = (x0 + x1) / 2;
    return `C${mid.toFixed(1)} ${y0.toFixed(1)} ${mid.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  });
  return [`M${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`, ...segments].join(" ");
}

const ACTIVITY_CSS =
  ".line{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 2.2s ease-out .2s forwards}" +
  "@keyframes draw{to{stroke-dashoffset:0}}" +
  ".area,.dot{opacity:0;animation:fade 1s ease forwards}" +
  ".pulse{transform-box:fill-box;transform-origin:center;animation:pulse 2s ease-out 2.4s infinite}" +
  "@keyframes pulse{0%{transform:scale(1);opacity:.55}100%{transform:scale(3.2);opacity:0}}";

function activityGrid(t, { left, top, chartW, chartH, ceiling }) {
  return [0, 0.5, 1].map((fraction) => {
    const y = top + chartH - fraction * chartH;
    return (
      `<line x1="${left}" y1="${y.toFixed(1)}" x2="${left + chartW}" y2="${y.toFixed(1)}" stroke="${t.grid}"/>` +
      `<text x="${left - 10}" y="${(y + 4).toFixed(1)}" class="muted" text-anchor="end">${Math.round(ceiling * fraction)}</text>`
    );
  });
}

function activitySvg(data, theme) {
  const t = THEMES[theme];
  const height = 280, left = 48, right = 24, top = 70, bottom = 44;
  const chartW = WIDTH - left - right, chartH = height - top - bottom, base = top + chartH;
  const counts = data.recent.map((d) => d.contributionCount);
  const ceiling = Math.max(4, ...counts);
  const step = chartW / Math.max(counts.length - 1, 1);
  const points = counts.map((c, i) => [left + i * step, base - (c / ceiling) * chartH]);
  const line = smoothPath(points);
  const [lastX, lastY] = points[points.length - 1];
  const out = [
    svgOpen(WIDTH, height, theme, ACTIVITY_CSS),
    `<defs><linearGradient id="s" gradientUnits="userSpaceOnUse" x1="${left}" y1="0" x2="${left + chartW}" y2="0">` +
      `<stop offset="0" stop-color="${t.a}"/><stop offset="1" stop-color="${t.b}"/></linearGradient>` +
      `<linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.a}" stop-opacity=".32"/>` +
      `<stop offset="1" stop-color="${t.a}" stop-opacity="0"/></linearGradient></defs>`,
    `<text x="24" y="38" class="title">Atividade nos últimos ${DAYS} dias</text>`,
    `<text x="${WIDTH - 24}" y="38" class="muted" text-anchor="end">${counts.reduce((a, b) => a + b, 0)} contribuições</text>`,
    ...activityGrid(t, { left, top, chartW, chartH, ceiling }),
    `<path class="area" style="animation-delay:1.4s" fill="url(#f)" d="${line} L${lastX.toFixed(1)} ${base} L${points[0][0].toFixed(1)} ${base}Z"/>`,
    `<path class="line" pathLength="1" stroke="url(#s)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="${line}"/>`,
  ];
  points.forEach(([x, y], index) => {
    out.push(
      `<circle class="dot" style="animation-delay:${(0.2 + index * 0.06).toFixed(2)}s" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${t.card}" stroke="${t.a}" stroke-width="1.5"/>`,
    );
    if (index % 5 === 0 || index === points.length - 1) {
      const label = data.recent[index].date;
      out.push(`<text x="${x.toFixed(1)}" y="${base + 24}" class="muted" text-anchor="middle">${label.slice(8, 10)}/${label.slice(5, 7)}</text>`);
    }
  });
  out.push(
    `<circle class="pulse" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="5" fill="${t.b}"/>`,
    `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="5" fill="${t.b}"/></svg>`,
  );
  return out.join("");
}

function languagesSvg(data, theme) {
  const t = THEMES[theme];
  const height = 190, barX = 24, barY = 60, barW = WIDTH - 48, barH = 14;
  const top = data.languages.slice(0, MAX_LANGUAGES);
  const total = data.languages.reduce((sum, l) => sum + l.size, 0) || 1;
  const shown = top.reduce((sum, l) => sum + l.size, 0) || 1;
  const out = [
    svgOpen(WIDTH, height, theme, ".item{opacity:0;animation:fade .6s ease forwards}"),
    `<defs><clipPath id="round"><rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="7"/></clipPath>` +
      `<clipPath id="reveal"><rect x="${barX}" y="${barY}" width="0" height="${barH}">` +
      `<animate attributeName="width" from="0" to="${barW}" dur="1.4s" begin="0.2s" fill="freeze" ` +
      `calcMode="spline" keyTimes="0;1" keySplines=".2 .8 .2 1"/></rect></clipPath></defs>`,
    `<text x="24" y="38" class="title">Linguagens mais usadas</text>`,
    `<g clip-path="url(#round)"><g clip-path="url(#reveal)">`,
  ];
  let cursor = barX;
  for (const { size, color } of top) {
    const width = (barW * size) / shown;
    out.push(`<rect x="${cursor.toFixed(1)}" y="${barY}" width="${width.toFixed(1)}" height="${barH}" fill="${color}" stroke="${t.card}" stroke-width="2"/>`);
    cursor += width;
  }
  out.push("</g></g>");
  top.forEach(({ name, size, color }, index) => {
    const x = 24 + (index % 3) * 264, y = 104 + Math.floor(index / 3) * 36;
    out.push(
      `<g class="item" style="animation-delay:${(0.9 + index * 0.1).toFixed(1)}s">` +
        `<circle cx="${x + 5}" cy="${y}" r="5" fill="${color}"/>` +
        `<text x="${x + 18}" y="${y + 4}" class="title" style="font-size:13px">${escapeXml(name)}</text>` +
        `<text x="${x + 18}" y="${y + 20}" class="muted">${((size / total) * 100).toFixed(1)}%</text></g>`,
    );
  });
  out.push("</svg>");
  return out.join("");
}

function headerSvg(name) {
  const phrases = ["Desenvolvedor Full-Stack", "Java · Spring Boot · React · Next.js", "Construindo sistemas na Synapse Tech"];
  const wave = "q150 -50 300 0" + " t300 0".repeat(7);
  const css =
    `text{font-family:${FONT};fill:#fff}` +
    ".wave{animation:slide 14s linear infinite}.wave2{animation:slide 22s linear infinite reverse}" +
    "@keyframes slide{to{transform:translateX(-600px)}}" +
    ".phrase{opacity:0;animation:cycle 9s ease-in-out infinite}" +
    "@keyframes cycle{0%{opacity:0;transform:translateY(10px)}6%,28%{opacity:1;transform:none}34%,100%{opacity:0;transform:translateY(-10px)}}" +
    ".name{opacity:0;animation:fade 1s ease .1s forwards}@keyframes fade{to{opacity:1}}";
  const lines = phrases.map(
    (phrase, i) =>
      `<text class="phrase" style="animation-delay:${i * 3}s" x="600" y="152" text-anchor="middle" font-size="22" fill-opacity=".92">${escapeXml(phrase)}</text>`,
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="240" viewBox="0 0 1200 240" role="img" aria-label="Cabeçalho do perfil">`,
    `<style>${css}</style>`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f6feb"/><stop offset="1" stop-color="#8957e5"/></linearGradient>`,
    `<clipPath id="frame"><rect width="1200" height="240" rx="16"/></clipPath></defs>`,
    `<g clip-path="url(#frame)"><rect width="1200" height="240" fill="url(#bg)"/>`,
    `<path class="wave" fill="#fff" fill-opacity=".10" d="M0 170 ${wave} V240 H0Z"/>`,
    `<path class="wave2" fill="#fff" fill-opacity=".07" d="M-300 190 ${wave} V240 H-300Z"/></g>`,
    `<text class="name" x="600" y="104" text-anchor="middle" font-size="50" font-weight="700">${escapeXml(name)}</text>`,
    ...lines,
    "</svg>",
  ].join("");
}

function write(file, content) {
  mkdirSync(ASSETS, { recursive: true });
  writeFileSync(join(ASSETS, file), content, "utf8");
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const login = process.env.PROFILE_USER;
  if (!token || !login) throw new Error("GH_TOKEN and PROFILE_USER must be set");
  const data = collect(await fetchUser(token, login));
  write("header.svg", headerSvg(process.env.PROFILE_NAME || "Marcondes"));
  for (const theme of Object.keys(THEMES)) {
    write(`stats-${theme}.svg`, statsSvg(data, theme));
    write(`activity-${theme}.svg`, activitySvg(data, theme));
    write(`languages-${theme}.svg`, languagesSvg(data, theme));
  }
  console.log(`ok: ${data.recent.length} days, ${data.languages.length} languages, ${data.repos} repos`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
