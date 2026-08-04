import { CommonModule } from "@angular/common";
import { HttpClient } from "@angular/common/http";
import { Component, OnInit, inject, signal } from "@angular/core";

interface Coverage {
  id: string;
  label: string;
  covered: number;
  total: number;
  percentage: number;
}

interface Finding {
  id: string;
  ruleId: string;
  status: "PASS" | "FAIL" | "UNVERIFIED" | "HUMAN_REVIEW_REQUIRED";
  title: string;
  explanation: string;
}

interface Report {
  schemaVersion: 2;
  evaluationId: string;
  projectName: string;
  status: string;
  mode: string;
  coverage: Coverage[];
  findings: Finding[];
  summary: {
    pass: number;
    fail: number;
    unverified: number;
    humanReviewRequired: number;
  };
  privacy: {
    includedFiles: number;
    excludedFiles: number;
    sourceRootStored: boolean;
    publicExportSafe: boolean;
  };
  aiExecution: {
    requestedMode: "auto" | "off" | "local" | "cloud";
    provider: "ollama" | "openai" | "anthropic" | "google" | null;
    model: string | null;
    status: "disabled" | "used" | "fallback" | "failed";
    fallbackUsed: boolean;
    batches: number;
    suggestionsAccepted: number;
    suggestionsRejected: number;
    durationMs: number;
    payloadSha256: string | null;
  };
  evidenceMaturity: {
    observed: number;
    declared: number;
    generated: number;
    reviewed: number;
    unresolvedReviewGates: number;
  };
  languageSupport: {
    certified: readonly ["javascript", "typescript"];
    detected: string[];
    status: "supported" | "partial" | "unsupported";
  };
}

const benchmarkReport: Report = {
  schemaVersion: 2,
  evaluationId: "synthetic-demo",
  projectName: "MileMesh Synthetic Benchmark",
  status: "REPORT_READY",
  mode: "rules",
  coverage: [
    {
      id: "api-spec",
      label: "API specification",
      covered: 8,
      total: 10,
      percentage: 80
    },
    {
      id: "implementation",
      label: "Implementation",
      covered: 10,
      total: 10,
      percentage: 100
    },
    {
      id: "test",
      label: "Test evidence",
      covered: 0,
      total: 10,
      percentage: 0
    },
    {
      id: "ui-api",
      label: "UI → API",
      covered: 10,
      total: 10,
      percentage: 100
    }
  ],
  findings: [
    {
      id: "f-1",
      ruleId: "ARF-TEST-001",
      status: "UNVERIFIED",
      title: "10 operations have no linked test evidence",
      explanation: "Missing evidence remains unverified; it is never inferred as a pass."
    },
    {
      id: "f-2",
      ruleId: "ARF-API-002",
      status: "FAIL",
      title: "2 specified operations are not implemented",
      explanation: "The synthetic Postman collection contains two deliberate benchmark gaps."
    },
    {
      id: "f-3",
      ruleId: "ARF-DATA-001",
      status: "UNVERIFIED",
      title: "2 response-to-screen mappings are absent",
      explanation: "Visible values still need reviewed response-field evidence."
    }
  ],
  summary: {
    pass: 31,
    fail: 2,
    unverified: 20,
    humanReviewRequired: 0
  },
  privacy: {
    includedFiles: 37,
    excludedFiles: 7,
    sourceRootStored: false,
    publicExportSafe: true
  },
  aiExecution: {
    requestedMode: "auto",
    provider: "ollama",
    model: null,
    status: "fallback",
    fallbackUsed: true,
    batches: 0,
    suggestionsAccepted: 0,
    suggestionsRejected: 0,
    durationMs: 4,
    payloadSha256: null
  },
  evidenceMaturity: {
    observed: 37,
    declared: 10,
    generated: 2,
    reviewed: 0,
    unresolvedReviewGates: 2
  },
  languageSupport: {
    certified: ["javascript", "typescript"],
    detected: ["typescript"],
    status: "supported"
  }
};

@Component({
  selector: "arf-root",
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="app-shell">
      <aside>
        <div class="brand"><span>AR</span><strong>Auto-RepoFlow</strong></div>
        <nav>
          <a class="active" href="#overview">Evaluation</a>
          <a href="#coverage">Coverage</a>
          <a href="#traceability">Trace graph</a>
          <a href="#findings">Findings</a>
          <a href="#automation">AI & evidence</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <div class="local-badge"><i></i> LOCAL ONLY</div>
      </aside>

      <main>
        <header id="overview">
          <div>
            <p class="eyebrow">ENGINEERING EVIDENCE AUDITOR</p>
            <h1>{{ report().projectName }}</h1>
            <p class="lede">
              Requirement → Design → Data → API → Code → Tests
            </p>
          </div>
          <div class="run-state">
            <span>EvaluationRun</span>
            <strong>{{ report().status }}</strong>
            <small>{{ live() ? "LIVE LOCAL REPORT" : "SYNTHETIC DEMO" }}</small>
          </div>
        </header>

        <section class="privacy-strip" id="privacy">
          <span class="shield">✓</span>
          <div>
            <strong>Privacy boundary active</strong>
            <small>Absolute source path is not stored · public export is identifier-free</small>
          </div>
          <dl>
            <div><dt>Included</dt><dd>{{ report().privacy.includedFiles }}</dd></div>
            <div><dt>Excluded</dt><dd>{{ report().privacy.excludedFiles }}</dd></div>
            <div><dt>AI</dt><dd>{{ report().aiExecution.status }}</dd></div>
          </dl>
        </section>

        <p class="notice" *ngIf="message()">{{ message() }}</p>

        <section class="coverage-grid" id="coverage">
          <article *ngFor="let metric of report().coverage">
            <div class="metric-head">
              <span>{{ metric.label }}</span>
              <strong>{{ metric.percentage }}%</strong>
            </div>
            <div class="bar"><i [style.width.%]="metric.percentage"></i></div>
            <small>{{ metric.covered }} / {{ metric.total }} evidence-linked</small>
          </article>
        </section>

        <section class="panel automation-panel" id="automation">
          <div class="panel-title">
            <div>
              <p class="eyebrow">READ-ONLY AUTOMATION TRACE</p>
              <h2>AI execution and evidence maturity</h2>
            </div>
            <span class="mode">NO CONTROL ACTIONS</span>
          </div>
          <div class="automation-grid">
            <article>
              <small>Provider</small>
              <strong>{{ report().aiExecution.provider || "Rules only" }}</strong>
              <span>{{ report().aiExecution.status }} · {{ report().aiExecution.batches }} batches</span>
            </article>
            <article>
              <small>Suggestions</small>
              <strong>{{ report().aiExecution.suggestionsAccepted }} accepted</strong>
              <span>{{ report().aiExecution.suggestionsRejected }} rejected · never auto-PASS</span>
            </article>
            <article>
              <small>Observed / declared</small>
              <strong>{{ report().evidenceMaturity.observed }} / {{ report().evidenceMaturity.declared }}</strong>
              <span>Repository-backed evidence</span>
            </article>
            <article>
              <small>Generated / reviewed</small>
              <strong>{{ report().evidenceMaturity.generated }} / {{ report().evidenceMaturity.reviewed }}</strong>
              <span>{{ report().evidenceMaturity.unresolvedReviewGates }} unresolved review gates</span>
            </article>
            <article>
              <small>Language support</small>
              <strong>{{ report().languageSupport.status }}</strong>
              <span>{{ report().languageSupport.detected.join(", ") || "none detected" }}</span>
            </article>
          </div>
          <p>
            This console can only display local reports. Approval, export, source edits,
            push, merge, deploy, and publish are unavailable here.
          </p>
        </section>

        <section class="panel trace-panel" id="traceability">
          <div class="panel-title">
            <div>
              <p class="eyebrow">TRACEABILITY MATRIX</p>
              <h2>{{ coverageById("implementation").total }} operations in scope</h2>
            </div>
            <span class="mode">RULES + EVIDENCE</span>
          </div>
          <div class="trace-flow">
            <div>
              <b>UI</b><span>{{ coverageById("ui-api").covered }}</span>
            </div><i>→</i>
            <div>
              <b>API</b><span>{{ coverageById("api-spec").total }}</span>
            </div><i>→</i>
            <div>
              <b>CODE</b><span>{{ coverageById("implementation").covered }}</span>
            </div><i>→</i>
            <div class="weak">
              <b>TEST</b><span>{{ coverageById("test").covered }}</span>
            </div>
          </div>
          <p>
            Every link carries a file hash and locator. Missing proof stays
            <code>UNVERIFIED</code>; AI cannot upgrade deterministic failures.
          </p>
        </section>

        <section class="panel findings" id="findings">
          <div class="panel-title">
            <div>
              <p class="eyebrow">REVIEW QUEUE</p>
              <h2>Evidence gaps</h2>
            </div>
            <div class="totals">
              <span class="fail">{{ report().summary.fail }} fail</span>
              <span>{{ report().summary.unverified }} unverified</span>
              <span class="review">
                {{ report().summary.humanReviewRequired }} human review
              </span>
            </div>
          </div>
          <article *ngFor="let finding of report().findings.slice(0, 8)">
            <span class="status" [class.fail]="finding.status === 'FAIL'">
              {{ finding.status }}
            </span>
            <div>
              <strong>{{ finding.title }}</strong>
              <p>{{ finding.explanation }}</p>
            </div>
            <code>{{ finding.ruleId }}</code>
          </article>
        </section>

        <footer>
          EvaluationRun stops at REPORT_READY · ChangeRun remains separately
          hard-stopped at DRAFT_PR_CREATED
        </footer>
      </main>
    </div>
  `
})
export class AppComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly report = signal<Report>(benchmarkReport);
  readonly live = signal(false);
  readonly message = signal("");

  coverageById(id: string): Coverage {
    return (
      this.report().coverage.find((item) => item.id === id) ?? {
        id,
        label: id,
        covered: 0,
        total: 0,
        percentage: 0
      }
    );
  }

  ngOnInit(): void {
    const evaluationId = new URLSearchParams(window.location.search).get(
      "evaluation"
    );
    if (!evaluationId) return;
    this.message.set("Loading the local evidence report…");
    this.http
      .get<Report>(
        `http://127.0.0.1:4100/api/v1/evaluations/${encodeURIComponent(
          evaluationId
        )}/report`
      )
      .subscribe({
        next: (report) => {
          this.report.set(report);
          this.live.set(true);
          this.message.set("");
        },
        error: () => {
          this.message.set(
            "Local API report was unavailable; showing the synthetic benchmark."
          );
        }
      });
  }
}
