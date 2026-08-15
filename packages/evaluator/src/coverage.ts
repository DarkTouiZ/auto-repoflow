import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

// Coverage-report ingestion. Static analysis cannot answer "did a test actually
// execute this line"; a coverage report answers it exactly. Both formats here
// are plain text/JSON, so no dependency is needed, and only {path, line, hits}
// is retained — never source text — so this stays privacy-clean.

export interface FileCoverage {
  /** Repo-relative path. */
  path: string;
  /** line number -> execution count. */
  hits: Map<number, number>;
}

export interface CoverageData {
  files: Map<string, FileCoverage>;
  generatedAt: Date;
  source: string;
}

function toRelative(root: string, filePath: string): string {
  const absolute = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  return relative(root, absolute).split("\\").join("/");
}

export function parseLcov(text: string, root: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SF:")) {
      current = { path: toRelative(root, line.slice(3)), hits: new Map() };
    } else if (line.startsWith("DA:") && current) {
      const [lineNo, count] = line
        .slice(3)
        .split(",")
        .map((value) => Number(value));
      if (Number.isFinite(lineNo)) {
        current.hits.set(lineNo, (current.hits.get(lineNo) ?? 0) + (count || 0));
      }
    } else if (line === "end_of_record" && current) {
      files.push(current);
      current = null;
    }
  }
  return files;
}

interface IstanbulEntry {
  path?: string;
  statementMap?: Record<string, { start: { line: number }; end: { line: number } }>;
  s?: Record<string, number>;
}

export function parseIstanbulJson(text: string, root: string): FileCoverage[] {
  const document = JSON.parse(text) as Record<string, IstanbulEntry>;
  const files: FileCoverage[] = [];
  for (const [key, entry] of Object.entries(document)) {
    const path = toRelative(root, entry.path ?? key);
    const hits = new Map<number, number>();
    const statementMap = entry.statementMap ?? {};
    const counts = entry.s ?? {};
    for (const [id, location] of Object.entries(statementMap)) {
      const count = counts[id] ?? 0;
      for (let line = location.start.line; line <= location.end.line; line += 1) {
        hits.set(line, Math.max(hits.get(line) ?? 0, count));
      }
    }
    files.push({ path, hits });
  }
  return files;
}

async function readIfExists(path: string): Promise<{ text: string; mtime: Date } | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { text: await readFile(path, "utf8"), mtime: info.mtime };
  } catch {
    return null;
  }
}

/**
 * Load coverage for a repository. Uses an explicit path when given, otherwise
 * auto-discovers the common locations. Returns null when no report is found.
 */
export async function loadCoverage(
  root: string,
  explicit?: string
): Promise<CoverageData | null> {
  const candidates = explicit
    ? [resolve(root, explicit)]
    : [
        join(root, "coverage", "lcov.info"),
        join(root, "coverage", "coverage-final.json"),
        join(root, ".nyc_output", "out.json")
      ];
  for (const candidate of candidates) {
    const found = await readIfExists(candidate);
    if (!found) continue;
    const entries = candidate.endsWith(".info")
      ? parseLcov(found.text, root)
      : parseIstanbulJson(found.text, root);
    const files = new Map<string, FileCoverage>();
    for (const entry of entries) files.set(entry.path, entry);
    return { files, generatedAt: found.mtime, source: candidate };
  }
  return null;
}

/** Lines in [addedRanges] for `file` that the coverage report shows as never run. */
export function uncoveredAddedLines(
  coverage: CoverageData,
  path: string,
  addedRanges: Array<[number, number]>
): number[] {
  const fileCoverage = coverage.files.get(path);
  if (!fileCoverage) return [];
  const uncovered: number[] = [];
  for (const [start, end] of addedRanges) {
    for (let line = start; line <= end; line += 1) {
      const hits = fileCoverage.hits.get(line);
      if (hits === 0) uncovered.push(line);
    }
  }
  return uncovered;
}
