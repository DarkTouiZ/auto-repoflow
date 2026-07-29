#!/usr/bin/env node

const [command = "help"] = process.argv.slice(2);

if (command === "help" || command === "--help") {
  console.log(`Auto-RepoFlow 0.1.0

Foundation commands:
  doctor   Run local environment diagnostics with: npm run doctor
  help     Show this help

Workflow commands will be added after the foundation review.`);
} else if (command === "doctor") {
  console.log("Run `npm run doctor` from the repository root.");
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
