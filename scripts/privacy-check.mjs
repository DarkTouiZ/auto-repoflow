import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const tracked = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  {
  encoding: "utf8",
  timeout: 5000
  }
);
if (tracked.status !== 0) {
  throw new Error("Unable to inspect tracked files");
}

const prohibited = tracked.stdout
  .split("\n")
  .filter(Boolean)
  .filter(
    (path) =>
      (/(?:^|\/)\.env(?:\.|$)/i.test(path) &&
        !/(?:^|\/)\.env\.example$/i.test(path)) ||
      /\.(?:pem|key|p12|pfx|jks)$/i.test(path) ||
      /(?:^|\/)\.autorepoflow-private(?:\/|$)/.test(path)
  );
if (prohibited.length > 0) {
  throw new Error(`Privacy-prohibited tracked files: ${prohibited.join(", ")}`);
}

const candidatePaths = tracked.stdout.split("\n").filter(Boolean);
const absolutePathLeaks = [];
for (const path of candidatePaths) {
  try {
    const contents = await readFile(path, "utf8");
    if (
      /\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\/i.test(
        contents
      )
    ) {
      absolutePathLeaks.push(path);
    }
  } catch {
    // Binary and concurrently removed files are ignored by the text scan.
  }
}
if (absolutePathLeaks.length > 0) {
  throw new Error(
    `User-specific absolute paths found in: ${absolutePathLeaks.join(", ")}`
  );
}

const privateRoot = join(
  process.env.HOME ?? "",
  ".autorepoflow-private"
);
try {
  const details = await stat(privateRoot);
  const mode = details.mode & 0o777;
  if (mode !== 0o700) {
    throw new Error(
      `Private artifact root must use mode 0700, found ${mode.toString(8)}`
    );
  }
  console.log("PASS private artifact root mode 0700");
} catch (error) {
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    error.code === "ENOENT"
  ) {
    console.log("PASS private artifact root will be created as mode 0700");
  } else {
    throw error;
  }
}

console.log("PASS no tracked environment, key, certificate, or private artifact files");
console.log("PASS no user-specific absolute paths in repository text");
