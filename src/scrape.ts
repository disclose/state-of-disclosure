// Sweep directory.disclose.io page-by-page and capture the maturity badge for every org.
// One-shot snapshot — re-runnable, resumable. Reuses the badge/score parsing strategy
// from ~/Projects/lookup-disclose-io/src/steps/diodb.ts but updated to read the
// CSS class suffix (m-badge-basic|partial|full|full-pluscvd) which encodes the level.

const DIRECTORY_BASE = 'https://directory.disclose.io';
const USER_AGENT = 'lookup.disclose.io/1.0 (directory lookup)';
const REQUEST_DELAY_MS = 700;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

const PROGRESS_PATH = `${import.meta.dir}/../data/progress.json`;
const today = new Date().toISOString().slice(0, 10);
const SNAPSHOT_PATH = `${import.meta.dir}/../data/snapshot-${today}.json`;

type BadgeKey = 'basic' | 'partial' | 'full' | 'full-pluscvd' | null;

// Maps the CSS class suffix to the disclose.io maturity level (0..5).
// Level 0 (Not Present) is excluded by definition — those orgs aren't in the directory.
// Level 1 (Contact Only) corresponds to rows with no badge / no score.
const BADGE_TO_LEVEL: Record<NonNullable<BadgeKey>, number> = {
  basic: 2,
  partial: 3,
  full: 4,
  'full-pluscvd': 5,
};

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
  lastCompletedPage: number;
  totalPages: number;
  totalProgramsAdvertised: number | null;
  orgs: OrgRow[];
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
}

function classifyBadgeClass(rowHtml: string): BadgeKey {
  const cls = rowHtml.match(/class="m-badge\s+m-badge-([a-z-]+)"/i);
  if (!cls) return null;
  const key = cls[1].toLowerCase();
  if (key === 'basic' || key === 'partial' || key === 'full' || key === 'full-pluscvd') {
    return key;
  }
  return null;
}

function parseRow(rowHtml: string): OrgRow | null {
  if (rowHtml.includes('empty-row') || !rowHtml.includes('org-name')) return null;

  const orgMatch = rowHtml.match(/<td class="org-name"[\s\S]*?<a href="\/([^"]+)" title="([^"]+)">/i);
  if (!orgMatch) return null;

  const badgeKey = classifyBadgeClass(rowHtml);
  const badgeTextMatch = rowHtml.match(/class="m-badge[^"]*"[^>]*>([^<]+)<\/span>/i);
  // Score percent lives in the badge title attribute: title="Maturity Score: 45%"
  const scoreMatch = rowHtml.match(/title="Maturity Score:\s*([\d.]+)%"/i);

  const level = badgeKey === null ? 1 : BADGE_TO_LEVEL[badgeKey];

  return {
    slug: orgMatch[1],
    program_name: decodeHtmlEntities(orgMatch[2]),
    badge: badgeKey,
    badge_text: badgeTextMatch ? decodeHtmlEntities(badgeTextMatch[1]) : null,
    score_percent: scoreMatch ? Number.parseFloat(scoreMatch[1]) : null,
    level,
  };
}

function parsePage(html: string): { rows: OrgRow[]; totalPrograms: number | null; lastPage: number | null } {
  const rows: OrgRow[] = [];
  for (const m of html.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const row = parseRow(m[1]);
    if (row) rows.push(row);
  }

  const totalMatch = html.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+([\d,]+)\s+programs/i);
  const totalPrograms = totalMatch ? Number.parseInt(totalMatch[1].replace(/,/g, ''), 10) : null;

  // Find the highest page= number in pagination links — that's the last page.
  let lastPage: number | null = null;
  for (const m of html.matchAll(/href="\?page=(\d+)"/g)) {
    const n = Number.parseInt(m[1], 10);
    if (lastPage === null || n > lastPage) lastPage = n;
  }

  return { rows, totalPrograms, lastPage };
}

async function fetchPage(page: number): Promise<string> {
  const url = page === 1 ? `${DIRECTORY_BASE}/` : `${DIRECTORY_BASE}/?page=${page}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} on page ${page}`);
      }
      return await response.text();
    } catch (err) {
      lastErr = err;
      const backoff = 1000 * attempt * attempt;
      console.warn(`  ! page ${page} attempt ${attempt} failed: ${(err as Error).message} — retrying in ${backoff}ms`);
      await Bun.sleep(backoff);
    }
  }
  throw new Error(`page ${page} failed after ${MAX_RETRIES} attempts: ${(lastErr as Error)?.message}`);
}

async function loadProgress(): Promise<Progress | null> {
  const file = Bun.file(PROGRESS_PATH);
  if (!(await file.exists())) return null;
  try {
    return await file.json() as Progress;
  } catch {
    return null;
  }
}

async function saveProgress(progress: Progress): Promise<void> {
  await Bun.write(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

async function main(): Promise<void> {
  console.log(`diostatus-snapshot: scraping ${DIRECTORY_BASE}`);

  let progress = await loadProgress();
  let startPage = 1;

  if (progress && progress.lastCompletedPage > 0) {
    console.log(`Resuming: ${progress.orgs.length} orgs already captured through page ${progress.lastCompletedPage}/${progress.totalPages}`);
    startPage = progress.lastCompletedPage + 1;
  } else {
    progress = {
      startedAt: new Date().toISOString(),
      lastCompletedPage: 0,
      totalPages: 0,
      totalProgramsAdvertised: null,
      orgs: [],
    };
  }

  const seenSlugs = new Set(progress.orgs.map(o => o.slug));

  // Probe page 1 to learn totalPages if we don't already know.
  if (progress.totalPages === 0) {
    const html = await fetchPage(1);
    const parsed = parsePage(html);
    progress.totalPages = parsed.lastPage ?? 1;
    progress.totalProgramsAdvertised = parsed.totalPrograms;
    console.log(`Discovered: ${parsed.totalPrograms?.toLocaleString() ?? '?'} programs across ${progress.totalPages} pages`);

    if (startPage === 1) {
      for (const row of parsed.rows) {
        if (!seenSlugs.has(row.slug)) {
          progress.orgs.push(row);
          seenSlugs.add(row.slug);
        }
      }
      progress.lastCompletedPage = 1;
      await saveProgress(progress);
      startPage = 2;
      await Bun.sleep(REQUEST_DELAY_MS);
    }
  }

  for (let page = startPage; page <= progress.totalPages; page++) {
    const html = await fetchPage(page);
    const parsed = parsePage(html);

    let added = 0;
    for (const row of parsed.rows) {
      if (!seenSlugs.has(row.slug)) {
        progress.orgs.push(row);
        seenSlugs.add(row.slug);
        added++;
      }
    }
    progress.lastCompletedPage = page;

    if (page % 10 === 0 || page === progress.totalPages || parsed.rows.length === 0) {
      await saveProgress(progress);
      const pct = ((page / progress.totalPages) * 100).toFixed(1);
      console.log(`  page ${page}/${progress.totalPages} (${pct}%) — +${added} (${progress.orgs.length} total, ${parsed.rows.length} on page)`);
    }

    if (parsed.rows.length === 0) {
      console.log(`  page ${page} returned 0 rows — stopping early`);
      break;
    }

    await Bun.sleep(REQUEST_DELAY_MS);
  }

  // Finalise snapshot.
  const snapshot = {
    fetchedAt: progress.startedAt,
    finishedAt: new Date().toISOString(),
    directoryBase: DIRECTORY_BASE,
    totalProgramsAdvertised: progress.totalProgramsAdvertised,
    totalProgramsCaptured: progress.orgs.length,
    pages: progress.totalPages,
    orgs: progress.orgs,
  };
  await Bun.write(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`\nWrote ${SNAPSHOT_PATH} (${progress.orgs.length} orgs, advertised ${progress.totalProgramsAdvertised?.toLocaleString() ?? '?'})`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
