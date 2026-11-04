// Sweep the disclose.io directory listing and capture the maturity level/score for every org.
// One-shot snapshot, re-runnable, resumable within the same UTC day.
//
// Source: https://directory.disclose.io/?page=N (server-rendered HTML, 25 rows per page).
//   * The disclosebot JSON API (widgets.disclosebot.io/directory/adf701) that this scraper
//     used through 2026-07 now returns 404; the directory moved to static server-rendered pages
//     with per-org detail pages at /o/{slug}.
//   * Each listing row carries: /o/{slug} link + title, a maturity badge "L{n} {label}",
//     and a raw score "{x} / 120".
//
// The emitted snapshot keeps the SAME schema as before
// ({slug, program_name, badge, badge_text, score_percent, level}) so aggregate.ts,
// scrape-details.ts, and build-page.ts run unchanged. `score_percent` has always held the
// raw /120 score (L5 orgs exceed 100), and still does.

const DIRECTORY_BASE = 'https://directory.disclose.io';
const USER_AGENT = 'state-of-disclosure/3.0 (diostatus-snapshot; +https://state.disclose.io)';
const REQUEST_DELAY_MS = Number(process.env.SCRAPE_DELAY_MS ?? 100);
const CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY ?? 4);
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;
const PER_PAGE = 25;

const PROGRESS_PATH = `${import.meta.dir}/../data/progress.json`;
const today = new Date().toISOString().slice(0, 10);
const SNAPSHOT_PATH = `${import.meta.dir}/../data/snapshot-${today}.json`;

type BadgeKey = 'basic' | 'partial' | 'full' | 'full-pluscvd' | null;

const LEVEL_TO_BADGE: Record<number, BadgeKey> = { 2: 'basic', 3: 'partial', 4: 'full', 5: 'full-pluscvd' };
// Short labels the page has always rendered; the directory's long labels vary ("L2 Basic VDP").
const LEVEL_TO_TEXT: Record<number, string> = { 2: 'Basic', 3: 'Partial', 4: 'Full', 5: 'Full+CVD' };

interface OrgRow {
  slug: string;
  program_name: string;
  badge: BadgeKey;
  badge_text: string | null;
  score_percent: number | null;
  level: number;
}

interface Progress {
  startedAt: string;
  day: string;
  totalPages: number;
  totalProgramsAdvertised: number;
  pages: Record<string, OrgRow[]>;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

export function parseTotal(html: string): number | null {
  const m = html.match(/([\d,]+)\s+organizations/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export function parseRows(html: string): OrgRow[] {
  const rows: OrgRow[] = [];
  for (const chunk of html.split(/<tr[\s>]/).slice(1)) {
    const link = chunk.match(/<a href="?\/o\/([^"\s>]+)"?\s+title="([^"]*)"/);
    if (!link) continue;
    const slug = link[1];
    const name = decode(link[2]) || slug;
    const badge = chunk.match(/data-maturity-assessment-badge>\s*L(\d)\b/);
    const score = chunk.match(/data-field="score">[\s\S]*?>([\d.]+)<\/span>/);
    const raw = badge ? Number(badge[1]) : 1;
    const level = raw < 1 ? 1 : raw; // fold sub-tier L0 into L1, preserving the 5-tier pyramid
    const badged = level >= 2;
    rows.push({
      slug,
      program_name: name,
      badge: LEVEL_TO_BADGE[level] ?? null,
      badge_text: badged ? LEVEL_TO_TEXT[level] : null,
      score_percent: badged && score ? Number(score[1]) : null,
      level,
    });
  }
  return rows;
}

async function fetchPage(page: number): Promise<string> {
  const url = `${DIRECTORY_BASE}/?page=${page}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} on page ${page}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      const backoff = 800 * attempt * attempt;
      console.warn(`  ! page ${page} attempt ${attempt} failed: ${(err as Error).message}; retrying in ${backoff}ms`);
      await Bun.sleep(backoff);
    }
  }
  throw new Error(`page ${page} failed after ${MAX_RETRIES} attempts: ${(lastErr as Error)?.message}`);
}

async function loadProgress(): Promise<Progress | null> {
  const file = Bun.file(PROGRESS_PATH);
  if (!(await file.exists())) return null;
  try {
    const p = (await file.json()) as Progress;
    // Only resume an unfinished sweep from the SAME UTC day. A finished or older progress file
    // once made a "fresh" run reuse a 3-month-old sweep under today's date (2026-11-04).
    if (p.day !== today || !p.pages || typeof p.pages !== 'object') return null;
    return p;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log(`diostatus-snapshot: scraping ${DIRECTORY_BASE}/?page=N`);

  const first = await fetchPage(1);
  const total = parseTotal(first);
  const firstRows = parseRows(first);
  if (!total || firstRows.length === 0) throw new Error('page 1 did not parse (no total or no rows): listing markup changed?');
  const totalPages = Math.ceil(total / PER_PAGE);

  let progress = await loadProgress();
  if (progress && (progress.totalProgramsAdvertised !== total || progress.totalPages !== totalPages)) {
    console.log('Directory total changed since the partial run; starting over.');
    progress = null;
  }
  if (!progress) {
    progress = { startedAt: new Date().toISOString(), day: today, totalPages, totalProgramsAdvertised: total, pages: {} };
  } else {
    console.log(`Resuming same-day sweep: ${Object.keys(progress.pages).length}/${totalPages} pages done`);
  }
  progress.pages['1'] = firstRows;
  console.log(`Discovered: ${total.toLocaleString()} organizations across ${totalPages} pages`);

  const todo: number[] = [];
  for (let p = 2; p <= totalPages; p++) if (!progress.pages[String(p)]) todo.push(p);

  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const page = todo.shift()!;
      const rows = parseRows(await fetchPage(page));
      const expected = page === totalPages ? total - PER_PAGE * (totalPages - 1) : PER_PAGE;
      if (rows.length !== expected) throw new Error(`page ${page}: parsed ${rows.length} rows, expected ${expected}`);
      progress!.pages[String(page)] = rows;
      if (++done % 50 === 0) {
        await Bun.write(PROGRESS_PATH, JSON.stringify(progress));
        console.log(`  ${Object.keys(progress!.pages).length}/${totalPages} pages`);
      }
      await Bun.sleep(REQUEST_DELAY_MS);
    }
  };
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    await Bun.write(PROGRESS_PATH, JSON.stringify(progress));
  }

  const seen = new Set<string>();
  const orgs: OrgRow[] = [];
  for (let p = 1; p <= totalPages; p++) {
    for (const row of progress.pages[String(p)] ?? []) {
      if (!seen.has(row.slug)) { seen.add(row.slug); orgs.push(row); }
    }
  }
  if (orgs.length !== total) {
    console.warn(`WARNING: captured ${orgs.length} unique orgs vs ${total} advertised (pagination shifted mid-sweep?)`);
  }

  const snapshot = {
    fetchedAt: progress.startedAt,
    finishedAt: new Date().toISOString(),
    directoryBase: DIRECTORY_BASE,
    sourceApi: `${DIRECTORY_BASE}/?page=N`,
    totalProgramsAdvertised: total,
    totalProgramsCaptured: orgs.length,
    pages: totalPages,
    orgs,
  };
  await Bun.write(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  // A completed sweep must never be "resumed" by a later run.
  await Bun.file(PROGRESS_PATH).delete();
  console.log(`\nWrote ${SNAPSHOT_PATH} (${orgs.length} orgs, advertised ${total.toLocaleString()})`);
}

if (import.meta.main) {
  main().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
