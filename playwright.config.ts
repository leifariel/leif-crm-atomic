import { defineConfig, devices } from "@playwright/test";

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, ".env.e2e") });

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./e2e",
  /* Run tests in files in parallel */
  fullyParallel: false,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* No parallel tests on CI as we depends on the same db. */
  workers: 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: "list",
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL for `page.goto('/')`. Overridable so an isolated e2e-smoke run can
       point the specs at its own per-slot app port (audit D7). Default matches the
       makefile's `start-app-e2e` port. */
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:5175",

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
    actionTimeout: 5000,
  },

  /* Configure projects for major browsers */
  //
  // A submitted Application is PERMANENT by design: materialize_native_
  // application_responses() writes application_responses in the same
  // transaction, and that table refuses DELETE even by cascade. So a spec that
  // submits a real public application leaves rows resetDb cannot clear, and
  // every spec after it fails with "application_responses is an immutable
  // submission record".
  //
  // Those specs therefore live in their own project which runs LAST (projects
  // run in declaration order, and workers: 1 keeps that honest), and the two
  // ordinary projects ignore them. They stay part of `npx playwright test`, so
  // this is isolation rather than an exemption.
  projects: [
    {
      name: "chromium",
      testIgnore: /.*\.submission\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.CI && { channel: "chromium-headless-shell" }),
      },
    },

    /* Test against mobile viewports. */
    {
      name: "Mobile Chrome",
      testIgnore: /.*\.submission\.spec\.ts/,
      use: {
        ...devices["Pixel 5"],
        ...(process.env.CI && { channel: "chromium-headless-shell" }),
      },
    },

    // Last, and deliberately so — see the note above.
    {
      name: "submission",
      testMatch: /.*\.submission\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        ...(process.env.CI && { channel: "chromium-headless-shell" }),
      },
    },
    // Uncomment to test against additional devices

    /* Test against desktop browsers. */
    // {
    //   name: "chromium",
    //   use: { ...devices["Desktop Chrome"] },
    // },

    /* Test against additional mobile browsers. */
    // {
    //   name: "firefox",
    //   use: { ...devices["Desktop Firefox"] },
    // },
    // {
    //   name: "Mobile Safari",
    //   use: { ...devices["iPhone 12"] },
    // },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],
});
