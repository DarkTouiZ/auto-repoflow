# Auto-RepoFlow: ภาพรวมและ Flow การทำงาน

เอกสารนี้อธิบายระบบ Auto-RepoFlow ตั้งแต่รับ repository จนถึงการสร้างรายงาน
โดยเน้น privacy, evidence traceability และ human review เป็นหลัก

> ขอบเขตปัจจุบัน: `EvaluationRun` หยุดที่ `REPORT_READY` ส่วน `ChangeRun` v0.3
> รองรับเฉพาะ test gap บน JavaScript/TypeScript ใน isolated worktree และหยุดที่
> `VERIFIED_LOCAL_PATCH` ระบบไม่ invoke agent, push, สร้าง PR, merge, deploy หรือ
> publish

## 1. Mental model

Auto-RepoFlow คือ local-first engineering evidence auditor ที่ตอบคำถามว่า:

1. ทีมตั้งใจสร้างอะไรจาก design และ specification?
2. Repository มี implementation อะไรจริง?
3. มี test และ quality evidence รองรับหรือไม่?
4. Artifact ส่วนใดขาดหรือขัดแย้งกัน?
5. ข้อสรุปแต่ละข้ออ้างอิงจากหลักฐานใด?

```mermaid
flowchart LR
    INTENT["Team intent<br/>Design + Requirements"]
    REALITY["Repository reality<br/>Code + Configuration"]
    PROOF["Verification evidence<br/>Tests + CI"]
    ARF["Auto-RepoFlow"]
    GRAPH["Evidence graph"]
    GAPS["Gaps and contradictions"]
    HUMAN["Human review and decision"]

    INTENT --> ARF
    REALITY --> ARF
    PROOF --> ARF
    ARF --> GRAPH
    GRAPH --> GAPS
    GAPS --> HUMAN
```

## 2. System context

Auto-RepoFlow เป็น platform แยกจาก repository ที่ถูกตรวจ หนึ่ง platform จึงรับได้หลาย
repositories ผ่าน `sourcePath` และ private configuration ของแต่ละ evaluation

```mermaid
flowchart TB
    PLATFORM["Auto-RepoFlow<br/>CLI + Evaluator + API + Console"]

    REPO_A["Private pilot repository<br/>Local isolated copy"]
    REPO_B["MileMesh synthetic benchmark"]
    REPO_N["Future repositories<br/>Adapter-supported stacks"]

    PLATFORM -->|"same pipeline"| REPO_A
    PLATFORM -->|"same pipeline"| REPO_B
    PLATFORM -. "future adapters" .-> REPO_N

    REPO_A --> PRIVATE_RESULT["Private detailed result"]
    REPO_B --> BENCHMARK_RESULT["Repeatable benchmark result"]
    PRIVATE_RESULT --> PUBLIC_AGGREGATE["Approved aggregate only"]
    BENCHMARK_RESULT --> PUBLIC_AGGREGATE
```

## 3. Main components

```mermaid
flowchart LR
    subgraph Interfaces["Interfaces"]
        CLI["CLI"]
        API["Loopback NestJS API"]
        CONSOLE["Angular console"]
    end

    subgraph Core["Core evaluation"]
        SERVICE["Evaluation service"]
        PRIVACY["Privacy snapshotter"]
        QUALITY["Allowlisted quality runner"]
        EXTRACTOR["Evidence extractors"]
        ENGINE["Rules engine"]
        SCORER["Known-gap scorer"]
        EXPORTER["Public exporter"]
    end

    subgraph Storage["Local private storage"]
        CONFIGS["Private configs"]
        SNAPSHOTS["Filtered snapshots"]
        REPORTS["Reports and logs"]
        EVIDENCE["Attached evidence"]
    end

    CLI --> SERVICE
    API --> SERVICE
    CONSOLE --> API
    SERVICE --> PRIVACY
    SERVICE --> QUALITY
    SERVICE --> EXTRACTOR
    EXTRACTOR --> ENGINE
    ENGINE --> SCORER
    ENGINE --> EXPORTER
    PRIVACY --> SNAPSHOTS
    QUALITY --> REPORTS
    ENGINE --> REPORTS
    SCORER --> REPORTS
    CONFIGS --> SERVICE
    EVIDENCE --> PRIVACY
```

## 4. End-to-end EvaluationRun

ผู้ใช้เรียก pipeline หนึ่งคำสั่ง ระบบจะทำงานตามลำดับต่อไปนี้

```mermaid
flowchart TD
    START(["Start evaluation"])
    CONFIG["1. Load private config"]
    PREFLIGHT["2. Preflight paths, aliases and tools"]
    SNAPSHOT["3. Create privacy-filtered snapshot"]
    ATTACH["4. Attach explicit external evidence"]
    HASH["5. Validate SHA-256 manifest"]
    QUALITY["6. Run required quality checks"]
    QPASS{"Required checks pass?"}
    EXTRACT["7. Extract artifacts"]
    GRAPH["8. Build evidence graph"]
    RULES["9. Apply deterministic rules"]
    AI{"Local AI mode enabled?"}
    SUGGEST["10. Request local semantic suggestions"]
    VERIFY["11. Verify AI IDs and evidence"]
    REPORT["12. Write private detailed report"]
    PUBLIC{"Public export requested?"}
    SANITIZE["13. Create anonymized aggregate"]
    READY(["REPORT_READY"])
    FAILED(["QUALITY_FAILED"])

    START --> CONFIG --> PREFLIGHT --> SNAPSHOT --> ATTACH --> HASH --> QUALITY
    QUALITY --> QPASS
    QPASS -- "no" --> FAILED
    QPASS -- "yes" --> EXTRACT --> GRAPH --> RULES --> AI
    AI -- "no / rules mode" --> REPORT
    AI -- "yes" --> SUGGEST --> VERIFY --> REPORT
    REPORT --> PUBLIC
    PUBLIC -- "yes" --> SANITIZE --> READY
    PUBLIC -- "no" --> READY
```

## 5. Pipeline sequence

```mermaid
sequenceDiagram
    actor User
    participant CLI as CLI
    participant Source as Source repository
    participant Private as Private storage
    participant Quality as Quality runner
    participant Eval as Evaluator
    participant Export as Public exporter

    User->>CLI: eval pipeline --config private-config.yaml
    CLI->>CLI: Parse and preflight configuration
    CLI->>Source: Walk repository with privacy policy
    CLI->>Private: Copy allowed files and write manifest
    CLI->>Private: Attach explicitly approved evidence
    CLI->>Private: Validate every snapshot hash
    CLI->>Quality: Run local allowlisted tools

    alt required quality check fails
        Quality-->>CLI: Failure evidence
        CLI-->>User: QUALITY_FAILED
    else required quality checks pass
        Quality-->>CLI: Pass evidence
        CLI->>Eval: Extract nodes and build trace edges
        Eval->>Eval: Apply rules and produce findings
        Eval->>Private: Write private report
        Eval->>Export: Remove identifying and technical details
        Export->>Private: Write public aggregate report
        CLI-->>User: REPORT_READY
    end
```

## 6. Private configuration and preflight

Private config ระบุ repository, scope, mode, evidence และ quality gates โดยไม่ต้อง
hard-code project ใดลงใน platform

```yaml
schemaVersion: 1
sourcePath: /absolute/path/to/repository
projectName: Local-Evaluation
mode: rules
scopePrefix: /api
evidence: []
quality:
  timeoutSeconds: 300
  checks:
    - id: typecheck
      tool: tsc
      args: [--noEmit]
    - id: tests
      tool: vitest
      args: [run]
exportPublic: true
```

```mermaid
flowchart TD
    INPUT["Pipeline config"] --> ABS{"Absolute sourcePath?"}
    ABS -- "no" --> REJECT["Reject before copy"]
    ABS -- "yes" --> SCOPE{"Not filesystem root or home?"}
    SCOPE -- "no" --> REJECT
    SCOPE -- "yes" --> FILES{"Evidence paths are files?"}
    FILES -- "no" --> REJECT
    FILES -- "yes" --> ALIASES{"Safe unique aliases?"}
    ALIASES -- "no" --> REJECT
    ALIASES -- "yes" --> TOOLS{"Quality tools and args allowed?"}
    TOOLS -- "no" --> REJECT
    TOOLS -- "yes" --> ACCEPT["Begin snapshot"]
```

## 7. Privacy boundary

```mermaid
flowchart LR
    SOURCE["Source repository"] --> WALK["Privacy-aware walk"]
    WALK --> DECISION{"File decision"}
    DECISION -- "source evidence" --> COPY["Private snapshot"]
    DECISION -- ".git / dependencies / build" --> EXCLUDE["Excluded"]
    DECISION -- ".env / keys / certificates" --> EXCLUDE
    DECISION -- "logs / cache / symlink" --> EXCLUDE
    COPY --> HASH["Per-file SHA-256"]
    HASH --> MANIFEST["Immutable manifest digest"]
```

Default exclusions ได้แก่:

- `.git`
- `.env*`
- private keys และ certificates
- `node_modules`, `dist`, `build`, `coverage`
- caches, logs, worktrees, mirrors และ prior artifacts
- symbolic links

Private root ใช้ permission `0700` และ manifests/reports ใช้ `0600`
manifest เก็บ relative paths และ hashes แต่ไม่เก็บ absolute source root

```mermaid
flowchart TB
    PRIVATE["Private detailed artifacts"]
    PRIVATE --> NODES["Nodes and trace edges"]
    PRIVATE --> FINDINGS["Detailed findings"]
    PRIVATE --> PATHS["Relative evidence paths"]
    PRIVATE --> LOGS["Quality logs"]
    PRIVATE --> SANITIZE["Public sanitizer"]
    SANITIZE --> PUBLIC["Aggregate public report"]
    PUBLIC --> COUNTS["Counts and percentages"]
    PUBLIC --> ZERO["No project name, endpoints,<br/>paths, schemas or code excerpts"]
```

Git remote, AI provider และ public export เป็นสาม permissions แยกจากกัน
การอนุญาตอย่างหนึ่งไม่ถือว่าอนุญาตอีกอย่างหนึ่ง

## 8. Quality execution boundary

```mermaid
flowchart TD
    CHECK["Configured quality check"] --> ALLOW{"Tool allowlisted?"}
    ALLOW -- "no" --> BLOCK["Block"]
    ALLOW -- "yes" --> LOCAL{"Local node_modules binary?"}
    LOCAL -- "no" --> FAILURE["Record failure"]
    LOCAL -- "yes" --> SPAWN["spawn with shell:false"]
    SPAWN --> ENV["Sanitized environment"]
    ENV --> LIMITS["Timeout and output cap"]
    LIMITS --> RESULT{"Exit code 0?"}
    RESULT -- "yes" --> PASS["Pass"]
    RESULT -- "no, required" --> STOP["Stop pipeline"]
    RESULT -- "no, optional" --> RECORD["Record and continue"]
```

Allowed tools ปัจจุบันคือ `tsc`, `jest`, `vitest`, `eslint` และ `tslint`
ระบบไม่รับ arbitrary package script หรือ arbitrary executable จาก config

ข้อจำกัด: process มี sanitized environment และไม่ใช้ shell แต่ยังไม่มี OS-level
network sandbox ดังนั้น repository test code ต้องเป็น code ที่ทีมเชื่อถือได้

## 9. Evidence extraction

```mermaid
flowchart LR
    DESIGN["design-flow.yaml"] --> SCREEN["SCREEN"]
    DESIGN --> ACTION["UI_ACTION"]
    DESIGN --> STATE["UI_STATE"]
    POSTMAN["Postman collection"] --> REQUIREMENT["REQUIREMENT"]
    ROUTES["Express routes"] --> OPERATION["API_OPERATION"]
    TYPESCRIPT["TypeScript source"] --> SYMBOL["CODE_SYMBOL"]
    TESTS["Jest/Vitest files"] --> TESTCASE["TEST_CASE"]
    PLAN["test-plan.yaml"] --> PLANNED["Planned scenarios"]
    ERD["Mermaid ERD"] --> ENTITY["DATA_ENTITY"]
    PACKAGE["package.json"] --> CHECK["QUALITY_CHECK"]
    CI["CI workflow"] --> CHECK
    WORLD[".autorepoflow/*.yaml"] --> CONTRACT["WORLD_CONTRACT"]
```

แต่ละ node มี stable ID และ evidence reference เช่น relative path, line และ SHA-256
จึงสามารถตรวจย้อนกลับได้ว่าข้อสรุปมาจาก snapshot file ใด

## 10. Evidence graph

```mermaid
flowchart LR
    SCREEN["Screen"] -->|"contains"| ACTION["UI action"]
    ACTION -->|"TRIGGERS"| ROUTE["API operation"]
    SPEC["API requirement"] -->|"SERVED_BY"| ROUTE
    ROUTE -->|"IMPLEMENTED_BY"| CODE["Code symbol"]
    ROUTE -->|"REQUIRES"| PLAN["Test plan"]
    ROUTE -->|"VERIFIED_BY"| TEST["Executable test"]
    PLAN -->|"VERIFIED_BY"| TEST
    TEST -->|"executed by"| QUALITY["Quality check"]
```

Trace edge ระบุชนิดความสัมพันธ์, source, confidence, rationale และ review status
ความสัมพันธ์ exact method/path ให้ confidence สูง ส่วน inferred semantic link ต้องผ่าน
human review หาก confidence ไม่พอ

## 11. Deterministic rules and findings

```mermaid
flowchart TB
    ROUTE["Implemented route"] --> SPEC{"Matching reviewed spec?"}
    SPEC -- "no" --> API_GAP["ARF-API-001<br/>UNVERIFIED"]
    SPEC -- "yes" --> TEST{"Matching executable test?"}
    TEST -- "no" --> TEST_GAP["ARF-TEST-001<br/>UNVERIFIED"]
    TEST -- "yes" --> VERIFIED["Trace chain verified"]

    DECLARED["Approved specified operation"] --> IMPLEMENTED{"Implemented route exists?"}
    IMPLEMENTED -- "no" --> CONTRADICTION["ARF-API-002<br/>FAIL"]
    IMPLEMENTED -- "yes" --> VERIFIED
```

สถานะหลัก:

| Status | ความหมาย |
| --- | --- |
| `PASS` | มี evidence chain ที่ rule ยืนยันได้ |
| `FAIL` | พบ contradiction ที่ชัดเจน |
| `UNVERIFIED` | หลักฐานยังไม่พอยืนยัน |
| `HUMAN_REVIEW_REQUIRED` | มี candidate link หรือ draft evidence ที่คนต้องอนุมัติ |

ตัวอย่าง rules เพิ่มเติม:

- UI action ไม่เชื่อมกับ API
- response-to-screen mapping ไม่มี fields
- confirmation หรือ permission state หาย
- acceptance criteria หาย
- reviewed test scenario ไม่มี executable test
- root build/test command หาย
- static analysis evidence หาย
- CI ไม่มี API contract check

## 12. Coverage model

```mermaid
flowchart LR
    UI["UI actions"] --> SPEC["Reviewed API spec"]
    SPEC --> IMPLEMENTATION["Implemented routes"]
    IMPLEMENTATION --> PLAN["Reviewed test plan"]
    PLAN --> TESTS["Executable tests"]
    TESTS --> CI["Executed quality checks"]
```

ระบบรายงาน metrics แยกกันเพื่อไม่ให้ build success กลบ traceability gaps:

- `ui-api`: UI actions ที่เชื่อมกับ API
- `api-spec`: routes ที่มี reviewed API specification
- `api-spec-readiness`: routes ที่มี reviewed หรือ draft specification
- `implementation`: routes ที่เชื่อมกับ implementation
- `test-plan`: routes ที่มี test plan
- `test`: routes ที่มี executable tests
- `test-scenario`: current-scope reviewed scenarios ที่มี executable tests
- `test-scenario-roadmap`: full-roadmap scenarios ที่มี executable tests

## 13. Known-gap benchmark scoring

MileMesh มี synthetic answer key ที่กำหนดก่อนประเมิน เพื่อวัดความแม่นยำของ
evaluator โดยไม่ใช้ข้อมูลบริษัท

```mermaid
flowchart LR
    EXPECTED["Expected gaps<br/>G01 ... G22"]
    DETECTED["Detected findings"]
    MATCH["Exact finding identity matcher"]
    TP["True positive"]
    FP["False positive"]
    FN["False negative"]
    METRICS["Precision and recall"]

    EXPECTED --> MATCH
    DETECTED --> MATCH
    MATCH --> TP
    MATCH --> FP
    MATCH --> FN
    TP --> METRICS
    FP --> METRICS
    FN --> METRICS
```

```text
Precision = TP / (TP + FP)
Recall    = TP / (TP + FN)
```

Ledger schema v1 ใช้ rule-count matching เพื่อ backward compatibility
ledger schema v2 ใช้ exact stable `findingId` และรายงาน:

- `matchedGapIds`
- `missedGapIds`
- `unexpectedFindingIds`

ถ้าระบบพบ rule ถูกประเภทแต่ผิด subject ใน schema v2 จะเกิดทั้ง false positive
และ false negative จึงไม่สามารถได้คะแนน 100% จากการนับจำนวนแบบหลวม ๆ

## 14. AI boundary

```mermaid
flowchart TD
    EXTRACT["Deterministic extraction"] --> RULES["Deterministic rules"]
    RULES --> MODE{"Evaluation mode"}
    MODE -- "rules" --> REPORT["Deterministic report"]
    MODE -- "auto/local" --> PROVIDER["Loopback-only Ollama"]
    MODE -- "cloud + policy + consent" --> CLOUD["Official OpenAI / Anthropic / Google HTTPS"]
    PROVIDER --> SCHEMA["Validate response schema"]
    SCHEMA --> IDS["Reject invented node/evidence IDs"]
    IDS --> CONFIDENCE{"Confidence sufficient?"}
    CONFIDENCE -- "yes" --> LINK["Verified suggestion"]
    CONFIDENCE -- "no" --> REVIEW["Human review required"]
    LINK --> REPORT
    REVIEW --> REPORT
```

Rules mode ใช้สำหรับ reproducible benchmark และไม่ต้องเรียก generative AI
Local-AI mode ใช้เสนอ semantic links เมื่อ artifact ตั้งชื่อไม่เหมือนกัน แต่ AI:

- เปลี่ยน deterministic failure เป็น pass ไม่ได้
- อ้าง node หรือ evidence ที่ไม่มีจริงไม่ได้
- merge หรือ deploy ไม่ได้
- ต้องผ่าน verification และ human review ตาม confidence

## 15. World Contracts and project identity

```mermaid
flowchart TB
    WORLD["World Contract"]
    WORLD --> IDENTITY["Project identity and vocabulary"]
    WORLD --> QUALITY["Quality expectations"]
    WORLD --> RISK["Risk policy"]
    WORLD --> FLOW["Allowed workflow"]
    IDENTITY --> EVALUATOR["Evaluator context"]
    QUALITY --> EVALUATOR
    RISK --> EVALUATOR
    FLOW --> EVALUATOR
```

`.autorepoflow/` ทำหน้าที่เป็น project constitution เพื่อรักษา flow, policy และ
identity ของ repository ไม่ให้ automation มอง project เป็นเพียงกอง source files

POC ปัจจุบัน validate และ extract World Contracts เป็น evidence แล้ว การนำ contract
ไปบังคับใช้กับทุกขั้นของ ChangeRun ยังเป็นงานพัฒนาถัดไป

## 16. Authority and terminal states

### EvaluationRun — implemented

```mermaid
stateDiagram-v2
    [*] --> CONFIGURED
    CONFIGURED --> SNAPSHOTTED
    SNAPSHOTTED --> VALIDATED
    VALIDATED --> QUALITY_CHECKED
    QUALITY_CHECKED --> EVALUATED
    EVALUATED --> REPORT_READY
    REPORT_READY --> [*]
```

### ChangeRun v0.3 — implemented local test-patch workflow

```mermaid
stateDiagram-v2
    [*] --> INTAKE
    INTAKE --> WORKTREE_READY
    WORKTREE_READY --> AWAITING_AGENT
    AWAITING_AGENT --> VERIFYING
    VERIFYING --> REPAIR_REQUIRED
    REPAIR_REQUIRED --> VERIFYING
    VERIFYING --> REVIEW_REQUIRED
    VERIFYING --> VERIFIED_LOCAL_PATCH
    VERIFIED_LOCAL_PATCH --> [*]

    note right of VERIFIED_LOCAL_PATCH
        Maximum authority in v0.3
        No push or pull request
        No merge, deploy, or publish
    end note
```

ChangeRun v0.3 รองรับเฉพาะ `ARF-TEST-001` และไฟล์ทดสอบ JavaScript/TypeScript
ใน isolated worktree ผู้ใช้เป็นผู้เปิด IDE agent เอง ส่วน AutoRepoFlow ทำหน้าที่
ตรวจ test-only patch, รัน exact checks ที่ policy อนุญาต, rescan และหยุดที่
`VERIFIED_LOCAL_PATCH` เท่านั้น

## 17. MileMesh Cycle 2 example

```mermaid
sequenceDiagram
    actor User
    participant ARF as Auto-RepoFlow
    participant MM as MileMesh
    participant Store as Private storage
    participant Ledger as Synthetic ledger v2

    User->>ARF: Run Cycle 2 pipeline
    ARF->>MM: Privacy-filtered snapshot
    ARF->>Store: Validate 37/37 hashes
    ARF->>MM: Run TypeScript and Vitest gates
    ARF->>Store: Build report with 22 findings
    User->>ARF: Score evaluation
    ARF->>Ledger: Read expected G01-G22
    ARF->>Store: Read detected finding identities
    ARF-->>User: TP 22, FP 0, FN 0
```

ผลที่ยืนยันแล้วบน synthetic benchmark:

| Metric | Result |
| --- | ---: |
| Included snapshot files | 37 |
| Manifest validation | 37/37 |
| Required quality gates | Passed |
| Implementation linkage | 11/11 — 100% |
| Reviewed API-spec coverage | 9/11 — 81.8% |
| Executable-test linkage | 1/11 — 9.1% |
| UI-to-API linkage | 10/10 — 100% |
| Exact known gaps | 22/22 |
| False positives | 0 |
| False negatives | 0 |
| Exact-match precision | 100% |
| Exact-match recall | 100% |

ตัวเลขนี้เป็นผลของ MileMesh synthetic benchmark ไม่ใช่ข้ออ้างว่า framework และ
repository ทุกชนิดจะได้ 100% เหมือนกัน

## 18. Current capabilities and limits

### ใช้งานได้แล้ว

- config-driven local evaluation
- privacy-filtered snapshot และ SHA-256 manifest
- explicit evidence attachment
- manifest tamper validation
- allowlisted TypeScript/Jest/Vitest quality execution
- design-flow, Postman, Express, TypeScript, test, CI, ERD และ World extraction
- deterministic findings และ coverage
- exact known-gap scoring schema v2
- private detailed report และ anonymized public report
- loopback-only Ollama และ explicit metadata-only cloud provider boundary

### ข้อจำกัดปัจจุบัน

- static PNG/Figma ต้องผ่าน human-reviewed design-flow mapping
- extractor เน้น TypeScript/Express; framework อื่นต้องมี adapters
- route registration ยังไม่พิสูจน์ controller-service-repository chain ทั้งหมด
- field-level request/response/schema tracing ยังไม่ลึกพอ
- quality runner ยังไม่มี OS-level network sandbox
- local AI quality/latency ต้องประเมินเมื่อใช้ model จริง
- ChangeRun และ draft-PR workflow ยังไม่ครบเท่า EvaluationRun
- private-pilot time saving ต้องวัดกับผู้ใช้จริงก่อนรายงานเป็นเปอร์เซ็นต์

## 19. Safe demo flow

```mermaid
flowchart LR
    PAIN["Explain review pain"] --> SYNTHETIC["Show synthetic MileMesh"]
    SYNTHETIC --> RUN["Run one-command pipeline"]
    RUN --> COVERAGE["Explain coverage vs quality"]
    COVERAGE --> FINDINGS["Show evidence-backed findings"]
    FINDINGS --> SCORE["Show exact precision/recall"]
    SCORE --> PRIVACY["Show anonymized public report"]
    PRIVACY --> FEEDBACK["Collect team feedback"]
```

สำหรับการบันทึกภาพหรือ poster ให้ใช้ MileMesh และ public aggregate report เท่านั้น
อย่าเปิด private backend, private detailed report หรือ absolute user paths ในภาพ

## 20. One-sentence summary

> Auto-RepoFlow เชื่อมความตั้งใจจาก design และ specification กับสิ่งที่มีจริงใน
> repository แล้วแสดงช่องว่างพร้อมหลักฐาน เพื่อให้ทีม review ได้เร็ว เป็นระบบ และ
> ปลอดภัยขึ้น โดยการตัดสินใจสุดท้ายยังเป็นของมนุษย์
