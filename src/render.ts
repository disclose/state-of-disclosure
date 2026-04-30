// Render a standalone HTML file with an inline SVG vertical bar chart of orgs per maturity level.
// No external CSS, no JS, no charting library — single self-contained file.

import { readdirSync } from 'node:fs';

const DATA_DIR = `${import.meta.dir}/../data`;
const OUT_PATH = `${import.meta.dir}/../output/chart.html`;

interface LevelRow {
  level: number;
  name: string;
  count: number;
  percent: number;
}

interface Counts {
  fetchedAt: string;
  sourceSnapshot: string;
  directoryBase: string;
  totalProgramsAdvertised: number | null;
  totalProgramsCaptured: number;
  note: string;
  levels: LevelRow[];
}

// Palette: greys for unscored levels, then a warm-to-cool ramp for the scored ones.
// Tuned to roughly match the climb image's palette in disclose-io-hugo.
const LEVEL_COLOR: Record<number, string> = {
  0: '#9ca3af',
  1: '#cbd5e1',
  2: '#fbbf24',
  3: '#fb923c',
  4: '#a78bfa',
  5: '#7c3aed',
};

function findLatestCounts(): string {
  const files = readdirSync(DATA_DIR)
    .filter(f => f.startsWith('counts-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error('No counts files found in data/. Run aggregate.ts first.');
  return `${DATA_DIR}/${files[files.length - 1]}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSvg(counts: Counts): string {
  const levels = counts.levels;
  const maxCount = Math.max(...levels.map(l => l.count), 1);

  // Layout
  const width = 880;
  const height = 540;
  const margin = { top: 40, right: 40, bottom: 130, left: 70 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const barCount = levels.length;
  const barGap = 24;
  const barWidth = (plotW - barGap * (barCount - 1)) / barCount;

  const yScale = (n: number): number => plotH - (n / maxCount) * plotH;

  // Y-axis ticks: nice round numbers
  const tickCount = 5;
  const tickStep = niceStep(maxCount / tickCount);
  const ticks: number[] = [];
  for (let v = 0; v <= maxCount; v += tickStep) ticks.push(v);
  if (ticks[ticks.length - 1] < maxCount) ticks.push(ticks[ticks.length - 1] + tickStep);

  const bars = levels.map((row, i) => {
    const x = margin.left + i * (barWidth + barGap);
    const y = margin.top + yScale(row.count);
    const h = plotH - yScale(row.count);
    const cx = x + barWidth / 2;
    const labelTop = margin.top + plotH + 22;
    const color = LEVEL_COLOR[row.level] ?? '#475569';
    return `
    <g>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${color}" />
      <text x="${cx.toFixed(1)}" y="${(y - 8).toFixed(1)}" text-anchor="middle" font-size="14" font-weight="600" fill="#1f2937">${row.count.toLocaleString()}</text>
      <text x="${cx.toFixed(1)}" y="${labelTop}" text-anchor="middle" font-size="13" font-weight="700" fill="#1f2937">L${row.level}</text>
      <text x="${cx.toFixed(1)}" y="${labelTop + 18}" text-anchor="middle" font-size="11" fill="#475569">${escapeHtml(row.name)}</text>
      <text x="${cx.toFixed(1)}" y="${labelTop + 34}" text-anchor="middle" font-size="11" fill="#64748b">${row.percent.toFixed(1)}%</text>
    </g>`;
  }).join('');

  const yTicks = ticks.map(t => {
    const y = margin.top + yScale(t);
    return `
    <line x1="${margin.left}" x2="${margin.left + plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1" />
    <text x="${margin.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#64748b">${t.toLocaleString()}</text>`;
  }).join('');

  const title = 'Where the disclose.io ecosystem sits on the maturity model';
  const subtitle = `${counts.totalProgramsCaptured.toLocaleString()} programs captured from directory.disclose.io`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">
  <text x="${margin.left}" y="22" font-size="16" font-weight="700" fill="#0f172a">${escapeHtml(title)}</text>
  <text x="${margin.left}" y="38" font-size="12" fill="#475569">${escapeHtml(subtitle)}</text>
  ${yTicks}
  <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${margin.top + plotH}" stroke="#94a3b8" stroke-width="1" />
  <line x1="${margin.left}" x2="${margin.left + plotW}" y1="${margin.top + plotH}" y2="${margin.top + plotH}" stroke="#94a3b8" stroke-width="1" />
  <text x="20" y="${(margin.top + plotH / 2).toFixed(1)}" font-size="11" fill="#64748b" transform="rotate(-90, 20, ${(margin.top + plotH / 2).toFixed(1)})" text-anchor="middle">Number of organisations</text>
  ${bars}
</svg>`;
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const m = raw / base;
  let nice: number;
  if (m < 1.5) nice = 1;
  else if (m < 3) nice = 2;
  else if (m < 7) nice = 5;
  else nice = 10;
  return nice * base;
}

async function main(): Promise<void> {
  const path = findLatestCounts();
  console.log(`Rendering chart from ${path}`);
  const counts = await Bun.file(path).json() as Counts;

  const svg = renderSvg(counts);
  const fetchedAtNice = new Date(counts.fetchedAt).toUTCString();

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>disclose.io maturity-model snapshot</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; margin: 0; padding: 32px; background: #f8fafc; color: #0f172a; }
  .wrap { max-width: 920px; margin: 0 auto; background: #ffffff; padding: 24px 32px 32px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p.lede { color: #475569; margin: 0 0 24px; font-size: 14px; }
  svg { display: block; width: 100%; height: auto; }
  footer { margin-top: 24px; font-size: 12px; color: #64748b; line-height: 1.5; }
  footer code { background: #f1f5f9; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
  .note { background: #f8fafc; border-left: 3px solid #cbd5e1; padding: 10px 14px; margin-top: 16px; font-size: 12px; color: #475569; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>disclose.io maturity-model snapshot</h1>
    <p class="lede">A one-shot count of organisations at each level of the disclose.io security maturity model, sampled from <a href="${counts.directoryBase}">directory.disclose.io</a>.</p>
    ${svg}
    <div class="note">${escapeHtml(counts.note)}</div>
    <footer>
      <p><strong>Source:</strong> <a href="${counts.directoryBase}">${counts.directoryBase}</a> &middot;
         <strong>Captured:</strong> ${escapeHtml(fetchedAtNice)} &middot;
         <strong>Snapshot:</strong> <code>${escapeHtml(counts.sourceSnapshot)}</code></p>
      ${counts.totalProgramsAdvertised ? `<p><strong>Programs captured:</strong> ${counts.totalProgramsCaptured.toLocaleString()} of ${counts.totalProgramsAdvertised.toLocaleString()} advertised by the directory.</p>` : ''}
    </footer>
  </div>
</body>
</html>
`;

  await Bun.write(OUT_PATH, html);
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
