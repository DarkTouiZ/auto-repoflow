import { Component } from "@angular/core";

@Component({
  selector: "arf-root",
  standalone: true,
  template: `
    <main class="shell">
      <header>
        <p class="eyebrow">LOCAL CONTROL PLANE</p>
        <h1>Auto-RepoFlow</h1>
        <p class="lede">
          Identity-aware changes, evidence-backed review, and a hard stop at
          draft pull request.
        </p>
      </header>

      <section class="flow" aria-label="Foundation workflow">
        <div><span>01</span> Intake</div>
        <div><span>02</span> Plan</div>
        <div><span>03</span> Verify</div>
        <div class="approval"><span>04</span> Approve draft PR</div>
      </section>

      <section class="status">
        <span class="dot"></span>
        Foundation cycle ready for local validation
      </section>
    </main>
  `
})
export class AppComponent {}
