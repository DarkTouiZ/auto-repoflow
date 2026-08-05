import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sandbox = await mkdtemp(join(tmpdir(), "arf-package-smoke-"));
const fixture = join(sandbox, "fixture");
const consumer = join(sandbox, "consumer");
const privateHome = join(sandbox, "home");
const output = join(sandbox, "report.json");
const npmCache = join(sandbox, "npm-cache");
const policyPath = join(sandbox, "change-policy.yaml");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
    ...options
  });
  if (result.status !== 0) {
    const details = [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed${details ? `\n${details}` : ""}`
    );
  }
  return result.stdout.trim();
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("package smoke must be launched through npm run");
  }
  return run(process.execPath, [npmCli, ...args]);
}

try {
  await mkdir(join(fixture, "tests"), { recursive: true });
  await writeFile(
    join(fixture, "package.json"),
    `${JSON.stringify(
      {
        name: "arf-isolated-smoke",
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
    )}\n`
  );
  await writeFile(
    join(fixture, "routes.js"),
    `const router = { get() {}, patch() {} };
router.get("/api/deliveries", listDeliveries);
router.patch("/api/deliveries/:id/status", updateDeliveryStatus);
export function listDeliveries(rows = []) { return rows; }
export function updateDeliveryStatus(row, status) { return { ...row, status }; }
`
  );
  await writeFile(
    join(fixture, "tests", "routes.test.js"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { listDeliveries, updateDeliveryStatus } from "../routes.js";
test("PATCH /api/deliveries/:id/status", () => {
  assert.equal(updateDeliveryStatus({ id: 1 }, "sent").status, "sent");
});
`
  );
  await writeFile(
    policyPath,
    `schemaVersion: 2
automation:
  maxStage: local-patch
change:
  enabled: true
  maxFiles: 5
  maxPatchBytes: 200000
  maxRepairAttempts: 2
  verification:
    timeoutSeconds: 30
    checks:
      - id: node-test
        runner: node
        args: [--test]
`
  );
  await chmod(policyPath, 0o600);

  run("git", ["init", "-b", "main"], { cwd: fixture });
  run("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: fixture
  });
  run("git", ["config", "user.name", "AutoRepoFlow Fixture"], {
    cwd: fixture
  });
  run("git", ["add", "."], { cwd: fixture });
  run("git", ["commit", "-m", "fixture"], { cwd: fixture });

  const packed = JSON.parse(
    runNpm([
      "pack",
      "--json",
      "--workspace",
      "auto-repoflow",
      "--pack-destination",
      sandbox,
      "--cache",
      npmCache
    ])
  );
  const tarball = join(sandbox, packed[0].filename);
  runNpm([
    "install",
    tarball,
    "--ignore-scripts",
    "--prefix",
    consumer,
    "--cache",
    npmCache
  ]);
  const cliEnvironment = {
    ...process.env,
    HOME: privateHome,
    USERPROFILE: privateHome
  };
  const cliCommand =
    process.platform === "win32"
      ? process.execPath
      : join(consumer, "node_modules", ".bin", "auto-repoflow");
  const cliPrefix =
    process.platform === "win32"
      ? [join(consumer, "node_modules", "auto-repoflow", "dist", "main.js")]
      : [];
  const cli = (args) =>
    run(cliCommand, [...cliPrefix, ...args], { env: cliEnvironment });

  cli(["scan", fixture, "--ai", "off", "--format", "json", "--out", output]);
  const report = JSON.parse(await readFile(output, "utf8"));
  if (
    report.schemaVersion !== 2 ||
    report.status !== "REPORT_READY" ||
    report.aiExecution?.requestedMode !== "off" ||
    report.evidenceMaturity?.generated !== 2
  ) {
    throw new Error("Packed CLI produced an unexpected schema v2 report");
  }
  const legacy = JSON.parse(
    cli(["scan", fixture, "--ai", "off", "--format", "json", "--compat", "v1"])
  );
  if (legacy.schemaVersion !== 1) {
    throw new Error("Packed CLI did not preserve legacy scan compatibility");
  }

  const demo = cli(["demo", "--scenario", "delivery-status"]);
  if (
    !demo.includes("deterministic-replay-not-ai-quality-evidence") ||
    !demo.includes("Target findings: 1 -> 0") ||
    !demo.includes("Test linkage: 50% -> 100%") ||
    !demo.includes("Status: passed")
  ) {
    throw new Error(`Packed guided demo returned unexpected output\n${demo}`);
  }

  const started = JSON.parse(
    cli([
      "change",
      "start",
      fixture,
      "--policy",
      policyPath,
      "--agent-label",
      "package-smoke"
    ])
  );
  const testPath = join(started.worktreePath, "tests", "routes.test.js");
  await writeFile(
    testPath,
    `${await readFile(testPath, "utf8")}
test("GET /api/deliveries", () => {
  assert.deepEqual(listDeliveries([{ id: 1 }]), [{ id: 1 }]);
});
`
  );
  const verified = JSON.parse(
    cli([
      "change",
      "verify",
      "--id",
      started.changeId,
      "--policy",
      policyPath,
      "--allow-verification"
    ])
  );
  if (
    verified.status !== "VERIFIED_LOCAL_PATCH" ||
    verified.report.before.testCoverage.percentage !== 50 ||
    verified.report.after.testCoverage.percentage !== 100
  ) {
    throw new Error("Packed ChangeRun did not produce a verified local patch");
  }
  cli(["change", "cleanup", "--id", started.changeId, "--confirm"]);

  const version = cli(["--version"]);
  if (version !== "0.3.0") {
    throw new Error(`Packed CLI returned unexpected version ${version}`);
  }
  console.log(`PASS packed auto-repoflow ${version} on ${process.version}`);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
