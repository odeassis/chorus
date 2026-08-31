# Global Search — Technical Design

**Version**: 2.0
**Updated**: 2026-08-17

---

## 1. Overview

Chorus Global Search provides unified search across 6 entity types: Task, Idea, Proposal, Document, Project, and Project Group. Users and AI agents can quickly locate any entity via the REST API, MCP tool, or the Cmd+K command palette UI.

## 2. Architecture

```
┌─────────────────────────────────────────────────┐
│  Frontend (global-search.tsx)                    │
│  Cmd+K Dialog · Filter Tabs · Keyboard Nav      │
│  Scope Selector (Global / Group / Project)       │
└──────────────────┬──────────────────────────────┘
                   │ GET /api/search?q=...&scope=...
                   ▼
┌─────────────────────────────────────────────────┐
│  REST API (api/search/route.ts)                  │
│  Auth · Param Validation · Scope Resolution      │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  Search Service (search.service.ts)              │
│  6 parallel raw SQL candidate queries            │
│  Graph expansion · Snippet Generation · Counts   │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────┐
│  Ranker (search-ranking.ts) — pure, no DB        │
│  RRF fusion · Authority multiplier · Explain     │
└──────────────────┬──────────────────────────────┘
                   │
    ┌──────────────┼──────────────┐
    ▼              ▼              ▼
┌────────┐  ┌──────────┐  ┌───────────┐
│  Task  │  │   Idea   │  │ Proposal  │  ...
│  table │  │   table  │  │   table   │
└────────┘  └──────────┘  └───────────┘

┌─────────────────────────────────────────────────┐
│  MCP Tool (chorus_search)                        │
│  Registered in public.ts · All roles             │
│  Same search.service.search() backend            │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│  OpenClaw Plugin (common-tools.ts)               │
│  Proxy tool → mcpClient.callTool()               │
└─────────────────────────────────────────────────┘
```

## 3. Searchable Entities & Fields

| Entity | Search Fields | Status Field | Scope Filtering |
|--------|--------------|--------------|-----------------|
| Task | title, description | status | projectUuid |
| Idea | title, content | status | projectUuid |
| Proposal | title, description | status | projectUuid |
| Document | title, content | type (as status) | projectUuid |
| Project | name, description | "active" (fixed) | uuid directly |
| Project Group | name, description | "active" (fixed) | uuid directly |

## 4. Search Strategy

Results are **relevance-ranked**. Candidates come from several independent
streams, are fused by Reciprocal Rank Fusion, and are then adjusted by a bounded
authority multiplier before truncation. All scoring logic lives in
`search-ranking.ts`, which is pure and has no database access; `search.service.ts`
generates candidates and orchestrates.

### 4.1 Candidate Streams

| Stream | Source | Ordered by | Weight |
|--------|--------|-----------|--------|
| `fts` | `to_tsvector('simple', title ‖ body) @@ to_tsquery(…)` | `ts_rank_cd(…, 32)` desc | 1.0 |
| `substring` | `title ILIKE '%q%' OR body ILIKE '%q%'` | `updatedAt` desc | 1.0 |
| `graph` | One hop along AI-DLC lineage | seed rank | 0.5 |

A canonical-UUID query keeps its own exact-lookup fast path and returns before
any ranking runs.

**Why the substring stream is retained.** Postgres' bundled text-search parsers
do not segment Chinese, Japanese or Korean, and `zhparser` / `pgroonga` are not
available under the embedded PGlite build. Full-text search alone would therefore
regress three of Chorus' four shipped locales. Keeping ILIKE as a peer stream
makes the previous behaviour the floor: every result the substring-only
implementation found is still found, and full-text only adds to it.

**Why terms are OR-ed, not AND-ed.** `websearch_to_tsquery` would AND the terms,
so a four-word query where three words match would return nothing — strictly
worse than what it replaces. `buildTsQuery` instead emits
`'term1' | 'term2' | 'term3':*`, and `ts_rank_cd(…, 32)` normalises by matched
unique-word count, so a row matching every term still outranks one matching a
single term while partial matches degrade gracefully. The final term carries a
`:*` prefix marker so the Cmd+K palette matches mid-word as the user types.

Terms are hand-quoted after stripping every tsquery operator character, so user
punctuation can never be parsed as query syntax. A query yielding no usable term
falls back to a valid-but-never-matching sentinel lexeme, because Postgres
rejects an empty tsquery and may evaluate `to_tsquery` even when a boolean guard
would short-circuit it.

### 4.2 Graph Expansion

Seeded from the top 10 direct hits, capped at 20 neighbours total. Every hop
rides an existing index:

| Seed | Hop | Column |
|------|-----|--------|
| Task, Document | → its Proposal | `proposalUuid` |
| Proposal | → its Tasks and Documents | `proposalUuid` |
| Idea | ↔ parent and child Ideas | `parentUuid` |
| Task | ↔ dependency neighbours | `TaskDependency` |

The **Idea → Proposal** direction is deliberately absent: `Proposal.inputUuids`
is an unindexed JSON array, so a containment scan per search would cost more than
the edge is worth. Task and document hits still reach their proposal, which
covers the common path.

At half weight, a neighbour that never matched the query text cannot outrank a
direct textual hit.

### 4.3 Authority Adjustment

A **bounded multiplier**, clamped to `[0.6, 1.4]` — authority nudges ordering, it
never filters. A targeted search for a rejected proposal must still find it, so
no factor combination can zero a candidate out.

| Entity | Signal | Deltas |
|--------|--------|--------|
| Proposal | `status` | approved +0.20, revised/pending +0.05, draft −0.10, rejected −0.25 |
| Task | `status` | done +0.15, to_verify/in_progress +0.05, closed −0.20 |
| Idea | `status` | elaborated +0.15, elaborating +0.05 |
| Document | `type` | adr +0.20, tech_design/prd +0.15 |
| All | recency | up to +0.10, decaying with a 60-day constant |

Document authority reads `type` rather than `status` because Document has no
status column, and its type is precisely the "is this a durable decision record?"
signal — the Chorus analogue of a decisions namespace.

Recency is included so the one thing the previous `updatedAt`-only ordering got
right survives: something touched this morning edges out an equally relevant
year-old row. It is bounded and smooth, so it never becomes the sort key.

### 4.4 Indexing — a deliberate follow-up

The full-text predicate currently runs **without a supporting index**. Expression
GIN indexes cannot be expressed in `schema.prisma`, so adding them means the
project's first hand-written migration SQL plus permanent Prisma drift to manage;
that was scoped out of the ranking change rather than rushed into it.

Every statement is bounded by `companyUuid` and a candidate `LIMIT`
(`limit × 5`, capped at 200), so the sequential scan is proportional to one
tenant's rows, not the whole table.

**When this stops being acceptable:** budget roughly 1 ms per 1 000 rows scanned
per entity type. Below ~10 000 rows per tenant per table the scan is not
measurable next to Next.js and network overhead. Past ~50 000 — or as soon as
p95 search latency clears ~200 ms — add the indexes:

```sql
CREATE INDEX CONCURRENTLY "Task_fts_idx" ON "Task"
  USING GIN (to_tsvector('simple',
    coalesce("title", '') || ' ' || coalesce("description", '')));
```

The expression must match the query's expression **exactly** for the planner to
use it. Repeat per entity table, and verify against PGlite as well as
Postgres/Aurora before shipping — GIN-on-expression under the embedded WASM build
is unverified.

### 4.5 Explain

Pass `explain: true` (REST `?explain=true`, or the MCP tool's `explain` input) to
attach ranking provenance to every result: which streams matched, at what rank,
each stream's contribution, the RRF subtotal, and every authority factor with its
delta. It is off by default — diagnostic payload should not spend an agent's
context budget unasked.

```json
{
  "streams": [
    { "stream": "fts", "rank": 1, "contribution": 0.016393 },
    { "stream": "substring", "rank": 3, "contribution": 0.015873 }
  ],
  "rrfScore": 0.032266,
  "authority": {
    "multiplier": 1.3,
    "factors": [
      { "name": "status:approved", "delta": 0.2 },
      { "name": "recency", "delta": 0.1 }
    ]
  },
  "finalScore": 0.041946
}
```

## 5. Scope System

Three scope levels control the search boundary:

| Scope | Behavior | Parameter |
|-------|----------|-----------|
| `global` | All entities in the company | None |
| `group` | All projects within a Project Group | `scopeUuid` = group UUID |
| `project` | Single project | `scopeUuid` = project UUID |

### Scope Resolution

```
global  → no projectUuid filter
group   → resolveGroupProjects(groupUuid) → projectUuid IN [...]
project → projectUuid = scopeUuid
```

For `group` scope, the service first queries all project UUIDs belonging to the group, then uses `projectUuid: { in: [...] }` for filtering. Project and Project Group entities have their own scope logic (e.g., project scope returns only that project if it matches).

### Scope Intelligence (UI)

The frontend automatically selects the default scope based on the current page:

| Current Page | Default Scope |
|-------------|---------------|
| `/projects` (global) | Global |
| `/project-groups/{uuid}` | Group (with group name) |
| `/projects/{uuid}/*` | This Project (with project name) |

Users can manually switch scope via the dropdown in the search header.

## 6. API Design

### 6.1 REST API

```
GET /api/search?q=keyword&scope=global&scopeUuid=xxx&types=task,idea&limit=20
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | Yes | - | Search query |
| `scope` | enum | No | `global` | `global` \| `group` \| `project` |
| `scopeUuid` | string | No | - | Required when scope is `group` or `project` |
| `types` | string | No | all | Comma-separated: `task,idea,proposal,document,project,project_group` |
| `limit` | number | No | 20 | Max results (1-100) |
| `explain` | boolean | No | `false` | `true` attaches ranking provenance per result (§4.5) |

**Response**:

```json
{
  "success": true,
  "data": {
    "results": [
      {
        "entityType": "task",
        "uuid": "...",
        "title": "...",
        "snippet": "...matched context...",
        "status": "in_progress",
        "projectUuid": "...",
        "projectName": "...",
        "updatedAt": "2026-03-20T...",
        "score": 0.041946
      }
    ],
    "counts": {
      "tasks": 3, "ideas": 2, "proposals": 1,
      "documents": 4, "projects": 1, "projectGroups": 1
    }
  }
}
```

`score` is the fused relevance score, comparable **only within one response**.
Exact-UUID lookups bypass ranking and report `0`. `counts` reports total matches
per type (from a `count(*) OVER ()` window), so it can legitimately exceed the
number of returned results.

### 6.2 MCP Tool

```
chorus_search({
  query: "keyword",
  scope?: "global" | "group" | "project",
  scopeUuid?: "uuid",
  entityTypes?: ["task", "idea", "proposal", "document", "project", "project_group"],
  explain?: false
})
```

Registered in `public.ts` — available to all agent roles (PM, Developer, Admin).

## 7. Search Execution

### 7.1 Parallel Candidate Queries

One raw SQL statement per requested entity type, all in parallel via
`Promise.all()`. Each statement does four things in a single pass, so the two
lexical streams cost one query rather than two:

- evaluates the full-text predicate and returns `ts_rank_cd` as `ftsRank`
- evaluates the ILIKE predicate and returns it as the boolean `likeMatch`
- returns the total match count via `count(*) OVER ()`
- returns `linkUuid` (the parent proposal, or parent idea) so upward graph hops
  need no extra query

The `WHERE` clause is the **disjunction** of the two predicates, so at least one
of `ftsRank > 0` / `likeMatch` holds for every returned row. Rows come back
ordered `ftsRank DESC, updatedAt DESC` and are capped at `limit × 5` (max 200),
so truncation keeps the best candidates.

A single `isGlobal::boolean` parameter lets one static statement serve both the
scoped and unscoped case, and scope lists are passed as
`= ANY($n::text[])` — which, unlike a generated `IN` list, handles the
empty-array case (a group with no projects) correctly.

### 7.2 Fusion, Expansion & Truncation

1. Each stream is ordered independently **across all entity types**, so a task and
   a document compete on the same footing.
2. `rankCandidates` fuses and sorts (see §4.1, §4.3).
3. The top 10 form the seed set for graph expansion; neighbours are appended as
   the `graph` stream.
4. Everything is re-ranked, then truncated to `limit`.

Ties are broken by `updatedAt` descending, giving a total and stable order — which
matters for the Cmd+K palette, where an unstable order would make keyboard
selection jump under the user.

### 7.3 Snippet Generation

For each result, a ~100 character snippet is extracted around the first match position:

1. Find the match position in the text (case-insensitive)
2. Calculate a window centered on the match
3. Adjust start to a word boundary if possible
4. Add ellipsis markers (`...`) when truncated

If the query doesn't match in the description/content, the beginning of the text is returned instead.

## 8. Frontend Design

### 8.1 Cmd+K Command Palette

The search UI is a Dialog-based command palette, inspired by Linear and Notion:

- **Trigger**: Sidebar button (desktop) / Header icon (mobile) / `Cmd+K` keyboard shortcut
- **Search Header**: Input field + Scope selector dropdown
- **Filter Tabs**: All / Tasks / Ideas / Proposals / Documents / Projects (server-side filtering)
- **Results List**: Scrollable list with keyboard navigation
- **Footer**: Keyboard hints (desktop only)

### 8.2 Keyboard Navigation

| Key | Action |
|-----|--------|
| `Cmd+K` / `Ctrl+K` | Open search dialog |
| `Esc` | Close dialog |
| `↑` / `↓` | Navigate results |
| `Enter` | Open selected result |

Selected result is visually highlighted and auto-scrolls into view.

### 8.3 Filter Tabs (Server-Side)

Clicking a filter tab sends a new API request with `types=<selected_type>`, returning up to 20 results of that specific type. This ensures the user sees the full Top 20 of each type, not just what happened to be in the mixed Top 20.

### 8.4 Responsive Design

| Aspect | Desktop | Mobile |
|--------|---------|--------|
| Trigger | Sidebar button with text + ⌘K badge | Header icon button |
| Dialog position | `top: 20%` | `top: 1rem` |
| Dialog width | `max-w: 600px` | `100vw - 2rem` |
| Footer hints | Visible | Hidden |
| Filter tabs | Inline | Horizontally scrollable |

### 8.5 Navigation

Clicking a result navigates to the entity's detail page:

| Entity Type | Route |
|-------------|-------|
| Task | `/projects/{projectUuid}/tasks/{taskUuid}` |
| Idea | `/projects/{projectUuid}/ideas/{ideaUuid}` |
| Proposal | `/projects/{projectUuid}/proposals/{proposalUuid}` |
| Document | `/projects/{projectUuid}/documents/{documentUuid}` |
| Project | `/projects/{projectUuid}/dashboard` |
| Project Group | `/projects` |

## 9. File Map

| File | Purpose |
|------|---------|
| `src/services/search.service.ts` | Candidate generation, graph expansion, orchestration, snippets |
| `src/services/search-ranking.ts` | RRF fusion, authority scoring, tsquery/LIKE parsing — pure, no DB |
| `src/services/__tests__/search.service.test.ts` | Unit tests (mocks `$queryRaw`) |
| `src/services/__tests__/search-ranking.test.ts` | Ranker unit tests |
| `src/services/__tests__/search-sql.integration.test.ts` | Real-Postgres SQL verification; skipped unless `SEARCH_REAL_DB_URL` is set |
| `src/app/api/search/route.ts` | REST API endpoint |
| `src/components/global-search.tsx` | Cmd+K dialog component |
| `src/app/(dashboard)/layout.tsx` | Search trigger integration |
| `src/mcp/tools/public.ts` | `chorus_search` MCP tool |
| `packages/openclaw-plugin/src/tools/common-tools.ts` | OpenClaw proxy tool |
| `messages/en.json` / `messages/zh.json` | i18n keys under `search.*` |
| `docs/design.pen` | UI mockup (frame: "Chorus - Global Search") |

## 10. Multi-tenancy

All search queries are scoped by `companyUuid` from the authenticated user's `AuthContext`. No cross-tenant data leakage is possible — every candidate statement carries `companyUuid` as a mandatory `WHERE` predicate, and every graph-expansion lookup passes it too.

Because candidate generation uses raw SQL, two rules are load-bearing:

- **Every interpolated value goes through a `$queryRaw` tagged template**, never string concatenation, so all values are parameterised by the driver.
- **The tsquery is built by `buildTsQuery`**, which strips every tsquery operator character and then hand-quotes each term. User text therefore cannot be parsed as query syntax, and cannot escape its quoting.

`search-sql.integration.test.ts` asserts the tenant boundary against a real database, not just against mocks.
