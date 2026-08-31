// src/services/search-ranking.ts
// Relevance ranking for global search — pure functions, no database access.
//
// Search generates candidates from several independent streams (see
// search.service.ts) and fuses them here with Reciprocal Rank Fusion, then
// applies a BOUNDED authority adjustment derived from Chorus's own AI-DLC
// semantics before the final truncation.
//
// Two invariants, borrowed from the ai-memory retrieval design:
//
//   1. Fusion is rank-based, never score-based. Streams are not comparable on
//      raw magnitudes (a ts_rank_cd value and an updatedAt ordering share no
//      unit), so only their ORDER is used. A candidate found by two streams
//      outranks one found by a single stream even when that stream ranked it
//      first — agreement between independent signals is the signal.
//
//   2. Authority is a bounded multiplier, never a filter. An approved proposal
//      is nudged above a rejected one; a rejected one is never excluded. A
//      targeted search for a rejected proposal must still find it. Every factor
//      is additive inside a clamp, so no combination of factors can zero a
//      candidate out or let one factor dominate relevance entirely.
//
// Everything in this module is deterministic and side-effect free: `now` is
// injected rather than read from the clock so recency is testable.

/** Candidate-generation streams that participate in fusion. */
export type StreamName = "fts" | "substring" | "graph";

/**
 * RRF smoothing constant. 60 is the value from the original Cormack et al.
 * formulation and the one ai-memory uses. Larger values flatten the curve
 * (rank 1 and rank 5 become closer); smaller values make the top of each
 * stream dominate. 60 keeps a rank-1 hit meaningfully ahead of rank-10 while
 * still letting two-stream agreement beat a single stream's top hit.
 */
export const RRF_K = 60;

/**
 * Per-stream weight applied to that stream's RRF contribution.
 *
 * `fts` and `substring` are peers: full-text carries relevance ranking for
 * space-delimited languages, substring carries CJK (Postgres' bundled parsers
 * do not segment Chinese/Japanese/Korean, so full-text alone would silently
 * regress those locales). `graph` is deliberately halved — a neighbour reached
 * through lineage never matched the query text at all, so it should surface as
 * useful context, not compete with a direct hit.
 */
export const STREAM_WEIGHTS: Record<StreamName, number> = {
  fts: 1,
  substring: 1,
  graph: 0.5,
};

/** Clamp bounds for the authority multiplier. */
export const AUTHORITY_MIN = 0.6;
export const AUTHORITY_MAX = 1.4;

/** Recency contributes at most this much, decaying smoothly. */
export const RECENCY_MAX_BONUS = 0.1;
/** Days at which the recency bonus has decayed to 1/e of its maximum. */
export const RECENCY_DECAY_DAYS = 60;

const MS_PER_DAY = 86_400_000;

/** One stream's contribution to a candidate's fused score. */
export interface StreamContribution {
  stream: StreamName;
  /** 1-based rank within that stream. */
  rank: number;
  /** weight / (RRF_K + rank) */
  contribution: number;
}

/** One additive component of the authority multiplier. */
export interface AuthorityFactor {
  name: string;
  delta: number;
}

/** Why a result ranked where it did. Returned only when `explain` is requested. */
export interface SearchExplain {
  streams: StreamContribution[];
  rrfScore: number;
  authority: {
    multiplier: number;
    factors: AuthorityFactor[];
  };
  finalScore: number;
}

/** Entity kinds the authority table knows about. */
export type RankableEntityType =
  | "task"
  | "idea"
  | "proposal"
  | "document"
  | "project"
  | "project_group";

/**
 * Status-derived authority deltas, keyed by entity type then status.
 *
 * These encode the AI-DLC lifecycle directly: a stage that a human has signed
 * off on is more trustworthy as an answer than one still in flight, and one
 * that was explicitly rejected or closed is less trustworthy than either.
 * Values are small on purpose — the whole table can shift a candidate by a few
 * positions, not rewrite the ordering.
 */
export const STATUS_AUTHORITY: Partial<
  Record<RankableEntityType, Record<string, number>>
> = {
  // Reviewed and approved is the authoritative plan; rejected is the least so.
  proposal: {
    approved: 0.2,
    revised: 0.05,
    pending: 0.05,
    draft: -0.1,
    rejected: -0.25,
  },
  // A verified task carries evidence; a closed one was abandoned.
  task: {
    done: 0.15,
    to_verify: 0.05,
    in_progress: 0.05,
    assigned: 0,
    open: 0,
    closed: -0.2,
  },
  // An elaborated idea has been through structured Q&A.
  idea: {
    elaborated: 0.15,
    elaborating: 0.05,
    open: 0,
  },
};

/**
 * Document authority comes from `type`, not `status` — Document has no status
 * column, and its type is exactly the "is this a durable decision record?"
 * signal. ADRs and tech designs are the Chorus analogue of ai-memory's
 * `decisions/` namespace.
 */
export const DOCUMENT_TYPE_AUTHORITY: Record<string, number> = {
  adr: 0.2,
  tech_design: 0.15,
  prd: 0.15,
};

/**
 * Fuse per-stream orderings into one score per candidate key.
 *
 * @param streams  Ordered candidate keys per stream. Position in the array is
 *                 the rank; a key may appear in any number of streams. Keys are
 *                 opaque to this function (search.service uses
 *                 `entityType:uuid`).
 * @returns        Map from key to its fused score and per-stream breakdown.
 */
export function fuseStreams(
  streams: Partial<Record<StreamName, string[]>>,
): Map<string, { rrfScore: number; contributions: StreamContribution[] }> {
  const fused = new Map<
    string,
    { rrfScore: number; contributions: StreamContribution[] }
  >();

  for (const [name, keys] of Object.entries(streams) as Array<
    [StreamName, string[] | undefined]
  >) {
    if (!keys) continue;
    const weight = STREAM_WEIGHTS[name];

    keys.forEach((key, index) => {
      const rank = index + 1;
      const contribution = weight / (RRF_K + rank);
      const existing = fused.get(key);

      if (existing) {
        // A key repeated inside one stream keeps its best (first) rank only.
        if (existing.contributions.some((c) => c.stream === name)) return;
        existing.rrfScore += contribution;
        existing.contributions.push({ stream: name, rank, contribution });
        return;
      }

      fused.set(key, {
        rrfScore: contribution,
        contributions: [{ stream: name, rank, contribution }],
      });
    });
  }

  return fused;
}

/** Inputs the authority adjustment reads. */
export interface AuthorityInput {
  entityType: RankableEntityType;
  /** Task/Idea/Proposal status, or Document.type. Projects pass "active". */
  status: string;
  updatedAt: Date;
}

/**
 * Enforce the "authority never filters" invariant.
 *
 * The shipped factor tables cannot currently reach either bound — the widest
 * combination is roughly 0.75 to 1.30 — so this is a guard on future edits, not
 * a live code path for today's values. It is exported and tested directly
 * because the bound is the contract: whatever anyone later adds to
 * STATUS_AUTHORITY, no candidate can be scored to zero (which would be a silent
 * exclusion) or lifted so far that authority outweighs relevance.
 */
export function clampAuthority(raw: number): number {
  return Math.min(AUTHORITY_MAX, Math.max(AUTHORITY_MIN, raw));
}

/**
 * Compute the bounded authority multiplier for one candidate.
 *
 * Returns the multiplier plus the factors that produced it, so `explain` can
 * show the reasoning rather than an opaque number.
 */
export function authorityAdjustment(
  input: AuthorityInput,
  now: Date,
): { multiplier: number; factors: AuthorityFactor[] } {
  const factors: AuthorityFactor[] = [];

  if (input.entityType === "document") {
    const delta = DOCUMENT_TYPE_AUTHORITY[input.status];
    if (delta !== undefined) {
      factors.push({ name: `document_type:${input.status}`, delta });
    }
  } else {
    const delta = STATUS_AUTHORITY[input.entityType]?.[input.status];
    if (delta !== undefined && delta !== 0) {
      factors.push({ name: `status:${input.status}`, delta });
    }
  }

  // Recency keeps the one behaviour the previous updatedAt-only ordering got
  // right: something touched this morning should edge out an equally relevant
  // year-old row. Bounded and smooth, so it never becomes the sort key.
  const ageDays = Math.max(
    0,
    (now.getTime() - input.updatedAt.getTime()) / MS_PER_DAY,
  );
  const recency = RECENCY_MAX_BONUS * Math.exp(-ageDays / RECENCY_DECAY_DAYS);
  if (recency > 0.001) {
    factors.push({ name: "recency", delta: round(recency) });
  }

  const raw = 1 + factors.reduce((sum, f) => sum + f.delta, 0);

  return { multiplier: round(clampAuthority(raw)), factors };
}

/** A candidate awaiting ranking. `key` must match the keys passed to fuseStreams. */
export interface RankableCandidate extends AuthorityInput {
  key: string;
}

export interface RankedCandidate<T extends RankableCandidate> {
  candidate: T;
  score: number;
  explain: SearchExplain;
}

/**
 * Fuse, adjust, and order candidates. Highest score first; ties broken by
 * `updatedAt` descending so the ordering is total and stable across calls
 * (important for a live command palette, where an unstable order makes
 * keyboard selection jump under the user).
 *
 * Candidates absent from every stream are dropped — a candidate nothing found
 * is not a result.
 */
export function rankCandidates<T extends RankableCandidate>(
  candidates: T[],
  streams: Partial<Record<StreamName, string[]>>,
  now: Date,
): RankedCandidate<T>[] {
  const fused = fuseStreams(streams);

  const ranked: RankedCandidate<T>[] = [];
  for (const candidate of candidates) {
    const hit = fused.get(candidate.key);
    if (!hit) continue;

    const authority = authorityAdjustment(candidate, now);
    const finalScore = round(hit.rrfScore * authority.multiplier);

    ranked.push({
      candidate,
      score: finalScore,
      explain: {
        streams: hit.contributions.map((c) => ({
          ...c,
          contribution: round(c.contribution),
        })),
        rrfScore: round(hit.rrfScore),
        authority,
        finalScore,
      },
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (
      b.candidate.updatedAt.getTime() - a.candidate.updatedAt.getTime()
    );
  });

  return ranked;
}

// ===== Query parsing =====

/**
 * Characters that are operators or quote delimiters inside a tsquery. Stripped
 * from every term before the term is quoted, so a user's punctuation can never
 * be read as tsquery syntax — the reason terms are hand-quoted here rather than
 * handed to `websearch_to_tsquery`, which would also impose AND semantics (see
 * buildTsQuery).
 */
const TSQUERY_RESERVED = /['"\\&|!():*<>]/g;

/** Bound the generated tsquery so a pathological paste cannot explode it. */
export const MAX_TSQUERY_TERMS = 10;

/**
 * A syntactically valid tsquery that cannot match real content. Used when the
 * caller's text yields no usable terms: Postgres rejects an empty tsquery, and
 * `to_tsquery` may be evaluated even when a boolean guard would short-circuit
 * it, so the safe move is a well-formed query that simply never matches.
 */
export const TSQUERY_NEVER_MATCHES = "'chorusnomatchsentinel'";

/**
 * Build a tsquery from user text.
 *
 * Terms are OR-ed rather than AND-ed. `websearch_to_tsquery` would AND them,
 * which turns a four-word query where three words match into zero results —
 * strictly worse than the substring matching this replaces. With OR,
 * `ts_rank_cd(..., 32)` normalises by the count of matched unique words, so a
 * row matching every term still outranks one matching a single term, and
 * partial matches degrade gracefully instead of vanishing.
 *
 * The final term gets a `:*` prefix marker so the Cmd+K palette matches while
 * the user is still typing the word.
 *
 * @returns A tsquery string, or null when the text contains no usable term.
 */
export function buildTsQuery(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((token) => token.replace(TSQUERY_RESERVED, ""))
    // A token needs at least one letter or digit to be a lexeme; pure
    // punctuation would produce a tsquery syntax error.
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .slice(0, MAX_TSQUERY_TERMS);

  if (terms.length === 0) return null;

  return terms
    .map((term, index) =>
      index === terms.length - 1 ? `'${term}':*` : `'${term}'`,
    )
    .join(" | ");
}

/**
 * Escape a query for use inside an `ILIKE '%…%'` pattern. Without this, a
 * query containing `%` or `_` would be read as a wildcard — Prisma's `contains`
 * escaped these for us, raw SQL does not.
 */
export function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, "\\$&");
}

/** Round to 6 decimals so scores serialise compactly and compare stably. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
