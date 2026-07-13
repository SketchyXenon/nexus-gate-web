import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    // Co-locate tests next to source files as *.test.ts, or under __tests__/
    include: ["src/**/*.test.ts", "src/**/__tests__/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // server-only is a Next.js bundler marker; in vitest (raw node) it
      // throws. Alias to an empty module so tests can import server modules.
      "server-only": path.resolve(__dirname, "./.vitest-empty.js"),
    },
  },
});
