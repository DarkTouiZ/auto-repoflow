import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { PrivacyDecision } from "@auto-repoflow/domain";

const PRIVATE_ROOT_NAME = ".autorepoflow-private";
const ALWAYS_EXCLUDED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".angular",
  ".cache",
  ".next",
  "artifacts",
  "run-worktrees",
  "bare-mirrors"
]);
const SECRET_BASENAME =
  /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|crt|cer|der|jks|keystore)|id_(?:rsa|dsa|ecdsa|ed25519))$/i;
const GENERATED_FILE = /(?:^|\/)(?:npm-debug|yarn-debug|yarn-error).*\.log$|\.log$/i;

export interface SnapshotFile {
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface SnapshotManifest {
  schemaVersion: 1;
  snapshotId: string;
  createdAt: string;
  sourceLabel: string;
  sourceRootStored: false;
  files: SnapshotFile[];
  decisions: PrivacyDecision[];
  manifestSha256: string;
}

export interface SnapshotResult {
  evaluationId: string;
  evaluationDirectory: string;
  snapshotDirectory: string;
  manifest: SnapshotManifest;
}

function normalizeRelative(path: string): string {
  return path.split(sep).join("/");
}

export function privacyDecisionFor(relativePath: string): PrivacyDecision {
  const normalized = normalizeRelative(relativePath);
  const parts = normalized.split("/");
  const filename = parts.at(-1) ?? "";
  if (parts.some((part) => ALWAYS_EXCLUDED_NAMES.has(part))) {
    return {
      relativePath: normalized,
      decision: "EXCLUDED",
      reason: "generated_or_repository_metadata"
    };
  }
  if (SECRET_BASENAME.test(filename)) {
    return {
      relativePath: normalized,
      decision: "EXCLUDED",
      reason: "secret_or_environment_file"
    };
  }
  if (GENERATED_FILE.test(normalized)) {
    return {
      relativePath: normalized,
      decision: "EXCLUDED",
      reason: "log_file"
    };
  }
  return {
    relativePath: normalized,
    decision: "INCLUDED",
    reason: "source_evidence"
  };
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function getPrivateRoot(): Promise<string> {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is required to resolve the private root");
  const root = join(home, PRIVATE_ROOT_NAME);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  return root;
}

async function walk(
  sourceRoot: string,
  current: string,
  decisions: PrivacyDecision[],
  files: string[]
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const rel = normalizeRelative(relative(sourceRoot, absolute));
    const decision = privacyDecisionFor(rel);
    if (decision.decision === "EXCLUDED") {
      decisions.push(decision);
      continue;
    }
    if (entry.isSymbolicLink()) {
      decisions.push({
        relativePath: rel,
        decision: "EXCLUDED",
        reason: "symbolic_link"
      });
      continue;
    }
    if (entry.isDirectory()) {
      await walk(sourceRoot, absolute, decisions, files);
    } else if (entry.isFile()) {
      decisions.push(decision);
      files.push(absolute);
    }
  }
}

export async function createPrivateSnapshot(input: {
  sourcePath: string;
  projectName: string;
  evaluationId?: string;
}): Promise<SnapshotResult> {
  const sourceRoot = await realpath(resolve(input.sourcePath));
  const sourceStats = await stat(sourceRoot);
  if (!sourceStats.isDirectory()) {
    throw new Error("Snapshot source must be a directory");
  }

  const privateRoot = await getPrivateRoot();
  const evaluationId = input.evaluationId ?? randomUUID();
  const evaluationDirectory = join(privateRoot, "evaluations", evaluationId);
  const snapshotDirectory = join(evaluationDirectory, "snapshot");
  await mkdir(snapshotDirectory, { recursive: true, mode: 0o700 });

  const decisions: PrivacyDecision[] = [];
  const sourceFiles: string[] = [];
  await walk(sourceRoot, sourceRoot, decisions, sourceFiles);

  const files: SnapshotFile[] = [];
  for (const sourceFile of sourceFiles) {
    const relativePath = normalizeRelative(relative(sourceRoot, sourceFile));
    const destination = join(snapshotDirectory, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourceFile, destination);
    const data = await readFile(destination);
    files.push({ relativePath, sha256: sha256(data), bytes: data.byteLength });
  }

  const manifestCore = {
    schemaVersion: 1 as const,
    snapshotId: randomUUID(),
    createdAt: new Date().toISOString(),
    sourceLabel: basename(sourceRoot),
    sourceRootStored: false as const,
    files,
    decisions
  };
  const manifest: SnapshotManifest = {
    ...manifestCore,
    manifestSha256: sha256(JSON.stringify(manifestCore))
  };
  await writeFile(
    join(evaluationDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 }
  );
  await writeFile(
    join(evaluationDirectory, "project.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        evaluationId,
        projectName: input.projectName,
        sourceLabel: manifest.sourceLabel,
        createdAt: manifest.createdAt
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return { evaluationId, evaluationDirectory, snapshotDirectory, manifest };
}
