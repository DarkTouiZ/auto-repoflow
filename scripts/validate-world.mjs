import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const requiredFiles = [
  ".autorepoflow/world.yaml",
  ".autorepoflow/quality.yaml",
  ".autorepoflow/risk.yaml",
  ".autorepoflow/flows/change-run.yaml",
  ".autorepoflow/flows/evaluation-run.yaml"
];

for (const file of requiredFiles) {
  const document = parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  if (!document?.schema_version || !document?.world_version) {
    throw new Error(`${file} must declare schema_version and world_version`);
  }
  console.log(`PASS ${file} (${document.world_version})`);
}
