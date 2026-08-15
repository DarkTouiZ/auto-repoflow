import { spawn } from "node:child_process";
import { resolve } from "node:path";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
}

export interface ChangeSet {
  root: string;
  head: string;
  baseRef: string;
  files: ChangedFile[];
}

export type ReviewScope = "worktree" | "staged" | "base";

export interface ChangeSetOptions {
  scope: ReviewScope;
  /** Required when scope === "base": the ref the change is measured against. */
  baseRef?: string;
}

interface GitResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise<GitResult>((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("git", args, {
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
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr });
    });
  });
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout;
}

function mapStatus(code: string): ChangeStatus {
  const letter = code[0];
  if (letter === "A") return "added";
  if (letter === "D") return "deleted";
  if (letter === "R") return "renamed";
  return "modified";
}

function parseNameStatus(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const parts = line.split("\t");
    const status = mapStatus(parts[0]);
    // For renames (R100  old  new) take the new path.
    const path = parts[parts.length - 1];
    files.push({ path, status });
  }
  return files;
}

async function untrackedPaths(root: string): Promise<string[]> {
  return (
    await gitOrThrow(root, ["ls-files", "--others", "--exclude-standard"])
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function untrackedPatch(
  root: string,
  path: string,
  unified: number | null
): Promise<string> {
  const args = ["diff", "--no-index", "--no-color"];
  if (unified !== null) args.push(`--unified=${unified}`);
  args.push("--", "/dev/null", path);
  const result = await git(root, args);
  // git diff --no-index uses exit code 1 when a diff was produced.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`
    );
  }
  return result.stdout;
}

async function diffIncludingUntracked(
  changeSet: ChangeSet,
  options: ChangeSetOptions,
  unified: number | null
): Promise<string> {
  const { root } = changeSet;
  const args = ["diff", "--no-color"];
  if (unified !== null) args.push(`--unified=${unified}`);
  if (options.scope === "staged") {
    args.push("--cached");
  } else if (options.scope === "base") {
    args.push(changeSet.baseRef);
  } else {
    args.push("HEAD");
  }

  let text = await gitOrThrow(root, args);
  if (options.scope === "staged") return text;

  const changedPaths = new Set(changeSet.files.map((file) => file.path));
  for (const path of await untrackedPaths(root)) {
    if (!changedPaths.has(path)) continue;
    const patch = await untrackedPatch(root, path, unified);
    if (patch.length > 0) {
      text += `${text.endsWith("\n") || text.length === 0 ? "" : "\n"}${patch}`;
    }
  }
  return text;
}

/**
 * Resolve the set of files that changed relative to the chosen baseline. The
 * default (worktree) scope reports uncommitted work — tracked modifications plus
 * untracked files — which is the state right after a coding agent finishes.
 */
export async function resolveChangeSet(
  sourcePath: string,
  options: ChangeSetOptions
): Promise<ChangeSet> {
  const requested = resolve(sourcePath);
  const isRepo = await git(requested, [
    "rev-parse",
    "--is-inside-work-tree"
  ]);
  if (isRepo.exitCode !== 0 || isRepo.stdout.trim() !== "true") {
    throw new Error(
      "review requires a git repository. Initialise one with `git init` or point at a checkout."
    );
  }
  const root = (
    await gitOrThrow(requested, ["rev-parse", "--show-toplevel"])
  ).trim();
  const head = (await gitOrThrow(root, ["rev-parse", "HEAD"])).trim();

  let baseRef = "HEAD";
  const files: ChangedFile[] = [];

  if (options.scope === "staged") {
    baseRef = "HEAD";
    files.push(
      ...parseNameStatus(
        await gitOrThrow(root, ["diff", "--cached", "--name-status", "--no-renames"])
      )
    );
  } else if (options.scope === "base") {
    if (!options.baseRef) {
      throw new Error("base scope requires a ref");
    }
    const mergeBase = (
      await gitOrThrow(root, ["merge-base", options.baseRef, "HEAD"])
    ).trim();
    baseRef = mergeBase;
    files.push(
      ...parseNameStatus(
        await gitOrThrow(root, [
          "diff",
          "--name-status",
          "--no-renames",
          `${mergeBase}`
        ])
      )
    );
    for (const path of await untrackedPaths(root)) {
      files.push({ path, status: "added" });
    }
  } else {
    // worktree: tracked changes vs HEAD ...
    baseRef = "HEAD";
    files.push(
      ...parseNameStatus(
        await gitOrThrow(root, ["diff", "--name-status", "--no-renames", "HEAD"])
      )
    );
    // ... plus untracked files (not ignored), reported as additions.
    for (const path of await untrackedPaths(root)) {
      files.push({ path, status: "added" });
    }
  }

  // De-duplicate by path (a file can appear staged and modified).
  const byPath = new Map<string, ChangedFile>();
  for (const file of files) {
    if (!byPath.has(file.path)) byPath.set(file.path, file);
  }

  return {
    root,
    head,
    baseRef,
    files: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  };
}

/**
 * Added line ranges (new-side) per changed file, from a zero-context diff.
 * Used to check whether the lines an agent just wrote are exercised by tests.
 */
export async function addedLineRanges(
  changeSet: ChangeSet,
  options: ChangeSetOptions
): Promise<Map<string, Array<[number, number]>>> {
  const text = await diffIncludingUntracked(changeSet, options, 0);
  const ranges = new Map<string, Array<[number, number]>>();
  let currentFile: string | null = null;
  for (const line of text.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!ranges.has(currentFile)) ranges.set(currentFile, []);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && currentFile) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) {
        ranges.get(currentFile)!.push([start, start + count - 1]);
      }
    }
  }
  return ranges;
}

/**
 * Contents of a file at the change set's base revision, or null when the file
 * did not exist there (e.g. a newly added file).
 */
export async function showBaseFile(
  changeSet: ChangeSet,
  path: string
): Promise<string | null> {
  const result = await git(changeSet.root, [
    "show",
    `${changeSet.baseRef}:${path}`
  ]);
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

/** Unified diff text for the change set, used to size the token baseline. */
export async function changeSetDiff(
  changeSet: ChangeSet,
  options: ChangeSetOptions
): Promise<string> {
  return diffIncludingUntracked(changeSet, options, null);
}
