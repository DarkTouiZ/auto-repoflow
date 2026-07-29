import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@auto-repoflow/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url)
      ),
      "@auto-repoflow/domain": fileURLToPath(
        new URL("./packages/domain/src/index.ts", import.meta.url)
      ),
      "@auto-repoflow/evaluator": fileURLToPath(
        new URL("./packages/evaluator/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"]
  }
});
