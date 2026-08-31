// src/services/__tests__/search-sql.integration.test.ts
//
// REAL-POSTGRES verification for the search ranking SQL.
//
// The unit suite (search.service.test.ts) mocks `$queryRaw`, so it proves the
// orchestration, fusion and authority logic but says NOTHING about whether the
// SQL is valid. This suite exists to cover exactly that gap: every statement is
// executed against a real Postgres, so a bad cast, a mistyped column, an
// `ANY(…::text[])` that rejects an empty array, or a `to_tsquery` the sentinel
// cannot satisfy fails here rather than in production.
//
// It also pins the two behaviours that motivated the change and that a mock
// cannot demonstrate, because they live in Postgres' own text search:
//   • a multi-word query matches (the previous `contains` implementation
//     required the entire query to be one literal substring);
//   • CJK text still matches through the substring stream, which is why that
//     stream is retained alongside full-text.
//
// HOW TO RUN (never touches the live store — see the gate below):
//   docker run -d --name chorus-search-pg -e POSTGRES_USER=srch \
//     -e POSTGRES_PASSWORD=srch -e POSTGRES_DB=srch \
//     -p 127.0.0.1:55446:5432 postgres:16-alpine
//   DATABASE_URL="postgresql://srch:srch@127.0.0.1:55446/srch" npx prisma migrate deploy
//   SEARCH_REAL_DB_URL="postgresql://srch:srch@127.0.0.1:55446/srch" \
//     npx vitest run src/services/__tests__/search-sql.integration.test.ts
//
// When SEARCH_REAL_DB_URL is NOT set (the default for `pnpm test` / CI) the whole
// suite is skipped, so it never connects to a database it shouldn't — and in
// particular never touches the live PGlite store (port 5433 / ~/.chorus-data).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const REAL_DB_URL = process.env.SEARCH_REAL_DB_URL;
const describeReal = REAL_DB_URL ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let realPrisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;
let search: typeof import("@/services/search.service")["search"];

const companyUuid = "11111111-1111-4111-8111-111111111111";
const otherCompanyUuid = "22222222-2222-4222-8222-222222222222";
const groupUuid = "33333333-3333-4333-8333-333333333333";
const emptyGroupUuid = "34343434-3434-4343-8343-343434343434";
const projectA = "44444444-4444-4444-8444-444444444444";
const projectB = "55555555-5555-4555-8555-555555555555";
const proposalApproved = "66666666-6666-4666-8666-666666666666";
const proposalRejected = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-08-17T12:00:00.000Z");

describeReal("search SQL — REAL Postgres", () => {
  beforeAll(async () => {
    const { PrismaClient } = await import(
      /* @vite-ignore */ "../../generated/prisma/client"
    );
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const pg = (await import("pg")).default;

    pool = new pg.Pool({ connectionString: REAL_DB_URL });
    realPrisma = new PrismaClient({ adapter: new PrismaPg(pool) });

    vi.doMock("@/lib/prisma", () => ({ prisma: realPrisma }));
    vi.doMock("@/lib/logger", () => {
      const fn = () => {};
      const stub = { error: fn, warn: fn, info: fn, debug: fn, child: () => stub };
      return { default: stub };
    });

    ({ search } = await import("@/services/search.service"));

    // ---- Clean slate, then seed ----
    for (const table of [
      "TaskDependency", "AcceptanceCriterion", "Task", "Document",
      "Proposal", "Idea", "Project", "ProjectGroup", "Company",
    ]) {
      await realPrisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }

    await realPrisma.company.createMany({
      data: [
        { uuid: companyUuid, name: "Search Co" },
        { uuid: otherCompanyUuid, name: "Other Co" },
      ],
    });
    await realPrisma.projectGroup.createMany({
      data: [
        { uuid: groupUuid, companyUuid, name: "Platform Group" },
        { uuid: emptyGroupUuid, companyUuid, name: "Empty Group" },
      ],
    });
    await realPrisma.project.createMany({
      data: [
        { uuid: projectA, companyUuid, name: "Alpha", description: "Retrieval work", groupUuid },
        { uuid: projectB, companyUuid, name: "Beta", description: "Unrelated" },
      ],
    });

    await realPrisma.task.createMany({
      data: [
        {
          // Title AND body both carry both terms — the strongest full-text match.
          uuid: "aaaa0001-0000-4000-8000-000000000001",
          companyUuid, projectUuid: projectA,
          title: "Improve search ranking",
          description: "Rework search ranking with fused streams",
          status: "done", createdByUuid: "user-1", updatedAt: NOW,
        },
        {
          // One term only — a weaker full-text match.
          uuid: "aaaa0002-0000-4000-8000-000000000002",
          companyUuid, projectUuid: projectA,
          title: "Ranking spike",
          description: "Investigate options",
          status: "open", createdByUuid: "user-1", updatedAt: NOW,
          proposalUuid: proposalApproved,
        },
        {
          // CJK content: reachable only through the substring stream.
          uuid: "aaaa0003-0000-4000-8000-000000000003",
          companyUuid, projectUuid: projectA,
          title: "搜索排序改进",
          description: "改进搜索排序的相关性",
          status: "open", createdByUuid: "user-1", updatedAt: NOW,
        },
        {
          // Literal wildcards, to prove LIKE escaping.
          uuid: "aaaa0004-0000-4000-8000-000000000004",
          companyUuid, projectUuid: projectA,
          title: "Rollout is 100% done",
          description: "snake_case naming settled",
          status: "open", createdByUuid: "user-1", updatedAt: NOW,
        },
        {
          // Different project, for scope checks.
          uuid: "aaaa0005-0000-4000-8000-000000000005",
          companyUuid, projectUuid: projectB,
          title: "Search ranking in Beta",
          description: null,
          status: "open", createdByUuid: "user-1", updatedAt: NOW,
        },
        {
          // Different tenant: must never appear.
          uuid: "aaaa0006-0000-4000-8000-000000000006",
          companyUuid: otherCompanyUuid, projectUuid: projectA,
          title: "Search ranking leak",
          description: "should never surface",
          status: "open", createdByUuid: "user-2", updatedAt: NOW,
        },
      ],
    });

    await realPrisma.proposal.createMany({
      data: [
        {
          uuid: proposalApproved, companyUuid, projectUuid: projectA,
          title: "Fused ranking proposal", description: "Adopt fused ranking",
          inputType: "idea", inputUuids: [], status: "approved",
          createdByUuid: "agent-1", updatedAt: NOW,
        },
        {
          uuid: proposalRejected, companyUuid, projectUuid: projectA,
          title: "Fused ranking proposal", description: "Adopt fused ranking",
          inputType: "idea", inputUuids: [], status: "rejected",
          createdByUuid: "agent-1", updatedAt: NOW,
        },
      ],
    });

    await realPrisma.document.createMany({
      data: [{
        uuid: "dddd0001-0000-4000-8000-000000000001",
        companyUuid, projectUuid: projectA,
        title: "Ranking decision record", content: "We chose reciprocal rank fusion",
        type: "adr", createdByUuid: "user-1", proposalUuid: proposalApproved,
        updatedAt: NOW,
      }],
    });

    await realPrisma.idea.createMany({
      data: [
        {
          uuid: "eeee0001-0000-4000-8000-000000000001",
          companyUuid, projectUuid: projectA,
          title: "Better retrieval", content: "Parent idea about retrieval",
          status: "elaborated", createdByUuid: "user-1", updatedAt: NOW,
        },
        {
          uuid: "eeee0002-0000-4000-8000-000000000002",
          companyUuid, projectUuid: projectA,
          title: "Child of retrieval", content: "Derived",
          status: "open", createdByUuid: "user-1",
          parentUuid: "eeee0001-0000-4000-8000-000000000001", updatedAt: NOW,
        },
      ],
    });

    await realPrisma.taskDependency.create({
      data: {
        taskUuid: "aaaa0002-0000-4000-8000-000000000002",
        dependsOnUuid: "aaaa0001-0000-4000-8000-000000000001",
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("executes every entity type's statement without error", async () => {
    // The point of this case: six raw statements, all six casts, on real
    // Postgres. A syntax error anywhere fails here.
    const result = await search({ query: "ranking", companyUuid, now: NOW });

    expect(result.results.length).toBeGreaterThan(0);
    expect(Object.keys(result.counts)).toHaveLength(6);
  });

  it("matches a multi-word query that literal substring matching could not", async () => {
    // "search fused" appears in no single contiguous substring of any row, so
    // the previous `contains` implementation returned nothing for this query.
    const result = await search({
      query: "search fused",
      companyUuid,
      entityTypes: ["task"],
      now: NOW,
    });

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.map(r => r.uuid)).toContain(
      "aaaa0001-0000-4000-8000-000000000001",
    );
  });

  it("ranks a row matching more terms above one matching fewer", async () => {
    const result = await search({
      query: "search ranking",
      companyUuid,
      scope: "project",
      scopeUuid: projectA,
      entityTypes: ["task"],
      now: NOW,
    });

    const ids = result.results.map(r => r.uuid);
    expect(ids.indexOf("aaaa0001-0000-4000-8000-000000000001")).toBeLessThan(
      ids.indexOf("aaaa0002-0000-4000-8000-000000000002"),
    );
  });

  it("still finds CJK text, which Postgres' parsers do not segment", async () => {
    // The whole reason the substring stream is retained.
    const result = await search({
      query: "搜索排序",
      companyUuid,
      entityTypes: ["task"],
      explain: true,
      now: NOW,
    });

    expect(result.results.map(r => r.uuid)).toContain(
      "aaaa0003-0000-4000-8000-000000000003",
    );
    const hit = result.results.find(
      r => r.uuid === "aaaa0003-0000-4000-8000-000000000003",
    )!;
    expect(hit.explain!.streams.map(s => s.stream)).toContain("substring");
  });

  it("treats LIKE wildcards in the query as literal characters", async () => {
    const percent = await search({
      query: "100%", companyUuid, entityTypes: ["task"], now: NOW,
    });
    expect(percent.results.map(r => r.uuid)).toEqual([
      "aaaa0004-0000-4000-8000-000000000004",
    ]);

    const underscore = await search({
      query: "snake_case", companyUuid, entityTypes: ["task"], now: NOW,
    });
    expect(underscore.results.map(r => r.uuid)).toEqual([
      "aaaa0004-0000-4000-8000-000000000004",
    ]);
  });

  it("accepts a punctuation-only query via the never-matching sentinel", async () => {
    // Postgres rejects an empty tsquery; this proves the sentinel is valid SQL.
    const result = await search({
      query: "!!!", companyUuid, entityTypes: ["task"], now: NOW,
    });

    expect(result.results).toEqual([]);
  });

  it("lifts an approved proposal above an identically-worded rejected one", async () => {
    const result = await search({
      query: "fused ranking proposal",
      companyUuid,
      entityTypes: ["proposal"],
      now: NOW,
    });

    expect(result.results[0].uuid).toBe(proposalApproved);
    // Authority nudges; the rejected one is still retrievable.
    expect(result.results.map(r => r.uuid)).toContain(proposalRejected);
  });

  it("never crosses the tenant boundary", async () => {
    const result = await search({
      query: "ranking", companyUuid, entityTypes: ["task"], limit: 100, now: NOW,
    });

    expect(result.results.map(r => r.uuid)).not.toContain(
      "aaaa0006-0000-4000-8000-000000000006",
    );
  });

  it("scopes to one project", async () => {
    const result = await search({
      query: "search ranking",
      companyUuid,
      scope: "project",
      scopeUuid: projectB,
      entityTypes: ["task"],
      now: NOW,
    });

    expect(result.results.map(r => r.uuid)).toEqual([
      "aaaa0005-0000-4000-8000-000000000005",
    ]);
  });

  it("scopes to a group's projects", async () => {
    const result = await search({
      query: "search ranking",
      companyUuid,
      scope: "group",
      scopeUuid: groupUuid,
      entityTypes: ["task"],
      limit: 100,
      now: NOW,
    });

    const ids = result.results.map(r => r.uuid);
    expect(ids).toContain("aaaa0001-0000-4000-8000-000000000001");
    // projectB is outside the group.
    expect(ids).not.toContain("aaaa0005-0000-4000-8000-000000000005");
  });

  it("handles a group with no projects (empty text[] parameter)", async () => {
    // `= ANY('{}')` is the edge case an empty IN list would break on.
    const result = await search({
      query: "search ranking",
      companyUuid,
      scope: "group",
      scopeUuid: emptyGroupUuid,
      entityTypes: ["task"],
      now: NOW,
    });

    expect(result.results).toEqual([]);
    expect(result.counts.tasks).toBe(0);
  });

  it("returns project and project-group rows with null parent fields", async () => {
    // Exercises the NULL::text casts in those two statements.
    const projects = await search({
      query: "Alpha", companyUuid, entityTypes: ["project"], now: NOW,
    });
    expect(projects.results[0]).toMatchObject({
      entityType: "project", title: "Alpha",
      status: "active", projectUuid: null, projectName: null,
    });

    const groups = await search({
      query: "Platform", companyUuid, entityTypes: ["project_group"], now: NOW,
    });
    expect(groups.results[0]).toMatchObject({
      entityType: "project_group", title: "Platform Group",
      projectUuid: null, projectName: null,
    });
  });

  it("reports the true match count even when the page is smaller", async () => {
    // count(*) OVER () comes back as a bigint from real Postgres.
    const result = await search({
      query: "ranking",
      companyUuid,
      scope: "project",
      scopeUuid: projectA,
      entityTypes: ["task"],
      limit: 1,
      now: NOW,
    });

    expect(result.results).toHaveLength(1);
    expect(result.counts.tasks).toBeGreaterThan(1);
    expect(Number.isInteger(result.counts.tasks)).toBe(true);
  });

  it("expands along real lineage edges", async () => {
    // "spike" appears in exactly one row, so everything else in the response
    // can only have arrived through lineage expansion. The matching task
    // carries a proposalUuid and a dependency edge.
    const result = await search({
      query: "spike",
      companyUuid,
      scope: "project",
      scopeUuid: projectA,
      limit: 50,
      explain: true,
      now: NOW,
    });

    const ids = result.results.map(r => r.uuid);
    expect(ids[0]).toBe("aaaa0002-0000-4000-8000-000000000002");
    // Its proposal, reached by the upward hop.
    expect(ids).toContain(proposalApproved);
    // Its dependency, reached through TaskDependency.
    expect(ids).toContain("aaaa0001-0000-4000-8000-000000000001");

    const neighbour = result.results.find(r => r.uuid === proposalApproved)!;
    expect(neighbour.explain!.streams.map(s => s.stream)).toEqual(["graph"]);
  });

  it("expands idea lineage in both directions", async () => {
    const result = await search({
      query: "retrieval",
      companyUuid,
      scope: "project",
      scopeUuid: projectA,
      entityTypes: ["idea"],
      limit: 50,
      now: NOW,
    });

    const ids = result.results.map(r => r.uuid);
    expect(ids).toContain("eeee0001-0000-4000-8000-000000000001");
    expect(ids).toContain("eeee0002-0000-4000-8000-000000000002");
  });

  it("finds an ADR by its content and reports its type as status", async () => {
    const result = await search({
      query: "reciprocal rank fusion",
      companyUuid,
      entityTypes: ["document"],
      now: NOW,
    });

    expect(result.results[0]).toMatchObject({
      uuid: "dddd0001-0000-4000-8000-000000000001",
      entityType: "document",
      status: "adr",
    });
  });

  it("prefix-matches the last term so typeahead works mid-word", async () => {
    const result = await search({
      query: "rank", companyUuid, entityTypes: ["document"], now: NOW,
    });

    // "rank" is a prefix of "Ranking" in the title.
    expect(result.results.map(r => r.uuid)).toContain(
      "dddd0001-0000-4000-8000-000000000001",
    );
  });
});
