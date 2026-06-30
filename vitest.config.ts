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
    },
  },
});
