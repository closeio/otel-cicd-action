import { getOctokit } from "@actions/github";
import { getJobsAnnotations } from "./github";

interface Variables {
  ids: string[];
  after: string | null;
}

// Exercise Octokit's GraphQL response/error handling without making network requests.
function graphqlClient(...responses: unknown[]) {
  const octokit = getOctokit("test-token");
  const requests: Variables[] = [];
  const queries: string[] = [];
  octokit.hook.wrap("request", (_, options) => {
    if (options.method !== "POST" || options.url !== "/graphql") {
      throw new Error(`Unexpected request: ${options.method} ${options.url}`);
    }
    const { query, variables } = options as typeof options & { query: string; variables: Variables };
    queries.push(query);
    requests.push(variables);
    if (responses.length === 0) {
      throw new Error("Unexpected GraphQL request");
    }
    const data = responses.shift();
    if (data instanceof Error) {
      throw data;
    }
    return Promise.resolve({ status: 200, url: "https://api.github.com/graphql", headers: {}, data });
  });
  return { octokit, requests, queries };
}

function checkRun(
  id: string,
  nodes: { annotationLevel: string; message: string }[] = [],
  hasNextPage = false,
  endCursor: string | null = null
) {
  return { id, annotations: { nodes, pageInfo: { hasNextPage, endCursor } } };
}

function gql(...nodes: unknown[]) {
  return { data: { nodes } };
}

const apiError = { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] };
const warning = { annotationLevel: "WARNING", message: "Warning on a successful job\nwith details" };

describe("getJobsAnnotations", () => {
  it("does not request annotations for an empty job list", async () => {
    const { octokit, requests } = graphqlClient();
    expect(await getJobsAnnotations(octokit, [])).toEqual({ annotations: {}, warnings: [] });
    expect(requests).toEqual([]);
  });

  it("uses node IDs, maps back to numeric job IDs, and preserves all levels and messages, including successful jobs", async () => {
    const jobs = [
      { id: 61_901_817_921, node_id: "check-run-success", conclusion: "success" },
      { id: 61_901_817_922, node_id: "check-run-failure", conclusion: "failure" },
      { id: 61_901_817_923, node_id: "check-run-empty", conclusion: "success" },
    ];
    const { octokit, requests, queries } = graphqlClient(
      gql(
        checkRun(jobs[0].node_id, [warning, { annotationLevel: "NOTICE", message: "Notice" }]),
        checkRun(jobs[1].node_id, [{ annotationLevel: "FAILURE", message: "Failure" }]),
        checkRun(jobs[2].node_id)
      )
    );

    expect(await getJobsAnnotations(octokit, jobs)).toEqual({
      annotations: {
        [jobs[0].id]: [
          { annotation_level: "warning", message: warning.message },
          { annotation_level: "notice", message: "Notice" },
        ],
        [jobs[1].id]: [{ annotation_level: "failure", message: "Failure" }],
        [jobs[2].id]: [],
      },
      warnings: [],
    });
    expect(requests).toEqual([{ ids: jobs.map((job) => job.node_id), after: null }]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("query JobAnnotations($ids: [ID!]!, $after: String)");
    expect(queries[0]).toContain("nodes(ids: $ids)");
    expect(queries[0]).toContain("... on CheckRun");
    expect(queries[0]).toContain("annotations(first: 100, after: $after)");
    expect(queries[0]).toContain("nodes { annotationLevel message }");
    expect(queries[0]).toContain("pageInfo { hasNextPage endCursor }");
  });

  it("batches more than 100 jobs without dropping empty results", async () => {
    const jobs = Array.from({ length: 205 }, (_, id) => ({ id, node_id: `check-run-${id}` }));
    const { octokit, requests } = graphqlClient(
      gql(...jobs.slice(0, 100).map((job) => checkRun(job.node_id))),
      gql(...jobs.slice(100, 200).map((job) => checkRun(job.node_id))),
      gql(...jobs.slice(200).map((job) => checkRun(job.node_id)))
    );

    expect(await getJobsAnnotations(octokit, jobs)).toEqual({
      annotations: Object.fromEntries(jobs.map((job) => [job.id, []])),
      warnings: [],
    });
    expect(requests).toEqual([
      { ids: jobs.slice(0, 100).map((job) => job.node_id), after: null },
      { ids: jobs.slice(100, 200).map((job) => job.node_id), after: null },
      { ids: jobs.slice(200).map((job) => job.node_id), after: null },
    ]);
  });

  it("concatenates all annotation pages using only that job's cursor and node ID", async () => {
    const jobs = [
      { id: 1, node_id: "many-annotations" },
      { id: 2, node_id: "other-job" },
    ];
    const nodes = Array.from({ length: 201 }, (_, i) => ({ annotationLevel: "NOTICE", message: `Annotation ${i}` }));
    const { octokit, requests } = graphqlClient(
      gql(checkRun(jobs[0].node_id, nodes.slice(0, 100), true, "page-1"), checkRun(jobs[1].node_id, [warning])),
      gql(checkRun(jobs[0].node_id, nodes.slice(100, 200), true, "page-2")),
      gql(checkRun(jobs[0].node_id, nodes.slice(200)))
    );

    expect(await getJobsAnnotations(octokit, jobs)).toEqual({
      annotations: {
        1: nodes.map((node) => ({ annotation_level: "notice", message: node.message })),
        2: [{ annotation_level: "warning", message: warning.message }],
      },
      warnings: [],
    });
    expect(requests).toEqual([
      { ids: jobs.map((job) => job.node_id), after: null },
      { ids: [jobs[0].node_id], after: "page-1" },
      { ids: [jobs[0].node_id], after: "page-2" },
    ]);
  });

  it.each([
    null,
    {},
    { id: "wrong-id" },
    { id: "bad-job" },
  ])("reports an inaccessible or malformed node (%j) without losing other jobs' annotations", async (badNode) => {
    const jobs = [
      { id: 1, node_id: "before" },
      { id: 2, node_id: "bad-job" },
      { id: 3, node_id: "after" },
    ];
    const { octokit, requests } = graphqlClient(
      gql(checkRun("before", [warning]), badNode, checkRun("after", [warning]))
    );
    const { annotations, warnings } = await getJobsAnnotations(octokit, jobs);
    expect(annotations).toEqual({
      1: [{ annotation_level: "warning", message: warning.message }],
      2: [],
      3: [{ annotation_level: "warning", message: warning.message }],
    });
    expect(warnings).toEqual([expect.stringContaining("job 2: Error: Missing check run annotations (bad-job)")]);
    expect(requests).toEqual([{ ids: ["before", "bad-job", "after"], after: null }]);
  });

  it("reports a missing node instead of treating it as an empty annotation list", async () => {
    const { octokit, requests } = graphqlClient(gql());
    const { warnings } = await getJobsAnnotations(octokit, [{ id: 1, node_id: "missing" }]);
    expect(warnings).toEqual([expect.stringContaining("Missing check run annotations (missing)")]);
    expect(requests).toEqual([{ ids: ["missing"], after: null }]);
  });

  it.each([null, ""])("stops when a next page has an invalid cursor (%j)", async (cursor) => {
    const { octokit, requests } = graphqlClient(gql(checkRun("job", [warning], true, cursor)));
    const { annotations, warnings } = await getJobsAnnotations(octokit, [{ id: 1, node_id: "job" }]);
    expect(annotations[1]).toEqual([{ annotation_level: "warning", message: warning.message }]);
    expect(warnings).toEqual([expect.stringContaining("job 1: Error: Invalid annotation pagination cursor")]);
    expect(requests).toEqual([{ ids: ["job"], after: null }]);
  });

  it.each([
    ["page-1", "page-1"],
    ["page-1", "page-2", "page-1"],
  ])("stops on repeated or cycling cursors (%j)", async (...cursors) => {
    const { octokit, requests } = graphqlClient(...cursors.map((cursor) => gql(checkRun("job", [], true, cursor))));
    const { warnings } = await getJobsAnnotations(octokit, [{ id: 1, node_id: "job" }]);
    expect(warnings).toEqual([expect.stringContaining("Invalid annotation pagination cursor")]);
    expect(requests).toEqual([
      { ids: ["job"], after: null },
      ...cursors.slice(0, -1).map((after) => ({ ids: ["job"], after })),
    ]);
  });

  it.each([
    gql(null),
    apiError,
    new Error("Network unavailable"),
  ])("preserves fetched pages and other jobs when pagination fails (%j)", async (failedPage) => {
    const { octokit, requests } = graphqlClient(
      gql(checkRun("job", [warning], true, "page-1"), checkRun("other", [warning])),
      failedPage
    );
    const { annotations, warnings } = await getJobsAnnotations(octokit, [
      { id: 1, node_id: "job" },
      { id: 2, node_id: "other" },
    ]);
    expect(annotations).toEqual({
      1: [{ annotation_level: "warning", message: warning.message }],
      2: [{ annotation_level: "warning", message: warning.message }],
    });
    expect(warnings).toEqual([expect.stringContaining("Failed to get job annotations for job 1:")]);
    expect(requests).toEqual([
      { ids: ["job", "other"], after: null },
      { ids: ["job"], after: "page-1" },
    ]);
  });

  it.each([
    apiError,
    new Error("Network unavailable"),
  ])("continues other batches after an API error (%j)", async (error) => {
    const jobs = Array.from({ length: 201 }, (_, id) => ({ id, node_id: `job-${id}` }));
    const { octokit, requests } = graphqlClient(
      gql(...jobs.slice(0, 100).map((job) => checkRun(job.node_id, [warning]))),
      error,
      gql(checkRun(jobs[200].node_id, [warning]))
    );
    const { annotations, warnings } = await getJobsAnnotations(octokit, jobs);
    expect(annotations).toEqual(
      Object.fromEntries(
        [...jobs.slice(0, 100), jobs[200]].map((job) => [
          job.id,
          [{ annotation_level: "warning", message: warning.message }],
        ])
      )
    );
    expect(warnings).toEqual([expect.stringContaining("Failed to get job annotations for jobs 100, 101,")]);
    expect(requests).toEqual([
      { ids: jobs.slice(0, 100).map((job) => job.node_id), after: null },
      { ids: jobs.slice(100, 200).map((job) => job.node_id), after: null },
      { ids: [jobs[200].node_id], after: null },
    ]);
  });
});
