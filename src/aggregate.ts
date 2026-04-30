// Read the latest snapshot, bucket orgs by maturity level, write counts JSON.

import { readdirSync } from 'node:fs';

const DATA_DIR = `${import.meta.dir}/../data`;

interface OrgRow {
  slug: string;
  program_name: string;
  badge: string | null;
  badge_text: string | null;
  score_percent: number | null;
  level: number;
}

interface Snapshot {
  fetchedAt: string;
  finishedAt: string;
  directoryBase: string;
  totalProgramsAdvertised: number | null;
  totalProgramsCaptured: number;
  pages: number;
  orgs: OrgRow[];
}

const LEVEL_NAMES: Record<number, string> = {
  0: 'Not Present',
  1: 'Contact Only',
  2: 'Basic VDP',
  3: 'Partial Safe Harbor',
  4: 'Full Safe Harbor',
  5: 'Full Safe Harbor + CVD',
};

function findLatestSnapshot(): string {
  const files = readdirSync(DATA_DIR)
    .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error('No snapshot files found in data/. Run scrape.ts first.');
  return `${DATA_DIR}/${files[files.length - 1]}`;
}

async function main(): Promise<void> {
  const path = findLatestSnapshot();
  console.log(`Aggregating ${path}`);
  const snapshot = await Bun.file(path).json() as Snapshot;

  const counts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const org of snapshot.orgs) {
    const level = org.level;
    if (counts[level] === undefined) counts[level] = 0;
    counts[level]++;
  }

  const total = snapshot.orgs.length;
  const percentages: Record<number, number> = {};
  for (const level of Object.keys(counts).map(Number)) {
    percentages[level] = total === 0 ? 0 : (counts[level] / total) * 100;
  }

  const output = {
    fetchedAt: snapshot.fetchedAt,
    sourceSnapshot: path.split('/').pop(),
    directoryBase: snapshot.directoryBase,
    totalProgramsAdvertised: snapshot.totalProgramsAdvertised,
    totalProgramsCaptured: total,
    note: 'Level 0 (Not Present) orgs are excluded by definition — they are not in the directory. Level 1 (Contact Only) orgs are those listed without a maturity badge.',
    levels: Object.keys(counts)
      .map(Number)
      .sort((a, b) => a - b)
      .map(level => ({
        level,
        name: LEVEL_NAMES[level] ?? `Level ${level}`,
        count: counts[level],
        percent: Number(percentages[level].toFixed(2)),
      })),
  };

  const date = path.match(/snapshot-(\d{4}-\d{2}-\d{2})\.json/)?.[1] ?? new Date().toISOString().slice(0, 10);
  const outPath = `${DATA_DIR}/counts-${date}.json`;
  await Bun.write(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);
  console.log('\nDistribution:');
  for (const row of output.levels) {
    const bar = '█'.repeat(Math.round(row.percent / 2));
    console.log(`  L${row.level} ${row.name.padEnd(24)} ${String(row.count).padStart(6)}  ${row.percent.toFixed(1).padStart(5)}%  ${bar}`);
  }
  console.log(`  Total captured: ${total.toLocaleString()}`);
  if (snapshot.totalProgramsAdvertised) {
    const delta = snapshot.totalProgramsAdvertised - total;
    console.log(`  Advertised:     ${snapshot.totalProgramsAdvertised.toLocaleString()}  (delta ${delta >= 0 ? '+' : ''}${delta})`);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
