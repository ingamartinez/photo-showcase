// Task #177. Each assertion below pins one property of the capture harness's
// Playwright config that, when it was the other way round, produced a
// well-formed screenshot of the WRONG thing:
//
//   * `reuseExistingServer: true` -> a screenshot of a sibling worktree's
//     branch (found independently by #130 and #143).
//   * `bun run dev` instead of `bun --bun run dev` -> `next dev` under Node,
//     where `Bun.S3Client` is undefined, so every page holding an asset 500s
//     (found by #145).
//   * one shared port -> the two above, at once.
import { describe, expect, it } from "vitest";
import { buildCaptureHarnessConfig } from "./e2e-capture-config";
import { captureHarnessPort } from "./e2e-worktree";

const MAIN_CHECKOUT = "/Users/alejo/projects/photo-showcase";
const LANE_A = `${MAIN_CHECKOUT}/.claude/worktrees/agent-a6dbe7c5de58efc92`;
const LANE_B = `${MAIN_CHECKOUT}/.claude/worktrees/agent-b1122334455667788`;

function webServerOf(worktreeRoot: string, portOverride?: string) {
  const { webServer } = buildCaptureHarnessConfig({ worktreeRoot, portOverride });
  // The config type allows an array of servers; this harness declares exactly
  // one, and every assertion below is about that one.
  if (!webServer || Array.isArray(webServer)) {
    throw new Error("expected exactly one webServer entry");
  }
  return webServer;
}

describe("buildCaptureHarnessConfig", () => {
  it("never reuses an already-running server -- reuse is what let a lane attach to a sibling worktree's dev server and screenshot another branch", () => {
    expect(webServerOf(LANE_A).reuseExistingServer).toBe(false);
  });

  it("starts the dev server under the Bun runtime, not Node -- under Node `Bun.S3Client` is undefined and every page with an asset 500s", () => {
    expect(webServerOf(LANE_A).command).toContain("--bun");
  });

  it("binds the dev server to this worktree's own derived port", () => {
    const port = captureHarnessPort(LANE_A);
    expect(webServerOf(LANE_A).command).toContain(`--port ${port}`);
  });

  it("gives two sibling lanes two different ports to bind", () => {
    expect(webServerOf(LANE_A).command).not.toBe(webServerOf(LANE_B).command);
    expect(webServerOf(LANE_A).url).not.toBe(webServerOf(LANE_B).url);
  });

  it("points baseURL, and the readiness probe, at the same port the server is told to bind", () => {
    const port = captureHarnessPort(LANE_A);
    const config = buildCaptureHarnessConfig({ worktreeRoot: LANE_A });
    expect(config.use?.baseURL).toBe(`http://localhost:${port}`);
    expect(webServerOf(LANE_A).url).toBe(config.use?.baseURL);
  });

  it("honors an explicit E2E_PORT for a developer who needs a typeable port", () => {
    expect(
      buildCaptureHarnessConfig({ worktreeRoot: LANE_A, portOverride: "31234" }).use?.baseURL,
    ).toBe("http://localhost:31234");
    expect(webServerOf(LANE_A, "31234").command).toContain("--port 31234");
  });

  it("still runs globalSetup and collects specs from e2e/", () => {
    const config = buildCaptureHarnessConfig({ worktreeRoot: LANE_A });
    expect(config.testDir).toBe("./e2e");
    expect(config.globalSetup).toBe("./e2e/global-setup.ts");
  });
});
