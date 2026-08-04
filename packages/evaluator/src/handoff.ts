import type {
  ArtifactNode,
  EvaluationReport,
  Finding
} from "@auto-repoflow/domain";

export const AGENT_PACKET_CONSTRAINTS = [
  "Treat this packet as evidence for review, not as permission to edit files.",
  "Inspect every referenced file before proposing a change.",
  "Do not read or modify .env files, credentials, repository metadata, or protected policy files.",
  "Do not run repository commands without explicit user approval.",
  "Do not merge, deploy, publish, or widen access without explicit human approval."
] as const;

interface AgentFixPacketBase {
  kind: "auto-repoflow-agent-fix-packet";
  generatedAt: string;
  evaluationId: string;
  project: {
    label: string;
    sourceRootStored: false;
  };
  evaluation: {
    status: EvaluationReport["status"];
    mode: EvaluationReport["mode"];
    snapshotSha256: string;
    summary: EvaluationReport["summary"];
  };
  constraints: string[];
  verification: {
    declaredCommands: string[];
    requiresExplicitApproval: true;
  };
  findings: Array<{
    id: string;
    ruleId: string;
    severity: Finding["severity"];
    status: Finding["status"];
    problem: string;
    whyItMatters: string;
    evidence: Array<{
      relativePath: string;
      line?: number;
      sha256: string;
    }>;
    suggestedAction: string;
    acceptanceCriteria: string[];
  }>;
}

export interface AgentFixPacketV1 extends AgentFixPacketBase {
  schemaVersion: 1;
}

export interface AgentFixPacketV2 extends AgentFixPacketBase {
  schemaVersion: 2;
  aiExecution: EvaluationReport["aiExecution"];
  evidenceMaturity: EvaluationReport["evidenceMaturity"];
  languageSupport: EvaluationReport["languageSupport"];
  reviewGates: Array<{
    id: string;
    reason: string;
    requiredDecision: "human-review";
  }>;
  packetAcceptanceCriteria: string[];
}

export type AgentFixPacket = AgentFixPacketV1 | AgentFixPacketV2;

function declaredVerificationCommands(nodes: ArtifactNode[]): string[] {
  const commands = nodes
    .filter(
      (node) =>
        node.kind === "QUALITY_CHECK" &&
        node.attributes?.source === "package-script" &&
        /^[A-Za-z0-9:_-]+$/.test(node.name) &&
        !/(?:^|:)(?:dev|serve|start|watch)(?::|$)/i.test(node.name)
    )
    .map((node) => `npm run ${node.name}`);
  return [...new Set(commands)].sort().slice(0, 10);
}

function findingPriority(finding: Finding): number {
  const status = {
    FAIL: 0,
    UNVERIFIED: 1,
    HUMAN_REVIEW_REQUIRED: 2,
    PASS: 3
  }[finding.status];
  const severity = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 }[
    finding.severity
  ];
  return status * 10 + severity;
}

export function createAgentFixPacket(
  report: EvaluationReport,
  options: { compat?: "v1" | "v2" } = {}
): AgentFixPacket {
  const base: AgentFixPacketBase = {
    kind: "auto-repoflow-agent-fix-packet",
    generatedAt: report.createdAt,
    evaluationId: report.evaluationId,
    project: {
      label: report.projectName,
      sourceRootStored: false
    },
    evaluation: {
      status: report.status,
      mode: report.mode,
      snapshotSha256: report.snapshotSha256,
      summary: report.summary
    },
    constraints: [...AGENT_PACKET_CONSTRAINTS],
    verification: {
      declaredCommands: declaredVerificationCommands(report.nodes),
      requiresExplicitApproval: true
    },
    findings: [...report.findings]
      .sort((left, right) => findingPriority(left) - findingPriority(right))
      .map((finding) => ({
        id: finding.id,
        ruleId: finding.ruleId,
        severity: finding.severity,
        status: finding.status,
        problem: finding.title,
        whyItMatters: finding.explanation,
        evidence: finding.evidence.map((item) => ({
          relativePath: item.relativePath,
          line: item.line,
          sha256: item.sha256
        })),
        suggestedAction:
          finding.suggestedAction ??
          "Inspect the referenced evidence and propose the smallest reviewable change.",
        acceptanceCriteria: [
          `Resolve or explicitly reclassify ${finding.ruleId} with evidence.`,
          "Preserve previously passing project checks.",
          "Record the files changed and the verification performed."
        ]
      }))
  };
  if (options.compat === "v1") {
    return { schemaVersion: 1, ...base };
  }
  return {
    schemaVersion: 2,
    ...base,
    aiExecution: report.aiExecution,
    evidenceMaturity: report.evidenceMaturity,
    languageSupport: report.languageSupport,
    reviewGates: report.findings
      .filter((finding) => finding.status === "HUMAN_REVIEW_REQUIRED")
      .map((finding) => ({
        id: finding.id,
        reason: finding.title,
        requiredDecision: "human-review" as const
      })),
    packetAcceptanceCriteria: [
      "No AI-only relationship is reclassified as PASS without deterministic evidence.",
      "Generated evidence is reviewed through a hash-bound manifest before it is treated as REVIEWED.",
      "A human reviews relative engineering metadata before sharing or committing this packet.",
      "No source edit, command execution, merge, deploy, or publish is authorized by this packet."
    ]
  };
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function inlineCode(value: string): string {
  return `\`${singleLine(value).replace(/`/g, "\\`")}\``;
}

export function formatAgentFixPacketMarkdown(packet: AgentFixPacket): string {
  const lines = [
    "# Auto-RepoFlow Agent Fix Packet",
    "",
    `- Evaluation: ${inlineCode(packet.evaluationId)}`,
    `- Project label: ${inlineCode(packet.project.label)}`,
    `- Status: **${packet.evaluation.status}**`,
    `- Findings: **${packet.findings.length}**`,
    `- Snapshot: ${inlineCode(packet.evaluation.snapshotSha256)}`,
    "",
    "## Instructions for the receiving agent",
    "",
    "Use this packet to inspect the repository and propose a minimal, evidence-backed fix. Do not assume that a suggested action is correct until you inspect the referenced files.",
    "",
    ...packet.constraints.map((constraint) => `- ${constraint}`),
    ""
  ];

  if (packet.schemaVersion === 2) {
    lines.push(
      "## Automation evidence",
      "",
      `- AI: **${packet.aiExecution.status}** (${packet.aiExecution.provider ?? "none"} / ${packet.aiExecution.model ?? "none"})`,
      `- Evidence maturity: ${packet.evidenceMaturity.observed} observed, ${packet.evidenceMaturity.declared} declared, ${packet.evidenceMaturity.generated} generated, ${packet.evidenceMaturity.reviewed} reviewed`,
      `- Unresolved review gates: **${packet.evidenceMaturity.unresolvedReviewGates}**`,
      `- Language support: **${packet.languageSupport.status}** (${packet.languageSupport.detected.join(", ") || "none detected"})`,
      "",
      "### Packet acceptance criteria",
      "",
      ...packet.packetAcceptanceCriteria.map((criterion) => `- ${criterion}`),
      ""
    );
  }

  if (packet.findings.length === 0) {
    lines.push("## Findings", "", "No evidence gaps were reported.", "");
  } else {
    lines.push("## Findings", "");
    for (const [index, finding] of packet.findings.entries()) {
      lines.push(
        `### ${index + 1}. ${singleLine(finding.problem)}`,
        "",
        `- ID: ${inlineCode(finding.id)}`,
        `- Rule: ${inlineCode(finding.ruleId)}`,
        `- Severity/status: **${finding.severity} / ${finding.status}**`,
        `- Why it matters: ${singleLine(finding.whyItMatters)}`,
        `- Suggested action: ${singleLine(finding.suggestedAction)}`,
        "- Evidence:"
      );
      if (finding.evidence.length === 0) {
        lines.push("  - No file-level evidence was available; inspect project configuration.");
      } else {
        for (const item of finding.evidence) {
          const location = item.line
            ? `${item.relativePath}:${item.line}`
            : item.relativePath;
          lines.push(
            `  - ${inlineCode(location)} (sha256 ${inlineCode(item.sha256)})`
          );
        }
      }
      lines.push(
        "- Acceptance criteria:",
        ...finding.acceptanceCriteria.map((criterion) => `  - ${criterion}`),
        ""
      );
    }
  }

  lines.push(
    "## Declared verification commands",
    "",
    "These commands were declared by the repository and were not executed by this scan. Inspect them and obtain explicit approval before running them.",
    ""
  );
  if (packet.verification.declaredCommands.length === 0) {
    lines.push("- No supported root verification commands were discovered.");
  } else {
    lines.push(
      ...packet.verification.declaredCommands.map(
        (command) => `- ${inlineCode(command)}`
      )
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function formatHumanReport(report: EvaluationReport): string {
  const lines = [
    `Auto-RepoFlow — ${singleLine(report.projectName)}`,
    `Status: ${report.status}  Mode: ${report.mode}`,
    `Run: ${report.evaluationId}`,
    `Evidence: ${report.privacy.includedFiles} included, ${report.privacy.excludedFiles} excluded`,
    `AI: ${report.aiExecution.status}  Provider: ${report.aiExecution.provider ?? "none"}  Fallback: ${report.aiExecution.fallbackUsed ? "yes" : "no"}`,
    `Maturity: ${report.evidenceMaturity.observed} observed, ${report.evidenceMaturity.declared} declared, ${report.evidenceMaturity.generated} generated, ${report.evidenceMaturity.reviewed} reviewed`,
    `Language support: ${report.languageSupport.status} (${report.languageSupport.detected.join(", ") || "no supported source detected"})`,
    `Findings: ${report.summary.fail} fail, ${report.summary.unverified} unverified, ${report.summary.humanReviewRequired} human review`,
    ""
  ];
  const topFindings = [...report.findings]
    .sort((left, right) => findingPriority(left) - findingPriority(right))
    .slice(0, 10);
  if (topFindings.length === 0) {
    lines.push("No evidence gaps were reported.");
  } else {
    lines.push("Top findings:");
    for (const finding of topFindings) {
      lines.push(
        `- [${finding.status}] ${singleLine(finding.title)} (${finding.ruleId})`
      );
    }
  }
  lines.push(
    "",
    "Create a portable handoff with --format agent-md or --format agent-json."
  );
  return `${lines.join("\n")}\n`;
}
