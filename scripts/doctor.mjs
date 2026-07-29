import { spawnSync } from "node:child_process";

const checks = [
  {
    name: "Node.js 22+",
    required: true,
    run: () => {
      const major = Number(process.versions.node.split(".")[0]);
      return { ok: major >= 22, detail: process.version };
    }
  },
  {
    name: "Git",
    required: true,
    command: ["git", "--version"]
  },
  {
    name: "Docker daemon",
    required: false,
    command: ["docker", "info", "--format", "{{.ServerVersion}}"]
  },
  {
    name: "Docker Compose",
    required: false,
    command: ["docker", "compose", "version", "--short"]
  },
  {
    name: "Ollama daemon",
    required: false,
    command: ["ollama", "list"]
  },
  {
    name: "GitHub CLI authentication",
    required: false,
    command: ["gh", "auth", "status"]
  }
];

let failedRequired = false;

for (const check of checks) {
  let result;
  if (check.run) {
    result = check.run();
  } else {
    const [command, ...args] = check.command;
    const execution = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 5000
    });
    const detail = (execution.stdout || execution.stderr || "").trim().split("\n")[0];
    result = { ok: execution.status === 0, detail: detail || "unavailable" };
  }

  const level = result.ok ? "PASS" : check.required ? "FAIL" : "WARN";
  console.log(`${level.padEnd(4)} ${check.name}: ${result.detail}`);
  failedRequired ||= check.required && !result.ok;
}

if (failedRequired) {
  process.exitCode = 1;
} else {
  console.log("Doctor completed. WARN items block only the workflow stage that needs them.");
}
