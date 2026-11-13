import fs from "node:fs/promises";
import util, { type InspectOptions } from "node:util";
import { jest } from "@jest/globals";
import { RequestError } from "@octokit/request-error";
import { trace } from "@opentelemetry/api";
import * as core from "./__fixtures__/core";
import * as github from "./__fixtures__/github";
import type { Octokit } from "./github";
import { replayOctokit } from "./replay";

// Mocks should be declared before the module being tested is imported.
jest.unstable_mockModule("@actions/core", () => core);
jest.unstable_mockModule("@actions/github", () => github);

const token = process.env["GH_TOKEN"] ?? "";

process.env["OTEL_CONSOLE_ONLY"] = "true";
process.env["OTEL_ID_SEED"] = "123"; // seed for stable otel ids generation

// The module being tested should be imported dynamically. This ensures that the
// mocks are used in place of any actual dependencies.
const { run, isOctokitError } = await import("./runner");

describe("isOctokitError", () => {
  it("returns true", () => {
    const err = new RequestError("this is an error", 400, {
      request: {
        method: "GET",
        url: "http://example.com",
        headers: {},
      },
    });
    expect(isOctokitError(err)).toBe(true);
  });
  it("returns false", () => {
    expect(isOctokitError("")).toBe(false);
  });
});

describe("run", () => {
  let octokit: Octokit;
  let runId: string;
  const annotationRequests: unknown[] = [];
  // Compare exported telemetry with the recorded output.
  let output = "";

  beforeAll(async () => {
    octokit = await replayOctokit("run", token);
    octokit.hook.before("request", (options) => {
      if (options.url === "/graphql") {
        annotationRequests.push(options["variables"]);
      }
    });

    github.getOctokit.mockReturnValue(octokit);

    core.getInput.mockImplementation((name: string) => {
      switch (name) {
        case "otlpEndpoint":
          return "";
        case "otlpHeaders":
          return "";
        case "otelServiceName":
          return "otel-cicd-action";
        case "runId":
          return runId;
        case "githubToken":
          return token;
        case "extraAttributes":
          return "extra.attribute=1,key2=value2";
        default:
          return "";
      }
    });

    // ConsoleSpanExporter calls console.dir to output telemetry, so we mock it to save the output
    // See: https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/opentelemetry-sdk-trace-base/src/export/ConsoleSpanExporter.ts
    jest.spyOn(console, "dir").mockImplementation((item: unknown, options?: InspectOptions) => {
      output += `${util.inspect(item, options)}\n`;
    });
  });

  afterAll(() => {
    jest.resetAllMocks();
  });

  afterEach(() => {
    trace.disable(); // Remove the global tracer provider
    output = "";
    core.setOutput.mockReset();
    core.setFailed.mockReset();
    core.warning.mockReset();
    annotationRequests.length = 0;
  });

  it("should run a successful workflow", async () => {
    // https://github.com/biomejs/biome/actions/runs/21487811823
    process.env["GITHUB_REPOSITORY"] = "biomejs/biome";
    runId = "21487811823";

    await run();
    expect(output).toBe((await fs.readFile("src/__assets__/output_success.txt", "utf8")).replaceAll("\r\n", "\n"));
    expect(core.warning).not.toHaveBeenCalled();
    expect(annotationRequests).toEqual([{ ids: ["CR_kwDOKAiibM8AAAAOaaLIQQ"], after: null }]);

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("traceId", "329e58aa53cec7a2beadd2fd0a85c388");
  }, 10_000);

  it("should run a failed workflow", async () => {
    // https://github.com/biomejs/biome/actions/runs/21458831126
    process.env["GITHUB_REPOSITORY"] = "biomejs/biome";
    runId = "21458831126";

    await run();
    expect(output).toBe((await fs.readFile("src/__assets__/output_failed.txt", "utf8")).replaceAll("\r\n", "\n"));
    expect(core.warning).not.toHaveBeenCalled();
    expect(annotationRequests).toEqual([{ ids: ["CR_kwDOKAiibM8AAAAOY_ISSA"], after: null }]);

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("traceId", "329e58aa53cec7a2beadd2fd0a85c388");
  }, 10_000);

  it("should run a cancelled workflow", async () => {
    // https://github.com/step-security/skip-duplicate-actions/actions/runs/16620109074?pr=305
    process.env["GITHUB_REPOSITORY"] = "step-security/skip-duplicate-actions";
    runId = "16620109074";

    await run();
    expect(output).toBe((await fs.readFile("src/__assets__/output_cancelled.txt", "utf8")).replaceAll("\r\n", "\n"));
    expect(core.warning).not.toHaveBeenCalled();
    expect(annotationRequests).toEqual([
      {
        ids: [
          "CR_kwDOKtjdoc8AAAAK8r33uw",
          "CR_kwDOKtjdoc8AAAAK8r33xw",
          "CR_kwDOKtjdoc8AAAAK8r33zQ",
          "CR_kwDOKtjdoc8AAAAK8r332g",
          "CR_kwDOKtjdoc8AAAAK8r5xBQ",
        ],
        after: null,
      },
    ]);

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("traceId", "329e58aa53cec7a2beadd2fd0a85c388");
  }, 10_000);

  it.each([
    { errors: [{ message: "API rate limit exceeded", type: "RATE_LIMITED" }] },
    { data: { nodes: [null] } },
  ])("exports base telemetry and warns on annotation failures (%j)", async (data) => {
    process.env["GITHUB_REPOSITORY"] = "biomejs/biome";
    runId = "21487811823";
    const failingOctokit = await replayOctokit("run", token);
    failingOctokit.hook.wrap("request", async (request, options) => {
      const response = await request(options);
      if (options.url === "/graphql") {
        expect(options["variables"]).toEqual({ ids: ["CR_kwDOKAiibM8AAAAOaaLIQQ"], after: null });
        return { ...response, data };
      }
      return response;
    });
    github.getOctokit.mockReturnValueOnce(failingOctokit);

    await run();

    expect(output).toBe((await fs.readFile("src/__assets__/output_success.txt", "utf8")).replaceAll("\r\n", "\n"));
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("traceId", "329e58aa53cec7a2beadd2fd0a85c388");
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Failed to get job annotations for job"));
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("errors" in data ? "API rate limit exceeded" : "Missing check run annotations")
    );
  });

  it("should fail", async () => {
    // https://github.com/corentinmusard/otel-cicd-action/actions/runs/111
    process.env["GITHUB_REPOSITORY"] = "corentinmusard/otel-cicd-action";
    runId = "111"; // does not exist

    await run();

    expect(output).toBe("");
    expect(core.setFailed).toHaveBeenCalledTimes(1);
    expect(core.setFailed).toHaveBeenCalledWith(expect.any(Error));
    expect(core.setOutput).not.toHaveBeenCalled();
  }, 10_000);
});
