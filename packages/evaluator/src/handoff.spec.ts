import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentFixPacket,
  formatAgentFixPacketMarkdown,
  formatHumanReport
} from "./handoff.js";
import { EvaluationService } from "./service.js";

const previousHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = previousHome;
});

async function createSampleRepository(): Promise<{
  sandbox: string;
  source: string;
}> {
  const sandbox = await mkdtemp(join(tmpdir(), "arf-scan-"));
  const source = join(sandbox, "sample-repo");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, ".git"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "sample-repo",
      scripts: {
        test: "vitest run",
        "test:watch": "vitest",
        build: "tsc",
        typecheck: "tsc --noEmit"
      }
    })
  );
  await writeFile(
    join(source, "src", "routes.ts"),
    'router.get("/api/v1/widgets", listWidgets); export function listWidgets() {}'
  );
  await writeFile(join(source, ".env"), "TOKEN=not-copied");
  return { sandbox, source };
}

describe("zero-config scan and agent handoff", () => {
  it("scans a scoped repository without executing its declared commands", async () => {
    const { sandbox, source } = await createSampleRepository();
    process.env.HOME = join(sandbox, "private-home");
    const report = await new EvaluationService().scan({ sourcePath: source });

    expect(report).toMatchObject({
      projectName: "sample-repo",
      mode: "rules",
      status: "REPORT_READY"
    });
    expect(report.findings.some((item) => item.ruleId === "ARF-TEST-001")).toBe(
      true
    );
    const stored = await readFile(
      join(
        process.env.HOME,
        ".autorepoflow-private",
        "evaluations",
        report.evaluationId,
        "report.json"
      ),
      "utf8"
    );
    expect(stored).not.toContain(source);
    expect(stored).not.toContain("TOKEN=not-copied");
  });

  it("creates deterministic JSON and Markdown packets for another agent", async () => {
    const { sandbox, source } = await createSampleRepository();
    process.env.HOME = join(sandbox, "private-home");
    const report = await new EvaluationService().scan({ sourcePath: source });
    const packet = createAgentFixPacket(report);
    const markdown = formatAgentFixPacketMarkdown(packet);

    expect(packet).toMatchObject({
      schemaVersion: 1,
      kind: "auto-repoflow-agent-fix-packet",
      project: { label: "sample-repo", sourceRootStored: false },
      verification: { requiresExplicitApproval: true }
    });
    expect(packet.verification.declaredCommands).toEqual([
      "npm run build",
      "npm run test",
      "npm run typecheck"
    ]);
    expect(JSON.stringify(packet)).not.toContain(source);
    expect(markdown).toContain("Auto-RepoFlow Agent Fix Packet");
    expect(markdown).toContain("ARF-TEST-001");
    expect(markdown).toContain("Do not run repository commands without explicit user approval");
    expect(formatHumanReport(report)).toContain("Create a portable handoff");
  });

  it("rejects a filesystem root as a scan target", async () => {
    await expect(
      new EvaluationService().scan({ sourcePath: parse(process.cwd()).root })
    ).rejects.toThrow(/scoped repository directory/);
  });
});
