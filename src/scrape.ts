// Sweep the disclose.io directory via the disclosebot JSON API and capture the maturity
// level/score for every org. One-shot snapshot — re-runnable, resumable.
//
// API: https://widgets.disclosebot.io/directory/{shortcode}?page=N
//   * origin-gated — requires the `Origin: https://directory.disclose.io` header
//   * perPage is locked server-side at 25 (the param is ignored); CSV export disabled
//   * each org carries maturity{level,score,label} inline, so the old two-stage HTML scrape
//     (listing badge-class + per-detail-page) collapses to this single pass for the listing.
//
// The emitted snapshot keeps the SAME schema the previous HTML scraper produced
// ({slug, program_name, badge, badge_text, score_percent, level}) so aggregate.ts,
// scrape-details.ts, and build-page.ts all run unchanged.

const SHORTCODE = 'adf701';
const API_BASE = `https://widgets.disclosebot.io/directory/${SHORTCODE}`;
const DIRECTORY_BASE = 'https://directory.disclose.io'; // human-facing; used for the Origin header + downstream org links
const ORIGIN_HEADER = DIRECTORY_BASE;
const USER_AGENT = 'state-of-disclosure/2.0 (diostatus-snapshot; +https://state.disclose.io)';
const REQUEST_DELAY_MS = 200;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 4;

const PROGRESS_PATH = `${import.meta.dir}/../data/progress.json`;
const today = new Date().toISOString().slice(0, 10);
const SNAPSHOT_PATH = `${import.meta.dir}/../data/snapshot-${today}.json`;

type BadgeKey = 'basic' | 'partial' | 'full' | 'full-pluscvd' | null;

// Inverse of the legacy CSS-class→level mapping, so downstream code that keys off `badge`
// (build-page.ts) keeps working. Level 1 (Contact Only) and 0 carry no badge.
const LEVEL_TO_BADGE: Record<number, BadgeKey> = {
  2: 'basic',
  3: 'partial',
  4: 'full',
  5: 'full-pluscvd',
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

// ---- API response shapes (only the fields we read) ----
interface ApiMaturity {
  level: number | null;
  score: number | null;
  label: string | null;
}
interface ApiOrg {
  id: string;
  name: string;
  slug: string;
  maturity: ApiMaturity | null;
}
interface ApiPagination {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}
interface ApiResponse {
  organizations: ApiOrg[];
  pagination: ApiPagination;
}

function mapOrg(api: ApiOrg): OrgRow | null {
  if (!api || typeof api.slug !== 'string' || api.slug.length === 0) return null;
  const m = api.maturity ?? { level: null, score: null, label: null };
  const rawLevel = typeof m.level === 'number' && Number.isFinite(m.level) ? m.level : 1;
  // The directory's 5-tier pyramid floors at L1 (Contact Only). The API exposes a sub-tier
  // "None" (level 0) for orgs with no policy at all; the legacy HTML scraper lumped these into
  // L1 (unbadged). Fold 0→1 to match that contract and keep the 5-level design (no L0 palette).
  const level = rawLevel < 1 ? 1 : rawLevel;
  const badged = level >= 2;
  return {
    slug: api.slug,
    program_name: typeof api.name === 'string' ? api.name : api.slug,
    badge: LEVEL_TO_BADGE[level] ?? null,
    badge_text: badged && typeof m.label === 'string' ? m.label : null,
    score_percent: badged && typeof m.score === 'number' && Number.isFinite(m.score) ? m.score : null,
    level,
  };
}

async function fetchPage(page: number): Promise<ApiResponse> {
  const url = `${API_BASE}?page=${page}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          'Origin': ORIGIN_HEADER,
          'Referer': `${ORIGIN_HEADER}/`,
          'Accept': 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} on page ${page}`);
      }
      const json = (await response.json()) as ApiResponse;
      if (!json || !Array.isArray(json.organizations) || !json.pagination) {
        throw new Error(`malformed response on page ${page}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      const backoff = 800 * attempt * attempt;
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
    return (await file.json()) as Progress;
  } catch {
    return null;
  }
}

async function saveProgress(progress: Progress): Promise<void> {
  await Bun.write(PROGRESS_PATH, JSON.stringify(progress, null, 2));
}

async function main(): Promise<void> {
  console.log(`diostatus-snapshot: scraping API ${API_BASE}`);

  let progress = await loadProgress();
  let startPage = 1;

  if (progress && progress.lastCompletedPage > 0 && progress.totalPages > 0) {
    console.log(`Resuming: ${progress.orgs.length} orgs captured through page ${progress.lastCompletedPage}/${progress.totalPages}`);
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

  // Probe page 1 to learn totalPages/totalItems if we don't already know.
  if (progress.totalPages === 0) {
    const first = await fetchPage(1);
    progress.totalPages = first.pagination.totalPages;
    progress.totalProgramsAdvertised = first.pagination.totalItems;
    console.log(`Discovered: ${first.pagination.totalItems.toLocaleString()} programs across ${progress.totalPages} pages (perPage ${first.pagination.perPage})`);

    for (const apiOrg of first.organizations) {
      const row = mapOrg(apiOrg);
      if (row && !seenSlugs.has(row.slug)) {
        progress.orgs.push(row);
        seenSlugs.add(row.slug);
      }
    }
    progress.lastCompletedPage = 1;
    await saveProgress(progress);
    startPage = 2;
    await Bun.sleep(REQUEST_DELAY_MS);
  }

  for (let page = startPage; page <= progress.totalPages; page++) {
    const parsed = await fetchPage(page);

    let added = 0;
    for (const apiOrg of parsed.organizations) {
      const row = mapOrg(apiOrg);
      if (row && !seenSlugs.has(row.slug)) {
        progress.orgs.push(row);
        seenSlugs.add(row.slug);
        added++;
      }
    }
    progress.lastCompletedPage = page;

    if (page % 25 === 0 || page === progress.totalPages || parsed.organizations.length === 0) {
      await saveProgress(progress);
      const pct = ((page / progress.totalPages) * 100).toFixed(1);
      console.log(`  page ${page}/${progress.totalPages} (${pct}%) — +${added} (${progress.orgs.length} total, ${parsed.organizations.length} on page)`);
    }

    if (parsed.organizations.length === 0) {
      console.log(`  page ${page} returned 0 orgs — stopping early`);
      break;
    }

    await Bun.sleep(REQUEST_DELAY_MS);
  }

  // Finalise snapshot — schema identical to the previous HTML scraper's output.
  const snapshot = {
    fetchedAt: progress.startedAt,
    finishedAt: new Date().toISOString(),
    directoryBase: DIRECTORY_BASE,
    sourceApi: API_BASE,
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
