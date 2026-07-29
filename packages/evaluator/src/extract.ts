import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type {
  ArtifactNode,
  ArtifactNodeKind,
  EvidenceRef
} from "@auto-repoflow/domain";
import { parse as parseYaml } from "yaml";
import type { SnapshotFile } from "./privacy.js";

export interface ExtractedArtifacts {
  nodes: ArtifactNode[];
  routePaths: Map<string, string>;
  postmanPaths: Map<string, string>;
}

interface RouterMount {
  parent: string;
  child: string;
  prefix: string;
}

function stableId(kind: ArtifactNodeKind, locator: string): string {
  return `${kind.toLowerCase()}:${locator
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

function evidence(file: SnapshotFile, line?: number): EvidenceRef {
  return {
    artifactId: `file:${file.sha256.slice(0, 16)}`,
    relativePath: file.relativePath,
    line,
    sha256: file.sha256
  };
}

function node(
  kind: ArtifactNodeKind,
  name: string,
  locator: string,
  file: SnapshotFile,
  line?: number,
  attributes?: Record<string, string | number | boolean>
): ArtifactNode {
  return {
    id: stableId(kind, locator),
    kind,
    name,
    locator,
    evidence: evidence(file, line),
    attributes
  };
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function normalizeApiPath(value: string): string {
  return value
    .replace(/^\{\{[^}]+\}\}/, "")
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/\{\{[^}]+\}\}/g, ":param")
    .replace(/:[A-Za-z_][\w-]*/g, ":param")
    .replace(/\{[^}]+\}/g, ":param")
    .split(/[?#]/, 1)[0]
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

function extractRoutes(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[],
  routePaths: Map<string, string>
): void {
  const routeRegex =
    /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
  for (const match of text.matchAll(routeRegex)) {
    const linePrefix = text.slice(text.lastIndexOf("\n", match.index ?? 0) + 1, match.index);
    if (linePrefix.includes("//")) continue;
    const router = match[1];
    const method = match[2].toUpperCase();
    const path = normalizeApiPath(match[3]);
    const locator = `${method} ${path}`;
    routePaths.set(locator, stableId("API_OPERATION", locator));
    nodes.push(
      node(
        "API_OPERATION",
        locator,
        locator,
        file,
        lineAt(text, match.index ?? 0),
        { source: "express-route", method, path, router }
      )
    );
    nodes.push(
      node(
        "CODE_SYMBOL",
        `${locator} route handler`,
        `route-handler:${locator}`,
        file,
        lineAt(text, match.index ?? 0),
        { source: "route-registration", operation: locator, router }
      )
    );
  }
}

function extractMounts(text: string, mounts: RouterMount[]): void {
  const mountRegex =
    /\b([A-Za-z_$][\w$]*)\.use\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*)/gi;
  for (const match of text.matchAll(mountRegex)) {
    const linePrefix = text.slice(
      text.lastIndexOf("\n", match.index ?? 0) + 1,
      match.index
    );
    if (linePrefix.includes("//")) continue;
    mounts.push({
      parent: match[1],
      prefix: normalizeApiPath(match[2]),
      child: match[3]
    });
  }
}

function joinApiPath(prefix: string, path: string): string {
  return normalizeApiPath(`${prefix}/${path}`);
}

function mountedPrefixes(
  router: string,
  mounts: RouterMount[],
  seen = new Set<string>()
): string[] {
  if (seen.has(router)) return [""];
  const parents = mounts.filter((mount) => mount.child === router);
  if (parents.length === 0) return [""];
  const nextSeen = new Set(seen).add(router);
  return parents.flatMap((mount) =>
    mountedPrefixes(mount.parent, mounts, nextSeen).map((parentPrefix) =>
      joinApiPath(parentPrefix, mount.prefix)
    )
  );
}

function applyRouterMounts(
  nodes: ArtifactNode[],
  mounts: RouterMount[]
): ArtifactNode[] {
  return nodes.flatMap((item) => {
    const router =
      typeof item.attributes?.router === "string"
        ? item.attributes.router
        : undefined;
    if (
      !router ||
      !["API_OPERATION", "CODE_SYMBOL"].includes(item.kind) ||
      item.attributes?.source === "typescript"
    ) {
      return [item];
    }
    const prefixes = mountedPrefixes(router, mounts).filter(Boolean);
    if (prefixes.length === 0) return [item];
    const path =
      item.kind === "API_OPERATION"
        ? String(item.attributes?.path ?? "/")
        : String(item.attributes?.operation ?? "").replace(/^\w+\s+/, "");
    const method =
      item.kind === "API_OPERATION"
        ? String(item.attributes?.method ?? "")
        : String(item.attributes?.operation ?? "").split(" ", 1)[0];
    return prefixes.map((prefix) => {
      const fullPath = joinApiPath(prefix, path);
      const operation = `${method} ${fullPath}`;
      return {
        ...item,
        id: stableId(
          item.kind,
          item.kind === "API_OPERATION"
            ? operation
            : `route-handler:${operation}`
        ),
        name:
          item.kind === "API_OPERATION"
            ? operation
            : `${operation} route handler`,
        locator:
          item.kind === "API_OPERATION"
            ? operation
            : `route-handler:${operation}`,
        attributes: {
          ...item.attributes,
          path: fullPath,
          operation,
          mounted: true
        }
      };
    });
  });
}

function flattenPostman(items: unknown[], output: unknown[]): void {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (Array.isArray(record.item)) flattenPostman(record.item, output);
    if (record.request) output.push(record);
  }
}

function extractPostman(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[],
  postmanPaths: Map<string, string>
): void {
  try {
    const parsed = JSON.parse(text) as {
      item?: unknown[];
      info?: Record<string, unknown>;
    };
    if (!Array.isArray(parsed.item)) return;
    const reviewStatus =
      typeof parsed.info?.["x-autorepoflow-review-status"] === "string"
        ? parsed.info["x-autorepoflow-review-status"]
        : "existing_evidence";
    const requests: unknown[] = [];
    flattenPostman(parsed.item, requests);
    for (const raw of requests) {
      const item = raw as {
        name?: string;
        request?: {
          method?: string;
          url?: string | { raw?: string; path?: string[] };
        };
      };
      const method = item.request?.method?.toUpperCase();
      const rawUrl =
        typeof item.request?.url === "string"
          ? item.request.url
          : item.request?.url?.raw ??
            `/${item.request?.url?.path?.join("/") ?? ""}`;
      if (!method || !rawUrl) continue;
      const path = normalizeApiPath(rawUrl);
      const operation = `${method} ${path}`;
      const locator = `postman:${operation}:${item.name ?? operation}`;
      const id = stableId("REQUIREMENT", locator);
      postmanPaths.set(operation, id);
      nodes.push(
        node(
          "REQUIREMENT",
          item.name ?? operation,
          locator,
          file,
          undefined,
          { source: "postman", method, path, operation, reviewStatus }
        )
      );
    }
  } catch {
    // Non-Postman JSON files are intentionally ignored.
  }
}

function extractTestPlan(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[]
): void {
  if (!/(?:^|\/)test-plan\.ya?ml$/i.test(file.relativePath)) return;
  try {
    const document = parseYaml(text) as {
      review_status?: string;
      test_cases?: Array<{
        id?: string;
        name?: string;
        api_operation?: string;
        level?: string;
        scenarios?: unknown[];
      }>;
    };
    const reviewStatus = document.review_status ?? "draft";
    for (const testCase of document.test_cases ?? []) {
      const testId = testCase.id ?? testCase.name;
      if (!testId || !testCase.api_operation) continue;
      nodes.push(
        node(
          "TEST_CASE",
          testCase.name ?? testId,
          `test-plan:${testId}`,
          file,
          undefined,
          {
            source: "test-plan",
            reviewStatus,
            apiOperation: testCase.api_operation,
            level: testCase.level ?? "unspecified",
            scenarioCount: testCase.scenarios?.length ?? 0
          }
        )
      );
    }
  } catch {
    // Invalid test plans remain represented by their snapshot hash.
  }
}

function extractMermaid(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[]
): void {
  const entityRegex = /^\s{0,8}([A-Za-z][\w-]+)\s*\{/gm;
  for (const match of text.matchAll(entityRegex)) {
    nodes.push(
      node(
        "DATA_ENTITY",
        match[1],
        `entity:${match[1]}`,
        file,
        lineAt(text, match.index ?? 0),
        { source: "mermaid-erd" }
      )
    );
  }
}

function extractTests(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[]
): void {
  const testRegex = /\b(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (const match of text.matchAll(testRegex)) {
    const title = match[1];
    const operationMatch = title.match(
      /^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s"'`]+)/i
    );
    const attributes: Record<string, string> = { source: "test" };
    if (operationMatch) {
      const method = operationMatch[1].toUpperCase();
      const path = normalizeApiPath(operationMatch[2]);
      attributes.method = method;
      attributes.path = path;
      attributes.operation = `${method} ${path}`;
    }
    nodes.push(
      node(
        "TEST_CASE",
        title,
        `test:${file.relativePath}:${title}`,
        file,
        lineAt(text, match.index ?? 0),
        attributes
      )
    );
  }
}

function extractCodeSymbols(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[]
): void {
  const symbolRegex =
    /\b(?:export\s+)?(?:default\s+)?(?:class|interface|function)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(symbolRegex)) {
    nodes.push(
      node(
        "CODE_SYMBOL",
        match[1],
        `symbol:${file.relativePath}:${match[1]}`,
        file,
        lineAt(text, match.index ?? 0),
        { source: "typescript" }
      )
    );
  }
}

function extractWorld(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[]
): void {
  if (!file.relativePath.startsWith(".autorepoflow/")) return;
  nodes.push(
    node(
      "WORLD_CONTRACT",
      file.relativePath,
      `world:${file.relativePath}`,
      file,
      1,
      { source: "world-contract", bytes: text.length }
    )
  );
}

function extractDesignFlow(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[]
): void {
  if (!/(?:^|\/)design-flow\.ya?ml$/i.test(file.relativePath)) return;
  try {
    const document = parseYaml(text) as {
      review_status?: string;
      screens?: Array<{
        id?: string;
        name?: string;
        actions?: Array<{
          id?: string;
          label?: string;
          api_operation?: string;
          response_mapping_required?: boolean;
          response_fields?: string[];
          confirmation_required?: boolean;
          permission_state_required?: boolean;
        }>;
        states?: string[];
        acceptance_criteria_required?: boolean;
        acceptance_criteria?: string[];
      }>;
    };
    const reviewStatus = document.review_status ?? "draft";
    for (const screen of document.screens ?? []) {
      const screenId = screen.id ?? screen.name;
      if (!screenId) continue;
      nodes.push(
        node(
          "SCREEN",
          screen.name ?? screenId,
          `screen:${screenId}`,
          file,
          undefined,
          { source: "reviewed-design-flow", reviewStatus }
        )
      );
      const addedScreen = nodes.at(-1);
      if (addedScreen && addedScreen.kind === "SCREEN") {
        addedScreen.attributes = {
          ...addedScreen.attributes,
          acceptanceCriteriaRequired:
            screen.acceptance_criteria_required === true,
          acceptanceCriteriaCount: screen.acceptance_criteria?.length ?? 0
        };
      }
      for (const action of screen.actions ?? []) {
        const actionId = action.id ?? action.label;
        if (!actionId) continue;
        nodes.push(
          node(
            "UI_ACTION",
            action.label ?? actionId,
            `action:${screenId}:${actionId}`,
            file,
            undefined,
            {
              source: "reviewed-design-flow",
              reviewStatus,
              screen: screenId,
              ...(action.api_operation
                ? { apiOperation: action.api_operation }
                : {}),
              responseMappingRequired:
                action.response_mapping_required === true,
              responseFieldCount: action.response_fields?.length ?? 0,
              confirmationRequired: action.confirmation_required === true,
              permissionStateRequired:
                action.permission_state_required === true
            }
          )
        );
      }
      for (const state of screen.states ?? []) {
        nodes.push(
          node(
            "UI_STATE",
            state,
            `state:${screenId}:${state}`,
            file,
            undefined,
            { source: "reviewed-design-flow", screen: screenId }
          )
        );
      }
    }
  } catch {
    // Invalid design-flow YAML is ignored by extraction and remains auditable by hash.
  }
}

function extractCi(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[]
): void {
  if (!/^\.github\/workflows\/.+\.ya?ml$/i.test(file.relativePath)) return;
  nodes.push(
    node(
      "QUALITY_CHECK",
      file.relativePath,
      `ci:${file.relativePath}`,
      file,
      1,
      {
        source: "ci-workflow",
        containsContractCheck: /contract|openapi|postman/i.test(text)
      }
    )
  );
}

function extractQuality(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[]
): void {
  if (file.relativePath !== "package.json") return;
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
    for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
      if (!/test|build|lint|check|typecheck|world/i.test(name)) continue;
      nodes.push(
        node(
          "QUALITY_CHECK",
          name,
          `quality:${name}`,
          file,
          undefined,
          { source: "package-script", command }
        )
      );
    }
  } catch {
    // Invalid package JSON becomes a separate evaluator finding later.
  }
}

export async function extractArtifacts(
  snapshotDirectory: string,
  files: SnapshotFile[]
): Promise<ExtractedArtifacts> {
  const nodes: ArtifactNode[] = [];
  const routePaths = new Map<string, string>();
  const postmanPaths = new Map<string, string>();
  const mounts: RouterMount[] = [];
  for (const file of files) {
    if (file.bytes > 2_000_000) continue;
    const extension = extname(file.relativePath).toLowerCase();
    if (![".ts", ".tsx", ".js", ".mjs", ".json", ".yaml", ".yml", ".mmd"].includes(extension)) {
      continue;
    }
    const text = await readFile(
      `${snapshotDirectory}/${file.relativePath}`,
      "utf8"
    );
    if ([".ts", ".tsx", ".js", ".mjs"].includes(extension)) {
      extractMounts(text, mounts);
      extractRoutes(text, file, nodes, routePaths);
      extractCodeSymbols(text, file, nodes);
      if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file.relativePath)) {
        extractTests(text, file, nodes);
      }
    }
    if (extension === ".json") {
      extractPostman(text, file, nodes, postmanPaths);
      extractQuality(text, file, nodes);
    }
    if (extension === ".mmd") extractMermaid(text, file, nodes);
    if ([".yaml", ".yml"].includes(extension)) {
      extractWorld(text, file, nodes);
      extractDesignFlow(text, file, nodes);
      extractTestPlan(text, file, nodes);
      extractCi(text, file, nodes);
    }
  }

  const mountedNodes = applyRouterMounts(nodes, mounts);
  const uniqueNodes = [
    ...new Map(mountedNodes.map((item) => [item.id, item])).values()
  ];
  return { nodes: uniqueNodes, routePaths, postmanPaths };
}
