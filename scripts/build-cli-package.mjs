import { chmod, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "..");
const entryPoint = resolve(repositoryRoot, "apps/cli/src/main.ts");
const outputFile = resolve(repositoryRoot, "apps/cli/dist/main.js");

await build({
  entryPoints: [entryPoint],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  external: ["yaml", "zod"],
  sourcemap: true,
  legalComments: "none"
});

await chmod(outputFile, 0o755);

for (const name of await readdir(resolve(repositoryRoot, "apps/cli/dist"))) {
  if (name.includes(".spec.")) {
    await rm(resolve(repositoryRoot, "apps/cli/dist", name), { force: true });
  }
}
