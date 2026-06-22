// Generate output/state-of-disclosure.html — a single self-contained interactive page.
//
// Data sources (whatever exists):
//   data/snapshot-YYYY-MM-DD.json    — required, all orgs with badge/level
//   data/details-l5-YYYY-MM-DD.json  — L5 detail (criteria, scores, contact)
//   data/details-l4-YYYY-MM-DD.json  — L4 detail (resumable, may be partial)
//   data/details-l3-YYYY-MM-DD.json  — L3 detail (resumable, may be partial)
//
// Layout: pyramid of 5 stacked rows, L5 narrowest at top, L1 widest at base.
// Each row is filled with one clickable bubble per org. Click → open the
// org's directory.disclose.io page in a new tab. Hover → tooltip with details.

import { existsSync, readdirSync, readFileSync } from 'node:fs';

const DATA_DIR = `${import.meta.dir}/../data`;
const OUT_PATH = `${import.meta.dir}/../output/state-of-disclosure.html`;
const HUGO_EXTERNAL = `${process.env.HOME}/Projects/disclose-io-hugo/external`;
const THREATS_README = `${HUGO_EXTERNAL}/research-threats/README.md`;
const PLATFORMS_README = `${HUGO_EXTERNAL}/bug-bounty-platforms/README.md`;
const PENDING_PATH = `${DATA_DIR}/threats-pending.json`;

type BadgeKey = 'basic' | 'partial' | 'full' | 'full-pluscvd' | null;

interface SnapshotOrg {
  slug: string;
  program_name: string;
  badge: BadgeKey;
  badge_text: string | null;
  score_percent: number | null;
  level: number;
}

interface OrgDetail {
  slug: string;
  program_name: string;
  level: number;
  score_percent: number | null;
  score_raw: number | null;
  score_total: number | null;
  last_assessed: string | null;
  attested: boolean;
  contact_text: string | null;
  contact_url: string | null;
  contact_email: string | null;
  policy_url: string | null;
  security_txt_url: string | null;
  safe_harbor_field: string | null;
  public_disclosure_field: string | null;
  core_met: number | null;
  core_total: number | null;
  bonus_met: number | null;
  bonus_total: number | null;
  criteria: Record<string, boolean>;
}

interface DetailsFile {
  level: number;
  fetchedAt: string;
  count: number;
  orgs: OrgDetail[];
}

interface Snapshot {
  fetchedAt: string;
  finishedAt?: string;
  directoryBase: string;
  totalProgramsAdvertised: number | null;
  totalProgramsCaptured: number;
  pages: number;
  orgs: SnapshotOrg[];
}

// Canonical disclose.io directory palette (extracted from /css/main.css inline rules).
const LEVEL_PALETTE: Record<number, { bg: string; text: string; border: string; name: string; key: string }> = {
  1: { bg: '#f3f0ff', text: '#7c3aed', border: '#ddd6fe', name: 'Contact Only', key: 'contact' },
  2: { bg: '#ede9fe', text: '#6d28d9', border: '#c4b5fd', name: 'Basic VDP', key: 'basic' },
  3: { bg: '#e0d4fc', text: '#5b21b6', border: '#a78bfa', name: 'Partial Safe Harbor', key: 'partial' },
  4: { bg: '#d4c4fb', text: '#4c1d95', border: '#8b5cf6', name: 'Full Safe Harbor', key: 'full' },
  5: { bg: '#673AB6', text: '#ffffff', border: '#673AB6', name: 'Full Safe Harbor + CVD', key: 'full-pluscvd' },
};

function findLatest(prefix: string): string | null {
  if (!existsSync(DATA_DIR)) return null;
  const files = readdirSync(DATA_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort();
  return files.length === 0 ? null : `${DATA_DIR}/${files[files.length - 1]}`;
}

async function readJson<T>(path: string): Promise<T> {
  return await Bun.file(path).json() as T;
}

async function loadDetails(level: number): Promise<DetailsFile | null> {
  const path = findLatest(`details-l${level}-`);
  if (!path) return null;
  return await readJson<DetailsFile>(path);
}

interface BubbleData {
  // Compact field names to keep inline JSON small (×27k entries adds up).
  s: string;          // slug
  n: string;          // name
  l: number;          // level
  p: number | null;   // score_percent
  // Detail-only fields (omitted if not enriched):
  a?: 0 | 1;          // attested
  c?: number;         // core_met
  C?: number;         // core_total
  b?: number;         // bonus_met
  B?: number;         // bonus_total
  m?: string[];       // missing criteria names (concise)
  P?: string;         // policy_url
  S?: string;         // security_txt_url
  e?: string;         // contact_email
  u?: string;         // contact_url
}

function jsonEscape(s: string): string {
  return JSON.stringify(s);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Convert a markdown cell into safe HTML: escape, then re-introduce <a> for [text](url)
// and <strong> for **bold**. Anything else is plain text.
function mdCellToHtml(raw: string): string {
  let s = escapeHtml(raw);
  // [text](url) — text already escaped, so href needs escaping too.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safeUrl = url.replace(/"/g, '&quot;');
    return `<a href="${safeUrl}" target="_blank" rel="noopener">${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return s;
}

// Strip markdown link syntax to plain text (for sort keys / search index).
function mdToPlainText(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ThreatRow {
  date: string;
  entity_html: string;
  entity_text: string;
  researcher_html: string;
  researcher_text: string;
  topic: string;
  status_html: string;
}

function parseThreats(): ThreatRow[] {
  if (!existsSync(THREATS_README)) return [];
  const raw = readFileSync(THREATS_README, 'utf-8');
  const lines = raw.split('\n');
  const startIdx = lines.findIndex(l => l.startsWith('### Confirmed Threats'));
  if (startIdx === -1) return [];
  const tableLines = lines.slice(startIdx + 1).filter(l => l.startsWith('|'));
  // First two lines are header + separator
  const dataLines = tableLines.slice(2);
  const rows: ThreatRow[] = [];
  for (const line of dataLines) {
    // Markdown table cells split by `|` — but URLs can contain `|` rarely; assume they don't here.
    const trimmed = line.replace(/^\|/, '').replace(/\|$/, '');
    const cells = trimmed.split('|').map(c => c.trim());
    if (cells.length < 5) continue;
    const [date, entity, researcher, topic, status] = cells;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    rows.push({
      date,
      entity_html: mdCellToHtml(entity),
      entity_text: mdToPlainText(entity),
      researcher_html: mdCellToHtml(researcher),
      researcher_text: mdToPlainText(researcher),
      topic: mdCellToHtml(topic),
      status_html: mdCellToHtml(status),
    });
  }
  return rows.sort((a, b) => (a.date < b.date ? 1 : -1));
}

interface PendingThreat {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  labels: { name: string; color: string }[];
  body?: string;
}

function loadPendingThreats(): PendingThreat[] {
  if (!existsSync(PENDING_PATH)) return [];
  try {
    const raw = readFileSync(PENDING_PATH, 'utf-8');
    const list = JSON.parse(raw) as PendingThreat[];
    return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

interface PlatformRow {
  name: string;
  url: string;
  region: string;
  twitter_html: string;
  program_types: string;
  has_leaderboard: string;
  leaderboard_url: string;
  programs_url: string;
}

function parsePlatforms(): PlatformRow[] {
  if (!existsSync(PLATFORMS_README)) return [];
  const raw = readFileSync(PLATFORMS_README, 'utf-8');
  const lines = raw.split('\n').filter(l => l.startsWith('|'));
  if (lines.length < 3) return [];
  const dataLines = lines.slice(2); // skip header + separator
  const rows: PlatformRow[] = [];
  for (const line of dataLines) {
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (cells.length < 3 || !cells[0]) continue;
    const [name, urlCell, region, twitter, program_types, has_leaderboard, leaderboard_url, programs_url] = cells;
    const urlMatch = urlCell?.match(/\(([^)]+)\)/);
    rows.push({
      name: mdToPlainText(name),
      url: urlMatch ? urlMatch[1] : '',
      region: region ?? '',
      twitter_html: twitter ? mdCellToHtml(twitter) : '',
      program_types: program_types ?? '',
      has_leaderboard: has_leaderboard ?? '',
      leaderboard_url: leaderboard_url ? (leaderboard_url.match(/\(([^)]+)\)/)?.[1] ?? '') : '',
      programs_url: programs_url ? (programs_url.match(/\(([^)]+)\)/)?.[1] ?? '') : '',
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function summarizeCriteria(allOrgs: BubbleData[]): {
  level: number;
  attested: number;
  total: number;
  topMissing: { name: string; count: number }[];
}[] {
  const byLevel: Record<number, BubbleData[]> = {};
  for (const o of allOrgs) {
    if (!byLevel[o.l]) byLevel[o.l] = [];
    byLevel[o.l].push(o);
  }

  return Object.keys(byLevel)
    .map(Number)
    .sort((a, b) => b - a)
    .map(level => {
      const orgs = byLevel[level];
      const enriched = orgs.filter(o => o.c !== undefined);
      const attested = enriched.filter(o => o.a === 1).length;
      const missingCounts: Record<string, number> = {};
      for (const o of enriched) {
        for (const m of o.m ?? []) {
          missingCounts[m] = (missingCounts[m] ?? 0) + 1;
        }
      }
      const topMissing = Object.entries(missingCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      return { level, attested, total: enriched.length, topMissing };
    });
}

async function main(): Promise<void> {
  const snapshotPath = findLatest('snapshot-');
  if (!snapshotPath) throw new Error('No snapshot file. Run scrape.ts first.');
  const snapshot = await readJson<Snapshot>(snapshotPath);
  console.log(`Loaded ${snapshot.orgs.length.toLocaleString()} orgs from ${snapshotPath}`);

  const detailsByLevel = new Map<number, Map<string, OrgDetail>>();
  for (const level of [5, 4, 3]) {
    const file = await loadDetails(level);
    if (!file) {
      console.log(`  L${level}: no detail file yet`);
      continue;
    }
    const map = new Map(file.orgs.map(o => [o.slug, o] as const));
    detailsByLevel.set(level, map);
    console.log(`  L${level}: ${file.orgs.length} detailed orgs`);
  }

  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const bubbles: BubbleData[] = [];
  for (const o of snapshot.orgs) {
    counts[o.level] = (counts[o.level] ?? 0) + 1;
    const detail = detailsByLevel.get(o.level)?.get(o.slug);
    const b: BubbleData = {
      s: o.slug,
      n: o.program_name,
      l: o.level,
      p: o.score_percent,
    };
    if (detail) {
      b.a = detail.attested ? 1 : 0;
      if (detail.core_met !== null) b.c = detail.core_met;
      if (detail.core_total !== null) b.C = detail.core_total;
      if (detail.bonus_met !== null) b.b = detail.bonus_met;
      if (detail.bonus_total !== null) b.B = detail.bonus_total;
      const missing = Object.entries(detail.criteria).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) b.m = missing;
      if (detail.policy_url) b.P = detail.policy_url;
      if (detail.security_txt_url) b.S = detail.security_txt_url;
      if (detail.contact_email) b.e = detail.contact_email;
      if (detail.contact_url) b.u = detail.contact_url;
    }
    bubbles.push(b);
  }

  const totalEnriched = bubbles.filter(b => b.c !== undefined).length;
  const total = bubbles.length;
  const summary = summarizeCriteria(bubbles);

  const threats = parseThreats();
  const pendingThreats = loadPendingThreats();
  const platforms = parsePlatforms();
  console.log(`  threats: ${threats.length} confirmed · ${pendingThreats.length} pending · ${platforms.length} platforms`);

  const html = renderPage({
    snapshot,
    bubbles,
    counts,
    summary,
    totalEnriched,
    total,
    threats,
    pendingThreats,
    platforms,
  });

  await Bun.write(OUT_PATH, html);
  const stat = await Bun.file(OUT_PATH).size;
  console.log(`\nWrote ${OUT_PATH} (${(stat / 1024 / 1024).toFixed(2)} MB, ${total.toLocaleString()} orgs, ${totalEnriched.toLocaleString()} enriched)`);
}

function renderPage(args: {
  snapshot: Snapshot;
  bubbles: BubbleData[];
  counts: Record<number, number>;
  summary: ReturnType<typeof summarizeCriteria>;
  totalEnriched: number;
  total: number;
  threats: ThreatRow[];
  pendingThreats: PendingThreat[];
  platforms: PlatformRow[];
}): string {
  const { snapshot, bubbles, counts, summary, totalEnriched, total, threats, pendingThreats, platforms } = args;
  const fetchedDate = snapshot.fetchedAt.slice(0, 10);
  const directoryBase = snapshot.directoryBase;

  const palettes = JSON.stringify(LEVEL_PALETTE);
  const data = JSON.stringify(bubbles);

  const summaryRows = summary.map(s => {
    const palette = LEVEL_PALETTE[s.level];
    const attestedPct = s.total > 0 ? ((s.attested / s.total) * 100).toFixed(0) : '—';
    const top = s.topMissing.length
      ? s.topMissing.map(m => `<li><span class="bar"><span style="width:${(m.count / s.total * 100).toFixed(0)}%; background:${palette.text}"></span></span><span class="name">${escapeHtml(m.name)}</span> <span class="num">${m.count} / ${s.total}</span></li>`).join('')
      : '<li class="muted">Detail data still loading…</li>';
    return `
    <div class="insight" style="border-color:${palette.border}; background:${palette.bg}">
      <h3 style="color:${palette.text}">L${s.level} · ${escapeHtml(palette.name)}</h3>
      <div class="meta">${counts[s.level]?.toLocaleString() ?? 0} orgs · ${s.total.toLocaleString()} with detail · ${attestedPct === '—' ? '—' : `${attestedPct}% attested`}</div>
      <div class="muted small">Most-common gaps:</div>
      <ul class="gaps">${top}</ul>
    </div>`;
  }).join('');

  // ── Threats section ──────────────────────────────────────────────────────
  const threatYears = threats
    .map(t => Number.parseInt(t.date.slice(0, 4), 10))
    .filter(y => !Number.isNaN(y));
  const pendingYears = pendingThreats
    .map(p => Number.parseInt((p.createdAt || '').slice(0, 4), 10))
    .filter(y => !Number.isNaN(y));
  const allTimelineYears = [...threatYears, ...pendingYears];
  const threatYearMin = allTimelineYears.length ? Math.min(...allTimelineYears) : null;
  const threatYearMax = allTimelineYears.length ? Math.max(...allTimelineYears) : null;

  // Build per-threat timeline bubbles (confirmed + pending).
  // Each bubble keeps the original index so clicking can scroll to the row / GH issue.
  interface TimelineBubble {
    year: number;
    kind: 'confirmed' | 'pending';
    label: string;     // Tooltip text
    href: string;      // anchor target — '#threat-detail-N' or GH issue URL
    idx: number;       // for confirmed: row idx; for pending: issue number
  }
  const timeline: TimelineBubble[] = [];
  threats.forEach((t, i) => {
    const y = Number.parseInt(t.date.slice(0, 4), 10);
    if (Number.isNaN(y)) return;
    timeline.push({
      year: y,
      kind: 'confirmed',
      label: `${t.date} · ${t.entity_text || 'Unknown'} · ${t.researcher_text || ''}`.trim(),
      href: `#threat-detail-${i}`,
      idx: i,
    });
  });
  pendingThreats.forEach(p => {
    const y = Number.parseInt((p.createdAt || '').slice(0, 4), 10);
    if (Number.isNaN(y)) return;
    timeline.push({
      year: y,
      kind: 'pending',
      label: `Pending #${p.number} · ${p.title}`,
      href: p.url,
      idx: p.number,
    });
  });
  // Group bubbles by year for stacking.
  const timelineByYear: Record<number, TimelineBubble[]> = {};
  for (const b of timeline) {
    if (!timelineByYear[b.year]) timelineByYear[b.year] = [];
    timelineByYear[b.year].push(b);
  }
  // Sort each year so confirmed appear first (stacked at the bottom).
  for (const y in timelineByYear) {
    timelineByYear[y].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'confirmed' ? -1 : 1));
  }

  // Render timeline SVG.
  let timelineSvg = '';
  if (threatYearMin !== null && threatYearMax !== null) {
    const yearStart = threatYearMin;
    const yearEnd = threatYearMax;
    const yearSpan = Math.max(1, yearEnd - yearStart);
    const W = 1080;
    const margin = { left: 40, right: 24, top: 24, bottom: 40 };
    const plotW = W - margin.left - margin.right;
    const radius = 6;
    const yGap = 14; // vertical center-to-center between stacked bubbles
    const maxStack = Math.max(...Object.values(timelineByYear).map(arr => arr.length), 1);
    const plotH = Math.max(120, maxStack * yGap + 20);
    const H = plotH + margin.top + margin.bottom;
    const xForYear = (y: number) => margin.left + (yearSpan === 0 ? plotW / 2 : ((y - yearStart) / yearSpan) * plotW);

    // Year axis ticks — show every year if span <= 18, else every 2 years.
    const tickStep = yearSpan <= 18 ? 1 : 2;
    let axis = '';
    for (let y = yearStart; y <= yearEnd; y++) {
      if ((y - yearStart) % tickStep !== 0 && y !== yearEnd) continue;
      const x = xForYear(y);
      axis += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${margin.top + plotH}" y2="${margin.top + plotH + 4}" stroke="#cbd5e1" stroke-width="1"/>`;
      axis += `<text x="${x.toFixed(1)}" y="${margin.top + plotH + 18}" text-anchor="middle" font-size="11" fill="#64748b" font-variant-numeric="tabular-nums">${y}</text>`;
    }
    // Baseline
    axis += `<line x1="${margin.left}" x2="${margin.left + plotW}" y1="${margin.top + plotH}" y2="${margin.top + plotH}" stroke="#e5e7eb" stroke-width="1"/>`;

    // Bubbles
    let bubbles = '';
    for (const yearKey of Object.keys(timelineByYear).map(Number).sort()) {
      const stack = timelineByYear[yearKey];
      const cx = xForYear(yearKey);
      stack.forEach((b, i) => {
        const cy = margin.top + plotH - 8 - (i * yGap);
        const cls = b.kind === 'confirmed' ? 'tl-bubble tl-confirmed' : 'tl-bubble tl-pending';
        const escLabel = b.label.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        bubbles += `<a href="${b.href}" ${b.kind === 'pending' ? 'target="_blank" rel="noopener"' : ''}><circle class="${cls}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius}" data-kind="${b.kind}" data-idx="${b.idx}"><title>${escLabel}</title></circle></a>`;
      });
    }
    timelineSvg = `
    <figure class="threats-timeline" aria-label="Frequency of researcher threats by year">
      <figcaption>
        <span class="tl-legend"><span class="tl-swatch tl-confirmed-sw"></span> Confirmed (${threats.length})</span>
        <span class="tl-legend"><span class="tl-swatch tl-pending-sw"></span> Pending research (${pendingThreats.length})</span>
        <span class="tl-hint muted small">Hover for details · click to jump to the entry</span>
      </figcaption>
      <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img">
        ${axis}
        ${bubbles}
      </svg>
    </figure>`;
  }

  const threatRows = threats.map((t, i) => `
    <tr class="threat-row" data-idx="${i}">
      <td class="t-year">${t.date.slice(0, 4)}</td>
      <td class="t-entity">${t.entity_html}</td>
      <td class="t-researcher">${t.researcher_html}</td>
      <td class="t-topic">${t.topic}</td>
      <td class="t-more"><button class="expand" aria-label="Expand">Read more</button></td>
    </tr>
    <tr class="threat-detail" id="threat-detail-${i}" hidden>
      <td colspan="5"><div class="status-prose">${t.status_html}</div></td>
    </tr>`).join('');

  const pendingCards = pendingThreats.map(p => {
    const ageDays = Math.round((Date.now() - new Date(p.createdAt).getTime()) / 86400000);
    const labels = (p.labels ?? []).map(l => `<span class="t-label" style="background:#${l.color}33; color:#${l.color}; border:1px solid #${l.color}66">${escapeHtml(l.name)}</span>`).join('');
    return `
    <a class="pending-card" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">
      <div class="p-meta">
        <span class="p-num">#${p.number}</span>
        <span class="p-age">${ageDays}d open · ${escapeHtml(p.createdAt.slice(0, 10))}</span>
      </div>
      <div class="p-title">${escapeHtml(p.title)}</div>
      <div class="p-labels">${labels || '<span class="muted small">(no label)</span>'}</div>
    </a>`;
  }).join('');

  // ── Platforms section ────────────────────────────────────────────────────
  const platformsCards = platforms.map(p => `
    <article class="platform-card" data-name="${escapeHtml(p.name.toLowerCase())}" data-region="${escapeHtml((p.region || '').toLowerCase())}">
      <header>
        <h3>${p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}</h3>
        ${p.region ? `<span class="region-pill">${escapeHtml(p.region)}</span>` : ''}
      </header>
      <dl>
        ${p.program_types ? `<div><dt>Programs</dt><dd>${escapeHtml(p.program_types)}</dd></div>` : ''}
        ${p.has_leaderboard ? `<div><dt>Leaderboard</dt><dd>${escapeHtml(p.has_leaderboard)}${p.leaderboard_url ? ` · <a href="${escapeHtml(p.leaderboard_url)}" target="_blank" rel="noopener">view</a>` : ''}</dd></div>` : ''}
        ${p.programs_url ? `<div><dt>Public programs</dt><dd><a href="${escapeHtml(p.programs_url)}" target="_blank" rel="noopener">browse ↗</a></dd></div>` : ''}
        ${p.twitter_html ? `<div><dt>X / Twitter</dt><dd>${p.twitter_html}</dd></div>` : ''}
      </dl>
    </article>`).join('');

  const platformRegions: Record<string, number> = {};
  for (const p of platforms) {
    if (p.region) platformRegions[p.region] = (platformRegions[p.region] ?? 0) + 1;
  }
  const topRegions = Object.entries(platformRegions).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Pyramid widths: stylized, narrowing toward top (level 5).
  const widthByLevel: Record<number, number> = { 5: 38, 4: 56, 3: 74, 2: 92, 1: 100 };

  const sections = [5, 4, 3, 2, 1].map(level => {
    const palette = LEVEL_PALETTE[level];
    const count = counts[level] ?? 0;
    const width = widthByLevel[level];
    return `
    <section class="band band-l${level}" data-level="${level}" style="--band-width:${width}%; --band-bg:${palette.bg}; --band-border:${palette.border}; --band-text:${palette.text}">
      <div class="band-inner">
        <div class="band-header">
          <span class="band-tag" style="background:${palette.text}; color:${palette.bg}">L${level}</span>
          <h2>${escapeHtml(palette.name)}</h2>
          <span class="band-count" id="count-l${level}">${count.toLocaleString()} orgs · ${(count / total * 100).toFixed(1)}%</span>
        </div>
        <div class="bubbles" id="bubbles-l${level}"></div>
      </div>
    </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>The State of Vulnerability Disclosure · disclose.io</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A living snapshot of ${total.toLocaleString()} organisations indexed by directory.disclose.io, mapped against the disclose.io maturity model. Plus the canonical archive of legal threats against researchers, and the registry of bug bounty &amp; VDP platforms.">
<meta property="og:type" content="website">
<meta property="og:title" content="The State of Vulnerability Disclosure">
<meta property="og:description" content="${total.toLocaleString()} organisations · ${threats.length} confirmed threats · ${platforms.length} platforms · the disclose.io ecosystem at a glance.">
<meta property="og:site_name" content="disclose.io">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="The State of Vulnerability Disclosure">
<meta name="twitter:description" content="${total.toLocaleString()} programs · ${counts[5]?.toLocaleString() ?? 0} at Level 5 · ${threats.length} confirmed threats · the maturity-model pyramid for the entire disclose.io directory.">
<meta name="twitter:site" content="@disclose_io">
<link rel="canonical" href="https://state.disclose.io/">
<meta property="og:url" content="https://state.disclose.io/">
<style>
  :root {
    --bg: #ffffff;
    --bg-alt: #faf7ff;
    --bg-tint: #f3f0ff;
    --bg-deep: #ede9fe;
    --ink: #0f172a;
    --muted: #64748b;
    --shade: #f1f5f9;
    --accent: #673AB6;
    --accent-deep: #4c1d95;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  ::selection { background: #ddd6fe; color: #1e1b4b; }

  header.hero { padding: 64px 24px 32px; max-width: 1200px; margin: 0 auto; text-align: center; }
  header.hero .eyebrow { font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
  header.hero h1 { font-size: 48px; line-height: 1.05; margin: 0 0 14px; color: var(--ink); letter-spacing: -0.02em; }
  header.hero p.lede { font-size: 17px; line-height: 1.6; max-width: 720px; margin: 0 auto; color: var(--muted); }
  .stats { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; margin-top: 28px; }
  .stat { background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 14px 20px; min-width: 140px; transition: border-color 0.15s ease, transform 0.15s ease; }
  .stat:hover { border-color: var(--accent); transform: translateY(-2px); }
  .stat .num { font-size: 26px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
  .stat .lbl { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-top: 2px; }
  .hero-nav { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-top: 32px; padding: 4px; background: white; border: 1px solid #e5e7eb; border-radius: 999px; }
  .hero-nav a { padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 500; color: var(--muted); transition: background 0.1s ease, color 0.1s ease; display: inline-flex; align-items: center; gap: 6px; }
  .hero-nav a:hover { background: #f3f0ff; color: var(--accent); text-decoration: none; }
  .hero-nav .nav-badge { font-size: 10px; font-weight: 700; background: #ede9fe; color: var(--accent); padding: 1px 6px; border-radius: 999px; }
  .pyramid-caption { max-width: 740px; margin: 16px auto 0; padding: 0 24px; text-align: center; color: var(--muted); font-size: 13px; line-height: 1.55; }

  /* Above-the-fold contributor strip — sits between hero nav and pyramid */
  .contrib-strip { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px 16px; max-width: 1100px; margin: 24px auto 0; padding: 12px 18px; background: linear-gradient(135deg, #faf5ff 0%, #f3e8ff 100%); border: 1px solid #d8b4fe; border-radius: 999px; font-size: 13px; }
  .contrib-strip-eyebrow { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--accent-deep); font-weight: 700; padding: 3px 10px; background: white; border: 1px solid #ddd6fe; border-radius: 999px; }
  .contrib-strip-prose { color: #475569; }
  .contrib-strip-actions { display: inline-flex; flex-wrap: wrap; gap: 6px; }
  .contrib-strip-actions a { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: white; border: 1px solid #d8b4fe; border-radius: 999px; color: var(--accent-deep); font-weight: 600; font-size: 12px; transition: background 0.1s ease, border-color 0.1s ease, transform 0.1s ease; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .contrib-strip-actions a:hover { background: var(--accent); color: white; border-color: var(--accent); transform: translateY(-1px); text-decoration: none; }
  .contrib-strip-actions a:hover .repo-icon { filter: brightness(0) invert(1); }
  .contrib-strip-actions .repo-icon { font-family: -apple-system, sans-serif; }
  .contrib-strip-actions .strip-arrow { opacity: 0.6; }

  .controls-wrap { position: sticky; top: 0; z-index: 30; background: rgba(255,255,255,0.92); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-bottom: 1px solid #ede9fe; transition: box-shadow 0.2s ease; }
  .controls-wrap.scrolled { box-shadow: 0 2px 12px rgba(15,23,42,0.04); }
  .controls { max-width: 1200px; margin: 0 auto; padding: 12px 24px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .controls input[type="search"] { flex: 1 1 240px; min-width: 180px; padding: 10px 14px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; transition: border-color 0.1s ease, box-shadow 0.1s ease; }
  .controls input[type="search"]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(103,58,182,0.15); }
  .controls label { font-size: 13px; color: var(--muted); display: inline-flex; align-items: center; gap: 6px; }
  .controls .pill { font-size: 12px; padding: 6px 12px; border-radius: 999px; background: var(--shade); color: var(--ink); font-variant-numeric: tabular-nums; }
  .controls .controls-spacer { flex: 1; }
  .controls .controls-mini-nav { display: inline-flex; gap: 4px; }
  .controls .controls-mini-nav a { font-size: 12px; color: var(--muted); padding: 6px 10px; border-radius: 6px; }
  .controls .controls-mini-nav a:hover { background: var(--bg-tint); color: var(--accent); text-decoration: none; }

  /* Back-to-top button */
  #to-top { position: fixed; right: 18px; bottom: 18px; width: 44px; height: 44px; border-radius: 50%; background: var(--accent); color: white; border: none; box-shadow: 0 4px 16px rgba(103,58,182,0.35); cursor: pointer; opacity: 0; transform: translateY(8px); transition: opacity 0.2s ease, transform 0.2s ease; z-index: 50; display: flex; align-items: center; justify-content: center; }
  #to-top.visible { opacity: 1; transform: translateY(0); }
  #to-top:hover { background: var(--accent-deep); }
  #to-top svg { width: 18px; height: 18px; }

  /* Pyramid wrapper section — sits on the alternating tint to feel like its own surface */
  .pyramid-section { background: var(--bg-alt); padding: 16px 0 56px; border-top: 1px solid #ede9fe; }
  .pyramid { display: flex; flex-direction: column; align-items: center; padding: 32px 24px 8px; max-width: 1320px; margin: 0 auto; }
  .band { width: var(--band-width); margin: 6px 0; padding: 14px 20px 18px; background: var(--band-bg); border: 1px solid var(--band-border); border-radius: 14px; transition: width 0.4s ease; }
  .band-inner { width: 100%; }
  .band-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .band-tag { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 6px; letter-spacing: 0.04em; }
  .band-header h2 { margin: 0; font-size: 18px; color: var(--band-text); }
  .band-count { font-size: 13px; color: var(--band-text); opacity: 0.8; margin-left: auto; font-variant-numeric: tabular-nums; }
  .bubbles { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 24px; }
  .bubble { display: block; cursor: pointer; border-radius: 50%; transition: transform 0.12s ease, box-shadow 0.12s ease; }
  .bubble:hover, .bubble.active { transform: scale(1.6); box-shadow: 0 0 0 2px white, 0 0 0 3px var(--band-text); z-index: 2; }
  .bubble.dim { opacity: 0.15; pointer-events: none; }

  /* Per-level bubble sizing — bigger for narrow tiers, smaller for the masses. */
  .band-l5 .bubble { width: 14px; height: 14px; background: #ffffff; border: 2px solid #ffffff; }
  .band-l5 .bubble.attested { background: #ffffff; box-shadow: 0 0 0 2px #ffffff inset; }
  .band-l4 .bubble { width: 11px; height: 11px; background: #4c1d95; }
  .band-l3 .bubble { width: 9px; height: 9px; background: #5b21b6; }
  .band-l2 .bubble { width: 5px; height: 5px; background: #6d28d9; }
  .band-l1 .bubble { width: 7px; height: 7px; background: #7c3aed; }
  .bubble.unattested { opacity: 0.5; }

  .insights { max-width: 1200px; margin: 0 auto; padding: 24px; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .insight { padding: 14px 16px; border-radius: 12px; border: 1px solid; }
  .insight h3 { margin: 0 0 6px; font-size: 14px; font-weight: 700; }
  .insight .meta { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
  .insight ul.gaps { list-style: none; padding: 0; margin: 0; font-size: 12px; }
  .insight ul.gaps li { display: grid; grid-template-columns: 80px 1fr auto; gap: 8px; align-items: center; padding: 3px 0; }
  .insight ul.gaps .bar { display: block; height: 6px; background: rgba(255,255,255,0.5); border-radius: 3px; overflow: hidden; }
  .insight ul.gaps .bar > span { display: block; height: 100%; }
  .insight ul.gaps .name { font-weight: 600; color: #0f172a; font-size: 11px; }
  .insight ul.gaps .num { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--muted); }
  .muted { color: var(--muted); }
  .small { font-size: 11px; }

  /* Tooltip / detail panel */
  #panel { position: fixed; right: 16px; top: 16px; width: 360px; max-height: calc(100vh - 32px); overflow-y: auto; background: white; border: 1px solid #e5e7eb; border-radius: 14px; padding: 18px 20px; box-shadow: 0 10px 40px rgba(15, 23, 42, 0.15); display: none; z-index: 100; }
  #panel.open { display: block; }
  #panel button.close { position: absolute; top: 12px; right: 12px; background: none; border: none; font-size: 18px; cursor: pointer; color: var(--muted); line-height: 1; }
  #panel h3 { margin: 0 0 4px; font-size: 18px; padding-right: 28px; }
  #panel .badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 6px; font-weight: 700; margin-bottom: 12px; }
  #panel .row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
  #panel .row .k { color: var(--muted); }
  #panel .row .v { font-weight: 500; }
  #panel ul.crit { list-style: none; padding: 0; margin: 8px 0 0; font-size: 12px; }
  #panel ul.crit li { display: flex; justify-content: space-between; padding: 3px 0; }
  #panel ul.crit li::before { content: "✗"; color: #dc2626; margin-right: 6px; font-weight: 700; }
  #panel ul.crit li.met::before { content: "✓"; color: #059669; }
  #panel .links { margin-top: 12px; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }

  /* Page footer */
  .page-footer { background: linear-gradient(180deg, transparent 0, var(--ink) 80px, var(--ink) 100%); color: #cbd5e1; padding: 64px 24px 40px; margin-top: 32px; }
  .footer-inner { max-width: 1200px; margin: 0 auto; }
  .footer-cta { background: linear-gradient(135deg, #4c1d95 0%, #6d28d9 100%); border-radius: 20px; padding: 40px 40px 36px; text-align: center; margin-bottom: 32px; }
  .footer-cta h3 { margin: 0 0 8px; font-size: 24px; color: white; }
  .footer-cta p { margin: 0 0 20px; color: #ddd6fe; font-size: 15px; line-height: 1.5; }
  .footer-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
  .btn.ghost-light { background: rgba(255,255,255,0.08); color: white; border: 1px solid rgba(255,255,255,0.25); }
  .btn.ghost-light:hover { background: rgba(255,255,255,0.16); border-color: rgba(255,255,255,0.4); transform: translateY(-1px); text-decoration: none; }
  .footer-cta .btn.primary { background: white; color: var(--accent); }
  .footer-cta .btn.primary:hover { background: #f3f0ff; }
  .footer-meta { text-align: center; color: #94a3b8; font-size: 12px; line-height: 1.7; }
  .footer-meta p { margin: 4px 0; }
  .footer-meta a { color: #c4b5fd; }
  .footer-meta a:hover { color: white; }
  .footer-stamp code { background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 4px; font-size: 11px; color: #94a3b8; }
  .about-snapshot { max-width: 720px; margin: 0 auto 24px; text-align: left; color: #cbd5e1; font-size: 13px; }
  .about-snapshot summary { cursor: pointer; font-weight: 600; color: #c4b5fd; padding: 8px 0; list-style: none; display: inline-flex; align-items: center; gap: 6px; }
  .about-snapshot summary::before { content: "▸"; transition: transform 0.15s ease; display: inline-block; }
  .about-snapshot[open] summary::before { transform: rotate(90deg); }
  .about-snapshot summary::-webkit-details-marker { display: none; }
  .about-snapshot .about-body { padding: 8px 0 12px 14px; line-height: 1.6; }
  .about-snapshot code { background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 4px; font-size: 11px; color: #c4b5fd; }
  .about-snapshot a { color: #c4b5fd; }

  /* Section eyebrows + heading rhythm */
  .eyebrow { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent); font-weight: 700; margin-bottom: 6px; }
  .lede-center { color: var(--muted); font-size: 16px; line-height: 1.55; max-width: 640px; margin: 0 auto 24px; text-align: center; }

  /* Demo section — policymaker walkthrough */
  .demo-section { background: var(--bg); padding: 64px 24px; border-top: 1px solid #ede9fe; border-bottom: 1px solid #ede9fe; }
  .demo-inner { max-width: 1200px; margin: 0 auto; display: grid; grid-template-columns: 1fr 1.4fr; gap: 48px; align-items: center; }
  .demo-text h2 { margin: 4px 0 16px; font-size: 30px; line-height: 1.15; color: var(--ink); letter-spacing: -0.01em; }
  .demo-text .lede { color: var(--muted); font-size: 15px; line-height: 1.6; }
  .demo-actions { display: flex; flex-wrap: wrap; gap: 10px; }
  .demo-video { position: relative; }
  .demo-video video { display: block; width: 100%; height: auto; border-radius: 14px; box-shadow: 0 20px 50px rgba(76,29,149,0.15), 0 0 0 1px rgba(103,58,182,0.08); background: #000; }
  .demo-caption-text { text-align: center; font-size: 12px; color: var(--muted); margin-top: 10px; font-variant-numeric: tabular-nums; }
  @media (max-width: 920px) {
    .demo-inner { grid-template-columns: 1fr; gap: 28px; }
    .demo-text h2 { font-size: 24px; }
  }

  /* Audience strip — between pyramid and threats */
  .audience-strip { background: var(--bg-tint); padding: 64px 24px 72px; border-top: 1px solid var(--bg-deep); border-bottom: 1px solid var(--bg-deep); }
  .audience-inner { max-width: 1200px; margin: 0 auto; text-align: center; }
  .audience-inner h2 { margin: 0 0 8px; font-size: 28px; color: var(--ink); }
  .audience-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 16px; text-align: left; }
  .audience-card { display: block; background: white; border: 1px solid #e5e7eb; border-radius: 14px; padding: 22px 22px 20px; color: var(--ink); text-decoration: none; transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease; position: relative; }
  .audience-card .audience-icon { width: 40px; height: 40px; border-radius: 10px; background: #f3f0ff; color: var(--accent); display: flex; align-items: center; justify-content: center; margin-bottom: 14px; }
  .audience-card .audience-icon svg { width: 20px; height: 20px; }
  .audience-card:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(103, 58, 182, 0.12); border-color: var(--accent); text-decoration: none; }
  .audience-card .audience-tag { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); font-weight: 700; margin-bottom: 8px; }
  .audience-card h3 { margin: 0 0 10px; font-size: 19px; line-height: 1.25; color: var(--ink); }
  .audience-card p { margin: 0 0 14px; font-size: 14px; line-height: 1.55; color: #475569; }
  .audience-card p code { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
  .audience-card .audience-cta { font-weight: 600; font-size: 14px; color: var(--accent); }
  .audience-card.researchers { border-top: 3px solid #8b5cf6; }
  .audience-card.vendors { border-top: 3px solid #6d28d9; }
  .audience-card.operators { border-top: 3px solid #4c1d95; }

  /* Contributor callouts — inline within sections; sophisticated purple, not warning yellow */
  .contrib-callout { display: grid; grid-template-columns: auto 1fr; gap: 18px; align-items: start; margin-top: 36px; padding: 26px 28px; background: linear-gradient(135deg, #faf5ff 0%, #f3e8ff 100%); border: 1px solid #d8b4fe; border-radius: 16px; box-shadow: 0 1px 3px rgba(103, 58, 182, 0.06); }
  .contrib-callout .contrib-icon { width: 44px; height: 44px; border-radius: 12px; background: var(--accent); color: white; display: flex; align-items: center; justify-content: center; font-size: 22px; }
  .contrib-callout .contrib-eyebrow { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent-deep); font-weight: 700; margin-bottom: 4px; }
  .contrib-callout h4 { margin: 0 0 6px; font-size: 18px; color: var(--ink); }
  .contrib-callout p { margin: 0 0 14px; font-size: 14px; color: #475569; line-height: 1.55; max-width: 70ch; }
  .contrib-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .btn { display: inline-block; padding: 9px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; text-decoration: none; transition: transform 0.1s ease, box-shadow 0.1s ease, background 0.1s ease; }
  .btn.primary { background: var(--accent); color: white; }
  .btn.primary:hover { background: var(--accent-deep); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(103, 58, 182, 0.25); text-decoration: none; }
  .btn.ghost { background: white; color: var(--accent); border: 1px solid #d8b4fe; }
  .btn.ghost:hover { background: #faf5ff; border-color: var(--accent); transform: translateY(-1px); text-decoration: none; }

  /* Ecosystem tools section */
  .ecosystem-section { background: linear-gradient(180deg, var(--bg-deep) 0%, #c4b5fd 100%); padding: 72px 24px 88px; border-top: 1px solid #a78bfa; }
  .ecosystem-inner { max-width: 1200px; margin: 0 auto; text-align: center; }
  .ecosystem-inner h2 { margin: 0 0 8px; font-size: 28px; color: var(--ink); }
  .eco-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; margin-top: 16px; text-align: left; }
  .eco-card { display: block; background: white; border: 1px solid #e5e7eb; border-radius: 14px; padding: 20px 22px; color: var(--ink); text-decoration: none; transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease; position: relative; }
  .eco-card:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: 0 10px 24px rgba(103, 58, 182, 0.14); text-decoration: none; }
  .eco-card .eco-step { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: #6d28d9; font-weight: 700; margin-bottom: 6px; }
  .eco-card h3 { margin: 0 0 10px; font-size: 18px; color: var(--ink); font-family: ui-monospace, "SF Mono", "Fira Code", Menlo, monospace; }
  .eco-card p { margin: 0 0 12px; font-size: 14px; line-height: 1.55; color: #475569; }
  .eco-card .eco-cta { font-weight: 600; font-size: 13px; color: var(--accent); }

  /* Section dividers — subtle gradient separators between major sections */
  .section-divider { height: 1px; max-width: 1200px; margin: 0 auto; background: linear-gradient(90deg, transparent 0, #ddd6fe 50%, transparent 100%); }

  /* Threats + Platforms sections */
  .section-band { padding: 8px 0; }
  .section-band.tint { background: var(--bg-tint); }
  .section-band.alt { background: var(--bg-alt); }
  .section-band.white { background: var(--bg); }
  .doc-section { max-width: 1200px; margin: 0 auto; padding: 64px 24px 24px; }
  .doc-section > header { margin-bottom: 16px; }
  .doc-section h2 { margin: 0 0 4px; font-size: 22px; color: var(--ink); }
  .doc-section .lede { margin: 0 0 12px; color: var(--muted); font-size: 14px; max-width: 700px; }
  .doc-section .doc-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .doc-section .doc-stat { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
  .doc-section .doc-stat strong { color: var(--accent); font-weight: 700; }
  .doc-section input[type="search"] { padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font: inherit; min-width: 240px; }

  /* Threats timeline */
  .threats-timeline { margin: 0 0 32px; padding: 20px 24px 12px; background: white; border: 1px solid #ede9fe; border-radius: 14px; box-shadow: 0 1px 3px rgba(103,58,182,0.04); }
  .threats-timeline figcaption { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
  .threats-timeline .tl-legend { display: inline-flex; align-items: center; gap: 6px; }
  .threats-timeline .tl-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .threats-timeline .tl-confirmed-sw { background: var(--accent); }
  .threats-timeline .tl-pending-sw { background: white; border: 2px solid #94a3b8; }
  .threats-timeline .tl-hint { margin-left: auto; }
  .threats-timeline svg { display: block; overflow: visible; }
  .threats-timeline .tl-bubble { cursor: pointer; transition: transform 0.1s ease, opacity 0.1s ease; transform-origin: center; }
  .threats-timeline a:hover .tl-bubble { transform: scale(1.4); }
  .threats-timeline .tl-confirmed { fill: var(--accent); opacity: 0.85; }
  .threats-timeline .tl-confirmed:hover { fill: var(--accent-deep); opacity: 1; }
  .threats-timeline .tl-pending { fill: white; stroke: #94a3b8; stroke-width: 2; }
  .threats-timeline .tl-pending:hover { fill: #f1f5f9; stroke: #475569; }
  @media (max-width: 720px) {
    .threats-timeline figcaption { font-size: 11px; }
    .threats-timeline .tl-hint { width: 100%; margin-left: 0; }
  }

  /* Threats table */
  .threats-table { width: 100%; border-collapse: collapse; font-size: 13px; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  .threats-table thead th { background: #f8fafc; color: var(--ink); font-weight: 600; text-align: left; padding: 10px 12px; border-bottom: 2px solid #e2e8f0; position: sticky; top: 0; z-index: 1; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; }
  .threats-table tbody td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .threats-table tr.threat-row { cursor: pointer; }
  .threats-table tr.threat-row:hover { background: #f8fafc; }
  .threats-table tr.threat-row.expanded { background: #f3f0ff; }
  .threats-table .t-year { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; width: 5rem; }
  .threats-table .t-entity { width: 16rem; font-weight: 500; }
  .threats-table .t-researcher { width: 14rem; }
  .threats-table .t-topic { color: var(--ink); }
  .threats-table .t-more { width: 7rem; text-align: right; }
  .threats-table .t-more button { background: none; border: 1px solid #cbd5e1; border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; color: var(--muted); }
  .threats-table .t-more button:hover { background: #f1f5f9; color: var(--ink); }
  .threats-table .threat-detail .status-prose { padding: 8px 4px 16px; font-size: 13px; line-height: 1.6; color: #334155; max-width: 80ch; }
  .threats-table .threat-detail .status-prose a { color: var(--accent); }
  .threats-table.dim-noresults tbody tr.dim { display: none; }

  /* SRLDF section — bridge between threats and platforms */
  .srldf-section { background: linear-gradient(180deg, #1e1b4b 0%, #312e81 100%); padding: 72px 24px; color: white; }
  .srldf-inner { max-width: 1100px; margin: 0 auto; }
  .srldf-card { display: grid; grid-template-columns: auto 1fr; gap: 36px; align-items: center; padding: 40px 44px; background: linear-gradient(135deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.02) 100%); border: 1px solid rgba(196,181,253,0.25); border-radius: 20px; backdrop-filter: blur(8px); }
  .srldf-logo-plate { background: white; padding: 22px 28px; border-radius: 16px; flex-shrink: 0; box-shadow: 0 8px 24px rgba(0,0,0,0.18); display: flex; align-items: center; justify-content: center; }
  .srldf-logo-plate img { display: block; height: 48px; width: auto; }
  .srldf-card .srldf-eyebrow { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #c4b5fd; font-weight: 700; margin-bottom: 8px; }
  .srldf-card h2 { margin: 0 0 14px; font-size: 26px; line-height: 1.2; color: white; letter-spacing: -0.01em; }
  .srldf-card .srldf-lede { font-size: 16px; line-height: 1.55; color: #e9e7ff; margin: 0 0 12px; }
  .srldf-card .srldf-lede strong { color: white; font-weight: 700; }
  .srldf-card .srldf-sub { font-size: 14px; line-height: 1.6; color: #c4b5fd; margin: 0 0 22px; }
  .srldf-actions { display: flex; flex-wrap: wrap; gap: 10px; }
  .srldf-section .btn.primary { background: white; color: #312e81; }
  .srldf-section .btn.primary:hover { background: #f3f0ff; box-shadow: 0 8px 20px rgba(0,0,0,0.25); }
  .srldf-section .btn.ghost { background: transparent; color: white; border-color: rgba(255,255,255,0.35); }
  .srldf-section .btn.ghost:hover { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.6); }
  @media (max-width: 720px) {
    .srldf-card { grid-template-columns: 1fr; gap: 20px; padding: 28px 24px; }
    .srldf-card h2 { font-size: 22px; }
    .srldf-logo-plate { padding: 18px 22px; }
    .srldf-logo-plate img { height: 40px; }
  }

  /* Pending threats */
  .pending-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-top: 16px; }
  .pending-card { display: block; background: white; border: 1px solid #e5e7eb; border-left: 3px solid #a78bfa; border-radius: 10px; padding: 12px 14px; color: var(--ink); text-decoration: none; transition: transform 0.1s ease, box-shadow 0.1s ease, border-color 0.1s ease; }
  .pending-card:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(103,58,182,0.12); border-left-color: var(--accent); text-decoration: none; }
  .pending-card .p-meta { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .pending-card .p-num { font-weight: 700; color: var(--accent); }
  .pending-card .p-title { font-size: 14px; font-weight: 600; line-height: 1.3; margin-bottom: 8px; }
  .pending-card .p-labels { display: flex; flex-wrap: wrap; gap: 4px; }
  .pending-card .t-label { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 500; }

  /* Platforms grid */
  .platforms-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .platform-card { background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 16px; transition: border-color 0.1s ease; }
  .platform-card:hover { border-color: var(--accent); }
  .platform-card.dim { display: none; }
  .platform-card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
  .platform-card h3 { margin: 0; font-size: 15px; font-weight: 700; }
  .platform-card h3 a { color: var(--ink); }
  .platform-card h3 a:hover { color: var(--accent); }
  .platform-card .region-pill { font-size: 11px; background: #f3f0ff; color: var(--accent); padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .platform-card dl { margin: 0; font-size: 12px; }
  .platform-card dl > div { display: grid; grid-template-columns: 92px 1fr; gap: 8px; padding: 3px 0; }
  .platform-card dt { color: var(--muted); }
  .platform-card dd { margin: 0; color: var(--ink); }

  @media (max-width: 720px) {
    .band { width: 100% !important; }
    header.hero h1 { font-size: 30px; }
    #panel { right: 8px; left: 8px; width: auto; }
  }
</style>
</head>
<body>
<header class="hero">
  <div class="eyebrow">disclose.io · A living index · ${escapeHtml(fetchedDate)}</div>
  <h1>The State of Vulnerability Disclosure</h1>
  <p class="lede">A snapshot of <strong>${total.toLocaleString()}</strong> organisations indexed by <a href="${directoryBase}">directory.disclose.io</a>, mapped against the disclose.io maturity model. Each dot below is one organisation. Click for details; filter to find specific programs.</p>
  <div class="stats">
    <div class="stat"><div class="num">${counts[5]?.toLocaleString() ?? 0}</div><div class="lbl">Level 5 · Full + CVD</div></div>
    <div class="stat"><div class="num">${counts[4]?.toLocaleString() ?? 0}</div><div class="lbl">Level 4 · Full Safe Harbor</div></div>
    <div class="stat"><div class="num">${counts[3]?.toLocaleString() ?? 0}</div><div class="lbl">Level 3 · Partial</div></div>
    <div class="stat"><div class="num">${counts[2]?.toLocaleString() ?? 0}</div><div class="lbl">Level 2 · Basic VDP</div></div>
    <div class="stat"><div class="num">${counts[1]?.toLocaleString() ?? 0}</div><div class="lbl">Level 1 · Contact only</div></div>
  </div>
  <nav class="hero-nav" aria-label="Page sections">
    <a href="#pyramid">The pyramid</a>
    <a href="#what-you-can-do">Where to next</a>
    <a href="#threats">Threats <span class="nav-badge">${threats.length}</span></a>
    <a href="#srldf">Legal defense</a>
    <a href="#platforms">Platforms <span class="nav-badge">${platforms.length}</span></a>
    <a href="#ecosystem">Ecosystem</a>
  </nav>
  <div class="contrib-strip" data-track="top-100-callout">
    <span class="contrib-strip-eyebrow">New</span>
    <span class="contrib-strip-prose">The safe-harbor scoreboard for the world's biggest companies</span>
    <span class="contrib-strip-actions">
      <a href="/top-100/" data-track="top-100-link">Explore the Top 100 <span class="strip-arrow">→</span></a>
    </span>
  </div>
</header>


<div class="pyramid-section">
  <div class="pyramid" id="pyramid">
    ${sections}
    <p class="pyramid-caption">Each dot is one organisation. Hover for name &amp; score; click for full criteria, contacts, and links. Sized by tier — narrower upper tiers reflect rarity, not screen real estate.</p>
  </div>
</div>

<section class="demo-section" id="demo">
  <div class="demo-inner">
    <div class="demo-text">
      <div class="eyebrow">See it in action</div>
      <h2>From blank page to defensible policy in under a minute</h2>
      <p class="lede" style="text-align:left;margin:0 0 20px;">policymaker.disclose.io walks any org through four short steps — name &amp; contact → CVD timeline → policy URL → download. The output is legally-reviewed boilerplate you can hand to counsel and ship.</p>
      <p class="lede" style="text-align:left;margin:0 0 20px;color:#475569;">It's free, open-source, available in 12 languages, and fully customizable. The hard work — drafting safe-harbor language that holds up, mapping CVD timelines, the security.txt format — is already done.</p>
      <div class="demo-actions">
        <a class="btn primary" href="https://policymaker.disclose.io/" target="_blank" rel="noopener" data-track="demo-cta-primary">Build your policy →</a>
        <a class="btn ghost" href="https://github.com/disclose/policymaker" target="_blank" rel="noopener" data-track="demo-cta-source">View source</a>
      </div>
    </div>
    <div class="demo-video">
      <video controls muted loop playsinline preload="metadata" poster="policymaker-demo.jpg" width="1280" height="720" aria-label="Walkthrough of policymaker.disclose.io with no narration">
        <source src="policymaker-demo.mp4" type="video/mp4">
        Your browser doesn't support embedded video.
        <a href="https://policymaker.disclose.io/">Visit policymaker.disclose.io →</a>
      </video>
      <div class="demo-caption-text">No narration. Real interactions. ~36 seconds.</div>
    </div>
  </div>
</section>

<section class="audience-strip" id="what-you-can-do">
  <div class="audience-inner">
    <div class="eyebrow">Where to next</div>
    <h2>Three roles in this ecosystem</h2>
    <p class="lede-center">Wherever you sit, the disclose.io stack has a place for you.</p>
    <div class="audience-grid">
      <a class="audience-card researchers" href="https://lookup.disclose.io/" target="_blank" rel="noopener">
        <div class="audience-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.05-4.05"/></svg>
        </div>
        <div class="audience-tag">Researchers &amp; finders</div>
        <h3>Find the right person for any asset</h3>
        <p>You found something. Don't guess at <code>security@</code>. lookup.disclose.io triangulates the contact, policy, and safe-harbor status for any domain, IP, GitHub org, or company name.</p>
        <div class="audience-cta">Use lookup.disclose.io →</div>
      </a>
      <a class="audience-card vendors" href="https://policymaker.disclose.io/" target="_blank" rel="noopener">
        <div class="audience-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>
        </div>
        <div class="audience-tag">Vendors &amp; defenders</div>
        <h3>Draft a defensible policy in minutes</h3>
        <p><strong>${(counts[2] / total * 100).toFixed(0)}%</strong> of orgs in the directory are still at Basic VDP — no safe harbor, no CVD timeline. policymaker.disclose.io generates a Level 4/5 policy you can review with legal and ship.</p>
        <div class="audience-cta">Open policymaker →</div>
      </a>
      <a class="audience-card operators" href="https://directory.disclose.io/" target="_blank" rel="noopener">
        <div class="audience-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 7l8 5 8-5-8-5z"/><path d="M4 12l8 5 8-5"/><path d="M4 17l8 5 8-5"/></svg>
        </div>
        <div class="audience-tag">Already running a program?</div>
        <h3>Get attested. Climb the ladder.</h3>
        <p>Only <strong>${counts[5]?.toLocaleString() ?? 0}</strong> orgs are at Level 5 — full safe harbor + a CVD timeline. Sign in, attest your program, and show researchers it's safe to test.</p>
        <div class="audience-cta">Visit the directory →</div>
      </a>
    </div>
  </div>
</section>

<div class="section-band white">
<section class="doc-section" id="threats">
  <header>
    <div class="eyebrow">The cost of getting it wrong</div>
    <h2>Threats against researchers</h2>
    <p class="lede">An archive of legal threats made against security researchers engaged in good-faith vulnerability disclosure, plus open submissions still under research. Source: <a href="https://github.com/disclose/research-threats" target="_blank" rel="noopener">disclose/research-threats</a>.</p>
    <div class="doc-stats">
      <div class="doc-stat"><strong>${threats.length}</strong> confirmed</div>
      <div class="doc-stat"><strong>${pendingThreats.length}</strong> pending under research</div>
      ${threatYearMin && threatYearMax ? `<div class="doc-stat">Spanning <strong>${threatYearMin}–${threatYearMax}</strong></div>` : ''}
    </div>
  </header>

  ${timelineSvg}

  <div class="threats-table-wrap">
    <table class="threats-table" id="threats-table">
      <thead>
        <tr>
          <th>Year</th>
          <th>Entity</th>
          <th>Researcher(s)</th>
          <th>Topic</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${threatRows}
      </tbody>
    </table>
  </div>

  <h3 style="margin: 28px 0 4px; font-size: 16px; color: var(--ink);">Pending — submitted, awaiting research</h3>
  <p class="lede" style="margin-bottom: 12px;">Open issues on the <a href="https://github.com/disclose/research-threats/issues" target="_blank" rel="noopener">research-threats repo</a> that are queued for confirmation and addition to the archive above.</p>
  <div class="pending-grid">
    ${pendingCards || '<p class="muted small">No pending issues.</p>'}
  </div>

  <div class="contrib-callout" data-track="threats-contrib">
    <div class="contrib-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M12 3v18"/><path d="M5 8h14"/><path d="m5 8-3 8h6z"/><path d="m19 8 3 8h-6z"/><path d="M2 16a3 3 0 0 0 6 0"/><path d="M16 16a3 3 0 0 0 6 0"/></svg>
    </div>
    <div>
      <div class="contrib-eyebrow">Open source · contributors and maintainers wanted</div>
      <h4>Saw a researcher get threatened? Help us document it.</h4>
      <p>Every entry keeps the ecosystem accountable, educates organizations and hackers alike, and gives policymakers something to point to. Three ways to help:</p>
      <div class="contrib-actions">
        <a class="btn primary" href="https://github.com/disclose/research-threats/issues/new" target="_blank" rel="noopener">Submit a new threat →</a>
        <a class="btn ghost" href="https://github.com/disclose/research-threats/issues" target="_blank" rel="noopener">Help research the ${pendingThreats.length} pending →</a>
        <a class="btn ghost" href="https://github.com/disclose/research-threats/edit/master/README.md" target="_blank" rel="noopener">PR a correction →</a>
      </div>
    </div>
  </div>
</section>
</div>

<section class="srldf-section" id="srldf">
  <div class="srldf-inner">
    <div class="srldf-card">
      <div class="srldf-logo-plate" aria-hidden="true">
        <img src="srldf-logo.svg" alt="Security Research Legal Defense Fund" width="220" height="48" loading="lazy">
      </div>
      <div class="srldf-body">
        <div class="srldf-eyebrow">If you've been threatened</div>
        <h2>Security researchers don't have to face it alone.</h2>
        <p class="srldf-lede">The <strong>Security Research Legal Defense Fund</strong> is a 501(c)(3) nonprofit that funds legal representation for good-faith security researchers facing legal action — the same kind of threats archived above.</p>
        <p class="srldf-sub">If you, or someone you know, is being threatened for good-faith research and vulnerability disclosure, the Defense Fund can help with legal counsel and emergency funding.</p>
        <div class="srldf-actions">
          <a class="btn primary" href="https://srldf.org/" target="_blank" rel="noopener" data-track="srldf-visit">Visit srldf.org →</a>
          <a class="btn ghost" href="https://srldf.org/#request-a-grant" target="_blank" rel="noopener" data-track="srldf-grant">Request a grant</a>
          <a class="btn ghost" href="https://srldf.org/#donate" target="_blank" rel="noopener" data-track="srldf-donate">Donate</a>
        </div>
      </div>
    </div>
  </div>
</section>

<div class="section-band alt">
<section class="doc-section" id="platforms">
  <header>
    <div class="eyebrow">Where programs live</div>
    <h2>Bug bounty &amp; VDP platforms</h2>
    <p class="lede">A community-curated index of crowdsourced security platforms — bug bounty, VDP, and triage services. Source: <a href="https://github.com/disclose/bug-bounty-platforms" target="_blank" rel="noopener">disclose/bug-bounty-platforms</a>.</p>
    <div class="doc-stats">
      <div class="doc-stat"><strong>${platforms.length}</strong> platforms</div>
      ${topRegions.map(([r, n]) => `<div class="doc-stat">${escapeHtml(r)} · <strong>${n}</strong></div>`).join('')}
    </div>
  </header>

  <div class="platforms-grid" id="platforms-grid">
    ${platformsCards}
  </div>

  <div class="contrib-callout" data-track="platforms-contrib">
    <div class="contrib-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M12 20a8 8 0 1 0-8-8"/><path d="M12 2v4"/><path d="M12 20v2"/><path d="m17 17 3 3"/><path d="M2 12h4"/><circle cx="12" cy="12" r="2"/></svg>
    </div>
    <div>
      <div class="contrib-eyebrow">Open source · contributors wanted</div>
      <h4>Run a platform, or know one we missed?</h4>
      <p>Platforms come and go fast. Help keep this list current — broken links, new launches, regional platforms we don't know about, anything.</p>
      <div class="contrib-actions">
        <a class="btn primary" href="https://github.com/disclose/bug-bounty-platforms/edit/main/README.md" target="_blank" rel="noopener">Add or correct a platform →</a>
        <a class="btn ghost" href="https://github.com/disclose/bug-bounty-platforms/issues/new" target="_blank" rel="noopener">Open an issue →</a>
      </div>
    </div>
  </div>
</section>
</div>

<section class="ecosystem-section" id="ecosystem">
  <div class="ecosystem-inner">
    <div class="eyebrow">The disclose.io stack</div>
    <h2>Tools that make this work in practice</h2>
    <p class="lede-center">A complete chain — from drafting a policy, to publishing it, to receiving reports safely, to coordinating disclosure.</p>
    <div class="eco-grid">
      <a class="eco-card" href="https://policymaker.disclose.io/" target="_blank" rel="noopener" data-track="eco-policymaker">
        <div class="eco-step">Draft</div>
        <h3>policymaker.disclose.io</h3>
        <p>Build a vulnerability disclosure policy from canonical, legally-reviewed components. The fastest path from "we have nothing" to a defensible Level 3+ policy.</p>
        <div class="eco-cta">Generate a policy →</div>
      </a>
      <a class="eco-card" href="https://directory.disclose.io/" target="_blank" rel="noopener" data-track="eco-directory">
        <div class="eco-step">Publish &amp; attest</div>
        <h3>directory.disclose.io</h3>
        <p>The directory above. ${(counts[3]+counts[4]+counts[5]).toLocaleString()} orgs already have a published policy. Sign in to attest your program and get rated against the maturity model.</p>
        <div class="eco-cta">Get listed →</div>
      </a>
      <a class="eco-card" href="https://lookup.disclose.io/" target="_blank" rel="noopener" data-track="eco-lookup">
        <div class="eco-step">Find the contact</div>
        <h3>lookup.disclose.io</h3>
        <p>For researchers: enter a domain, IP, or company name and get the right contact, policy URL, and safe-harbor status — without guessing or googling.</p>
        <div class="eco-cta">Try a lookup →</div>
      </a>
      <a class="eco-card" href="https://vault.disclose.io/" target="_blank" rel="noopener" data-track="eco-vault">
        <div class="eco-step">Coordinate</div>
        <h3>vault.disclose.io</h3>
        <p>Cryptographically-enforced coordinated disclosure. Time-locked submissions, vendor escalation, automatic publication when timelines lapse.</p>
        <div class="eco-cta">Open the vault →</div>
      </a>
      <a class="eco-card" href="https://community.disclose.io/" target="_blank" rel="noopener" data-track="eco-community">
        <div class="eco-step">Connect</div>
        <h3>community.disclose.io</h3>
        <p>The forum where program operators, researchers, and policy folks compare notes. Free; moderated; anti-toxic by design.</p>
        <div class="eco-cta">Join the conversation →</div>
      </a>
      <a class="eco-card" href="https://blog.disclose.io/" target="_blank" rel="noopener" data-track="eco-blog">
        <div class="eco-step">Stay current</div>
        <h3>blog.disclose.io</h3>
        <p>Weekly Policy Pulse — what changed in legislation, frameworks, and high-profile disclosure events. Plus deep-dives from the disclose.io team.</p>
        <div class="eco-cta">Read the blog →</div>
      </a>
    </div>
  </div>
</section>

<aside id="panel" role="dialog" aria-hidden="true">
  <button class="close" id="panel-close" aria-label="Close">×</button>
  <div id="panel-body"></div>
</aside>

<button id="to-top" aria-label="Back to top" title="Back to top">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>
</button>

<footer class="page-footer">
  <div class="footer-inner">
    <div class="footer-cta">
      <h3>This page is open source. So is everything it links to.</h3>
      <p>Want to keep it accurate, expand it, embed it, or fork it for your own ecosystem? Pull requests welcome.</p>
      <div class="footer-actions">
        <a class="btn primary" href="https://github.com/disclose" target="_blank" rel="noopener" data-track="footer-github">github.com/disclose →</a>
        <a class="btn ghost-light" href="https://disclose.io/docs/diostatus/" target="_blank" rel="noopener" data-track="footer-diostatus">Maturity model docs →</a>
        <a class="btn ghost-light" href="https://community.disclose.io/" target="_blank" rel="noopener" data-track="footer-community">Join the community →</a>
      </div>
    </div>
    <details class="about-snapshot">
      <summary>About this snapshot</summary>
      <div class="about-body">
        <p>This page captures the state of <a href="${directoryBase}">directory.disclose.io</a> at a point in time. Each organisation's maturity level (1–5) is read from the directory's badge — Level 0 (no findable contact) is excluded by definition, since those orgs aren't in the directory. Levels 3–5 are enriched with full criteria detail (Core 0–9, Bonus 0–3) by visiting each org's detail page. Threats data is parsed from the canonical <code>disclose/research-threats</code> README; pending entries are open issues on the same repo. Platforms are parsed from <code>disclose/bug-bounty-platforms</code>.</p>
        <p>The snapshot is regenerated on demand. Numbers will drift slightly between runs as orgs are added, attest, or improve their score.</p>
      </div>
    </details>
    <div class="footer-meta">
      <p>Snapshot taken ${escapeHtml(snapshot.fetchedAt)} · ${total.toLocaleString()} programs from <a href="${directoryBase}">${directoryBase}</a></p>
      <p>Source data: <a href="https://github.com/disclose/research-threats" target="_blank" rel="noopener">research-threats</a> · <a href="https://github.com/disclose/bug-bounty-platforms" target="_blank" rel="noopener">bug-bounty-platforms</a> · <a href="https://disclose.io/docs/diostatus/" target="_blank" rel="noopener">diostatus model</a></p>
      <p class="footer-stamp"><code>${escapeHtml(snapshotPathFooter())}</code></p>
    </div>
  </div>
</footer>

<!-- Google Analytics 4 — matches the directory.disclose.io property + cross-domain linker -->
<script>
(function(){
  var host = (window.location.hostname||'').toLowerCase();
  var isLocal = host==='' || host==='localhost' || host==='127.0.0.1' || host==='::1' || host.endsWith('.local') || /\\.pages\\.dev$/.test(host) || /\\.netlify\\.app$/.test(host) || /^(file:)/.test(window.location.protocol);
  if (isLocal && console && console.info) console.info('[ga4] skipped on local/preview host:', host);
  if (isLocal) return;
  var s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=G-NJQTCTSYCM'; document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  var internal = false;
  try {
    var qs = new URLSearchParams(window.location.search);
    if (qs.has('internal')) {
      var v = qs.get('internal');
      if (v==='0' || v==='off' || v==='false') localStorage.removeItem('ga4_internal');
      else localStorage.setItem('ga4_internal', '1');
    }
    internal = localStorage.getItem('ga4_internal') === '1';
  } catch {}
  var cfg = { linker: { domains: ['disclose.io','directory.disclose.io','policymaker.disclose.io','lookup.disclose.io','community.disclose.io','blog.disclose.io','vault.disclose.io'] } };
  if (internal) { cfg.debug_mode = true; cfg.traffic_type = 'internal'; }
  gtag('config', 'G-NJQTCTSYCM', cfg);
  if (internal) gtag('set', { traffic_type: 'internal', debug_mode: true });
  // Outbound link tagging — same taxonomy as directory.disclose.io
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!/^https?:\\/\\//i.test(href)) return;
    var u; try { u = new URL(href); } catch { return; }
    var h = u.hostname.toLowerCase();
    if (h === host) return;
    var cls = 'other';
    if (/(^|\\.)disclose\\.io$/.test(h)) cls = 'disclose-io';
    else if (/github\\.com\\/disclose/i.test(href)) cls = 'github-framework';
    else if (h === 'github.com' || h.endsWith('.github.com')) cls = 'github';
    else if (/^(www\\.)?(bugcrowd|hackerone|intigriti|yeswehack|immunefi)\\.com$/i.test(h)) cls = 'platform';
    else if (/(^|\\.)(twitter|x)\\.com$/.test(h) || /(^|\\.)linkedin\\.com$/.test(h) || /(^|\\.)bsky\\.app$/.test(h) || /mastodon/i.test(h) || /(^|\\.)reddit\\.com$/.test(h) || h === 'infosec.exchange') cls = 'social';
    else if (/(^|\\.)(eff\\.org|mvsp\\.dev|owasp\\.org)$/i.test(h)) cls = 'ally';
    gtag('event', 'outbound', { link_class: cls, link_domain: h, link_url: href });
  }, true);
})();
</script>

<script id="orgs-data" type="application/json">${data.replace(/</g, '\\u003c')}</script>
<script>
(function() {
  const palette = ${palettes};
  const orgs = JSON.parse(document.getElementById('orgs-data').textContent);
  const directoryBase = ${jsonEscape(directoryBase)};

  // Group by level for rendering.
  const byLevel = {};
  for (const o of orgs) {
    if (!byLevel[o.l]) byLevel[o.l] = [];
    byLevel[o.l].push(o);
  }

  // Within each level, sort: enriched orgs first (attested first), then by score desc, then name.
  for (const l in byLevel) {
    byLevel[l].sort((a, b) => {
      const aEnr = a.c !== undefined ? 1 : 0;
      const bEnr = b.c !== undefined ? 1 : 0;
      if (aEnr !== bEnr) return bEnr - aEnr;
      if (a.a !== b.a) return (b.a || 0) - (a.a || 0);
      return (b.p || 0) - (a.p || 0);
    });
  }

  // Build slug→org index once for O(1) lookup later.
  const slugMap = new Map();
  for (const o of orgs) slugMap.set(o.s, o);

  // Render bubbles into each band. Click handling is delegated to the band container
  // (one listener per band, not per bubble) — important at 27k bubbles.
  for (const level of [5, 4, 3, 2, 1]) {
    const container = document.getElementById('bubbles-l' + level);
    if (!container) continue;
    const list = byLevel[level] || [];
    const frag = document.createDocumentFragment();
    for (const o of list) {
      const el = document.createElement('span');
      el.className = 'bubble' + (o.a === 1 ? ' attested' : (o.c !== undefined ? ' unattested' : ''));
      el.dataset.slug = o.s;
      el.title = o.n + (o.p != null ? ' · ' + o.p + '%' : '');
      frag.appendChild(el);
    }
    container.appendChild(frag);
    container.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof Element) || !t.classList.contains('bubble')) return;
      const o = slugMap.get(t.getAttribute('data-slug'));
      if (o) openPanel(o);
    });
  }

  // Detail panel.
  const panel = document.getElementById('panel');
  const panelBody = document.getElementById('panel-body');
  document.getElementById('panel-close').addEventListener('click', () => panel.classList.remove('open'));

  function openPanel(o) {
    const p = palette[o.l];
    const criteriaLines = [];
    if (o.c !== undefined && o.m) {
      // Compose all known criteria from met (inferred = total - missing) and missing list.
      // We didn't ship the met-criteria names individually, so display only missing for compactness.
      criteriaLines.push('<li>' + (o.c) + ' / ' + (o.C) + ' core criteria met</li>');
      if (o.B != null) criteriaLines.push('<li>' + (o.b) + ' / ' + (o.B) + ' bonus criteria met</li>');
      if (o.m && o.m.length) {
        criteriaLines.push('<li class="muted small" style="padding-top:6px;list-style:none;">Missing:</li>');
        for (const m of o.m) {
          criteriaLines.push('<li>' + escapeHtml(m) + '</li>');
        }
      }
    }
    const links = [];
    if (o.P) links.push('<a href="' + escapeAttr(o.P) + '" target="_blank" rel="noopener">Policy URL ↗</a>');
    if (o.S) links.push('<a href="' + escapeAttr(o.S) + '" target="_blank" rel="noopener">security.txt ↗</a>');
    if (o.e) links.push('<a href="mailto:' + escapeAttr(o.e) + '">' + escapeHtml(o.e) + '</a>');
    if (o.u) links.push('<a href="' + escapeAttr(o.u) + '" target="_blank" rel="noopener">Contact form ↗</a>');
    links.push('<a href="' + directoryBase + '/' + o.s + '" target="_blank" rel="noopener" style="font-weight:600;">View on directory.disclose.io ↗</a>');

    panelBody.innerHTML =
      '<h3>' + escapeHtml(o.n) + '</h3>' +
      '<span class="badge" style="background:' + p.bg + '; color:' + p.text + '; border:1px solid ' + p.border + '">L' + o.l + ' · ' + escapeHtml(p.name) + '</span>' +
      (o.p != null ? '<div class="row"><span class="k">Maturity score</span><span class="v">' + o.p + '%</span></div>' : '') +
      (o.a !== undefined ? '<div class="row"><span class="k">Attested by org</span><span class="v">' + (o.a === 1 ? 'Yes' : 'No') + '</span></div>' : '') +
      (criteriaLines.length ? '<ul class="crit">' + criteriaLines.join('') + '</ul>' : '<div class="muted small" style="margin-top:8px">Detail data not yet collected for this tier.</div>') +
      '<div class="links">' + links.join('') + '</div>';
    panel.classList.add('open');
  }

  function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function escapeAttr(s) { return escapeHtml(s); }

  // Click-outside to close panel.
  document.addEventListener('click', e => {
    if (panel.classList.contains('open') && !panel.contains(e.target) && !e.target.classList.contains('bubble')) {
      panel.classList.remove('open');
    }
  });
  // Esc closes panel.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && panel.classList.contains('open')) {
      panel.classList.remove('open');
    }
  });

  // Back-to-top visibility
  const toTop = document.getElementById('to-top');
  function onScroll() {
    const y = window.scrollY;
    if (toTop) toTop.classList.toggle('visible', y > 1200);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  if (toTop) toTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    gtagEvent('back_to_top_click', {});
  });
  onScroll();

  // ── Threats: row expansion + filter ──────────────────────────────────────
  const threatsTable = document.getElementById('threats-table');
  if (threatsTable) {
    threatsTable.addEventListener('click', e => {
      const row = e.target.closest && e.target.closest('tr.threat-row');
      if (!row) return;
      const idx = row.getAttribute('data-idx');
      const detail = document.getElementById('threat-detail-' + idx);
      if (!detail) return;
      const open = !detail.hidden;
      detail.hidden = open;
      row.classList.toggle('expanded', !open);
      const btn = row.querySelector('.expand');
      if (btn) btn.textContent = open ? 'Read more' : 'Hide';
    });
  }

  // ── Timeline bubble click — expand the corresponding row before letting the anchor jump.
  document.querySelectorAll('.threats-timeline a[href^="#threat-detail-"]').forEach(a => {
    a.addEventListener('click', () => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/#threat-detail-(\d+)/);
      if (!m) return;
      const idx = m[1];
      const row = document.querySelector('.threat-row[data-idx="' + idx + '"]');
      const detail = document.getElementById('threat-detail-' + idx);
      if (row && detail && detail.hidden) {
        detail.hidden = false;
        row.classList.add('expanded');
        const btn = row.querySelector('.expand');
        if (btn) btn.textContent = 'Hide';
      }
      gtagEvent('timeline_bubble_click', { kind: 'confirmed', idx });
    });
  });
  document.querySelectorAll('.threats-timeline a[target="_blank"]').forEach(a => {
    a.addEventListener('click', () => gtagEvent('timeline_bubble_click', { kind: 'pending', destination: a.getAttribute('href') || '' }));
  });

  // ── GA4 event tagging (matches directory.disclose.io taxonomy) ───────────
  function gtagEvent(name, params) {
    if (typeof window.gtag !== 'function') return;
    try { window.gtag('event', name, params || {}); } catch {}
  }
  // Demo video play / completion
  const demoVid = document.querySelector('.demo-video video');
  if (demoVid) {
    let started = false;
    demoVid.addEventListener('play', () => {
      if (!started) { gtagEvent('demo_video_play', {}); started = true; }
    });
    demoVid.addEventListener('ended', () => gtagEvent('demo_video_complete', {}));
  }
  // SRLDF CTAs
  document.querySelectorAll('.srldf-actions a').forEach(el => {
    el.addEventListener('click', () => gtagEvent('srldf_cta_click', {
      label: el.dataset.track || '',
      destination: el.getAttribute('href') || '',
    }));
  });

  // Demo CTAs
  document.querySelectorAll('.demo-actions a').forEach(el => {
    el.addEventListener('click', () => gtagEvent('demo_cta_click', {
      label: el.dataset.track || '',
      destination: el.getAttribute('href') || '',
    }));
  });

  // Above-the-fold contrib strip
  document.querySelectorAll('.contrib-strip-actions a').forEach(el => {
    el.addEventListener('click', () => gtagEvent('contrib_strip_click', {
      destination: el.getAttribute('href') || '',
      label: (el.dataset.track || '').replace('contrib-strip-', ''),
    }));
  });
  // Audience cards
  document.querySelectorAll('.audience-card').forEach(el => {
    el.addEventListener('click', () => {
      const tag = el.querySelector('.audience-tag');
      gtagEvent('audience_cta_click', { audience: tag ? tag.textContent.trim() : '', destination: el.getAttribute('href') || '' });
    });
  });
  // Ecosystem cards
  document.querySelectorAll('.eco-card').forEach(el => {
    el.addEventListener('click', () => gtagEvent('ecosystem_card_click', {
      tool: el.dataset.track || '',
      destination: el.getAttribute('href') || '',
    }));
  });
  // Contributor callouts
  document.querySelectorAll('.contrib-callout .btn').forEach(btn => {
    btn.addEventListener('click', () => gtagEvent('contributor_cta_click', {
      section: btn.closest('.contrib-callout').dataset.track || '',
      destination: btn.getAttribute('href') || '',
      label: btn.textContent.trim(),
    }));
  });
  // Threat row expansion
  if (threatsTable) {
    threatsTable.addEventListener('click', e => {
      const row = e.target.closest && e.target.closest('tr.threat-row');
      if (row) gtagEvent('threat_row_expand', { idx: row.getAttribute('data-idx') });
    }, true);
  }
  // Pending issue card
  document.querySelectorAll('.pending-card').forEach(el => {
    el.addEventListener('click', () => gtagEvent('pending_threat_click', { destination: el.getAttribute('href') || '' }));
  });

})();
</script>
</body>
</html>
`;
}

function snapshotPathFooter(): string {
  const p = findLatest('snapshot-');
  return p ? p.split('/').pop() ?? 'unknown' : 'unknown';
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
