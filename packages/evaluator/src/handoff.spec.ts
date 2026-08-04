import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
      schemaVersion: 2,
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

    const compatible = createAgentFixPacket(report, { compat: "v1" });
    expect(compatible.schemaVersion).toBe(1);
    expect("aiExecution" in compatible).toBe(false);
  });

  it("can remove the raw snapshot while retaining the generated report", async () => {
    const { sandbox, source } = await createSampleRepository();
    process.env.HOME = join(sandbox, "private-home");
    const report = await new EvaluationService().scan({
      sourcePath: source,
      retainSnapshot: false
    });
    const evaluationDirectory = join(
      process.env.HOME,
      ".autorepoflow-private",
      "evaluations",
      report.evaluationId
    );

    await expect(
      access(join(evaluationDirectory, "snapshot"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(evaluationDirectory, "report.json"), "utf8")
    ).resolves.toContain(report.evaluationId);
  });

  it("rejects a filesystem root as a scan target", async () => {
    await expect(
      new EvaluationService().scan({ sourcePath: parse(process.cwd()).root })
    ).rejects.toThrow(/scoped repository directory/);
  });

  it("does not present unsupported-language coverage as complete", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "arf-language-"));
    process.env.HOME = join(sandbox, "private-home");
    const source = join(sandbox, "python-repository");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "app.py"), "def main():\n    return True\n");
    const report = await new EvaluationService().scan({
      sourcePath: source,
      ai: { requestedMode: "off" }
    });
    expect(report.languageSupport).toEqual({
      certified: ["javascript", "typescript"],
      detected: ["python"],
      status: "unsupported"
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "ARF-LANGUAGE-001",
        status: "UNVERIFIED"
      })
    );
  });
});
