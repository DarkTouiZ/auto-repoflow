import type {
  ArtifactNode,
  EvaluationReport,
  TraceEdgeKind
} from "@auto-repoflow/domain";
import { z } from "zod";

const allowedAiEdgeKinds = [
  "REQUIRES",
  "TRIGGERS",
  "SERVED_BY",
  "READS",
  "WRITES",
  "IMPLEMENTED_BY",
  "VERIFIED_BY"
] as const satisfies readonly TraceEdgeKind[];

const suggestionSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  kind: z.enum(allowedAiEdgeKinds),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(500),
  evidenceArtifactIds: z.array(z.string().min(1)).min(1)
});

const suggestionListSchema = z.object({
  suggestions: z.array(suggestionSchema).max(100)
});

export type SemanticLinkSuggestion = z.infer<typeof suggestionSchema>;

export interface SemanticLinkProvider {
  readonly name: "mock" | "ollama";
  suggestLinks(nodes: ArtifactNode[]): Promise<SemanticLinkSuggestion[]>;
}

export class MockSemanticLinkProvider implements SemanticLinkProvider {
  readonly name = "mock" as const;

  async suggestLinks(): Promise<SemanticLinkSuggestion[]> {
    return [];
  }
}

function requireLoopbackEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)
  ) {
    throw new Error("Ollama endpoint must use HTTP on a loopback host");
  }
  return endpoint;
}

export class OllamaSemanticLinkProvider implements SemanticLinkProvider {
  readonly name = "ollama" as const;
  private readonly endpoint: URL;

  constructor(
    endpoint = process.env.ARF_OLLAMA_URL ?? "http://127.0.0.1:11434",
    private readonly model = process.env.ARF_OLLAMA_MODEL ?? "qwen2.5-coder:7b"
  ) {
    this.endpoint = requireLoopbackEndpoint(endpoint);
  }

  async suggestLinks(nodes: ArtifactNode[]): Promise<SemanticLinkSuggestion[]> {
    const safeNodes = nodes.map(({ id, kind, name, locator, evidence }) => ({
      id,
      kind,
      name,
      locator,
      evidenceArtifactId: evidence.artifactId
    }));
    const response = await fetch(new URL("/api/generate", this.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        prompt: [
          "You link software engineering artifacts using only supplied metadata.",
          "Return JSON: {suggestions:[{fromId,toId,kind,confidence,rationale,evidenceArtifactIds}]}.",
          "Never invent node IDs or evidence IDs. Do not infer a PASS/FAIL result.",
          JSON.stringify(safeNodes)
        ].join("\n")
      }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}`);
    }
    const envelope = (await response.json()) as { response?: string };
    if (!envelope.response) throw new Error("Ollama response was empty");
    return suggestionListSchema.parse(JSON.parse(envelope.response)).suggestions;
  }
}

export function verifyAiSuggestions(
  report: EvaluationReport,
  suggestions: SemanticLinkSuggestion[]
): EvaluationReport {
  const nodes = new Map(report.nodes.map((node) => [node.id, node]));
  const artifactIds = new Set(
    report.nodes.map((node) => node.evidence.artifactId)
  );
  const existing = new Set(
    report.edges.map((edge) => `${edge.kind}:${edge.from}:${edge.to}`)
  );
  for (const suggestion of suggestions) {
    const from = nodes.get(suggestion.fromId);
    const to = nodes.get(suggestion.toId);
    const evidenceIsValid = suggestion.evidenceArtifactIds.every((id) =>
      artifactIds.has(id)
    );
    const key = `${suggestion.kind}:${suggestion.fromId}:${suggestion.toId}`;
    if (!from || !to || !evidenceIsValid || existing.has(key)) continue;
    report.edges.push({
      id: `edge:local-ai:${suggestion.kind}:${suggestion.fromId}:${suggestion.toId}`,
      kind: suggestion.kind,
      from: suggestion.fromId,
      to: suggestion.toId,
      confidence: suggestion.confidence,
      source: "LOCAL_AI",
      status:
        suggestion.confidence >= 0.85
          ? "PASS"
          : "HUMAN_REVIEW_REQUIRED",
      rationale: suggestion.rationale
    });
    existing.add(key);
  }
  report.summary.pass = report.edges.filter(
    (edge) => edge.status === "PASS"
  ).length;
  report.summary.humanReviewRequired =
    report.edges.filter(
      (edge) => edge.status === "HUMAN_REVIEW_REQUIRED"
    ).length +
    report.findings.filter(
      (item) => item.status === "HUMAN_REVIEW_REQUIRED"
    ).length;
  return report;
}

export function createSemanticLinkProvider(
  name = process.env.ARF_AI_PROVIDER ?? "mock"
): SemanticLinkProvider {
  if (name === "mock") return new MockSemanticLinkProvider();
  if (name === "ollama") return new OllamaSemanticLinkProvider();
  throw new Error("ARF_AI_PROVIDER must be mock or ollama");
}
