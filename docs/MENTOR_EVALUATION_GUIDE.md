# Mentor evaluation guide

## Goal

Collect reviewer-acceptance and time-to-proposal evidence for the SuperAI
Engineer SS6 poster without publishing company data, reviewer identities, raw
findings, or completed worksheets.

This is a small pilot, not a general accuracy study. Keep synthetic accuracy
claims separate from human-review outcomes.

## Optional usability rehearsal

Before the formal review, two users may run the private terminal recorder to
test whether the command, task, and handoff output are understandable:

```bash
auto-repoflow pilot validate --study <study-id>
auto-repoflow pilot run --study <study-id> --session <session-id>
auto-repoflow pilot summary --study <study-id>
```

This rehearsal records task completion, clarity, handoff readiness, one-line
proposal text, and time automatically. Raw records remain private and the
aggregate removes identities, paths, timestamps, finding tokens, proposals,
and comments. The resulting summary is usability evidence only. It must not be
reported as finding acceptance, engineering accuracy, precision, or recall.

The formal protocol below remains necessary for reviewed acceptance,
reclassification, and poster claims.

## Recommended design

Use at least two reviewers and two approved public targets. Counterbalance the
order to reduce learning bias:

| Comparison block | Reviewer A | Reviewer B |
| --- | --- | --- |
| Public target 1 | Manual | Rules-assisted |
| Public target 2 | Rules-assisted | Manual |

Give the manual and assisted sessions for the same pinned target the same
anonymous `comparison_id`. Give every session a unique anonymous `session_id`.
If only one reviewer is available, label the result exploratory and
single-reviewer.

The optional `local-ai` mode is available in v0.2, but it must be evaluated as
a separate comparison block with an explicit installed model. Deterministic
evidence verification remains enabled, and AI-only edges always require human
review.

## Session protocol

1. Use only MileMesh or another explicitly approved public repository at a
   pinned Git commit.
2. Define the same operation scope and stopping condition for both modes.
3. Start timing at artifact intake.
4. Stop when the reviewer has a prioritized finding or clarification list that
   is ready to become a fix proposal.
5. Do not count environment installation or dependency download time.
6. Record one row per reviewed finding in a local copy of
   `evidence/benchmarks/2026-08-04/human-review-template.csv`.
7. Use anonymous tokens for reviewer, session, and comparison IDs. Never use a
   name or email address.
8. Have a second person confirm the decisions before publishing aggregates.

Allowed `review_mode` values are `manual`, `rules`, and `local-ai`.
Allowed `decision` values are `accept`, `reject`, and `reclassify`.
`reclassified_as` is required only for a reclassified finding.

All rows in one session repeat the same timestamps and elapsed seconds. The
summarizer deduplicates timing by session so a session with many findings does
not receive extra weight.

## Produce the aggregate

Keep the completed CSV outside the repository, then run:

```bash
npm run review:summarize -- /path/outside/repository/review.csv \
  --label mentor-pilot-1 > human-review-summary.json
```

The command validates:

- exact template columns;
- anonymous identifiers and a pinned Git SHA;
- allowed modes and decisions;
- consistent session metadata;
- duplicate finding decisions;
- timestamp order and elapsed-time agreement;
- one session per mode in each comparison block.

The JSON output includes aggregate decision rates, timing by mode, and paired
time reduction when a comparison block has both manual and assisted sessions.
It omits reviewer IDs, session IDs, comparison IDs, finding IDs, rule IDs,
target labels, revisions, timestamps, notes, and the worksheet path.

## Public release gate

- Inspect the generated JSON before committing it.
- Run `npm run privacy:check`.
- Search for company names, email addresses, and absolute paths.
- State the reviewer count and whether the study is exploratory.
- Do not claim time reduction when no paired comparison is present.
- Do not commit the completed CSV; the repository ignores filenames beginning
  with `human-review-completed` or `human-review-private`.
- Obtain second-person approval before using the aggregate in the poster.
