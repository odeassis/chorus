import { vi, describe, it, expect, beforeEach } from "vitest";

// ===== Module mocks (hoisted) =====

const mockPrisma = vi.hoisted(() => ({
  // Text search runs through raw SQL: one statement per entity type, each
  // generating both the full-text and the substring stream in one pass.
  $queryRaw: vi.fn(),
  task: { findFirst: vi.fn(), findMany: vi.fn() },
  idea: { findFirst: vi.fn(), findMany: vi.fn() },
  proposal: { findFirst: vi.fn(), findMany: vi.fn() },
  document: { findFirst: vi.fn(), findMany: vi.fn() },
  project: { findFirst: vi.fn(), findMany: vi.fn() },
  projectGroup: { findFirst: vi.fn(), findMany: vi.fn() },
  taskDependency: { findMany: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// ===== Import under test (after mocks) =====

import { search, type EntityType } from "@/services/search.service";

// ===== Fixtures =====

const NOW = new Date("2026-08-17T12:00:00.000Z");
const DAY = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

/** One row as the per-type SQL would return it. */
function row(overrides: { uuid: string } & Record<string, unknown>) {
  return {
    title: `Title ${overrides.uuid}`,
    body: null,
    status: "open",
    projectUuid: "project-1",
    projectName: "Project A",
    updatedAt: NOW,
    linkUuid: null,
    ftsRank: 0,
    likeMatch: true,
    totalCount: 1,
    ...overrides,
  };
}

/** Which entity table a raw statement targets. */
function tableOf(sql: string): EntityType | "unknown" {
  if (sql.includes('FROM "Task"')) return "task";
  if (sql.includes('FROM "Idea"')) return "idea";
  if (sql.includes('FROM "Proposal"')) return "proposal";
  if (sql.includes('FROM "Document"')) return "document";
  if (sql.includes('FROM "ProjectGroup"')) return "project_group";
  if (sql.includes('FROM "Project"')) return "project";
  return "unknown";
}

/** Serve raw-SQL results per entity type, ignoring statement order. */
function serveRaw(byType: Partial<Record<EntityType, unknown[]>>) {
  mockPrisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
    Promise.resolve(byType[tableOf(strings.join(" ")) as EntityType] ?? []),
  );
}

/** Entity types whose raw statement was issued. */
function queriedTypes(): string[] {
  return mockPrisma.$queryRaw.mock.calls.map(([strings]) =>
    tableOf((strings as TemplateStringsArray).join(" ")),
  );
}

/** Interpolated values of the raw statement for one entity type. */
function valuesFor(type: EntityType): unknown[] {
  const call = mockPrisma.$queryRaw.mock.calls.find(
    ([strings]) => tableOf((strings as TemplateStringsArray).join(" ")) === type,
  );
  return call ? call.slice(1) : [];
}

// ===== Test Suite =====

describe("search.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [key, model] of Object.entries(mockPrisma)) {
      if (key === "$queryRaw") continue;
      const m = model as Record<string, ReturnType<typeof vi.fn>>;
      m.findFirst?.mockResolvedValue(null);
      m.findMany?.mockResolvedValue([]);
    }
    serveRaw({});
  });

  describe("canonical UUID search", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";

    it("returns an exact compact result with tenant isolation", async () => {
      mockPrisma.task.findFirst.mockResolvedValue({
        uuid,
        title: "Exact task",
        status: "open",
        projectUuid: "project-1",
        updatedAt: NOW,
        project: { name: "Project A" },
      });

      const result = await search({
        query: uuid.toUpperCase(),
        companyUuid: "company-1",
        entityTypes: ["task"],
      });

      expect(mockPrisma.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { uuid, companyUuid: "company-1" },
      }));
      expect(result).toEqual({
        results: [{
          entityType: "task",
          uuid,
          title: "Exact task",
          snippet: "",
          status: "open",
          projectUuid: "project-1",
          projectName: "Project A",
          updatedAt: NOW.toISOString(),
          score: 0,
        }],
        counts: {
          tasks: 1,
          ideas: 0,
          proposals: 0,
          documents: 0,
          projects: 0,
          projectGroups: 0,
        },
      });
      // An exact hit short-circuits before any ranking work.
      expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("honors entity and project filters", async () => {
      await search({
        query: uuid,
        companyUuid: "company-1",
        scope: "project",
        scopeUuid: "project-1",
        entityTypes: ["idea", "project_group"],
      });

      expect(mockPrisma.idea.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          uuid,
          companyUuid: "company-1",
          projectUuid: { in: ["project-1"] },
        },
      }));
      expect(mockPrisma.task.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.projectGroup.findFirst).not.toHaveBeenCalled();
    });

    it("falls back to text search when no exact UUID match survives filters", async () => {
      const result = await search({
        query: uuid,
        companyUuid: "company-1",
        scope: "project",
        scopeUuid: "project-1",
        entityTypes: ["task"],
      });

      expect(mockPrisma.task.findFirst).toHaveBeenCalled();
      expect(queriedTypes()).toEqual(["task"]);
      expect(valuesFor("task")).toContain("company-1");
      expect(result.results).toEqual([]);
    });

    it("resolves an exact proposal", async () => {
      mockPrisma.proposal.findFirst.mockResolvedValue({
        uuid, title: "Exact proposal", status: "approved",
        projectUuid: "project-1", updatedAt: NOW, project: { name: "Project A" },
      });

      const result = await search({
        query: uuid, companyUuid: "company-1", entityTypes: ["proposal"],
      });

      expect(result.results[0]).toMatchObject({
        entityType: "proposal", uuid, status: "approved", score: 0,
      });
      expect(result.counts.proposals).toBe(1);
    });

    it("resolves an exact document, reporting its type as status", async () => {
      mockPrisma.document.findFirst.mockResolvedValue({
        uuid, title: "Exact doc", type: "adr",
        projectUuid: "project-1", updatedAt: NOW, project: { name: "Project A" },
      });

      const result = await search({
        query: uuid, companyUuid: "company-1", entityTypes: ["document"],
      });

      expect(result.results[0]).toMatchObject({
        entityType: "document", uuid, status: "adr",
      });
      expect(result.counts.documents).toBe(1);
    });

    it("resolves an exact project with null parent-project fields", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({
        uuid, name: "Exact project", updatedAt: NOW,
      });

      const result = await search({
        query: uuid, companyUuid: "company-1", entityTypes: ["project"],
      });

      expect(result.results[0]).toMatchObject({
        entityType: "project", uuid, title: "Exact project",
        status: "active", projectUuid: null, projectName: null,
      });
      expect(result.counts.projects).toBe(1);
    });

    it("does not return a project outside the scoped project list", async () => {
      mockPrisma.project.findFirst.mockResolvedValue({
        uuid, name: "Other project", updatedAt: NOW,
      });

      const result = await search({
        query: uuid,
        companyUuid: "company-1",
        scope: "project",
        scopeUuid: "a-different-project",
        entityTypes: ["project"],
      });

      expect(result.results).toEqual([]);
      expect(mockPrisma.project.findFirst).not.toHaveBeenCalled();
    });

    it("resolves an exact project group", async () => {
      mockPrisma.projectGroup.findFirst.mockResolvedValue({
        uuid, name: "Exact group", updatedAt: NOW,
      });

      const result = await search({
        query: uuid, companyUuid: "company-1", entityTypes: ["project_group"],
      });

      expect(result.results[0]).toMatchObject({
        entityType: "project_group", uuid, status: "active",
        projectUuid: null, projectName: null,
      });
      expect(result.counts.projectGroups).toBe(1);
    });

    it("never resolves a project group under project scope", async () => {
      mockPrisma.projectGroup.findFirst.mockResolvedValue({
        uuid, name: "Exact group", updatedAt: NOW,
      });

      const result = await search({
        query: uuid,
        companyUuid: "company-1",
        scope: "project",
        scopeUuid: "project-1",
        entityTypes: ["project_group"],
      });

      expect(result.results).toEqual([]);
      expect(mockPrisma.projectGroup.findFirst).not.toHaveBeenCalled();
    });

    it("does not resolve a project group other than the scoped one", async () => {
      mockPrisma.project.findMany.mockResolvedValue([]);
      mockPrisma.projectGroup.findFirst.mockResolvedValue({
        uuid, name: "Exact group", updatedAt: NOW,
      });

      const result = await search({
        query: uuid,
        companyUuid: "company-1",
        scope: "group",
        scopeUuid: "a-different-group",
        entityTypes: ["project_group"],
      });

      expect(result.results).toEqual([]);
      expect(mockPrisma.projectGroup.findFirst).not.toHaveBeenCalled();
    });

    it("does not attempt exact lookup for non-canonical UUID text", async () => {
      await search({
        query: "123e4567-e89b-42d3-a456",
        companyUuid: "company-1",
        entityTypes: ["task"],
      });

      expect(mockPrisma.task.findFirst).not.toHaveBeenCalled();
      expect(queriedTypes()).toEqual(["task"]);
    });
  });

  describe("query translation", () => {
    it("passes an OR-ed prefix tsquery so multi-word queries match", async () => {
      await search({
        query: "search ranking",
        companyUuid: "company-1",
        entityTypes: ["task"],
      });

      expect(valuesFor("task")).toContain("'search' | 'ranking':*");
    });

    it("passes a never-matching tsquery when the text has no usable term", async () => {
      // Postgres rejects an empty tsquery, so the substring stream has to carry
      // a punctuation-only query on its own.
      await search({
        query: "!!!",
        companyUuid: "company-1",
        entityTypes: ["task"],
      });

      expect(valuesFor("task")).toContain("'chorusnomatchsentinel'");
      expect(valuesFor("task")).toContain("%!!!%");
    });

    it("escapes LIKE wildcards so they match literally", async () => {
      await search({
        query: "100%_done",
        companyUuid: "company-1",
        entityTypes: ["task"],
      });

      expect(valuesFor("task")).toContain("%100\\%\\_done%");
    });
  });

  describe("relevance ranking", () => {
    it("ranks a two-stream match above a single-stream match", async () => {
      serveRaw({
        task: [
          row({ uuid: "task-both", ftsRank: 0.5, likeMatch: true, totalCount: 2 }),
          row({ uuid: "task-fts-only", ftsRank: 0.9, likeMatch: false }),
        ],
      });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task"],
        now: NOW,
      });

      // task-fts-only ranks first in the full-text stream, but task-both is
      // corroborated by two independent streams.
      expect(result.results.map(r => r.uuid)).toEqual(["task-both", "task-fts-only"]);
      expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
    });

    it("ranks by relevance, not recency", async () => {
      // The behaviour this change replaces sorted purely by updatedAt, so a
      // freshly touched weak match always won. It must not any more.
      serveRaw({
        task: [
          row({ uuid: "task-strong", ftsRank: 0.9, likeMatch: true, updatedAt: daysAgo(200), totalCount: 2 }),
          row({ uuid: "task-weak", ftsRank: 0, likeMatch: true, updatedAt: NOW }),
        ],
      });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task"],
        now: NOW,
      });

      expect(result.results[0].uuid).toBe("task-strong");
    });

    it("lifts an approved proposal above a rejected one at equal relevance", async () => {
      serveRaw({
        proposal: [
          row({ uuid: "prop-rejected", status: "rejected", ftsRank: 0.5, totalCount: 2 }),
          row({ uuid: "prop-approved", status: "approved", ftsRank: 0.5 }),
        ],
      });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["proposal"],
        now: NOW,
      });

      expect(result.results[0].uuid).toBe("prop-approved");
      // Authority nudges; it never excludes.
      expect(result.results.map(r => r.uuid)).toContain("prop-rejected");
    });

    it("fuses streams across entity types, not within one type", async () => {
      serveRaw({
        task: [row({ uuid: "task-1", ftsRank: 0.1, likeMatch: false })],
        document: [row({ uuid: "doc-1", status: "adr", ftsRank: 0.9, likeMatch: true })],
      });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task", "document"],
        now: NOW,
      });

      expect(result.results[0].uuid).toBe("doc-1");
      expect(result.results[0].entityType).toBe("document");
    });

    it("truncates to the requested limit after ranking", async () => {
      serveRaw({
        task: Array.from({ length: 5 }, (_, i) =>
          row({ uuid: `task-${i}`, ftsRank: 1 - i / 10, totalCount: 5 }),
        ),
      });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task"],
        limit: 2,
        now: NOW,
      });

      expect(result.results).toHaveLength(2);
      // The kept results are the highest-ranked, not the first fetched.
      expect(result.results.map(r => r.uuid)).toEqual(["task-0", "task-1"]);
      // counts still reports every match, not just the returned page.
      expect(result.counts.tasks).toBe(5);
    });
  });

  describe("explain", () => {
    it("omits ranking provenance by default", async () => {
      serveRaw({ task: [row({ uuid: "task-1", ftsRank: 0.5 })] });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task"],
        now: NOW,
      });

      expect(result.results[0]).not.toHaveProperty("explain");
      expect(result.results[0].score).toBeGreaterThan(0);
    });

    it("reports which streams matched and how authority adjusted the score", async () => {
      serveRaw({
        proposal: [row({ uuid: "prop-1", status: "approved", ftsRank: 0.5, likeMatch: true })],
      });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["proposal"],
        explain: true,
        now: NOW,
      });

      const explain = result.results[0].explain!;
      expect(explain.streams.map(s => s.stream)).toEqual(["fts", "substring"]);
      expect(explain.streams[0].rank).toBe(1);
      expect(explain.authority.factors.map(f => f.name)).toContain("status:approved");
      expect(explain.finalScore).toBe(result.results[0].score);
    });
  });

  describe("counts", () => {
    it("reports the window count, independent of how many rows were fetched", async () => {
      serveRaw({
        task: [row({ uuid: "task-1", totalCount: 137 })],
        idea: [row({ uuid: "idea-1", totalCount: 4 })],
      });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task", "idea"],
        now: NOW,
      });

      expect(result.counts.tasks).toBe(137);
      expect(result.counts.ideas).toBe(4);
    });

    it("coerces a bigint window count", async () => {
      serveRaw({ task: [row({ uuid: "task-1", totalCount: BigInt(9) })] });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task"],
        now: NOW,
      });

      expect(result.counts.tasks).toBe(9);
    });

    it("reports zero for a type with no matches", async () => {
      const result = await search({
        query: "q",
        companyUuid: "company-1",
        now: NOW,
      });

      expect(result.counts).toEqual({
        tasks: 0, ideas: 0, proposals: 0, documents: 0, projects: 0, projectGroups: 0,
      });
    });
  });

  describe("scope", () => {
    it("queries every entity type by default", async () => {
      await search({ query: "q", companyUuid: "company-1" });

      expect(queriedTypes().sort()).toEqual(
        ["document", "idea", "project", "project_group", "proposal", "task"],
      );
    });

    it("queries only the requested entity types", async () => {
      await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task", "document"],
      });

      expect(queriedTypes().sort()).toEqual(["document", "task"]);
    });

    it("marks the statement unscoped for global search", async () => {
      await search({ query: "q", companyUuid: "company-1", entityTypes: ["task"] });

      expect(valuesFor("task")).toContain(true);
    });

    it("passes the project list for project scope", async () => {
      await search({
        query: "q",
        companyUuid: "company-1",
        scope: "project",
        scopeUuid: "project-9",
        entityTypes: ["task"],
      });

      const values = valuesFor("task");
      expect(values).toContain(false);
      expect(values).toContainEqual(["project-9"]);
    });

    it("resolves a group to its projects before searching", async () => {
      mockPrisma.project.findMany.mockResolvedValue([
        { uuid: "project-1" },
        { uuid: "project-2" },
      ]);

      await search({
        query: "q",
        companyUuid: "company-1",
        scope: "group",
        scopeUuid: "group-1",
        entityTypes: ["task"],
      });

      expect(mockPrisma.project.findMany).toHaveBeenCalledWith({
        where: { companyUuid: "company-1", groupUuid: "group-1" },
        select: { uuid: true },
      });
      expect(valuesFor("task")).toContainEqual(["project-1", "project-2"]);
    });

    it("passes an empty project list for a group with no projects", async () => {
      mockPrisma.project.findMany.mockResolvedValue([]);

      await search({
        query: "q",
        companyUuid: "company-1",
        scope: "group",
        scopeUuid: "empty-group",
        entityTypes: ["task"],
      });

      expect(valuesFor("task")).toContainEqual([]);
    });

    it("restricts project groups to the scoped group", async () => {
      mockPrisma.project.findMany.mockResolvedValue([]);

      await search({
        query: "q",
        companyUuid: "company-1",
        scope: "group",
        scopeUuid: "group-1",
        entityTypes: ["project_group"],
      });

      const values = valuesFor("project_group");
      expect(values).toContain(true);
      expect(values).toContain("group-1");
    });

    it("leaves project groups unrestricted outside group scope", async () => {
      await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["project_group"],
      });

      const values = valuesFor("project_group");
      expect(values).toContain(false);
      expect(values).toContain("");
    });

    it("scopes every statement by companyUuid", async () => {
      await search({ query: "q", companyUuid: "company-42" });

      const calls = mockPrisma.$queryRaw.mock.calls;
      expect(calls).toHaveLength(6);
      for (const call of calls) {
        expect(call.slice(1)).toContain("company-42");
      }
    });
  });

  describe("graph-neighbour stream", () => {
    it("surfaces the proposal behind a matching task", async () => {
      serveRaw({ task: [row({ uuid: "task-1", ftsRank: 0.9, linkUuid: "prop-1" })] });
      mockPrisma.proposal.findMany.mockResolvedValue([{
        uuid: "prop-1",
        title: "Parent proposal",
        description: "Body",
        status: "approved",
        projectUuid: "project-1",
        updatedAt: NOW,
        project: { name: "Project A" },
      }]);

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task", "proposal"],
        now: NOW,
      });

      expect(mockPrisma.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          companyUuid: "company-1",
          uuid: { in: ["prop-1"] },
        }),
      }));
      expect(result.results.map(r => r.uuid)).toEqual(["task-1", "prop-1"]);
      // Context must not outrank the direct textual hit.
      expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
    });

    it("surfaces the tasks and documents under a matching proposal", async () => {
      serveRaw({ proposal: [row({ uuid: "prop-1", status: "approved", ftsRank: 0.9 })] });
      mockPrisma.task.findMany.mockResolvedValue([{
        uuid: "task-9", title: "Child task", description: null, status: "open",
        proposalUuid: "prop-1", projectUuid: "project-1", updatedAt: NOW,
        project: { name: "Project A" },
      }]);
      mockPrisma.document.findMany.mockResolvedValue([{
        uuid: "doc-9", title: "Child doc", content: null, type: "prd",
        proposalUuid: "prop-1", projectUuid: "project-1", updatedAt: NOW,
        project: { name: "Project A" },
      }]);

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["proposal", "task", "document"],
        now: NOW,
      });

      expect(result.results.map(r => r.uuid)).toEqual(["prop-1", "doc-9", "task-9"]);
    });

    it("surfaces both directions of a task dependency edge", async () => {
      serveRaw({ task: [row({ uuid: "task-1", ftsRank: 0.9 })] });
      mockPrisma.taskDependency.findMany.mockResolvedValue([
        { taskUuid: "task-1", dependsOnUuid: "task-upstream" },
        { taskUuid: "task-downstream", dependsOnUuid: "task-1" },
      ]);
      mockPrisma.task.findMany.mockResolvedValue([
        {
          uuid: "task-upstream", title: "Upstream", description: null, status: "done",
          proposalUuid: null, projectUuid: "project-1", updatedAt: NOW,
          project: { name: "Project A" },
        },
        {
          uuid: "task-downstream", title: "Downstream", description: null, status: "open",
          proposalUuid: null, projectUuid: "project-1", updatedAt: NOW,
          project: { name: "Project A" },
        },
      ]);

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task"],
        now: NOW,
      });

      expect(mockPrisma.task.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ uuid: { in: ["task-upstream", "task-downstream"] } }),
      }));
      expect(result.results.map(r => r.uuid)).toEqual([
        "task-1", "task-upstream", "task-downstream",
      ]);
    });

    it("walks idea lineage in both directions", async () => {
      serveRaw({ idea: [row({ uuid: "idea-1", ftsRank: 0.9, linkUuid: "idea-parent" })] });
      mockPrisma.idea.findMany.mockResolvedValue([{
        uuid: "idea-parent", title: "Parent idea", content: null, status: "elaborated",
        parentUuid: null, projectUuid: "project-1", updatedAt: NOW,
        project: { name: "Project A" },
      }]);

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["idea"],
        now: NOW,
      });

      expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { parentUuid: { in: ["idea-1"] } },
            { uuid: { in: ["idea-parent"] } },
          ],
        }),
      }));
      expect(result.results.map(r => r.uuid)).toEqual(["idea-1", "idea-parent"]);
    });

    it("does not expand into an entity type the caller excluded", async () => {
      serveRaw({ task: [row({ uuid: "task-1", ftsRank: 0.9, linkUuid: "prop-1" })] });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task"],
        now: NOW,
      });

      expect(mockPrisma.proposal.findMany).not.toHaveBeenCalled();
      expect(result.results.map(r => r.uuid)).toEqual(["task-1"]);
    });

    it("does not duplicate a neighbour that already matched directly", async () => {
      serveRaw({
        task: [row({ uuid: "task-1", ftsRank: 0.9, linkUuid: "prop-1" })],
        proposal: [row({ uuid: "prop-1", status: "approved", ftsRank: 0.8 })],
      });
      mockPrisma.proposal.findMany.mockResolvedValue([{
        uuid: "prop-1", title: "Already matched", description: null, status: "approved",
        projectUuid: "project-1", updatedAt: NOW, project: { name: "Project A" },
      }]);

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["task", "proposal"],
        explain: true,
        now: NOW,
      });

      expect(result.results.filter(r => r.uuid === "prop-1")).toHaveLength(1);
      // It keeps its direct-hit provenance rather than being re-added as
      // half-weighted graph context.
      const prop = result.results.find(r => r.uuid === "prop-1")!;
      expect(prop.explain!.streams.map(s => s.stream)).toEqual(["fts", "substring"]);
    });

    it("skips expansion entirely when nothing matched", async () => {
      const result = await search({
        query: "q",
        companyUuid: "company-1",
        now: NOW,
      });

      expect(result.results).toEqual([]);
      expect(mockPrisma.proposal.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.taskDependency.findMany).not.toHaveBeenCalled();
    });

    it("caps how many neighbours it will contribute", async () => {
      serveRaw({ proposal: [row({ uuid: "prop-1", status: "approved", ftsRank: 0.9 })] });
      // More children than the cap allows.
      mockPrisma.task.findMany.mockResolvedValue(
        Array.from({ length: 30 }, (_, i) => ({
          uuid: `task-${i}`, title: `Child ${i}`, description: null, status: "open",
          proposalUuid: "prop-1", projectUuid: "project-1", updatedAt: NOW,
          project: { name: "Project A" },
        })),
      );

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["proposal", "task"],
        limit: 100,
        now: NOW,
      });

      // 1 direct hit + at most the neighbour cap.
      expect(result.results.length).toBeLessThanOrEqual(21);
      expect(result.results.filter(r => r.entityType === "task")).toHaveLength(20);
    });

    it("expands child ideas when no seed idea has a parent", async () => {
      serveRaw({ idea: [row({ uuid: "idea-root", ftsRank: 0.9, linkUuid: null })] });
      mockPrisma.idea.findMany.mockResolvedValue([{
        uuid: "idea-child", title: "Child idea", content: null, status: "open",
        parentUuid: "idea-root", projectUuid: "project-1", updatedAt: NOW,
        project: { name: "Project A" },
      }]);

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["idea"],
        now: NOW,
      });

      expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ parentUuid: { in: ["idea-root"] } }],
        }),
      }));
      expect(result.results.map(r => r.uuid)).toEqual(["idea-root", "idea-child"]);
    });

    it("confines expansion to the scoped projects", async () => {
      serveRaw({ task: [row({ uuid: "task-1", ftsRank: 0.9, linkUuid: "prop-1" })] });

      await search({
        query: "q",
        companyUuid: "company-1",
        scope: "project",
        scopeUuid: "project-1",
        entityTypes: ["task", "proposal"],
        now: NOW,
      });

      expect(mockPrisma.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ projectUuid: { in: ["project-1"] } }),
      }));
    });
  });

  describe("snippet generation", () => {
    // Long enough that a 100-char window centred mid-text is bounded on both
    // sides even after the helper nudges the start to a word boundary.
    const longBody =
      "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod " +
      "tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam " +
      "quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo " +
      "consequat duis aute irure dolor in reprehenderit in voluptate velit esse " +
      "cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat";

    async function snippetFor(body: string | null, query: string, title = "Task title") {
      serveRaw({ task: [row({ uuid: "task-1", title, body, ftsRank: 0.5 })] });
      const result = await search({
        query,
        companyUuid: "company-1",
        entityTypes: ["task"],
        now: NOW,
      });
      return result.results[0].snippet;
    }

    it("centres the excerpt on the match with ellipsis on both sides", async () => {
      const snippet = await snippetFor(longBody, "exercitation");

      expect(snippet).toContain("exercitation");
      expect(snippet.startsWith("...")).toBe(true);
      expect(snippet.endsWith("...")).toBe(true);
    });

    it("returns the head of the text when the query is not in the body", async () => {
      const snippet = await snippetFor(longBody, "absent");

      expect(snippet.startsWith("Lorem ipsum")).toBe(true);
      expect(snippet.endsWith("...")).toBe(true);
    });

    it("returns short text whole, without ellipsis", async () => {
      const snippet = await snippetFor("Short body", "body");

      expect(snippet).toBe("Short body");
    });

    it("falls back to the title when the body is empty", async () => {
      const snippet = await snippetFor(null, "title", "Task title");

      expect(snippet).toBe("Task title");
    });

    it("matches case-insensitively", async () => {
      const snippet = await snippetFor("Contains MixedCase Word", "mixedcase");

      expect(snippet).toContain("MixedCase");
    });

    it("returns an empty snippet when there is no text at all", async () => {
      const snippet = await snippetFor(null, "anything", "");

      expect(snippet).toBe("");
    });
  });

  describe("result structure", () => {
    it("returns a fully populated project-scoped result", async () => {
      serveRaw({
        task: [row({
          uuid: "task-1",
          title: "Implement search",
          body: "Add ranking to search",
          status: "in_progress",
          ftsRank: 0.5,
        })],
      });

      const result = await search({
        query: "search",
        companyUuid: "company-1",
        entityTypes: ["task"],
        now: NOW,
      });

      expect(result.results[0]).toEqual({
        entityType: "task",
        uuid: "task-1",
        title: "Implement search",
        snippet: "Add ranking to search",
        status: "in_progress",
        projectUuid: "project-1",
        projectName: "Project A",
        updatedAt: NOW.toISOString(),
        score: expect.any(Number),
      });
    });

    it("returns null project fields for a project group", async () => {
      serveRaw({
        project_group: [row({
          uuid: "group-1",
          title: "Platform",
          body: "Group description",
          status: "active",
          projectUuid: null,
          projectName: null,
          ftsRank: 0.5,
        })],
      });

      const result = await search({
        query: "platform",
        companyUuid: "company-1",
        entityTypes: ["project_group"],
        now: NOW,
      });

      expect(result.results[0]).toMatchObject({
        entityType: "project_group",
        projectUuid: null,
        projectName: null,
        status: "active",
      });
    });

    it("uses document type as the status field", async () => {
      serveRaw({
        document: [row({ uuid: "doc-1", status: "adr", ftsRank: 0.5, projectUuid: "project-1" })],
      });

      const result = await search({
        query: "q",
        companyUuid: "company-1",
        entityTypes: ["document"],
        now: NOW,
      });

      expect(result.results[0].status).toBe("adr");
    });
  });

  describe("error handling", () => {
    it("should throw error if scopeUuid missing for project scope", async () => {
      await expect(
        search({ query: "q", companyUuid: "company-1", scope: "project" }),
      ).rejects.toThrow('scopeUuid is required for scope "project"');
    });

    it("should throw error if scopeUuid missing for group scope", async () => {
      await expect(
        search({ query: "q", companyUuid: "company-1", scope: "group" }),
      ).rejects.toThrow('scopeUuid is required for scope "group"');
    });
  });
});
