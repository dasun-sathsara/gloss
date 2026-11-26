import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // The suite shares one Gloss server and SQLite database.
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8777",
    browserName: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL || "chromium",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "uv run gloss --demo --no-browser --port 8777 --frontend frontend/dist",
    cwd: "..",
    url: "http://127.0.0.1:8777/api/health",
    reuseExistingServer: false,
    env: {
      GLOSS_CONFIG_DIR:
        process.env.GLOSS_E2E_CONFIG ||
        `${process.env.TMPDIR || process.env.TEMP || "/tmp"}/gloss-e2e-${Date.now()}`,
    },
  },
});
