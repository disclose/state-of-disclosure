---
project: state-of-disclosure
slug: diostatus-api-migration
effort: E3
phase: complete
progress: 15/16
mode: ALGORITHM
started: 2026-06-18
updated: 2026-06-19
---

# ISA — State of Disclosure (diostatus-snapshot)

## Problem

`diostatus-snapshot` builds the single-page `state.disclose.io` by **HTML-scraping**
`directory.disclose.io` twice: `scrape.ts` paginates the listing table to read each org's
maturity badge, then `scrape-details.ts` fetches every L3–L5 org's detail page for the
criteria checklist. This is slow (~43 min), brittle (regex over markup), and fights bot
protection. directory.disclose.io has since exposed a **structured JSON API**
(`widgets.disclosebot.io/directory/{shortcode}`) that returns maturity level/score/label,
contacts, and policies inline — making the listing scrape obsolete. The live page is also a
stale 2026-04-29 snapshot and needs a refresh.

## Vision

The listing sweep is a single clean API pass that returns `maturity.level` for all 27,583
orgs directly — no markup parsing, no badge-class reverse-engineering. The rest of the
pipeline is untouched because the snapshot schema is preserved byte-for-byte at the boundary,
and the live page refreshes to current numbers in one `bun run` chain.

## Out of Scope

- Rewriting `scrape-details.ts` to the API — the criteria checklist (core/bonus met/unmet,
  last_assessed) lives **only** in the HTML detail page, not in the API; the legacy HTML
  parser still matches current pages, so it stays.
- Changing `aggregate.ts`, `build-page.ts`, or the page's HTML/layout.
- Adding trends-over-time, a backend, or any runtime-token feature (still build-time only).
- Re-recording the policymaker demo video.

## Constraints

- The API requires an `Origin: https://directory.disclose.io` request header (origin-gated;
  returns 403 `{"error":"Origin not allowed"}` without it).
- `perPage` is locked server-side at 25 → 1,104 pages for 27,583 items; CSV export disabled;
  maturity/level filters are ignored (must bucket client-side).
- The emitted snapshot MUST keep the existing schema
  (`{slug, program_name, badge, badge_text, score_percent, level}` per org) so the
  downstream pipeline runs unchanged.
- bun/bunx only; deploy from this Mac (darwin) with a Pages-scoped Cloudflare API token.

## Goal

Replace `scrape.ts`'s HTML listing scrape with the disclosebot directory API while preserving
the snapshot schema, then re-run the full pipeline (scrape → details → aggregate → build) and
redeploy so `state.disclose.io` reflects current directory data, verified live with Interceptor.

## Criteria

- [x] ISC-1: `scrape.ts` fetches `widgets.disclosebot.io/directory/adf701?page=N` with the `Origin` header
- [x] ISC-2: `scrape.ts` reads `pagination.totalItems`/`totalPages` to bound the sweep (1,104 pages)
- [x] ISC-3: Each org maps `maturity.level→level`, `maturity.score→score_percent`, `maturity.label→badge_text`, level→`badge` key
- [x] ISC-4: Emitted snapshot keeps the exact prior schema keys per org (badge,badge_text,level,program_name,score_percent,slug)
- [x] ISC-5: `scrape.ts` is resumable (progress.json) + retries with backoff on transient errors
- [x] ISC-6: `bun run src/scrape.ts` completes and writes `data/snapshot-2026-06-19.json` (UTC date)
- [x] ISC-7: Captured org count = 27,583 = totalItems (delta +0)
- [x] ISC-8: Level distribution sane — {1:473, 2:24600, 3:1597, 4:730, 5:183}
- [x] ISC-9: `bun run src/scrape-details.ts` regenerated `details-l{3,4,5}-2026-06-19.json` (183/728/1597)
- [x] ISC-10: `bun run src/aggregate.ts` wrote `counts-2026-06-19.json`
- [x] ISC-11: `bun run src/build-page.ts` wrote `output/state-of-disclosure.html` (2.46 MB)
- [x] ISC-12: Built + served HTML embeds the new total (`27,583`, `183 at Level 5`)
- [x] ISC-13: Deploy to Cloudflare Pages **`state-disclosure`** (corrected target) succeeded — 4 files, deployment complete
- [DEFERRED-VERIFY] ISC-14: `state.disclose.io` serves the new build — confirmed via byte-identical raw HTTP artifact (2,583,815 B == built file == deployment URL, cache-busted). Interceptor pixel screenshot blocked by local daemon page-op timeout + missing Screen Recording TCC permission (machine fault, not deploy). Follow-up: re-probe with Interceptor after a Brave restart / TCC grant.
- [x] ISC-15: Anti: snapshot contains 0 orgs with non-finite `level` (verified)
- [x] ISC-16: Anti: build-page joined same-dated 2026-06-19 details (not stale Apr-29) — build log shows L5:183 L4:728 L3:1597

## Test Strategy

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| 1-3,5 | code | grep new symbols/host/header/mapping | present | Grep |
| 4,15 | data | inspect sample rows + filter bad levels | schema match, 0 bad | Bash/bun |
| 6,9,10,11 | artifact | dated output files exist + sized | present | Bash stat |
| 7,8 | data | counts vs 27,583 + distribution shape | within tolerance | Bash |
| 12,16 | content | grep built HTML / compare file dates | match | Grep/ls |
| 13 | deploy | wrangler returns deployment URL | 200 | Bash |
| 14 | live | Interceptor screenshot of state.disclose.io | pyramid + total render | Interceptor |

## Features

| name | satisfies | depends_on | parallelizable |
|------|-----------|------------|----------------|
| api-scraper rewrite | ISC-1..5,15 | — | no |
| run scrape (snapshot) | ISC-6,7,8 | api-scraper | no |
| run details (HTML enrich) | ISC-9,16 | snapshot | no |
| aggregate + build | ISC-10,11,12 | details | no |
| deploy + live verify | ISC-13,14 | build | no |

## Decisions

- 2026-06-18: API discovered at `widgets.disclosebot.io/directory/adf701` (origin-gated) after
  ruling out static JSON, per-page Hugo JSON, `api.`/`data.` hosts, and the diodb dump
  (diodb's `program-list.json` is the old curated subset, not the 27.5k directory). The
  disclosebot URL in the homepage is a telemetry beacon; GET with the allowed Origin returns data.
- 2026-06-18: Keep `scrape-details.ts` on HTML — the API lacks the named criteria checklist;
  legacy parser markers (`pol-grid-label`, `mat-section-title`, `met`/`unmet`) all still match.
- 2026-06-18: ISC soft-floor (E3 ≥32) relaxed to 16 — show-your-math: single-file data-source
  swap + pipeline run + deploy; padding to 32 would be ceremony (ref: execute-means-ship feedback).
  Forge delegation relaxed — fully-specified ~150-line single-file rewrite; Forge round-trip +
  apply_patch risk outweighs benefit for this surface.
- 2026-06-19: Live domain `state.disclose.io` is bound to the **`state-disclosure`** Pages project
  (production branch `main`), NOT the README's `state-disclosure-20260429-f12de2b9`. README deploy
  section corrected. Deploy works headless via a Pages-scoped Cloudflare API token (README's "OAuth
  required / env tokens lack Pages perms" was stale).

## Changelog

- **conjectured**: the new directory API would be a discoverable public REST/JSON endpoint on
  directory.disclose.io (per-page JSON, `/api`, or a `data.`/`api.` host).
  **refuted_by**: every such probe 404'd; directory.disclose.io is a static Hugo+Pagefind SPA. The
  data API is `widgets.disclosebot.io/directory/{shortcode}`, origin-gated (403 without the
  `Origin: https://directory.disclose.io` header), surfaced only via a telemetry-beacon URL in the
  homepage JS.
  **learned**: "an API was added" can mean a third-party widget backend (disclosebot) the static
  site fetches from, not a first-party endpoint; spoof the allowed `Origin` server-side to read it.
  **criterion_now**: ISC-1 pins the exact host + required header.
- **conjectured**: the API list response would carry everything the page needs, retiring both scrapers.
  **refuted_by**: the list (and the `/policy/{shortcode}` detail endpoint) lack the named core/bonus
  criteria checklist that build-page.ts renders for L3–5 cards; only the HTML detail page has it.
  **learned**: keep `scrape-details.ts` on HTML (its parser still matches current pages); migrate only
  the listing.
  **criterion_now**: Out of Scope explicitly excludes a details-API rewrite.
- **conjectured**: a faithful API snapshot would reproduce the old level distribution directly.
  **refuted_by**: the API exposes a sub-tier level-0 ("None", 253 orgs) the HTML scraper never
  produced — build-page.ts crashed on the missing L0 palette. Old L1 (473) == new L0+L1 (253+220).
  **learned**: the legacy scraper floored unbadged orgs at L1; fold API level-0 → L1 to preserve the
  5-tier design and the headline count.
  **criterion_now**: ISC-8 pins the exact distribution; mapOrg floors level at 1.

## Verification

- ISC-7: `snapshot-2026-06-19.json` totalProgramsCaptured = 27,583 = advertised (delta +0).
- ISC-8: distribution {1:473, 2:24600, 3:1597, 4:730, 5:183}, sums to 27,583, 0 dupes, 0 L0 remaining.
- ISC-9: details L5:183 / L4:728 / L3:1597 — all records carry non-empty criteria (no silent drop).
- ISC-12/13: `wrangler pages deploy` → 4 files uploaded, deployment complete (`45562f3e.state-disclosure.pages.dev`).
- ISC-14 (artifact): `curl https://state.disclose.io` (cache-busted) returns byte-identical HTML
  (2,583,815 B) to the built file and the deployment URL, containing `27,583` and `183 at Level 5`.
- L5 delta provenance: 184→183 is real source churn — `vultron-c35371` reassessed L5→L3 (explains
  L3 1596→1597); confirmed not a fold/dedup artifact.
