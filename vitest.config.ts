import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests run against sources, so packages don't need to be built first.
  resolve: {
    alias: [
      { find: /^@codesignflo\/core\/protocol$/, replacement: fileURLToPath(new URL("packages/core/src/protocol.ts", import.meta.url)) },
      { find: /^@codesignflo\/core$/, replacement: fileURLToPath(new URL("packages/core/src/index.ts", import.meta.url)) },
    ],
  },
  test: { include: ["packages/*/src/**/*.test.ts"] },
});
