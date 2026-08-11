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
  } else {
    // worktree: tracked changes vs HEAD ...
    baseRef = "HEAD";
    files.push(
      ...parseNameStatus(
        await gitOrThrow(root, ["diff", "--name-status", "--no-renames", "HEAD"])
      )
    );
    // ... plus untracked files (not ignored), reported as additions.
    const untracked = (
      await gitOrThrow(root, [
        "ls-files",
        "--others",
        "--exclude-standard"
      ])
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const path of untracked) {
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

/** Unified diff text for the change set, used to size the token baseline. */
export async function changeSetDiff(
  changeSet: ChangeSet,
  options: ChangeSetOptions
): Promise<string> {
  const { root } = changeSet;
  if (options.scope === "staged") {
    return gitOrThrow(root, ["diff", "--cached"]);
  }
  if (options.scope === "base") {
    return gitOrThrow(root, ["diff", changeSet.baseRef]);
  }
  // worktree: tracked diff (untracked files are not part of `git diff`).
  return gitOrThrow(root, ["diff", "HEAD"]);
}
