# state-of-disclosure

A living one-page snapshot of the disclose.io ecosystem — every organisation in `directory.disclose.io` mapped against the disclose.io security maturity model, plus the canonical archive of legal threats against researchers, the registry of bug-bounty/VDP platforms, and the rest of the disclose.io stack.

The build sweeps `directory.disclose.io` for all ~27.5k programs, fetches detail-page criteria for the higher-tier ones (L3–L5), parses the `disclose/research-threats` and `disclose/bug-bounty-platforms` READMEs, and emits a single self-contained HTML page (~2.4 MB) that can be hosted anywhere static.

**Live staging:** [`state-disclosure-20260429-f12de2b9.pages.dev`](https://state-disclosure-20260429-f12de2b9.pages.dev/) (unlisted).

---

## What's on the page

| Section | What it is |
|---|---|
| Pyramid | All 27,583 orgs as bubbles, stacked into the 5 maturity levels — click for criteria, contacts, links |
| Demo | A 36-second no-narration walkthrough of `policymaker.disclose.io` with a "build your policy" CTA |
| Three roles | Audience-targeted CTAs for researchers, vendors, and operators |
| Threats | Bubble-vs-timeline visualization of the ~91 confirmed legal threats against researchers, with grey rings for the ~19 pending submissions; the table below expands inline |
| SRLDF | Bridge band pointing affected researchers to the Security Research Legal Defense Fund |
| Platforms | All ~85 bug bounty / VDP platforms as cards, sorted alphabetically |
| Ecosystem | The full disclose.io stack — policymaker, directory, lookup, vault, community, blog |
| Footer | Open-source attribution, source-data links, snapshot timestamp, "About this snapshot" methodology |

---

## Run it

Requires [Bun](https://bun.sh).

```bash
# 1. Sweep the directory via the disclosebot JSON API for all programs (~5 min, resumable)
#    API: widgets.disclosebot.io/directory/adf701?page=N — origin-gated (sends the
#    `Origin: https://directory.disclose.io` header), perPage locked at 25 → 1,104 pages.
#    maturity{level,score,label} comes inline; API level-0 ("None") is folded into L1 to
#    match the directory's 5-tier pyramid. The old HTML listing scrape is retired.
bun run src/scrape.ts

# 2. Fetch detail pages for L5 → L4 → L3 (~30 min, resumable per level)
bun run src/scrape-details.ts

# 3. Parse READMEs + emit aggregate counts JSON
bun run src/aggregate.ts

# 4. Generate the self-contained HTML page
bun run src/build-page.ts
```

The build also reads:
- `~/Projects/disclose-io-hugo/external/research-threats/README.md` — confirmed-threats table
- `~/Projects/disclose-io-hugo/external/bug-bounty-platforms/README.md` — platforms table
- `data/threats-pending.json` — open issues from `disclose/research-threats`, refreshed via:
  ```bash
  gh issue list -R disclose/research-threats --state open \
    --json number,title,labels,createdAt,url,body --limit 100 > data/threats-pending.json
  ```

Output lands at `output/state-of-disclosure.html`. Drop it on any static host.

---

## Deploy

The live custom domain **`state.disclose.io`** is bound to the Cloudflare Pages project
**`state-disclosure`** (production branch `main`) — NOT the older
`state-disclosure-20260429-f12de2b9` staging project. Deploy to `state-disclosure` or the
live site won't change.

```bash
# Stage assets (regenerated index + the video, poster, and SRLDF logo)
mkdir -p /tmp/sod-deploy
cp output/state-of-disclosure.html /tmp/sod-deploy/index.html
cp output/policymaker-demo.mp4    /tmp/sod-deploy/
cp output/policymaker-demo.jpg    /tmp/sod-deploy/
cp output/srldf-logo.svg          /tmp/sod-deploy/

# Deploy with a Pages-scoped Cloudflare API token (works headless — no OAuth needed).
# Requires CLOUDFLARE_API_TOKEN (Pages → Edit) and CLOUDFLARE_ACCOUNT_ID in the environment.
CLOUDFLARE_API_TOKEN="$CF_PAGES_EDIT_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
  bunx wrangler pages deploy /tmp/sod-deploy \
    --project-name=state-disclosure --branch=main --commit-dirty=true
```

---

## Project layout

```
diostatus-snapshot/
├── README.md
├── PRD.md                      # product requirements + design rationale
├── package.json                # bun workspace
├── tsconfig.json
├── src/
│   ├── scrape.ts               # paginated sweep of directory.disclose.io
│   ├── scrape-details.ts       # per-org detail-page fetcher (L5 → L4 → L3)
│   ├── aggregate.ts            # bucket by level, emit counts JSON
│   ├── render.ts               # legacy bar-chart renderer (early prototype)
│   └── build-page.ts           # the single source of truth for the page
├── data/
│   ├── snapshot-YYYY-MM-DD.json     # full directory snapshot
│   ├── details-l{3,4,5}-YYYY-MM-DD.json  # per-org detail enrichment
│   ├── counts-YYYY-MM-DD.json       # aggregate counts by level
│   └── threats-pending.json         # open GH issues on research-threats
├── output/
│   ├── policymaker-demo.mp4         # 36s walkthrough (committed; re-recorded with src/record-demo.ts if changed)
│   ├── policymaker-demo.jpg         # poster frame
│   ├── srldf-logo.svg               # vendored from srldf.org
│   └── state-of-disclosure.html     # gitignored — regenerated by build-page.ts
└── .gitignore
```

---

## Re-recording the policymaker demo

The demo MP4 is committed because re-recording requires Playwright and the live policymaker site, but it's straightforward:

```bash
bun run src/record-demo.ts
ffmpeg -y -i /tmp/pm-video/*.webm -c:v libx264 -preset slow -crf 26 \
  -movflags +faststart -pix_fmt yuv420p -an output/policymaker-demo.mp4
ffmpeg -y -i output/policymaker-demo.mp4 -ss 12 -frames:v 1 output/policymaker-demo.jpg
```

---

## Analytics

GA4 measurement ID `G-NJQTCTSYCM` (the same property as the rest of disclose.io), with cross-domain linker covering `disclose.io`, `directory.disclose.io`, `policymaker.disclose.io`, `lookup.disclose.io`, `community.disclose.io`, `blog.disclose.io`, and `vault.disclose.io`. Skipped on `file://` and `*.local` hosts.

Custom events:
- `audience_cta_click`, `ecosystem_card_click`, `contributor_cta_click`, `contrib_strip_click`
- `demo_video_play`, `demo_video_complete`, `demo_cta_click`
- `srldf_cta_click`
- `threat_row_expand`, `pending_threat_click`, `timeline_bubble_click`
- `back_to_top_click`
- `outbound` (with `link_class` taxonomy: `disclose-io | github-framework | github | platform | social | ally | other`)

---

## Contributing

Two upstream datasets feed this page; both are open-source and welcome contributions:

- [`disclose/research-threats`](https://github.com/disclose/research-threats) — submit, research, or correct entries in the threat archive
- [`disclose/bug-bounty-platforms`](https://github.com/disclose/bug-bounty-platforms) — add a platform we missed or fix a broken link

For changes to this page itself (sections, copy, layout), open an issue or PR here. See [`PRD.md`](PRD.md) for design rationale and goals.

---

## License

MIT. The vendored `srldf-logo.svg` is the property of the Security Research Legal Defense Fund and used here for attribution.
