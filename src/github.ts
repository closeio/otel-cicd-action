import type { context } from "@actions/github";
import type { GitHub } from "@actions/github/lib/utils";
import type { components } from "@octokit/openapi-types";

type Context = typeof context;
type Octokit = InstanceType<typeof GitHub>;

async function getWorkflowRun(context: Context, octokit: Octokit, runId: number) {
  const res = await octokit.rest.actions.getWorkflowRun({
    ...context.repo,
    run_id: runId,
  });
  return res.data;
}

async function listJobsForWorkflowRun(context: Context, octokit: Octokit, runId: number) {
  return await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
    ...context.repo,
    run_id: runId,
    filter: "latest", // risk of missing a run if re-run happens between Action trigger and this query
    per_page: 100,
  });
}

type Annotation = Pick<components["schemas"]["check-annotation"], "annotation_level" | "message">;
type AnnotationJob = Pick<components["schemas"]["job"], "id" | "node_id">;

interface CheckRunAnnotations {
  id: string;
  annotations: {
    nodes: { annotationLevel: "FAILURE" | "WARNING" | "NOTICE"; message: string }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const annotationsQuery = `
  query JobAnnotations($ids: [ID!]!, $after: String) {
    nodes(ids: $ids) {
      ... on CheckRun {
        id
        annotations(first: 100, after: $after) {
          nodes { annotationLevel message }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

interface AnnotationsResponse {
  nodes: (CheckRunAnnotations | null)[];
}

async function getJobsAnnotations(octokit: Octokit, jobs: AnnotationJob[]) {
  const annotations: Record<number, Annotation[]> = {};
  const warnings: string[] = [];

  for (let offset = 0; offset < jobs.length; offset += 100) {
    const batch = jobs.slice(offset, offset + 100);
    let response: AnnotationsResponse;
    try {
      response = await octokit.graphql<AnnotationsResponse>(annotationsQuery, {
        ids: batch.map((job) => job.node_id),
        after: null,
      });
    } catch (error) {
      warnings.push(
        `Failed to get job annotations for jobs ${batch.map((job) => job.id).join(", ")}: ${String(error)}`
      );
      continue;
    }

    for (const [index, job] of batch.entries()) {
      annotations[job.id] = [];
      try {
        await listAnnotations(octokit, job, response.nodes?.[index], annotations[job.id]);
      } catch (error) {
        warnings.push(`Failed to get job annotations for job ${job.id}: ${String(error)}`);
      }
    }
  }
  return { annotations, warnings };
}

async function listAnnotations(
  octokit: Octokit,
  job: AnnotationJob,
  firstNode: CheckRunAnnotations | null | undefined,
  annotations: Annotation[]
) {
  let node = firstNode;
  const cursors = new Set<string>();
  for (;;) {
    if (!node || node.id !== job.node_id || !node.annotations) {
      throw new Error(`Missing check run annotations (${job.node_id})`);
    }
    const { nodes, pageInfo } = node.annotations;
    annotations.push(
      ...nodes.map((annotation) => ({
        annotation_level: annotation.annotationLevel.toLowerCase(),
        message: annotation.message,
      }))
    );
    if (!pageInfo.hasNextPage) {
      break;
    }
    if (!pageInfo.endCursor || cursors.has(pageInfo.endCursor)) {
      throw new Error("Invalid annotation pagination cursor");
    }
    cursors.add(pageInfo.endCursor);
    const next = await octokit.graphql<AnnotationsResponse>(annotationsQuery, {
      ids: [job.node_id],
      after: pageInfo.endCursor,
    });
    node = next.nodes?.[0];
  }
}

async function getPRsLabels(context: Context, octokit: Octokit, prNumbers: number[]) {
  const labels: Record<number, string[]> = {};

  for (const prNumber of prNumbers) {
    labels[prNumber] = await listLabelsOnIssue(context, octokit, prNumber);
  }
  return labels;
}

async function listLabelsOnIssue(context: Context, octokit: Octokit, prNumber: number) {
  return await octokit.paginate(
    octokit.rest.issues.listLabelsOnIssue,
    {
      ...context.repo,
      issue_number: prNumber,
    },
    (response) => response.data.map((issue) => issue.name)
  );
}

export { getWorkflowRun, listJobsForWorkflowRun, getJobsAnnotations, getPRsLabels, type Annotation, type Octokit };
