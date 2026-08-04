#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import {
  HUMAN_REVIEW_USAGE,
  parseHumanReviewArgs,
  summarizeHumanReview
} from "./human-review-lib.mjs";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HUMAN_REVIEW_USAGE);
    return;
  }
  const input = parseHumanReviewArgs(args);
  let worksheet;
  try {
    worksheet = await readFile(input.inputPath, "utf8");
  } catch {
    throw new Error("Unable to read human-review worksheet");
  }
  const result = summarizeHumanReview(worksheet, { label: input.label });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
