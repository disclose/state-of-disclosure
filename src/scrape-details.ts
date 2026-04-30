// Fetch the detail page for every L5/L4/L3 org in the latest snapshot and extract:
//   * pol-grid fields (Contact, Policy URL, security.txt, Safe Harbor, Public Disclosure, …)
//   * score (percent + raw + total)
//   * last-assessed date
//   * met/unmet criteria checklist (Core + Bonus sections)
//   * attestation status (whether the org has attested or it's a public-source estimate)
//
// Levels are processed in order [5, 4, 3] so the smallest tier completes fastest.
// Each level is written to its own file (data/details-lN-DATE.json) the moment that
// level finishes — interrupting the script still yields whatever levels did complete.
//
// Resumable: subsequent runs skip orgs whose slug is already present in the level file.

import { readdirSync, existsSync } from 'node:fs';

const DIRECTORY_BASE = 'https://directory.disclose.io';
const USER_AGENT = 'lookup.disclose.io/1.0 (directory lookup)';
const REQUEST_DELAY_MS = 700;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const TARGET_LEVELS = [5, 4, 3] as const;

const DATA_DIR = `${import.meta.dir}/../data`;
const today = new Date().toISOString().slice(0, 10);

type BadgeKey = 'basic' | 'partial' | 'full' | 'full-pluscvd' | null;

interface SnapshotOrg {
  slug: string;
  program_name: string;
  badge: BadgeKey;
  badge_text: string | null;
  score_percent: number | null;
  level: number;
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

interface OrgDetail {
  slug: string;
  program_name: string;
  badge: BadgeKey;
  badge_text: string | null;
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
  fetched_at: string;
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

function stripHtml(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function isEmail(value: string): boolean {
  return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value.trim());
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function findLatestSnapshot(): string | null {
  if (!existsSync(DATA_DIR)) return null;
  const files = readdirSync(DATA_DIR)
    .filter(f => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  return files.length === 0 ? null : `${DATA_DIR}/${files[files.length - 1]}`;
}

async function loadSnapshot(): Promise<Snapshot> {
  const path = findLatestSnapshot();
  if (path) {
    console.log(`Reading snapshot: ${path}`);
    return await Bun.file(path).json() as Snapshot;
  }
  // Fall back to in-flight progress.json so we can start while bulk scrape still runs.
  const progressPath = `${DATA_DIR}/progress.json`;
  if (!existsSync(progressPath)) {
    throw new Error('No snapshot or progress file found. Run scrape.ts first.');
  }
  console.log(`No final snapshot yet — falling back to in-flight progress.json`);
  let raw: string;
  for (let attempt = 1; attempt <= 3; attempt++) {
    raw = await Bun.file(progressPath).text();
    try {
      const p = JSON.parse(raw);
      return {
        fetchedAt: p.startedAt,
        directoryBase: DIRECTORY_BASE,
        totalProgramsAdvertised: null,
        totalProgramsCaptured: p.orgs.length,
        pages: p.totalPages,
        orgs: p.orgs,
      };
    } catch {
      if (attempt === 3) throw new Error('progress.json was unreadable across 3 attempts');
      await Bun.sleep(500);
    }
  }
  throw new Error('unreachable');
}

async function fetchHtml(url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.text();
    } catch (err) {
      lastErr = err;
      const backoff = 1000 * attempt * attempt;
      console.warn(`  ! ${url} attempt ${attempt}: ${(err as Error).message} (retry in ${backoff}ms)`);
      await Bun.sleep(backoff);
    }
  }
  throw new Error(`failed: ${url}: ${(lastErr as Error)?.message}`);
}

function extractPolGridPair(html: string, label: string): { text: string | null; href: string | null } {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<div class="pol-grid-label">${escaped}</div>\\s*<div class="pol-grid-value">([\\s\\S]*?)</div>`,
    'i',
  );
  const match = html.match(pattern);
  if (!match) return { text: null, href: null };
  const valHtml = match[1];
  const text = stripHtml(valHtml) || null;
  const hrefMatch = valHtml.match(/href="([^"]+)"/i);
  return { text, href: hrefMatch ? hrefMatch[1] : null };
}

function extractSection(html: string, sectionLabel: string): { met: number; total: number; criteria: Record<string, boolean> } {
  // Find the section header and its trailing block until the next section or container close.
  const escaped = sectionLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headerRe = new RegExp(
    `<div class="mat-section-title">${escaped}\\s*\\((\\d+)/(\\d+)\\)</div>([\\s\\S]*?)(?=<div class="mat-section-title">|<div class="att-explainer"|<\\/section>|<footer)`,
    'i',
  );
  const m = html.match(headerRe);
  const criteria: Record<string, boolean> = {};
  if (!m) return { met: 0, total: 0, criteria };

  const met = Number.parseInt(m[1], 10);
  const total = Number.parseInt(m[2], 10);
  const block = m[3];

  for (const cm of block.matchAll(/<span class="(met|unmet)">([^<]+)<\/span>/gi)) {
    const name = decodeHtmlEntities(cm[2]);
    criteria[name] = cm[1] === 'met';
  }

  return { met, total, criteria };
}

function parseDetail(slug: string, snap: SnapshotOrg, html: string): OrgDetail {
  const contact = extractPolGridPair(html, 'Contact');
  const policy = extractPolGridPair(html, 'Policy URL');
  const securityTxt = extractPolGridPair(html, 'security.txt');
  const safeHarbor = extractPolGridPair(html, 'Safe Harbor');
  const publicDisclosure = extractPolGridPair(html, 'Public Disclosure');

  const dateMatch = html.match(/<span class="pol-card-date">([^<]+)<\/span>/i);
  const ringText = html.match(/<div class="ring-text">([\d.]+)%<\/div>/i);
  const scoreRaw = html.match(/<div class="score-raw">([\d.]+)\s*\/\s*([\d.]+)<\/div>/i);
  const attested = !html.includes('class="att-explainer"');

  const core = extractSection(html, 'Core');
  const bonus = extractSection(html, 'Bonus');

  let contactUrl: string | null = null;
  let contactEmail: string | null = null;
  if (contact.text && isEmail(contact.text)) contactEmail = contact.text;
  else if (contact.href && isUrl(contact.href)) contactUrl = contact.href;
  else if (contact.text && isUrl(contact.text)) contactUrl = contact.text;

  return {
    slug,
    program_name: snap.program_name,
    badge: snap.badge,
    badge_text: snap.badge_text,
    level: snap.level,
    score_percent: ringText ? Number.parseFloat(ringText[1]) : snap.score_percent,
    score_raw: scoreRaw ? Number.parseFloat(scoreRaw[1]) : null,
    score_total: scoreRaw ? Number.parseFloat(scoreRaw[2]) : null,
    last_assessed: dateMatch ? decodeHtmlEntities(dateMatch[1]) : null,
    attested,
    contact_text: contact.text,
    contact_url: contactUrl,
    contact_email: contactEmail,
    policy_url: policy.href,
    security_txt_url: securityTxt.href,
    safe_harbor_field: safeHarbor.text,
    public_disclosure_field: publicDisclosure.text,
    core_met: core.total > 0 ? core.met : null,
    core_total: core.total > 0 ? core.total : null,
    bonus_met: bonus.total > 0 ? bonus.met : null,
    bonus_total: bonus.total > 0 ? bonus.total : null,
    criteria: { ...core.criteria, ...bonus.criteria },
    fetched_at: new Date().toISOString(),
  };
}

interface LevelFile {
  level: number;
  fetchedAt: string;
  source: string;
  count: number;
  orgs: OrgDetail[];
}

async function loadLevelFile(level: number): Promise<LevelFile | null> {
  const path = `${DATA_DIR}/details-l${level}-${today}.json`;
  if (!existsSync(path)) return null;
  try {
    return await Bun.file(path).json() as LevelFile;
  } catch {
    return null;
  }
}

async function saveLevelFile(level: number, orgs: OrgDetail[], source: string): Promise<string> {
  const path = `${DATA_DIR}/details-l${level}-${today}.json`;
  const file: LevelFile = {
    level,
    fetchedAt: new Date().toISOString(),
    source,
    count: orgs.length,
    orgs,
  };
  await Bun.write(path, JSON.stringify(file, null, 2));
  return path;
}

async function processLevel(level: number, snap: Snapshot): Promise<void> {
  const candidates = snap.orgs.filter(o => o.level === level);
  console.log(`\n━━ Level ${level} ━━ ${candidates.length} candidate orgs from snapshot`);

  const existing = await loadLevelFile(level);
  const seen = new Set<string>(existing?.orgs.map(o => o.slug) ?? []);
  const collected: OrgDetail[] = existing?.orgs ?? [];

  if (existing) {
    console.log(`  Resuming: ${seen.size} already fetched`);
  }

  const todo = candidates.filter(c => !seen.has(c.slug));
  if (todo.length === 0) {
    console.log(`  Nothing to fetch for L${level}`);
    return;
  }

  console.log(`  Fetching ${todo.length} new detail pages…`);
  const startedAt = Date.now();

  for (let i = 0; i < todo.length; i++) {
    const org = todo[i];
    const url = `${DIRECTORY_BASE}/${org.slug}`;
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`  ! skipping ${org.slug}: ${(err as Error).message}`);
      await Bun.sleep(REQUEST_DELAY_MS);
      continue;
    }
    const detail = parseDetail(org.slug, org, html);
    collected.push(detail);

    if ((i + 1) % 25 === 0 || i + 1 === todo.length) {
      await saveLevelFile(level, collected, findLatestSnapshot() ?? 'progress.json');
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = (i + 1) / elapsed;
      const eta = Math.round((todo.length - (i + 1)) / Math.max(rate, 0.01));
      console.log(`  L${level} ${i + 1}/${todo.length} (${(((i + 1) / todo.length) * 100).toFixed(1)}%) — ${rate.toFixed(2)}/s, ETA ${eta}s`);
    }

    await Bun.sleep(REQUEST_DELAY_MS);
  }

  const path = await saveLevelFile(level, collected, findLatestSnapshot() ?? 'progress.json');
  console.log(`  ✓ Wrote ${path} (${collected.length} orgs)`);
}

async function main(): Promise<void> {
  const snap = await loadSnapshot();
  console.log(`Snapshot has ${snap.orgs.length.toLocaleString()} orgs total`);
  for (const level of TARGET_LEVELS) {
    await processLevel(level, snap);
  }
  console.log('\nAll target levels complete.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
