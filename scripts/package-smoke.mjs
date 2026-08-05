import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sandbox = await mkdtemp(join(tmpdir(), "arf-package-smoke-"));
const fixture = join(sandbox, "fixture");
const consumer = join(sandbox, "consumer");
const privateHome = join(sandbox, "home");
const output = join(sandbox, "report.json");
const npmCache = join(sandbox, "npm-cache");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
    ...options
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout.trim();
}

try {
  await mkdir(fixture, { recursive: true });
  await writeFile(
    join(fixture, "package.json"),
    `${JSON.stringify({ name: "arf-isolated-smoke", private: true })}\n`
  );
  await writeFile(
    join(fixture, "routes.ts"),
    'router.get("/api/widgets", listWidgets); export function listWidgets() {}\n'
  );

  const packed = JSON.parse(
    run("npm", [
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
  run("npm", [
    "install",
    tarball,
    "--ignore-scripts",
    "--prefix",
    consumer,
    "--cache",
    npmCache
  ]);
  const executable = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "auto-repoflow.cmd" : "auto-repoflow"
  );
  run(
    executable,
    ["scan", fixture, "--ai", "off", "--format", "json", "--out", output],
    { env: { ...process.env, HOME: privateHome } }
  );
  const report = JSON.parse(await readFile(output, "utf8"));
  if (
    report.schemaVersion !== 2 ||
    report.status !== "REPORT_READY" ||
    report.aiExecution?.requestedMode !== "off" ||
    report.evidenceMaturity?.generated !== 2
  ) {
    throw new Error("Packed CLI produced an unexpected schema v2 report");
  }
  const version = run(executable, ["--version"], {
    env: { ...process.env, HOME: privateHome }
  });
  if (version !== "0.2.0") {
    throw new Error(`Packed CLI returned unexpected version ${version}`);
  }
  console.log(`PASS packed auto-repoflow ${version} on ${process.version}`);
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
