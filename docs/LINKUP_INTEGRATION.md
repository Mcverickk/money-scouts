# Linkup — Integration Detail

Findings from an audit of the live Linkup documentation (2026-07-12) against the shared
evidence adapter's needs (`packages/integrations/src/linkup.ts`, plan §4.5). Verified via
Linkup's docs MCP server — registered in `.mcp.json` (`linkup-docs`,
`https://docs.linkup.so/mcp`). (Tip: the `api-reference/*` pages there are mostly empty
stubs; the real content is under `/pages/documentation/`.)

**Bottom line: `/search` covers evidence discovery and `/fetch` covers corroborating a
specific URL. One real gap: results carry no publish timestamps — freshness must be enforced
by us, not read from the API.**

## Auth and SDK

- `Authorization: Bearer $LINKUP_API_KEY` on every request. Key from app.linkup.so (free tier).
- Official JS SDK: `linkup-sdk` (`new LinkupClient({ apiKey })`, `client.search({...})`) —
  or plain `fetch`; the API is a single JSON POST.
- No-key fallback exists (x402 pay-per-request in USDC) — irrelevant for us, we'll have a key.
- Rate limit: **10 queries/second per organization** across Search + Fetch. Fine for our
  cadence, but it is the tightest limit in the stack — the evidence adapter should serialize
  per-market queries rather than fanning out dozens at once.

## `POST https://api.linkup.so/v1/search` (`fetchFreshEvidence`)

Required: `q` (natural-language; instructions inside the query are followed literally in
agentic modes), `depth`, `outputType`.

### Depth — the latency lever

| depth | Behavior | Latency | Use in Edge Desk |
| --- | --- | --- | --- |
| `fast` | No LLM, no reinterpretation; query straight to index | <1s | **Hot path**: corroborate a Sports-WS trigger during a live match |
| `standard` | Single-iteration agentic search, parallel sub-searches | 1–3s | Default: evidence gathering for the specialist |
| `deep` | Multi-iteration search+scrape | 5–30s | Never in the alert path; offline eval/research only |

### Output type

| outputType | Returns | Use |
| --- | --- | --- |
| `searchResults` | `results[]: {type:'text', name, url, content, favicon}` | **Default** — raw snippets for the evidence table; cheapest |
| `sourcedAnswer` | `answer` + `sources[]` (`snippet`) | Only if we want Linkup's own summarization (we don't — specialists summarize) |
| `structured` | JSON per `structuredOutputSchema` (+`sources` if `includeSources=true`) | Tempting for direct-to-`evidence`-rows extraction; adds LLM latency — bench before adopting |

### Filters

- `fromDate` / `toDate` — ISO `YYYY-MM-DD`. **Date granularity only** — for a live match,
  `fromDate = today` is the maximum precision available.
- `includeDomains` / `excludeDomains` (≤100 domains) — this is how we implement the plan's
  `sourceTier`: an allowlist of trusted sports outlets per category = `primary`/`secondary`
  tiers by construction rather than by classification.
- `maxResults` — cap it (5–10); we only need corroboration, not coverage.

### The freshness gap (design consequence)

Search results include **no `publishedAt` field** — only `{name, url, content}`. The plan's
evidence contract (§4.5) and `packages/contracts` `EvidenceItem.publishedAt` assume one. For
Linkup-sourced evidence:

- `retrievedAt` = our clock at ingestion (authoritative, always present).
- `publishedAt` = best-effort: parse from page content/URL when present, else null —
  **treat as nullable at ingestion**; do not fabricate it.
- Freshness gating (matcher's `maxEvidenceAgeSeconds`) must key on the *event-to-retrieval*
  window (`fromDate` filter + `retrievedAt`), not on claimed publish times.
- This is a contracts-seam nuance — announce before changing `EvidenceItem`.

## `POST /v1/fetch` — corroborate one URL

Real-time page-to-markdown extractor (HTML + PDF): `{url, renderJs?, includeRawHtml?,
extractImages?}`. Use when the specialist needs the full text behind a specific search hit
(e.g., confirming a goal report). Docs recommend `renderJs: true` by default in agentic
pipelines ($0.005 vs $0.001 without); no auth walls — public pages only; >20 MB → 400.

## Cost per alert cycle (for the rubric's cost/latency line)

Polymarket reads are free. Evidence: 1–2 `fast`/`standard` `searchResults` calls =
**$0.005–0.01**, optional `fetch` +$0.001–0.005. With model-assisted extraction/explanation
on top, a full trigger→alert cycle stays well under the L5 target of $0.10 — capture the
actual numbers in `run_steps.cost_usd` and show them from the trace, not as a claim.

## Errors worth handling

`401` bad/missing key · `429` rate limit **or insufficient credits** (same code — check the
account's credit balance when 429s persist) · `402` only in the no-key x402 flow.

## Adapter mapping

| Plan capability (§4.5) | Linkup call |
| --- | --- |
| Discover fresh evidence for a trigger | `search` `depth=fast` (live) / `standard`, `outputType=searchResults`, `fromDate=today`, domain allowlist, `maxResults≈8` |
| Corroborate a specific source | `fetch` with `renderJs=true` |
| Source tiering | `includeDomains` allowlists per tier |
| Geopolitics/crypto specialists (post-MVP) | same contract, different domain allowlists |
