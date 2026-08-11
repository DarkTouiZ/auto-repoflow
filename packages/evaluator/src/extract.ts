import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type {
  ArtifactNode,
  ArtifactNodeKind,
  EvidenceRef
} from "@auto-repoflow/domain";
import { parse as parseYaml } from "yaml";
import type { SnapshotFile } from "./privacy.js";
import {
  bodySpanOf,
  callArgs,
  computeCodeMask,
  countTopLevelStatements,
  isCodeIndex,
  maskNonCode
} from "./jsscan.js";

export const CODE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts"
];

export const TEST_FILE_PATTERN =
  /(?:\.(?:spec|test|cy|e2e-spec)\.[cm]?[jt]sx?$)|(?:(?:^|\/)(?:__tests__|tests?)\/.*\.[cm]?[jt]sx?$)/;

export function isCodeFile(relativePath: string): boolean {
  return CODE_EXTENSIONS.includes(extname(relativePath).toLowerCase());
}

export function isTestFilePath(relativePath: string): boolean {
  return TEST_FILE_PATTERN.test(relativePath);
}

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

// Receivers that are HTTP clients making outbound calls, not route registrars.
// Their `.get("/x")` is a frontend/integration call handled elsewhere.
const HTTP_CLIENT_RECEIVERS = new Set([
  "axios",
  "http",
  "https",
  "fetch",
  "superagent",
  "got",
  "ky",
  "request",
  "client",
  "httpclient"
]);

function isRouteRegistration(receiver: string, rawPath: string): boolean {
  // A known HTTP client is never a route registrar.
  if (HTTP_CLIENT_RECEIVERS.has(receiver.toLowerCase())) return false;
  // Accept a route when its path is server-route-like (leading slash) or the
  // receiver is clearly a router. This admits server.get / api.post / r.get on
  // absolute paths while rejecting map.get("key"), cache.get(...), _.get(...).
  if (rawPath.startsWith("/")) return true;
  return /(?:^app$|router$)/i.test(receiver);
}

function extractRoutes(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[],
  routePaths: Map<string, string>,
  mask: Uint8Array
): void {
  const routeRegex =
    /\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
  for (const match of text.matchAll(routeRegex)) {
    if (!isCodeIndex(mask, match.index ?? 0)) continue;
    const router = match[1];
    if (!isRouteRegistration(router, match[3])) continue;
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

function nestControllerPrefix(text: string): string | null {
  const controllerMatch = text.match(/@Controller\s*\(([^)]*)\)/);
  if (!controllerMatch) return null;
  const args = controllerMatch[1] ?? "";
  // String form: @Controller("users") or @Controller('users').
  const stringForm = args.match(/^\s*["'`]([^"'`]*)["'`]\s*$/);
  // Object form: @Controller({ path: "users", version: "1" }).
  const objectForm = args.match(/path\s*:\s*["'`]([^"'`]*)["'`]/);
  const rawPrefix = stringForm?.[1] ?? objectForm?.[1] ?? "/";
  return normalizeApiPath(
    rawPrefix.startsWith("/") ? rawPrefix : `/${rawPrefix}`
  );
}

function extractNestRoutes(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[],
  routePaths: Map<string, string>,
  mask: Uint8Array
): void {
  const prefix = nestControllerPrefix(text);
  if (prefix === null) return;
  // Tolerate any number of intervening decorators (e.g. @UseGuards(...),
  // @HttpCode(201)) and modifiers between the HTTP method decorator and the
  // handler method name.
  const routeRegex =
    /@(Get|Post|Put|Patch|Delete)\s*\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)\s*(?:@[A-Za-z_$][\w$]*\s*(?:\([^)]*\))?\s*|public\s+|private\s+|protected\s+|readonly\s+|async\s+|static\s+|override\s+)*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of text.matchAll(routeRegex)) {
    if (!isCodeIndex(mask, match.index ?? 0)) continue;
    const method = match[1].toUpperCase();
    const path = joinApiPath(prefix, match[2] ?? "/");
    const locator = `${method} ${path}`;
    const line = lineAt(text, match.index ?? 0);
    routePaths.set(locator, stableId("API_OPERATION", locator));
    nodes.push(
      node("API_OPERATION", locator, locator, file, line, {
        source: "nestjs-route",
        method,
        path
      })
    );
    nodes.push(
      node(
        "CODE_SYMBOL",
        match[3],
        `symbol:${file.relativePath}:${match[3]}`,
        file,
        line,
        { source: "typescript", operation: locator }
      )
    );
  }
}

// An outbound HTTP call to an absolute external URL (e.g. a third-party API
// like https://api.stripe.com/...) is not a UI action against this repo's own
// API surface, so it must not become a traceable UI_ACTION. Only same-origin
// relative paths represent UI-to-API edges worth tracing.
function isExternalUrl(rawPath: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath);
}

function extractFrontendApiCalls(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[],
  mask: Uint8Array
): void {
  const axiosRegex =
    /\baxios\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
  for (const match of text.matchAll(axiosRegex)) {
    if (!isCodeIndex(mask, match.index ?? 0)) continue;
    if (isExternalUrl(match[2])) continue;
    const method = match[1].toUpperCase();
    const path = normalizeApiPath(match[2]);
    const operation = `${method} ${path}`;
    nodes.push(
      node(
        "UI_ACTION",
        `Frontend request ${operation}`,
        `frontend-call:${file.relativePath}:${operation}`,
        file,
        lineAt(text, match.index ?? 0),
        {
          source: "frontend-api-call",
          apiOperation: operation,
          method,
          path,
          reviewStatus: "draft_inferred_requires_review"
        }
      )
    );
  }
  const fetchRegex = /\bfetch\s*\(\s*["'`]([^"'`]+)["'`]/gi;
  for (const match of text.matchAll(fetchRegex)) {
    if (!isCodeIndex(mask, match.index ?? 0)) continue;
    if (isExternalUrl(match[1])) continue;
    const path = normalizeApiPath(match[1]);
    const nearby = text.slice(match.index ?? 0, (match.index ?? 0) + 400);
    const method =
      nearby.match(/method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i)?.[1]?.toUpperCase() ??
      "GET";
    const operation = `${method} ${path}`;
    nodes.push(
      node(
        "UI_ACTION",
        `Frontend request ${operation}`,
        `frontend-call:${file.relativePath}:${operation}`,
        file,
        lineAt(text, match.index ?? 0),
        {
          source: "frontend-api-call",
          apiOperation: operation,
          method,
          path,
          reviewStatus: "draft_inferred_requires_review"
        }
      )
    );
  }
}

function extractOpenApi(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[],
  postmanPaths: Map<string, string>
): void {
  try {
    const document = (file.relativePath.endsWith(".json")
      ? JSON.parse(text)
      : parseYaml(text)) as Record<string, unknown>;
    if (!document.openapi && !document.swagger) return;
    const paths = document.paths;
    if (!paths || typeof paths !== "object") return;
    const reviewStatus =
      typeof document["x-auto-repoflow-review-status"] === "string"
        ? String(document["x-auto-repoflow-review-status"])
        : "draft_declared_requires_review";
    for (const [rawPath, value] of Object.entries(
      paths as Record<string, unknown>
    )) {
      if (!value || typeof value !== "object") continue;
      for (const [rawMethod, operationValue] of Object.entries(
        value as Record<string, unknown>
      )) {
        const method = rawMethod.toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          continue;
        }
        const path = normalizeApiPath(rawPath);
        const operation = `${method} ${path}`;
        const operationRecord =
          operationValue && typeof operationValue === "object"
            ? (operationValue as Record<string, unknown>)
            : {};
        const name =
          typeof operationRecord.summary === "string"
            ? operationRecord.summary
            : operation;
        const locator = `openapi:${operation}:${name}`;
        const id = stableId("REQUIREMENT", locator);
        postmanPaths.set(operation, id);
        nodes.push(
          node("REQUIREMENT", name, locator, file, undefined, {
            source: "openapi",
            method,
            path,
            operation,
            reviewStatus
          })
        );
      }
    }
  } catch {
    // Non-OpenAPI JSON/YAML files are intentionally ignored.
  }
}

function extractMarkdownRequirements(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[]
): void {
  const headingRegex =
    /^#{1,4}\s+(.+(?:requirement|acceptance|user stor|specification).*)$/gim;
  let count = 0;
  for (const match of text.matchAll(headingRegex)) {
    if (count >= 100) break;
    const title = match[1].trim();
    nodes.push(
      node(
        "REQUIREMENT",
        title,
        `markdown:${file.relativePath}:${title}`,
        file,
        lineAt(text, match.index ?? 0),
        {
          source: "markdown-requirement",
          reviewStatus: "draft_declared_requires_review"
        }
      )
    );
    count += 1;
  }
}

function extractMounts(
  text: string,
  mounts: RouterMount[],
  mask: Uint8Array
): void {
  const mountRegex =
    /\b([A-Za-z_$][\w$]*)\.use\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*)/gi;
  for (const match of text.matchAll(mountRegex)) {
    if (!isCodeIndex(mask, match.index ?? 0)) continue;
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
        scenarios?: Array<
          | string
          | {
              name?: string;
              status?: string;
              reason?: string;
            }
        >;
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
      for (const scenarioValue of testCase.scenarios ?? []) {
        const scenario =
          typeof scenarioValue === "string"
            ? scenarioValue.trim()
            : String(scenarioValue?.name ?? "").trim();
        if (!scenario) continue;
        const scenarioStatus =
          typeof scenarioValue === "string"
            ? "in_scope"
            : String(scenarioValue.status ?? "in_scope");
        const scenarioAttributes: Record<string, string> = {
          source: "test-plan-scenario",
          reviewStatus,
          apiOperation: testCase.api_operation,
          scenario,
          scenarioStatus,
          level: testCase.level ?? "unspecified"
        };
        if (typeof scenarioValue !== "string" && scenarioValue.reason) {
          scenarioAttributes.scenarioReason = scenarioValue.reason;
        }
        nodes.push(
          node(
            "TEST_CASE",
            `${testCase.api_operation} [scenario: ${scenario}]`,
            `test-plan-scenario:${testId}:${scenario}`,
            file,
            undefined,
            scenarioAttributes
          )
        );
      }
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

const ASSERTION_TOKENS = [
  "expect(",
  ".expect(",
  "assert(",
  "assert.",
  ".should",
  "should(",
  "t.is(",
  "t.deepequal(",
  "t.throws(",
  "t.notthrows(",
  "t.truthy(",
  "t.falsy(",
  "t.snapshot(",
  "t.assert.",
  "tomatchsnapshot",
  "tomatchinlinesnapshot",
  "tomatchfilesnapshot",
  "expect.assertions(",
  "expect.hasassertions(",
  "cy.should(",
  ".rejects",
  ".resolves"
];

function classifyTestBody(
  maskedText: string,
  titleParenIndex: number
): { bodyStatements: number; assertionCount: number; assertionStyles: string } {
  const args = callArgs(maskedText, titleParenIndex);
  if (args.length === 0) {
    return { bodyStatements: 0, assertionCount: 0, assertionStyles: "" };
  }
  const callback = args[args.length - 1];
  const span = bodySpanOf(maskedText, callback[0], callback[1]);
  if (!span) {
    return { bodyStatements: 0, assertionCount: 0, assertionStyles: "" };
  }
  const bodyStatements = countTopLevelStatements(
    maskedText,
    span.start,
    span.end
  );
  const body = maskedText.slice(span.start, span.end).toLowerCase();
  const styles = new Set<string>();
  for (const token of ASSERTION_TOKENS) {
    if (body.includes(token)) styles.add(token.replace(/[.(]/g, ""));
  }
  return {
    bodyStatements,
    assertionCount: styles.size,
    assertionStyles: [...styles].sort().join(",")
  };
}

function extractTests(
  text: string,
  file: SnapshotFile,
  nodes: ArtifactNode[],
  mask: Uint8Array,
  maskedText: string
): void {
  // Match it / test / fit / xit with an optional modifier (.only, .skip, .todo,
  // .each(...), .concurrent, .failing) and an optional chained call for
  // parameterised tests, e.g. it.each([...])("title", ...).
  const testRegex =
    /\b(it|test|fit|xit)(?:\.(only|skip|todo|each|concurrent|failing))?\s*(?:\([^)]*\)\s*)?\(\s*["'`]([^"'`]+)["'`]/g;
  for (const match of text.matchAll(testRegex)) {
    if (!isCodeIndex(mask, match.index ?? 0)) continue;
    const name = match[1].toLowerCase();
    const title = match[3];
    let modifier = match[2]?.toLowerCase() ?? "none";
    if (name === "fit") modifier = "only";
    if (name === "xit") modifier = "skip";

    const attributes: Record<string, string | number> = {
      source: "test",
      modifier
    };
    const operationMatch = title.match(
      /^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s"'`]+)/i
    );
    if (operationMatch) {
      const method = operationMatch[1].toUpperCase();
      const path = normalizeApiPath(operationMatch[2]);
      attributes.method = method;
      attributes.path = path;
      attributes.operation = `${method} ${path}`;
    }
    const scenarioMatch = title.match(/\[scenario:\s*([^\]]+)\]/i);
    if (scenarioMatch) {
      attributes.scenario = scenarioMatch[1].trim();
    }

    // The title paren is the last real `(` within the match span. Search the
    // masked text so a `(` inside the title string (e.g. it("returns (200)"))
    // is a space and cannot be mistaken for the call paren.
    const titleParen = maskedText.lastIndexOf(
      "(",
      (match.index ?? 0) + match[0].length
    );
    const { bodyStatements, assertionCount, assertionStyles } = classifyTestBody(
      maskedText,
      titleParen
    );
    attributes.bodyStatements = bodyStatements;
    attributes.assertionCount = assertionCount;
    if (assertionStyles) attributes.assertionStyles = assertionStyles;

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
    if (![...CODE_EXTENSIONS, ".json", ".yaml", ".yml", ".mmd", ".md"].includes(extension)) {
      continue;
    }
    const text = await readFile(
      `${snapshotDirectory}/${file.relativePath}`,
      "utf8"
    );
    if (CODE_EXTENSIONS.includes(extension)) {
      const mask = computeCodeMask(text);
      const isTestFile = TEST_FILE_PATTERN.test(file.relativePath);
      extractMounts(text, mounts, mask);
      extractRoutes(text, file, nodes, routePaths, mask);
      extractNestRoutes(text, file, nodes, routePaths, mask);
      // A backend/server file that registers routes should not have its
      // outbound HTTP client calls (e.g. axios to a third-party API) treated as
      // UI actions. Only mine frontend calls when the file declares no routes.
      const declaresRoutes = nodes.some(
        (item) =>
          item.kind === "API_OPERATION" &&
          item.evidence.relativePath === file.relativePath
      );
      if (!declaresRoutes && !isTestFile) {
        extractFrontendApiCalls(text, file, nodes, mask);
      }
      extractCodeSymbols(text, file, nodes);
      if (isTestFile) {
        extractTests(text, file, nodes, mask, maskNonCode(text));
      }
    }
    if (extension === ".json") {
      extractPostman(text, file, nodes, postmanPaths);
      extractOpenApi(text, file, nodes, postmanPaths);
      extractQuality(text, file, nodes);
    }
    if (extension === ".mmd") extractMermaid(text, file, nodes);
    if ([".yaml", ".yml"].includes(extension)) {
      extractOpenApi(text, file, nodes, postmanPaths);
      extractWorld(text, file, nodes);
      extractDesignFlow(text, file, nodes);
      extractTestPlan(text, file, nodes);
      extractCi(text, file, nodes);
    }
    if (extension === ".md") extractMarkdownRequirements(text, file, nodes);
  }

  const mountedNodes = applyRouterMounts(nodes, mounts);
  const uniqueNodes = [
    ...new Map(mountedNodes.map((item) => [item.id, item])).values()
  ];
  return { nodes: uniqueNodes, routePaths, postmanPaths };
}
