import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scenario regressions use node:test and run separately via test:scenario.
    exclude: [...configDefaults.exclude, "tests/*.test.mjs"],
  },
});
