// src/services/search.service.ts
// Search Service Layer — Unified search across 6 entity types
// UUID-Based Architecture: All operations use UUIDs
//
// RETRIEVAL MODEL
//
// A query is answered from several independent candidate streams, fused by
// Reciprocal Rank Fusion and then adjusted by a bounded authority multiplier
// (see search-ranking.ts, which owns all the scoring logic and is pure):
//
//   fts        Postgres full-text over title + body, ranked by ts_rank_cd.
//              Makes multi-word queries work at all — the previous
//              `contains`-only implementation required the whole query to be
//              one literal substring, so "search ranking" matched nothing.
//   substring  ILIKE '%q%' over the same fields, ordered by recency. Retained
//              deliberately: Postgres' bundled text-search parsers do not
//              segment Chinese/Japanese/Korean, and zhparser/pgroonga are not
//              available under the embedded PGlite build. Dropping this stream
//              would regress three of Chorus' four shipped locales, so it stays
//              as the floor — every result the old implementation found is still
//              found.
//   graph      One hop along AI-DLC lineage (task/document → proposal,
//              proposal → its tasks/documents, idea ↔ child ideas, task ↔ its
//              dependencies). Surfaces the proposal behind a matching task even
//              when the proposal's own text never mentions the query. Weighted
//              at half, so context never outranks a direct textual hit.
//
// A canonical-UUID query keeps its own exact-lookup fast path and returns
// before any of this runs.
//
// PERFORMANCE NOTE
//
// The full-text predicate is evaluated without a supporting index: expression
// GIN indexes cannot be expressed in schema.prisma and would need the project's
// first hand-written migration SQL, which is a deliberate follow-up rather than
// part of this change. Every query is bounded by `companyUuid` and a candidate
// LIMIT, which keeps the sequential scan proportional to one tenant's rows. See
// docs/SEARCH.md §4.4 for the row count at which the index stops being
// optional.

import { prisma } from "@/lib/prisma";
import {
  buildTsQuery,
  escapeLikePattern,
  rankCandidates,
  TSQUERY_NEVER_MATCHES,
  type RankableCandidate,
  type SearchExplain,
  type StreamName,
} from "@/services/search-ranking";

// ===== Type Definitions =====

export type EntityType = "task" | "idea" | "proposal" | "document" | "project" | "project_group";
export type SearchScope = "global" | "group" | "project";

export interface SearchParams {
  query: string;
  companyUuid: string;
  scope?: SearchScope;
  scopeUuid?: string;  // project group UUID or project UUID
  entityTypes?: EntityType[];
  limit?: number;
  /** Include per-result ranking provenance. Off by default — it is diagnostic
   *  payload, and an agent's context budget should not pay for it unasked. */
  explain?: boolean;
  /** Injected clock, so recency scoring is deterministic under test. */
  now?: Date;
}

export interface SearchResult {
  entityType: EntityType;
  uuid: string;
  title: string;
  snippet: string;  // ~100 char excerpt around match
  status: string;
  projectUuid: string | null;  // null for project_group
  projectName: string | null;  // null for project_group
  updatedAt: string;
  /** Fused relevance score. Higher is more relevant; comparable only within
   *  one response. Zero for exact-UUID lookups, which bypass ranking. */
  score: number;
  /** Present only when `explain` was requested. */
  explain?: SearchExplain;
}

export interface SearchCounts {
  tasks: number;
  ideas: number;
  proposals: number;
  documents: number;
  projects: number;
  projectGroups: number;
}

export interface SearchResponse {
  results: SearchResult[];
  counts: SearchCounts;
}

// ===== Tuning constants =====

/** Candidates fetched per entity type before fusion, as a multiple of `limit`. */
const CANDIDATE_OVERFETCH = 5;
/** Hard ceiling on candidates fetched per entity type. */
const CANDIDATE_MAX = 200;
/** Direct hits used to seed the graph stream. */
const GRAPH_SEED_LIMIT = 10;
/** Total neighbours the graph stream may contribute. */
const GRAPH_NEIGHBOUR_LIMIT = 20;

// ===== Helper Functions =====

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emptyCounts(): SearchCounts {
  return {
    tasks: 0,
    ideas: 0,
    proposals: 0,
    documents: 0,
    projects: 0,
    projectGroups: 0,
  };
}

function countKeyFor(type: EntityType): keyof SearchCounts {
  switch (type) {
    case "task": return "tasks";
    case "idea": return "ideas";
    case "proposal": return "proposals";
    case "document": return "documents";
    case "project": return "projects";
    case "project_group": return "projectGroups";
  }
}

// Generate snippet: extract ~100 chars around the first match position
function generateSnippet(text: string, query: string, maxLength = 100): string {
  if (!text) return "";

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  if (matchIndex === -1) {
    // No match found, return beginning
    return text.substring(0, maxLength) + (text.length > maxLength ? "..." : "");
  }

  // Calculate start position (try to center the match)
  const halfLength = Math.floor(maxLength / 2);
  let start = Math.max(0, matchIndex - halfLength);

  // Adjust start to avoid cutting words if possible
  if (start > 0) {
    const spaceIndex = text.lastIndexOf(" ", start + 10);
    if (spaceIndex > start && spaceIndex < start + 20) {
      start = spaceIndex + 1;
    }
  }

  let snippet = text.substring(start, start + maxLength);

  // Add ellipsis
  if (start > 0) snippet = "..." + snippet;
  if (start + maxLength < text.length) snippet = snippet + "...";

  return snippet.trim();
}

// Resolve project UUIDs for a group scope
async function resolveGroupProjects(companyUuid: string, groupUuid: string): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: { companyUuid, groupUuid },
    select: { uuid: true },
  });
  return projects.map(p => p.uuid);
}

async function searchExactUuid(
  companyUuid: string,
  uuid: string,
  typesToSearch: EntityType[],
  scope: SearchScope,
  projectUuids: string[] | null,
  groupUuid: string | null,
): Promise<SearchResponse | null> {
  const lookups = typesToSearch.map(async (type): Promise<SearchResult | null> => {
    const projectFilter = projectUuids ? { in: projectUuids } : undefined;

    switch (type) {
      case "task": {
        const task = await prisma.task.findFirst({
          where: { uuid, companyUuid, ...(projectFilter && { projectUuid: projectFilter }) },
          select: {
            uuid: true,
            title: true,
            status: true,
            projectUuid: true,
            updatedAt: true,
            project: { select: { name: true } },
          },
        });
        return task && {
          entityType: "task",
          uuid: task.uuid,
          title: task.title,
          snippet: "",
          status: task.status,
          projectUuid: task.projectUuid,
          projectName: task.project.name,
          updatedAt: task.updatedAt.toISOString(),
          score: 0,
        };
      }
      case "idea": {
        const idea = await prisma.idea.findFirst({
          where: { uuid, companyUuid, ...(projectFilter && { projectUuid: projectFilter }) },
          select: {
            uuid: true,
            title: true,
            status: true,
            projectUuid: true,
            updatedAt: true,
            project: { select: { name: true } },
          },
        });
        return idea && {
          entityType: "idea",
          uuid: idea.uuid,
          title: idea.title,
          snippet: "",
          status: idea.status,
          projectUuid: idea.projectUuid,
          projectName: idea.project.name,
          updatedAt: idea.updatedAt.toISOString(),
          score: 0,
        };
      }
      case "proposal": {
        const proposal = await prisma.proposal.findFirst({
          where: { uuid, companyUuid, ...(projectFilter && { projectUuid: projectFilter }) },
          select: {
            uuid: true,
            title: true,
            status: true,
            projectUuid: true,
            updatedAt: true,
            project: { select: { name: true } },
          },
        });
        return proposal && {
          entityType: "proposal",
          uuid: proposal.uuid,
          title: proposal.title,
          snippet: "",
          status: proposal.status,
          projectUuid: proposal.projectUuid,
          projectName: proposal.project.name,
          updatedAt: proposal.updatedAt.toISOString(),
          score: 0,
        };
      }
      case "document": {
        const document = await prisma.document.findFirst({
          where: { uuid, companyUuid, ...(projectFilter && { projectUuid: projectFilter }) },
          select: {
            uuid: true,
            title: true,
            type: true,
            projectUuid: true,
            updatedAt: true,
            project: { select: { name: true } },
          },
        });
        return document && {
          entityType: "document",
          uuid: document.uuid,
          title: document.title,
          snippet: "",
          status: document.type,
          projectUuid: document.projectUuid,
          projectName: document.project.name,
          updatedAt: document.updatedAt.toISOString(),
          score: 0,
        };
      }
      case "project": {
        if (projectUuids && !projectUuids.includes(uuid)) return null;
        const project = await prisma.project.findFirst({
          where: { uuid, companyUuid },
          select: { uuid: true, name: true, updatedAt: true },
        });
        return project && {
          entityType: "project",
          uuid: project.uuid,
          title: project.name,
          snippet: "",
          status: "active",
          projectUuid: null,
          projectName: null,
          updatedAt: project.updatedAt.toISOString(),
          score: 0,
        };
      }
      case "project_group": {
        if (scope === "project") return null;
        if (groupUuid && uuid !== groupUuid) return null;
        const projectGroup = await prisma.projectGroup.findFirst({
          where: { uuid, companyUuid },
          select: { uuid: true, name: true, updatedAt: true },
        });
        return projectGroup && {
          entityType: "project_group",
          uuid: projectGroup.uuid,
          title: projectGroup.name,
          snippet: "",
          status: "active",
          projectUuid: null,
          projectName: null,
          updatedAt: projectGroup.updatedAt.toISOString(),
          score: 0,
        };
      }
    }
  });

  const results = (await Promise.all(lookups)).filter(
    (result): result is SearchResult => result !== null,
  );
  if (results.length === 0) return null;

  const counts = emptyCounts();
  for (const result of results) {
    counts[countKeyFor(result.entityType)] += 1;
  }
  return { results, counts };
}

// ===== Candidate generation =====

/**
 * One candidate row as returned by the per-type SQL. `ftsRank` is 0 when the
 * row was found only by the substring predicate; `likeMatch` is false when it
 * was found only by full-text. At least one of the two is always set, because
 * the WHERE clause is their disjunction.
 */
interface CandidateRow {
  uuid: string;
  title: string;
  body: string | null;
  status: string;
  projectUuid: string | null;
  projectName: string | null;
  updatedAt: Date;
  /** Uuid of the entity one hop up the lineage (proposal, or parent idea). */
  linkUuid: string | null;
  ftsRank: number;
  likeMatch: boolean;
  totalCount: bigint | number;
}

/** A candidate plus everything needed to emit it as a SearchResult. */
interface Candidate extends RankableCandidate {
  entityType: EntityType;
  uuid: string;
  title: string;
  body: string | null;
  projectUuid: string | null;
  projectName: string | null;
  linkUuid: string | null;
}

function candidateKey(entityType: EntityType, uuid: string): string {
  return `${entityType}:${uuid}`;
}

function toCandidate(entityType: EntityType, row: CandidateRow): Candidate {
  return {
    key: candidateKey(entityType, row.uuid),
    entityType,
    uuid: row.uuid,
    title: row.title,
    body: row.body,
    status: row.status,
    projectUuid: row.projectUuid,
    projectName: row.projectName,
    linkUuid: row.linkUuid,
    updatedAt: row.updatedAt,
  };
}

/** Per-type candidate fetch result: rows plus the true total match count. */
interface CandidateFetch {
  rows: CandidateRow[];
  total: number;
}

function fetchTotal(rows: CandidateRow[]): number {
  if (rows.length === 0) return 0;
  return Number(rows[0].totalCount);
}

/**
 * SQL parameter bundle shared by every per-type query.
 *
 * `isGlobal` lets one static statement serve both the unscoped and the scoped
 * case: `(true OR …)` short-circuits the array comparison away rather than
 * needing a second statement per type.
 */
interface SqlScope {
  companyUuid: string;
  isGlobal: boolean;
  projectUuids: string[];
  tsQuery: string;
  likePattern: string;
  limit: number;
}

function buildSqlScope(
  companyUuid: string,
  query: string,
  projectUuids: string[] | null,
  limit: number,
): SqlScope {
  return {
    companyUuid,
    isGlobal: projectUuids === null,
    projectUuids: projectUuids ?? [],
    tsQuery: buildTsQuery(query) ?? TSQUERY_NEVER_MATCHES,
    likePattern: `%${escapeLikePattern(query)}%`,
    limit: Math.min(limit * CANDIDATE_OVERFETCH, CANDIDATE_MAX),
  };
}

async function fetchTasks(s: SqlScope): Promise<CandidateFetch> {
  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT t."uuid", t."title", t."description" AS "body", t."status",
           t."projectUuid", p."name" AS "projectName", t."updatedAt",
           t."proposalUuid" AS "linkUuid",
           ts_rank_cd(
             to_tsvector('simple', coalesce(t."title", '') || ' ' || coalesce(t."description", '')),
             to_tsquery('simple', ${s.tsQuery}), 32
           ) AS "ftsRank",
           (t."title" ILIKE ${s.likePattern} OR t."description" ILIKE ${s.likePattern}) AS "likeMatch",
           count(*) OVER () AS "totalCount"
    FROM "Task" t
    JOIN "Project" p ON p."uuid" = t."projectUuid"
    WHERE t."companyUuid" = ${s.companyUuid}
      AND (${s.isGlobal}::boolean OR t."projectUuid" = ANY(${s.projectUuids}::text[]))
      AND (
        to_tsvector('simple', coalesce(t."title", '') || ' ' || coalesce(t."description", ''))
          @@ to_tsquery('simple', ${s.tsQuery})
        OR t."title" ILIKE ${s.likePattern}
        OR t."description" ILIKE ${s.likePattern}
      )
    ORDER BY "ftsRank" DESC, t."updatedAt" DESC
    LIMIT ${s.limit}
  `;
  return { rows, total: fetchTotal(rows) };
}

async function fetchIdeas(s: SqlScope): Promise<CandidateFetch> {
  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT i."uuid", i."title", i."content" AS "body", i."status",
           i."projectUuid", p."name" AS "projectName", i."updatedAt",
           i."parentUuid" AS "linkUuid",
           ts_rank_cd(
             to_tsvector('simple', coalesce(i."title", '') || ' ' || coalesce(i."content", '')),
             to_tsquery('simple', ${s.tsQuery}), 32
           ) AS "ftsRank",
           (i."title" ILIKE ${s.likePattern} OR i."content" ILIKE ${s.likePattern}) AS "likeMatch",
           count(*) OVER () AS "totalCount"
    FROM "Idea" i
    JOIN "Project" p ON p."uuid" = i."projectUuid"
    WHERE i."companyUuid" = ${s.companyUuid}
      AND (${s.isGlobal}::boolean OR i."projectUuid" = ANY(${s.projectUuids}::text[]))
      AND (
        to_tsvector('simple', coalesce(i."title", '') || ' ' || coalesce(i."content", ''))
          @@ to_tsquery('simple', ${s.tsQuery})
        OR i."title" ILIKE ${s.likePattern}
        OR i."content" ILIKE ${s.likePattern}
      )
    ORDER BY "ftsRank" DESC, i."updatedAt" DESC
    LIMIT ${s.limit}
  `;
  return { rows, total: fetchTotal(rows) };
}

async function fetchProposals(s: SqlScope): Promise<CandidateFetch> {
  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT pr."uuid", pr."title", pr."description" AS "body", pr."status",
           pr."projectUuid", p."name" AS "projectName", pr."updatedAt",
           NULL::text AS "linkUuid",
           ts_rank_cd(
             to_tsvector('simple', coalesce(pr."title", '') || ' ' || coalesce(pr."description", '')),
             to_tsquery('simple', ${s.tsQuery}), 32
           ) AS "ftsRank",
           (pr."title" ILIKE ${s.likePattern} OR pr."description" ILIKE ${s.likePattern}) AS "likeMatch",
           count(*) OVER () AS "totalCount"
    FROM "Proposal" pr
    JOIN "Project" p ON p."uuid" = pr."projectUuid"
    WHERE pr."companyUuid" = ${s.companyUuid}
      AND (${s.isGlobal}::boolean OR pr."projectUuid" = ANY(${s.projectUuids}::text[]))
      AND (
        to_tsvector('simple', coalesce(pr."title", '') || ' ' || coalesce(pr."description", ''))
          @@ to_tsquery('simple', ${s.tsQuery})
        OR pr."title" ILIKE ${s.likePattern}
        OR pr."description" ILIKE ${s.likePattern}
      )
    ORDER BY "ftsRank" DESC, pr."updatedAt" DESC
    LIMIT ${s.limit}
  `;
  return { rows, total: fetchTotal(rows) };
}

async function fetchDocuments(s: SqlScope): Promise<CandidateFetch> {
  // `type` stands in for status here — Document has no status column, and its
  // type is what authority scoring reads (an ADR outranks a scratch note).
  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT d."uuid", d."title", d."content" AS "body", d."type" AS "status",
           d."projectUuid", p."name" AS "projectName", d."updatedAt",
           d."proposalUuid" AS "linkUuid",
           ts_rank_cd(
             to_tsvector('simple', coalesce(d."title", '') || ' ' || coalesce(d."content", '')),
             to_tsquery('simple', ${s.tsQuery}), 32
           ) AS "ftsRank",
           (d."title" ILIKE ${s.likePattern} OR d."content" ILIKE ${s.likePattern}) AS "likeMatch",
           count(*) OVER () AS "totalCount"
    FROM "Document" d
    JOIN "Project" p ON p."uuid" = d."projectUuid"
    WHERE d."companyUuid" = ${s.companyUuid}
      AND (${s.isGlobal}::boolean OR d."projectUuid" = ANY(${s.projectUuids}::text[]))
      AND (
        to_tsvector('simple', coalesce(d."title", '') || ' ' || coalesce(d."content", ''))
          @@ to_tsquery('simple', ${s.tsQuery})
        OR d."title" ILIKE ${s.likePattern}
        OR d."content" ILIKE ${s.likePattern}
      )
    ORDER BY "ftsRank" DESC, d."updatedAt" DESC
    LIMIT ${s.limit}
  `;
  return { rows, total: fetchTotal(rows) };
}

async function fetchProjects(s: SqlScope): Promise<CandidateFetch> {
  // A project is matched by its own uuid rather than a projectUuid column, so
  // both group and project scope reduce to "uuid is one of these".
  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT p."uuid", p."name" AS "title", p."description" AS "body",
           'active' AS "status",
           NULL::text AS "projectUuid", NULL::text AS "projectName", p."updatedAt",
           NULL::text AS "linkUuid",
           ts_rank_cd(
             to_tsvector('simple', coalesce(p."name", '') || ' ' || coalesce(p."description", '')),
             to_tsquery('simple', ${s.tsQuery}), 32
           ) AS "ftsRank",
           (p."name" ILIKE ${s.likePattern} OR p."description" ILIKE ${s.likePattern}) AS "likeMatch",
           count(*) OVER () AS "totalCount"
    FROM "Project" p
    WHERE p."companyUuid" = ${s.companyUuid}
      AND (${s.isGlobal}::boolean OR p."uuid" = ANY(${s.projectUuids}::text[]))
      AND (
        to_tsvector('simple', coalesce(p."name", '') || ' ' || coalesce(p."description", ''))
          @@ to_tsquery('simple', ${s.tsQuery})
        OR p."name" ILIKE ${s.likePattern}
        OR p."description" ILIKE ${s.likePattern}
      )
    ORDER BY "ftsRank" DESC, p."updatedAt" DESC
    LIMIT ${s.limit}
  `;
  return { rows, total: fetchTotal(rows) };
}

async function fetchProjectGroups(
  s: SqlScope,
  groupUuid: string | null,
): Promise<CandidateFetch> {
  // Group scope narrows to the group itself; other scopes are unrestricted,
  // matching the behaviour this ranking change replaces.
  const restrictToGroup = groupUuid !== null;
  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT g."uuid", g."name" AS "title", g."description" AS "body",
           'active' AS "status",
           NULL::text AS "projectUuid", NULL::text AS "projectName", g."updatedAt",
           NULL::text AS "linkUuid",
           ts_rank_cd(
             to_tsvector('simple', coalesce(g."name", '') || ' ' || coalesce(g."description", '')),
             to_tsquery('simple', ${s.tsQuery}), 32
           ) AS "ftsRank",
           (g."name" ILIKE ${s.likePattern} OR g."description" ILIKE ${s.likePattern}) AS "likeMatch",
           count(*) OVER () AS "totalCount"
    FROM "ProjectGroup" g
    WHERE g."companyUuid" = ${s.companyUuid}
      AND (NOT ${restrictToGroup}::boolean OR g."uuid" = ${groupUuid ?? ""})
      AND (
        to_tsvector('simple', coalesce(g."name", '') || ' ' || coalesce(g."description", ''))
          @@ to_tsquery('simple', ${s.tsQuery})
        OR g."name" ILIKE ${s.likePattern}
        OR g."description" ILIKE ${s.likePattern}
      )
    ORDER BY "ftsRank" DESC, g."updatedAt" DESC
    LIMIT ${s.limit}
  `;
  return { rows, total: fetchTotal(rows) };
}

// ===== Graph-neighbour stream =====

/**
 * Expand direct hits one hop along AI-DLC lineage.
 *
 * Every hop rides an existing index (`Task.proposalUuid`, `Document.proposalUuid`,
 * `Idea.parentUuid`, both `TaskDependency` indexes) and the whole expansion is
 * capped, so the stream costs a bounded handful of keyed lookups.
 *
 * The idea → proposal direction is deliberately absent: `Proposal.inputUuids`
 * is an unindexed JSON array, and a containment scan per search would cost more
 * than this stream is worth. Task and document hits still reach their proposal,
 * so the common path is covered.
 */
async function fetchGraphNeighbours(
  companyUuid: string,
  seeds: Candidate[],
  allowedTypes: Set<EntityType>,
  projectUuids: string[] | null,
  existingKeys: Set<string>,
): Promise<Candidate[]> {
  const projectScope = projectUuids ? { projectUuid: { in: projectUuids } } : {};

  const seedTaskUuids = seeds.filter(c => c.entityType === "task").map(c => c.uuid);
  const seedProposalUuids = seeds.filter(c => c.entityType === "proposal").map(c => c.uuid);
  const seedIdeaUuids = seeds.filter(c => c.entityType === "idea").map(c => c.uuid);

  // Upward hops need no query beyond fetching the parent itself: the child rows
  // already carry their parent uuid in `linkUuid`.
  const parentProposalUuids = [
    ...new Set(
      seeds
        .filter(c => c.entityType === "task" || c.entityType === "document")
        .map(c => c.linkUuid)
        .filter((u): u is string => u !== null),
    ),
  ];
  const parentIdeaUuids = [
    ...new Set(
      seeds
        .filter(c => c.entityType === "idea")
        .map(c => c.linkUuid)
        .filter((u): u is string => u !== null),
    ),
  ];

  const wantProposal = allowedTypes.has("proposal");
  const wantTask = allowedTypes.has("task");
  const wantDocument = allowedTypes.has("document");
  const wantIdea = allowedTypes.has("idea");

  const needProposals = wantProposal && parentProposalUuids.length > 0;
  // parentIdeaUuids is derived from idea seeds, so it can only be non-empty
  // when seedIdeaUuids already is — the seed list alone decides this.
  const needIdeas = wantIdea && seedIdeaUuids.length > 0;
  const needSiblingTasks = wantTask && seedProposalUuids.length > 0;
  const needSiblingDocs = wantDocument && seedProposalUuids.length > 0;
  const needDeps = wantTask && seedTaskUuids.length > 0;

  const [proposals, ideas, siblingTasks, siblingDocs, deps] = await Promise.all([
    needProposals
      ? prisma.proposal.findMany({
          where: { companyUuid, uuid: { in: parentProposalUuids }, ...projectScope },
          take: GRAPH_NEIGHBOUR_LIMIT,
          select: {
            uuid: true, title: true, description: true, status: true,
            projectUuid: true, updatedAt: true, project: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    needIdeas
      ? prisma.idea.findMany({
          where: {
            companyUuid,
            ...projectScope,
            OR: [
              // Children always; parents only when some seed has one.
              { parentUuid: { in: seedIdeaUuids } },
              ...(parentIdeaUuids.length > 0 ? [{ uuid: { in: parentIdeaUuids } }] : []),
            ],
          },
          take: GRAPH_NEIGHBOUR_LIMIT,
          select: {
            uuid: true, title: true, content: true, status: true, parentUuid: true,
            projectUuid: true, updatedAt: true, project: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    needSiblingTasks
      ? prisma.task.findMany({
          where: { companyUuid, proposalUuid: { in: seedProposalUuids }, ...projectScope },
          take: GRAPH_NEIGHBOUR_LIMIT,
          select: {
            uuid: true, title: true, description: true, status: true, proposalUuid: true,
            projectUuid: true, updatedAt: true, project: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    needSiblingDocs
      ? prisma.document.findMany({
          where: { companyUuid, proposalUuid: { in: seedProposalUuids }, ...projectScope },
          take: GRAPH_NEIGHBOUR_LIMIT,
          select: {
            uuid: true, title: true, content: true, type: true, proposalUuid: true,
            projectUuid: true, updatedAt: true, project: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    needDeps
      ? prisma.taskDependency.findMany({
          where: {
            OR: [
              { taskUuid: { in: seedTaskUuids } },
              { dependsOnUuid: { in: seedTaskUuids } },
            ],
          },
          take: GRAPH_NEIGHBOUR_LIMIT * 2,
          select: { taskUuid: true, dependsOnUuid: true },
        })
      : Promise.resolve([]),
  ]);

  const neighbours: Candidate[] = [];
  const seen = new Set(existingKeys);

  const push = (candidate: Candidate) => {
    if (neighbours.length >= GRAPH_NEIGHBOUR_LIMIT) return;
    if (seen.has(candidate.key)) return;
    seen.add(candidate.key);
    neighbours.push(candidate);
  };

  for (const p of proposals) {
    push({
      key: candidateKey("proposal", p.uuid), entityType: "proposal", uuid: p.uuid,
      title: p.title, body: p.description, status: p.status,
      projectUuid: p.projectUuid, projectName: p.project.name,
      linkUuid: null, updatedAt: p.updatedAt,
    });
  }
  for (const i of ideas) {
    push({
      key: candidateKey("idea", i.uuid), entityType: "idea", uuid: i.uuid,
      title: i.title, body: i.content, status: i.status,
      projectUuid: i.projectUuid, projectName: i.project.name,
      linkUuid: i.parentUuid, updatedAt: i.updatedAt,
    });
  }
  for (const t of siblingTasks) {
    push({
      key: candidateKey("task", t.uuid), entityType: "task", uuid: t.uuid,
      title: t.title, body: t.description, status: t.status,
      projectUuid: t.projectUuid, projectName: t.project.name,
      linkUuid: t.proposalUuid, updatedAt: t.updatedAt,
    });
  }
  for (const d of siblingDocs) {
    push({
      key: candidateKey("document", d.uuid), entityType: "document", uuid: d.uuid,
      title: d.title, body: d.content, status: d.type,
      projectUuid: d.projectUuid, projectName: d.project.name,
      linkUuid: d.proposalUuid, updatedAt: d.updatedAt,
    });
  }

  // Dependency neighbours are uuid pairs; resolve the far side of each edge.
  const seedTaskSet = new Set(seedTaskUuids);
  const depUuids = [
    ...new Set(
      deps.flatMap(d => [d.taskUuid, d.dependsOnUuid])
        .filter(u => !seedTaskSet.has(u)),
    ),
  ];
  if (depUuids.length > 0 && neighbours.length < GRAPH_NEIGHBOUR_LIMIT) {
    const depTasks = await prisma.task.findMany({
      where: { companyUuid, uuid: { in: depUuids }, ...projectScope },
      take: GRAPH_NEIGHBOUR_LIMIT,
      select: {
        uuid: true, title: true, description: true, status: true, proposalUuid: true,
        projectUuid: true, updatedAt: true, project: { select: { name: true } },
      },
    });
    for (const t of depTasks) {
      push({
        key: candidateKey("task", t.uuid), entityType: "task", uuid: t.uuid,
        title: t.title, body: t.description, status: t.status,
        projectUuid: t.projectUuid, projectName: t.project.name,
        linkUuid: t.proposalUuid, updatedAt: t.updatedAt,
      });
    }
  }

  return neighbours;
}

// ===== Main Search Function =====

export async function search(params: SearchParams): Promise<SearchResponse> {
  const {
    query,
    companyUuid,
    scope = "global",
    scopeUuid,
    entityTypes,
    limit = 20,
    explain = false,
    now = new Date(),
  } = params;

  // Validate scope requirements
  if ((scope === "group" || scope === "project") && !scopeUuid) {
    throw new Error(`scopeUuid is required for scope "${scope}"`);
  }

  // Determine which entity types to search
  const allTypes: EntityType[] = ["task", "idea", "proposal", "document", "project", "project_group"];
  const typesToSearch = entityTypes && entityTypes.length > 0 ? entityTypes : allTypes;

  // Resolve project UUIDs based on scope
  let projectUuids: string[] | null = null;
  let groupUuid: string | null = null;

  if (scope === "project" && scopeUuid) {
    projectUuids = [scopeUuid];
  } else if (scope === "group" && scopeUuid) {
    projectUuids = await resolveGroupProjects(companyUuid, scopeUuid);
    groupUuid = scopeUuid;
  }

  if (CANONICAL_UUID_PATTERN.test(query)) {
    const exactResult = await searchExactUuid(
      companyUuid,
      query.toLowerCase(),
      typesToSearch,
      scope,
      projectUuids,
      groupUuid,
    );
    if (exactResult) return exactResult;
  }

  const sqlScope = buildSqlScope(companyUuid, query, projectUuids, limit);

  // Fetch candidates for every requested type in parallel.
  const fetches = typesToSearch.map((type) => {
    switch (type) {
      case "task": return fetchTasks(sqlScope);
      case "idea": return fetchIdeas(sqlScope);
      case "proposal": return fetchProposals(sqlScope);
      case "document": return fetchDocuments(sqlScope);
      case "project": return fetchProjects(sqlScope);
      case "project_group": return fetchProjectGroups(sqlScope, groupUuid);
    }
  });
  const fetched = await Promise.all(fetches);

  const counts = emptyCounts();
  const candidates: Candidate[] = [];
  // Per-stream ordering is built from the same rows: the SQL already returned
  // them best-full-text-first, and each row reports which predicates matched.
  const ftsRows: Array<{ key: string; rank: number }> = [];
  const substringRows: Array<{ key: string; updatedAt: number }> = [];

  fetched.forEach((result, index) => {
    const type = typesToSearch[index];
    counts[countKeyFor(type)] = result.total;

    for (const row of result.rows) {
      const candidate = toCandidate(type, row);
      candidates.push(candidate);

      const ftsRank = Number(row.ftsRank);
      if (ftsRank > 0) {
        ftsRows.push({ key: candidate.key, rank: ftsRank });
      }
      if (row.likeMatch) {
        substringRows.push({ key: candidate.key, updatedAt: row.updatedAt.getTime() });
      }
    }
  });

  // Each stream is ordered independently, across all entity types, so fusion
  // compares a task against a document on the same footing.
  ftsRows.sort((a, b) => b.rank - a.rank);
  substringRows.sort((a, b) => b.updatedAt - a.updatedAt);

  const streams: Partial<Record<StreamName, string[]>> = {
    fts: ftsRows.map(r => r.key),
    substring: substringRows.map(r => r.key),
  };

  // Graph expansion is seeded from the best direct hits, so it needs a
  // provisional ordering first.
  const directKeys = new Set(candidates.map(c => c.key));
  const provisional = rankCandidates(candidates, streams, now);
  const seeds = provisional.slice(0, GRAPH_SEED_LIMIT).map(r => r.candidate);

  if (seeds.length > 0) {
    const neighbours = await fetchGraphNeighbours(
      companyUuid,
      seeds,
      new Set(typesToSearch),
      projectUuids,
      directKeys,
    );
    if (neighbours.length > 0) {
      candidates.push(...neighbours);
      streams.graph = neighbours.map(n => n.key);
    }
  }

  const ranked = rankCandidates(candidates, streams, now).slice(0, limit);

  const results: SearchResult[] = ranked.map(({ candidate, score, explain: why }) => ({
    entityType: candidate.entityType,
    uuid: candidate.uuid,
    title: candidate.title,
    snippet: generateSnippet(candidate.body || candidate.title, query),
    status: candidate.status,
    projectUuid: candidate.projectUuid,
    projectName: candidate.projectName,
    updatedAt: candidate.updatedAt.toISOString(),
    score,
    ...(explain ? { explain: why } : {}),
  }));

  return { results, counts };
}
