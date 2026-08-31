import { describe, it, expect } from "vitest";

import {
  authorityAdjustment,
  buildTsQuery,
  clampAuthority,
  escapeLikePattern,
  fuseStreams,
  rankCandidates,
  AUTHORITY_MAX,
  AUTHORITY_MIN,
  MAX_TSQUERY_TERMS,
  RECENCY_MAX_BONUS,
  RRF_K,
  STREAM_WEIGHTS,
  type RankableCandidate,
} from "@/services/search-ranking";

// A fixed clock so recency scoring is deterministic.
const NOW = new Date("2026-08-17T12:00:00.000Z");
const DAY = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

function candidate(
  overrides: Partial<RankableCandidate> & { key: string },
): RankableCandidate {
  return {
    entityType: "task",
    status: "open",
    updatedAt: NOW,
    ...overrides,
  };
}

describe("search-ranking", () => {
  describe("fuseStreams", () => {
    it("scores a single-stream hit as weight / (K + rank)", () => {
      const fused = fuseStreams({ fts: ["task:a", "task:b"] });

      expect(fused.get("task:a")!.rrfScore).toBeCloseTo(
        STREAM_WEIGHTS.fts / (RRF_K + 1),
        10,
      );
      expect(fused.get("task:b")!.rrfScore).toBeCloseTo(
        STREAM_WEIGHTS.fts / (RRF_K + 2),
        10,
      );
    });

    it("lets agreement between two streams beat a single stream's top hit", () => {
      // This is the property that makes fusion worth having: `b` is second in
      // both streams, `a` is first in only one. Two independent signals
      // agreeing outrank one signal's best guess.
      const fused = fuseStreams({
        fts: ["task:a", "task:b"],
        substring: ["task:c", "task:b"],
      });

      expect(fused.get("task:b")!.rrfScore).toBeGreaterThan(
        fused.get("task:a")!.rrfScore,
      );
      expect(fused.get("task:b")!.contributions).toHaveLength(2);
    });

    it("weights the graph stream below the lexical streams at equal rank", () => {
      const fused = fuseStreams({ fts: ["task:a"], graph: ["task:b"] });

      expect(fused.get("task:b")!.rrfScore).toBeLessThan(
        fused.get("task:a")!.rrfScore,
      );
    });

    it("records the rank and contribution of every stream that matched", () => {
      const fused = fuseStreams({
        fts: ["doc:x"],
        substring: ["other", "doc:x"],
      });

      expect(fused.get("doc:x")!.contributions).toEqual([
        { stream: "fts", rank: 1, contribution: STREAM_WEIGHTS.fts / (RRF_K + 1) },
        {
          stream: "substring",
          rank: 2,
          contribution: STREAM_WEIGHTS.substring / (RRF_K + 2),
        },
      ]);
    });

    it("keeps only the best rank when a key repeats inside one stream", () => {
      const fused = fuseStreams({ fts: ["task:a", "task:a"] });

      expect(fused.get("task:a")!.contributions).toHaveLength(1);
      expect(fused.get("task:a")!.rrfScore).toBeCloseTo(
        STREAM_WEIGHTS.fts / (RRF_K + 1),
        10,
      );
    });

    it("ignores absent and undefined streams", () => {
      const fused = fuseStreams({ fts: undefined, substring: ["task:a"] });

      expect(fused.size).toBe(1);
      expect(fused.get("task:a")!.contributions).toHaveLength(1);
    });

    it("returns an empty map for no streams", () => {
      expect(fuseStreams({}).size).toBe(0);
    });
  });

  describe("clampAuthority", () => {
    it("passes through values inside the bounds", () => {
      expect(clampAuthority(1)).toBe(1);
      expect(clampAuthority(1.25)).toBe(1.25);
    });

    it("never lets authority reach zero, however negative the factors", () => {
      // The invariant: authority nudges, it never excludes.
      expect(clampAuthority(-5)).toBe(AUTHORITY_MIN);
      expect(clampAuthority(0)).toBe(AUTHORITY_MIN);
    });

    it("caps the upside so authority cannot outweigh relevance", () => {
      expect(clampAuthority(99)).toBe(AUTHORITY_MAX);
    });
  });

  describe("authorityAdjustment", () => {
    it("ranks an approved proposal above a rejected one", () => {
      const approved = authorityAdjustment(
        { entityType: "proposal", status: "approved", updatedAt: NOW },
        NOW,
      );
      const rejected = authorityAdjustment(
        { entityType: "proposal", status: "rejected", updatedAt: NOW },
        NOW,
      );

      expect(approved.multiplier).toBeGreaterThan(rejected.multiplier);
      expect(approved.factors).toEqual(
        expect.arrayContaining([{ name: "status:approved", delta: 0.2 }]),
      );
      expect(rejected.factors).toEqual(
        expect.arrayContaining([{ name: "status:rejected", delta: -0.25 }]),
      );
    });

    it("still returns a usable multiplier for a rejected proposal", () => {
      // A targeted search for a rejected proposal must be able to find it.
      const { multiplier } = authorityAdjustment(
        { entityType: "proposal", status: "rejected", updatedAt: daysAgo(400) },
        NOW,
      );

      expect(multiplier).toBeGreaterThan(0);
      expect(multiplier).toBeGreaterThanOrEqual(AUTHORITY_MIN);
    });

    it("favours a verified task over an abandoned one", () => {
      const done = authorityAdjustment(
        { entityType: "task", status: "done", updatedAt: NOW },
        NOW,
      );
      const closed = authorityAdjustment(
        { entityType: "task", status: "closed", updatedAt: NOW },
        NOW,
      );

      expect(done.multiplier).toBeGreaterThan(closed.multiplier);
    });

    it("favours an elaborated idea over an untouched one", () => {
      const elaborated = authorityAdjustment(
        { entityType: "idea", status: "elaborated", updatedAt: NOW },
        NOW,
      );
      const open = authorityAdjustment(
        { entityType: "idea", status: "open", updatedAt: NOW },
        NOW,
      );

      expect(elaborated.multiplier).toBeGreaterThan(open.multiplier);
    });

    it("reads document authority from type, since Document has no status", () => {
      const adr = authorityAdjustment(
        { entityType: "document", status: "adr", updatedAt: NOW },
        NOW,
      );
      const other = authorityAdjustment(
        { entityType: "document", status: "meeting_notes", updatedAt: NOW },
        NOW,
      );

      expect(adr.factors).toEqual(
        expect.arrayContaining([{ name: "document_type:adr", delta: 0.2 }]),
      );
      expect(other.factors.map((f) => f.name)).not.toContain(
        "document_type:meeting_notes",
      );
      expect(adr.multiplier).toBeGreaterThan(other.multiplier);
    });

    it("omits a zero-delta status rather than reporting a no-op factor", () => {
      const { factors } = authorityAdjustment(
        { entityType: "task", status: "open", updatedAt: NOW },
        NOW,
      );

      expect(factors.map((f) => f.name)).not.toContain("status:open");
    });

    it("adds no status factor for an entity type with no authority table", () => {
      const { factors, multiplier } = authorityAdjustment(
        { entityType: "project", status: "active", updatedAt: daysAgo(1000) },
        NOW,
      );

      expect(factors).toEqual([]);
      expect(multiplier).toBe(1);
    });

    it("gives a fresh row the full recency bonus and an old row none", () => {
      const fresh = authorityAdjustment(
        { entityType: "project", status: "active", updatedAt: NOW },
        NOW,
      );
      const stale = authorityAdjustment(
        { entityType: "project", status: "active", updatedAt: daysAgo(3650) },
        NOW,
      );

      expect(fresh.factors).toEqual([
        { name: "recency", delta: RECENCY_MAX_BONUS },
      ]);
      expect(stale.factors).toEqual([]);
      expect(fresh.multiplier).toBeGreaterThan(stale.multiplier);
    });

    it("treats a future updatedAt as maximally recent rather than negative", () => {
      // Clock skew across remote daemons can write a timestamp slightly ahead
      // of the server; that must not produce a negative age.
      const { factors } = authorityAdjustment(
        {
          entityType: "project",
          status: "active",
          updatedAt: new Date(NOW.getTime() + 10 * DAY),
        },
        NOW,
      );

      expect(factors).toEqual([{ name: "recency", delta: RECENCY_MAX_BONUS }]);
    });
  });

  describe("rankCandidates", () => {
    it("orders by fused score, highest first", () => {
      const candidates = [
        candidate({ key: "task:low" }),
        candidate({ key: "task:high" }),
      ];

      const ranked = rankCandidates(
        candidates,
        { fts: ["task:high", "task:low"], substring: ["task:high"] },
        NOW,
      );

      expect(ranked.map((r) => r.candidate.key)).toEqual([
        "task:high",
        "task:low",
      ]);
      expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    it("drops candidates that no stream matched", () => {
      const ranked = rankCandidates(
        [candidate({ key: "task:a" }), candidate({ key: "task:orphan" })],
        { fts: ["task:a"] },
        NOW,
      );

      expect(ranked.map((r) => r.candidate.key)).toEqual(["task:a"]);
    });

    it("lets authority reorder two candidates of equal relevance", () => {
      // Same rank in the same single stream: only authority separates them.
      const ranked = rankCandidates(
        [
          candidate({
            key: "proposal:rejected",
            entityType: "proposal",
            status: "rejected",
          }),
          candidate({
            key: "proposal:approved",
            entityType: "proposal",
            status: "approved",
          }),
        ],
        { fts: ["proposal:rejected", "proposal:approved"] },
        NOW,
      );

      expect(ranked[0].candidate.key).toBe("proposal:approved");
    });

    it("breaks score ties by updatedAt descending for a stable order", () => {
      // A real tie needs equal relevance AND equal authority: rank 1 in two
      // equally weighted streams, and timestamps close enough that the recency
      // factor rounds to the same value while still ordering differently.
      const ranked = rankCandidates(
        [
          candidate({ key: "task:older", updatedAt: new Date(NOW.getTime() - 1000) }),
          candidate({ key: "task:newer", updatedAt: NOW }),
        ],
        { fts: ["task:older"], substring: ["task:newer"] },
        NOW,
      );

      expect(ranked[0].score).toBe(ranked[1].score);
      expect(ranked.map((r) => r.candidate.key)).toEqual([
        "task:newer",
        "task:older",
      ]);
    });

    it("reports the full provenance of each result", () => {
      const ranked = rankCandidates(
        [
          candidate({
            key: "proposal:a",
            entityType: "proposal",
            status: "approved",
          }),
        ],
        { fts: ["proposal:a"], graph: ["proposal:a"] },
        NOW,
      );

      const { explain, score } = ranked[0];
      expect(explain.streams.map((s) => s.stream)).toEqual(["fts", "graph"]);
      expect(explain.rrfScore).toBeGreaterThan(0);
      expect(explain.authority.multiplier).toBeGreaterThan(1);
      expect(explain.authority.factors.map((f) => f.name)).toContain(
        "status:approved",
      );
      expect(explain.finalScore).toBe(score);
      expect(score).toBeCloseTo(
        explain.rrfScore * explain.authority.multiplier,
        5,
      );
    });

    it("returns an empty list when there are no candidates", () => {
      expect(rankCandidates([], { fts: [] }, NOW)).toEqual([]);
    });
  });

  describe("buildTsQuery", () => {
    it("ORs the terms so a partial match still returns rows", () => {
      // AND semantics (what websearch_to_tsquery would impose) would make a
      // four-word query where three words match return nothing at all.
      expect(buildTsQuery("search ranking design")).toBe(
        "'search' | 'ranking' | 'design':*",
      );
    });

    it("marks the last term as a prefix so typeahead matches mid-word", () => {
      expect(buildTsQuery("rank")).toBe("'rank':*");
    });

    it("strips characters that tsquery would read as operators", () => {
      expect(buildTsQuery("foo&bar (baz)|qux")).toBe("'foobar' | 'bazqux':*");
    });

    it("cannot be broken out of by an embedded quote", () => {
      expect(buildTsQuery("it's o'clock")).toBe("'its' | 'oclock':*");
    });

    it("returns null when nothing usable remains", () => {
      expect(buildTsQuery("")).toBeNull();
      expect(buildTsQuery("   ")).toBeNull();
      expect(buildTsQuery("&|!():*")).toBeNull();
      expect(buildTsQuery("--- ...")).toBeNull();
    });

    it("keeps CJK text, which the substring stream then also matches", () => {
      expect(buildTsQuery("搜索排序")).toBe("'搜索排序':*");
    });

    it("bounds the term count so a large paste cannot explode the query", () => {
      const query = Array.from({ length: 40 }, (_, i) => `t${i}`).join(" ");
      const built = buildTsQuery(query)!;

      expect(built.split("|")).toHaveLength(MAX_TSQUERY_TERMS);
      expect(built).toContain(`'t${MAX_TSQUERY_TERMS - 1}':*`);
    });
  });

  describe("escapeLikePattern", () => {
    it("escapes wildcards so they match literally", () => {
      // Prisma's `contains` escaped these; raw ILIKE does not, so a query of
      // "100%" would otherwise match everything starting with "100".
      expect(escapeLikePattern("100%")).toBe("100\\%");
      expect(escapeLikePattern("snake_case")).toBe("snake\\_case");
    });

    it("escapes the escape character itself", () => {
      expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    });

    it("leaves ordinary text untouched", () => {
      expect(escapeLikePattern("plain query")).toBe("plain query");
    });
  });
});
