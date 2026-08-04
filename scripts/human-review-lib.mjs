import { resolve } from "node:path";

export const HUMAN_REVIEW_COLUMNS = [
  "session_id",
  "comparison_id",
  "review_mode",
  "target_label",
  "target_revision",
  "reviewer_id",
  "finding_id",
  "rule_id",
  "decision",
  "reclassified_as",
  "review_started_at",
  "proposal_ready_at",
  "elapsed_seconds",
  "notes"
];

export const HUMAN_REVIEW_USAGE = [
  "Usage:",
  "  npm run review:summarize -- <worksheet.csv> --label <public-label>",
  "",
  "The completed worksheet stays local. Standard output contains aggregate",
  "decision and timing metrics without reviewer, session, finding, target,",
  "timestamp, or notes data."
].join("\n");

const supportedFlags = new Set(["label"]);
const allowedModes = ["manual", "rules", "local-ai"];
const allowedDecisions = ["accept", "reject", "reclassify"];
const safeLabel = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const anonymousId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const gitRevision = /^[0-9a-f]{7,64}$/;

export function parseHumanReviewArgs(values, { cwd = process.cwd() } = {}) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    const name = value.slice(2, equals > 2 ? equals : undefined);
    if (!supportedFlags.has(name)) {
      throw new Error("Unknown human-review option: --" + name);
    }
    const next = equals > 2 ? value.slice(equals + 1) : values[index + 1];
    if (!next || (equals < 0 && next.startsWith("--"))) {
      throw new Error("Missing value for --" + name);
    }
    flags.set(name, next);
    if (equals < 0) index += 1;
  }
  if (positionals.length !== 1) {
    throw new Error("Human-review summary requires exactly one worksheet path");
  }
  const label = flags.get("label");
  if (!label || !safeLabel.test(label)) {
    throw new Error(
      "--label must be 1-80 characters using letters, numbers, dot, underscore, or hyphen"
    );
  }
  return { inputPath: resolve(cwd, positionals[0]), label };
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      if (field.length > 0) throw new Error("Invalid quote in CSV field");
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character === "\r") {
      if (text[index + 1] !== "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Unterminated quoted CSV field");
  if (field.length > 0 || row.length > 0 || text.endsWith(",")) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(
    (candidate) =>
      !(candidate.length === 1 && candidate[0].trim().length === 0)
  );
}

function rowError(rowNumber, message) {
  throw new Error("Worksheet row " + rowNumber + ": " + message);
}

function requireValue(record, column, rowNumber) {
  const value = record[column]?.trim();
  if (!value) rowError(rowNumber, column + " is required");
  return value;
}

function parseTimestamp(value, column, rowNumber) {
  const timestamp = Date.parse(value);
  if (!value.includes("T") || !Number.isFinite(timestamp)) {
    rowError(rowNumber, column + " must be an ISO-8601 timestamp");
  }
  return timestamp;
}

function round(value) {
  return Number(value.toFixed(1));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentage(value, total) {
  return total === 0 ? 0 : round((value / total) * 100);
}

function decisionSummary(rows) {
  const counts = { accept: 0, reject: 0, reclassify: 0 };
  for (const row of rows) counts[row.decision] += 1;
  return {
    findingsReviewed: rows.length,
    decisions: counts,
    ratesPercent: {
      acceptance: percentage(counts.accept, rows.length),
      rejection: percentage(counts.reject, rows.length),
      reclassification: percentage(counts.reclassify, rows.length)
    }
  };
}

function timingSummary(sessions) {
  const values = sessions.map((session) => session.elapsedSeconds);
  return {
    sessions: values.length,
    min: Math.min(...values),
    median: round(median(values)),
    max: Math.max(...values)
  };
}

function buildModeSummary(mode, sessions) {
  const rows = sessions.flatMap((session) => session.rows);
  return {
    mode,
    sessions: sessions.length,
    reviewers: new Set(sessions.map((session) => session.reviewerId)).size,
    targets: new Set(
      sessions.map(
        (session) => session.targetLabel + "\u0000" + session.targetRevision
      )
    ).size,
    ...decisionSummary(rows),
    timeToProposalSeconds: timingSummary(sessions)
  };
}

function parseWorksheet(text) {
  const parsedRows = parseCsv(text);
  if (parsedRows.length === 0) throw new Error("Worksheet is empty");
  const header = [...parsedRows[0]];
  header[0] = header[0].replace(/^\uFEFF/, "");
  if (JSON.stringify(header) !== JSON.stringify(HUMAN_REVIEW_COLUMNS)) {
    throw new Error(
      "Worksheet header must exactly match the published human-review template"
    );
  }
  if (parsedRows.length === 1) {
    throw new Error("Worksheet must contain at least one completed review row");
  }

  const sessions = new Map();
  for (let index = 1; index < parsedRows.length; index += 1) {
    const rowNumber = index + 1;
    const values = parsedRows[index];
    if (values.length !== HUMAN_REVIEW_COLUMNS.length) {
      rowError(rowNumber, "column count does not match the template");
    }
    const record = Object.fromEntries(
      HUMAN_REVIEW_COLUMNS.map((column, columnIndex) => [
        column,
        values[columnIndex]
      ])
    );
    const sessionId = requireValue(record, "session_id", rowNumber);
    const comparisonId = requireValue(record, "comparison_id", rowNumber);
    const mode = requireValue(record, "review_mode", rowNumber);
    const targetLabel = requireValue(record, "target_label", rowNumber);
    const targetRevision = requireValue(record, "target_revision", rowNumber);
    const reviewerId = requireValue(record, "reviewer_id", rowNumber);
    const findingId = requireValue(record, "finding_id", rowNumber);
    const ruleId = requireValue(record, "rule_id", rowNumber);
    const decision = requireValue(record, "decision", rowNumber);
    const reclassifiedAs = record.reclassified_as.trim();
    const startedAt = requireValue(record, "review_started_at", rowNumber);
    const readyAt = requireValue(record, "proposal_ready_at", rowNumber);
    const elapsedText = requireValue(record, "elapsed_seconds", rowNumber);

    if (!anonymousId.test(sessionId)) {
      rowError(rowNumber, "session_id must be an anonymous token");
    }
    if (!anonymousId.test(comparisonId)) {
      rowError(rowNumber, "comparison_id must be an anonymous token");
    }
    if (!allowedModes.includes(mode)) {
      rowError(rowNumber, "review_mode must be manual, rules, or local-ai");
    }
    if (!safeLabel.test(targetLabel)) {
      rowError(rowNumber, "target_label must be public or anonymized");
    }
    if (!gitRevision.test(targetRevision)) {
      rowError(rowNumber, "target_revision must be a 7-64 character Git SHA");
    }
    if (!anonymousId.test(reviewerId) || reviewerId.includes("@")) {
      rowError(rowNumber, "reviewer_id must be anonymous and must not be an email");
    }
    if (!allowedDecisions.includes(decision)) {
      rowError(rowNumber, "decision must be accept, reject, or reclassify");
    }
    if (decision === "reclassify" && !reclassifiedAs) {
      rowError(rowNumber, "reclassified_as is required for reclassify");
    }
    if (decision !== "reclassify" && reclassifiedAs) {
      rowError(rowNumber, "reclassified_as must be empty unless reclassifying");
    }

    const startedMs = parseTimestamp(startedAt, "review_started_at", rowNumber);
    const readyMs = parseTimestamp(readyAt, "proposal_ready_at", rowNumber);
    const elapsedSeconds = Number(elapsedText);
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
      rowError(rowNumber, "elapsed_seconds must be a positive number");
    }
    const measuredSeconds = (readyMs - startedMs) / 1000;
    if (measuredSeconds <= 0 || Math.abs(measuredSeconds - elapsedSeconds) > 1) {
      rowError(
        rowNumber,
        "elapsed_seconds must match the start and proposal timestamps"
      );
    }

    const normalized = {
      rowNumber,
      sessionId,
      comparisonId,
      mode,
      targetLabel,
      targetRevision,
      reviewerId,
      findingId,
      ruleId,
      decision,
      reclassifiedAs,
      startedAt,
      readyAt,
      elapsedSeconds
    };
    const existing = sessions.get(sessionId);
    if (!existing) {
      sessions.set(sessionId, {
        ...normalized,
        rows: [normalized],
        findingIds: new Set([findingId])
      });
      continue;
    }
    for (const key of [
      "comparisonId",
      "mode",
      "targetLabel",
      "targetRevision",
      "reviewerId",
      "startedAt",
      "readyAt",
      "elapsedSeconds"
    ]) {
      if (existing[key] !== normalized[key]) {
        rowError(rowNumber, key + " must be consistent within a session");
      }
    }
    if (existing.findingIds.has(findingId)) {
      rowError(rowNumber, "finding_id is duplicated within the session");
    }
    existing.findingIds.add(findingId);
    existing.rows.push(normalized);
  }
  return [...sessions.values()];
}

export function summarizeHumanReview(
  text,
  { label, generatedAt = new Date().toISOString() }
) {
  if (!label || !safeLabel.test(label)) {
    throw new Error("Summary label must be public or anonymized");
  }
  const sessions = parseWorksheet(text);
  const comparisons = new Map();
  for (const session of sessions) {
    let comparison = comparisons.get(session.comparisonId);
    if (!comparison) {
      comparison = {
        targetLabel: session.targetLabel,
        targetRevision: session.targetRevision,
        modes: new Map()
      };
      comparisons.set(session.comparisonId, comparison);
    }
    if (
      comparison.targetLabel !== session.targetLabel ||
      comparison.targetRevision !== session.targetRevision
    ) {
      rowError(
        session.rowNumber,
        "comparison_id must refer to one pinned target"
      );
    }
    if (comparison.modes.has(session.mode)) {
      rowError(
        session.rowNumber,
        "comparison_id can contain only one session per review mode"
      );
    }
    comparison.modes.set(session.mode, session);
  }

  const comparisonSummary = [];
  for (const assistedMode of ["rules", "local-ai"]) {
    const pairs = [...comparisons.values()].filter(
      (comparison) =>
        comparison.modes.has("manual") &&
        comparison.modes.has(assistedMode)
    );
    if (pairs.length === 0) continue;
    const secondsSaved = pairs.map((comparison) => {
      const manual = comparison.modes.get("manual").elapsedSeconds;
      const assisted = comparison.modes.get(assistedMode).elapsedSeconds;
      return manual - assisted;
    });
    const reductions = pairs.map((comparison) => {
      const manual = comparison.modes.get("manual").elapsedSeconds;
      const assisted = comparison.modes.get(assistedMode).elapsedSeconds;
      return ((manual - assisted) / manual) * 100;
    });
    comparisonSummary.push({
      baselineMode: "manual",
      assistedMode,
      pairedTargets: pairs.length,
      fasterPairs: secondsSaved.filter((value) => value > 0).length,
      medianSecondsSaved: round(median(secondsSaved)),
      medianTimeReductionPercent: round(median(reductions))
    });
  }

  const allRows = sessions.flatMap((session) => session.rows);
  return {
    schemaVersion: 1,
    kind: "auto-repoflow-human-review-summary",
    generatedAt,
    study: { label },
    protocol: {
      reviewModes: allowedModes,
      decisionUnit: "one reviewed finding",
      timingUnit: "one deduplicated review session",
      comparisonDesign: "paired-by-comparison-id-and-pinned-target"
    },
    overall: {
      sessions: sessions.length,
      reviewers: new Set(sessions.map((session) => session.reviewerId)).size,
      targets: new Set(
        sessions.map(
          (session) => session.targetLabel + "\u0000" + session.targetRevision
        )
      ).size,
      ...decisionSummary(allRows),
      timeToProposalSeconds: timingSummary(sessions)
    },
    modes: allowedModes
      .map((mode) => ({
        mode,
        sessions: sessions.filter((session) => session.mode === mode)
      }))
      .filter((entry) => entry.sessions.length > 0)
      .map((entry) => buildModeSummary(entry.mode, entry.sessions)),
    comparisons: comparisonSummary,
    privacy: {
      sourceWorksheetStored: false,
      reviewerIdsStored: false,
      sessionIdsStored: false,
      comparisonIdsStored: false,
      findingIdsStored: false,
      ruleIdsStored: false,
      targetLabelsStored: false,
      targetRevisionsStored: false,
      timestampsStored: false,
      notesStored: false
    }
  };
}
