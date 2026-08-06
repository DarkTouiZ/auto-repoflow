import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { changeAutomationPolicySchema } from "./policy.js";
import { getPrivateRoot, sha256 } from "./privacy.js";
import { startChangeRun, verifyChangeRun } from "./change.js";

export const MILEMESH_SCENARIOS = [
  "delivery-list",
  "delivery-status"
] as const;
export type MileMeshScenario = (typeof MILEMESH_SCENARIOS)[number];

const MIT_LICENSE = `MIT License

Copyright (c) 2026 AutoRepoFlow contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const ROUTES = `const router = { get() {}, patch() {} };

router.get("/api/deliveries", listDeliveries);
router.patch("/api/deliveries/:id/status", updateDeliveryStatus);

export function listDeliveries(rows = []) {
  return rows.map(({ id, status }) => ({ id, status }));
}

export function updateDeliveryStatus(delivery, status) {
  if (!delivery || !status) throw new TypeError("delivery and status are required");
  return { ...delivery, status };
}
`;

const PACKAGE_JSON = `${JSON.stringify(
  {
    name: "milemesh-lite",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: {
      test: "node --test",
      build: "node --check routes.js",
      typecheck: "node --check routes.js"
    }
  },
  null,
  2
)}\n`;

const EXISTING_TESTS: Record<MileMeshScenario, string> = {
  "delivery-list": `import test from "node:test";
import assert from "node:assert/strict";
import { updateDeliveryStatus } from "../routes.js";

test("PATCH /api/deliveries/:id/status", () => {
  assert.deepEqual(updateDeliveryStatus({ id: "d-1", status: "ready" }, "sent"), {
    id: "d-1",
    status: "sent"
  });
});
`,
  "delivery-status": `import test from "node:test";
import assert from "node:assert/strict";
import { listDeliveries } from "../routes.js";

test("GET /api/deliveries", () => {
  assert.deepEqual(listDeliveries([{ id: "d-1", status: "ready", secret: true }]), [
    { id: "d-1", status: "ready" }
  ]);
});
`
};

const REPLAY_PATCHES: Record<MileMeshScenario, string> = {
  "delivery-list": `diff --git a/tests/delivery-list.test.js b/tests/delivery-list.test.js
new file mode 100644
--- /dev/null
+++ b/tests/delivery-list.test.js
@@ -0,0 +1,9 @@
+import test from "node:test";
+import assert from "node:assert/strict";
+import { listDeliveries } from "../routes.js";
+
+test("GET /api/deliveries", () => {
+  assert.deepEqual(listDeliveries([{ id: "d-2", status: "ready", private: true }]), [
+    { id: "d-2", status: "ready" }
+  ]);
+});
`,
  "delivery-status": `diff --git a/tests/delivery-status.test.js b/tests/delivery-status.test.js
new file mode 100644
--- /dev/null
+++ b/tests/delivery-status.test.js
@@ -0,0 +1,11 @@
+import test from "node:test";
+import assert from "node:assert/strict";
+import { updateDeliveryStatus } from "../routes.js";
+
+test("PATCH /api/deliveries/:id/status", () => {
+  assert.deepEqual(updateDeliveryStatus({ id: "d-2", status: "ready" }, "sent"), {
+    id: "d-2",
+    status: "sent"
+  });
+  assert.throws(() => updateDeliveryStatus(null, "sent"), TypeError);
+});
`
};

export const REPLAY_PATCH_SHA256: Record<MileMeshScenario, string> = {
  "delivery-list": "1a3d9d06334828df1e0859ede53680114deb27a66fde8e54ca8082c305a23d53",
  "delivery-status": "a08b65c994f0f2d4dffe8e53cc7099324732ce43be3ea86227e3e421f5836697"
};

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function run(
  command: string,
  args: string[],
  cwd: string
): Promise<ProcessResult> {
  let stdout = "";
  let stderr = "";
  const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("close", resolvePromise);
  });
  return { exitCode, stdout, stderr };
}

async function requireRun(
  command: string,
  args: string[],
  cwd: string
): Promise<ProcessResult> {
  const result = await run(command, args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result;
}

export async function createMileMeshFixture(input: {
  directory: string;
  scenario: MileMeshScenario;
}): Promise<{ directory: string; head: string }> {
  await mkdir(join(input.directory, "tests"), { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {
    "LICENSE": MIT_LICENSE,
    "package.json": PACKAGE_JSON,
    "routes.js": ROUTES,
    "tests/existing.test.js": EXISTING_TESTS[input.scenario]
  };
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(input.directory, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents, { mode: 0o600 });
  }
  await requireRun("git", ["init", "-b", "main"], input.directory);
  await requireRun(
    "git",
    ["config", "user.email", "fixture@example.invalid"],
    input.directory
  );
  await requireRun(
    "git",
    ["config", "user.name", "AutoRepoFlow Fixture"],
    input.directory
  );
  await requireRun("git", ["add", "."], input.directory);
  await requireRun("git", ["commit", "-m", `MileMesh Lite ${input.scenario}`], input.directory);
  const head = (await requireRun("git", ["rev-parse", "HEAD"], input.directory)).stdout.trim();
  return { directory: input.directory, head };
}

export function bundledReplayPatch(scenario: MileMeshScenario): {
  patch: string;
  sha256: string;
} {
  return { patch: REPLAY_PATCHES[scenario], sha256: REPLAY_PATCH_SHA256[scenario] };
}

export const DEMO_CHANGE_POLICY = changeAutomationPolicySchema.parse({
  schemaVersion: 2,
  automation: { maxStage: "local-patch" },
  change: {
    enabled: true,
    maxFiles: 5,
    maxPatchBytes: 200_000,
    maxRepairAttempts: 2,
    verification: {
      timeoutSeconds: 30,
      checks: [{ id: "node-test", runner: "node", args: ["--test"] }]
    }
  }
});

export async function runGuidedDemo(input: {
  scenario?: MileMeshScenario;
  mode?: "replay" | "handoff";
}): Promise<
  | {
      mode: "handoff";
      scenario: MileMeshScenario;
      liveAi: false;
      evidenceClassification: "agent-handoff-not-ai-quality-evidence";
      changeId: string;
      worktreePath: string;
      fixPacketPath: string;
      promptPath: string;
    }
  | {
      mode: "replay";
      scenario: MileMeshScenario;
      liveAi: false;
      evidenceClassification: "deterministic-replay-not-ai-quality-evidence";
      changeId: string;
      baselineCheckPassed: boolean;
      originalFixtureUnchanged: boolean;
      report: Awaited<ReturnType<typeof verifyChangeRun>>["report"];
    }
> {
  const scenario = input.scenario ?? "delivery-list";
  const mode = input.mode ?? "replay";
  const root = join(await getPrivateRoot(), "demos", randomUUID());
  const fixturePath = join(root, "milemesh-lite");
  const fixture = await createMileMeshFixture({ directory: fixturePath, scenario });
  const baselineCheck = await run(process.execPath, ["--test"], fixturePath);
  if (baselineCheck.exitCode !== 0) {
    throw new Error(`Bundled demo baseline test failed: ${baselineCheck.stderr}`);
  }
  const started = await startChangeRun({
    sourcePath: fixturePath,
    policy: DEMO_CHANGE_POLICY,
    agentLabel: mode === "replay" ? "deterministic-replay" : "user-ide-agent"
  });
  if (mode === "handoff") {
    return {
      mode,
      scenario,
      liveAi: false,
      evidenceClassification: "agent-handoff-not-ai-quality-evidence",
      changeId: started.changeId,
      worktreePath: started.worktreePath,
      fixPacketPath: started.fixPacketPath,
      promptPath: started.promptPath
    };
  }
  const replay = bundledReplayPatch(scenario);
  if (sha256(replay.patch) !== replay.sha256) {
    throw new Error("Bundled replay patch failed its pinned SHA-256 check");
  }
  const patchPath = join(root, "replay.patch");
  await writeFile(patchPath, replay.patch, { mode: 0o600 });
  await requireRun("git", ["apply", "--check", patchPath], started.worktreePath);
  await requireRun("git", ["apply", patchPath], started.worktreePath);
  const verified = await verifyChangeRun({
    changeId: started.changeId,
    policy: DEMO_CHANGE_POLICY,
    allowVerification: true
  });
  if (verified.status !== "VERIFIED_LOCAL_PATCH") {
    throw new Error(`Bundled demo verification ended at ${verified.status}`);
  }
  const currentHead = (
    await requireRun("git", ["rev-parse", "HEAD"], fixturePath)
  ).stdout.trim();
  const currentStatus = (
    await requireRun(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      fixturePath
    )
  ).stdout;
  return {
    mode,
    scenario,
    liveAi: false,
    evidenceClassification: "deterministic-replay-not-ai-quality-evidence",
    changeId: started.changeId,
    baselineCheckPassed: true,
    originalFixtureUnchanged:
      currentHead === fixture.head && currentStatus === "",
    report: verified.report
  };
}
