# PRD — The State of Vulnerability Disclosure

**Status:** Live on unlisted staging, awaiting decision on whether to embed in disclose.io main site.
**Owner:** Casey Ellis
**Last updated:** 2026-04-30

---

## 1. Problem

The disclose.io project has, over a decade, accumulated a remarkable amount of public infrastructure: a live directory of ~27,500 organisations, a maturity model, a policy generator, a security-contact lookup, a threat archive, a platforms registry, a coordinated-disclosure vault, and a forum. Each of these lives at its own subdomain or repo. There is no single page that:

1. Shows **how the ecosystem is doing** — concretely, where the 27k+ orgs sit on the maturity model, how often researchers get sued, how many platforms exist.
2. Routes **whoever you are** (researcher, vendor, operator, contributor, policy-maker) to the right next action.
3. Frames the **open-source data** behind the project as something maintained by a community, not a black box.

Without this, the disclose.io ecosystem is a constellation of tools that experts know how to navigate. Newcomers — especially the vendors and operators who most need policymaker.disclose.io — bounce off.

## 2. Goals

| # | Goal | How we measure |
|---|---|---|
| G1 | Make the **scale of the ecosystem visceral** — the 24,600 orgs at L2, the 184 at L5, the 91 documented threats — without anyone having to read a chart axis | Dwell time on the pyramid, scroll depth past it |
| G2 | Convert visitors into **next-action takers** — get vendors to policymaker, researchers to lookup, operators to attest in the directory | Click-through on the audience cards & ecosystem cards (`audience_cta_click`, `ecosystem_card_click`) |
| G3 | Surface the **community-maintained data** so contributors can find their way in | `contrib_strip_click`, `contributor_cta_click` events |
| G4 | Give **threatened researchers** a clear path to legal aid | `srldf_cta_click` events |
| G5 | Make the page **embeddable, forkable, and durable** — survive a maintainer change without rotting | Single-file HTML output, no build-time servers, regeneratable from open-source data alone |

## 3. Non-goals

- A real-time dashboard. The directory updates often; a live-fetched bubble for every program would be slow, unreliable, and fight Cloudflare's bot protection. This is a **snapshot regenerated on demand**.
- A hosted application. No backend, no DB, no auth. One HTML file plus a small handful of static assets.
- Replacement for `directory.disclose.io`. The directory remains the source of truth for individual program data; this page is the **summary surface** above it.
- A trends-over-time visualization (yet). Deferred until we have ≥3 snapshots to compare.
- Any feature that requires API tokens at runtime. Everything in the page is rendered at build time from open-source feeds.

## 4. Audiences & their journeys

### 4.1 Security researchers
- **Land here from**: a tweet, a talk, a friend who got threatened
- **Ask**: "How do I report something? What's safe to test?"
- **Routed to**: `lookup.disclose.io` (audience card, ecosystem card) for asset → contact resolution; SRLDF if currently threatened
- **Secondary**: pyramid filter to find specific orgs by name; threats archive to read precedent

### 4.2 Vendors / defenders (the largest opportunity)
- **Land here from**: SEO ("vulnerability disclosure policy template"), policy advisor, RFP requirement
- **Ask**: "How do I get a defensible VDP without spending six months in legal?"
- **Routed to**: `policymaker.disclose.io` via the audience card AND the inline 36-second video demo (we picked policymaker for the demo specifically because the L2 mass — 89% of the directory — is the largest TAM)
- **Secondary**: ecosystem cards for the rest of the stack once their policy is up

### 4.3 Operators (orgs already running a program)
- **Land here from**: word-of-mouth, the disclose.io blog, a security-team Slack
- **Ask**: "Are we doing this right? How do we level up from L4 to L5?"
- **Routed to**: directory.disclose.io to attest their program; diostatus model docs to see what L5 requires; `dioseal` (future ecosystem entry) for the badge once they're at L4+

### 4.4 Contributors / maintainers
- **Land here from**: GitHub, conferences, "is anyone working on this?" curiosity
- **Ask**: "What's broken? What needs help?"
- **Routed to**: the **above-the-fold contrib strip** with both repo links, plus inline contributor callouts in each section ("Help research the 19 pending →" is the most concrete)
- **Tracked separately so we can measure whether the page generates contribution intent**

### 4.5 Policy makers / journalists / legal
- **Land here from**: research, a citation in a paper, a Substack post
- **Ask**: "Show me the data."
- **Routed to**: the threats timeline (visceral and citable), the open-source READMEs, the methodology disclosure in the footer

## 5. Information architecture

The page is a single scroll, deliberately not a SPA. Order is intentional:

```
1. Hero (claim + 5-card maturity stat-strip + section nav-pill)
2. Above-the-fold contributor strip (open-source signal before anything else)
3. Pyramid (the visceral wall — this is what makes the page worth visiting)
4. Demo (policymaker walkthrough — converts the L2 mass into action)
5. Three roles (audience-targeted CTAs)
6. Threats (table + bubble timeline + pending list + maintainer call)
7. SRLDF (bridge band — "if it happens to you")
8. Platforms (alphabetical card grid + maintainer call)
9. Ecosystem (the rest of the disclose.io stack)
10. Footer (CTA box, source attribution, methodology disclosure)
```

The order reflects narrative momentum: scale → urgency → action → cost-of-inaction → safety net → infrastructure → invitation. Reordering breaks the read.

## 6. Visual system

- **Palette**: extracted directly from `directory.disclose.io/css/main.css` so the page reads as native disclose.io. Brand purple `#673AB6`, deepening to `#4c1d95` for emphasis. Section backgrounds alternate white → `#faf7ff` → `#f3f0ff` → `#ede9fe` → indigo (SRLDF) → near-black (footer) to pace the scroll.
- **Bubbles**: per-tier sizing (L5: 14 px down to L2: 5 px). At L2's volume (24,600), small dots make the wall functional rather than overwhelming. Each is independently clickable (event delegation, not 27k listeners).
- **Threats timeline**: filled purple = confirmed, **grey ring** = pending. We deliberately moved the pending colour from amber to grey because amber read as "warning" — these aren't dangers, they're work waiting to be done.
- **Three CTA tiers**: primary (filled purple), ghost (white-on-purple-border), and the dark-ghost variants used inside the SRLDF section.
- **No external fonts**, no external CSS — everything inline so the page works as a single file.

## 7. Technical architecture

- **Single static HTML output.** ~2.4 MB; one HTTP request. The bubble data is inlined as JSON in a `<script type="application/json">` tag, ~1.7 MB of that.
- **Built by 5 TypeScript files** (`src/scrape.ts`, `src/scrape-details.ts`, `src/aggregate.ts`, `src/build-page.ts`, plus a legacy `render.ts`). All run under Bun. No bundler, no framework.
- **Three data sources**:
  1. `directory.disclose.io` — paginated HTML scraping with the same User-Agent (`lookup.disclose.io/1.0 (directory lookup)`) the lookup tool uses
  2. `disclose/research-threats` README + open issues
  3. `disclose/bug-bounty-platforms` README
- **Resumable**: scrapes write `data/progress.json` every 10 pages; killing and restarting picks up where it stopped.
- **Idempotent**: repeated runs produce identical output if the source data is unchanged.
- **Deployed to**: Cloudflare Pages (unlisted project name with random suffix). Could be moved to disclose.io as a Hugo page or as a subdomain redirect.

## 8. Analytics & success criteria

GA4 (`G-NJQTCTSYCM`) inlined with the same cross-domain linker the rest of disclose.io uses. Custom events listed in the README. Success at 30 days post-launch:

| Metric | Target |
|---|---|
| Unique visitors | ≥1k |
| Median scroll depth | ≥60% (i.e. people reach the threats section) |
| Click-through to `policymaker.disclose.io` | ≥5% of visitors |
| Click-through to `lookup.disclose.io` | ≥3% of visitors |
| Contributor-strip clicks | ≥1% of visitors (proxy for "did this page actually generate contribution intent?") |
| `demo_video_play` rate | ≥15% of visitors who see the demo section |

These are starting hypotheses. Adjust after first dataset.

## 9. Open questions / future work

- **Trends over time.** Once we have ≥3 snapshots, add a small "year-on-year movement" callout: how many orgs climbed a tier, how many slipped, etc.
- **L1 visibility.** L1 (Contact Only) orgs are in the directory but not deeply inspected. Worth a one-off pass to enrich them too.
- **Embed mode.** Strip the hero and footer, serve at `state-of-disclosure.html?embed=1` for use inside iframes. Useful if the disclose.io blog wants to feature it inline.
- **Trend per criterion.** "Standard Template" is the most common gap at L5 (183/183). Worth a dedicated callout: "the one criterion the elite are missing."
- **L5 highlight reel.** 184 orgs is a small enough number to surface a "leaderboard" — top scorers with logos. Deferred because favicon-fetching adds runtime work.
- **State of disclosure as a section on disclose.io itself.** Casey has parked the question of whether this becomes its own subpath on `disclose.io/` (Hugo content + layout) or stays a separate static deployment. Discuss with Daniel & Jeremy before actioning.
- **Localisation.** Policymaker is in 12 languages. Should this page be?
- **RSS / JSON feed.** Each rebuild produces a JSON snapshot. We could publish these for downstream tooling.

## 10. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-29 | Pyramid widths are stylized (level 5 narrowest), bubble counts are real | Tier-rarity reads as a pyramid; population would read as a diamond (L2 dominates) |
| 2026-04-29 | L1 contact-only orgs included, L0 (no contact) excluded | L0 is by definition not in the directory |
| 2026-04-29 | All search/filter UI removed | Casey: "let's keep this static." Static is simpler to maintain and less to break |
| 2026-04-29 | Renamed `state-of-vd.html` → `state-of-disclosure.html` | "VD" is a venereal-disease acronym; avoid |
| 2026-04-30 | Pending-threat bubbles changed from amber → grey | Amber read as "warning"; pending = work-waiting, not danger |
| 2026-04-30 | SRLDF placed as a dark bridge band between threats and platforms, with the canonical SVG logo on a white plate | Bridges the threats archive ("here's the cost") to a service ("here's where to turn") |
| 2026-04-30 | Page hosted on Cloudflare Pages with random-suffix project name | Casey wanted unlisted staging without disrupting other disclose.io properties |
