import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
    headless: true,
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL || 'msedge' },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], channel: process.env.PW_CHANNEL || 'msedge' },
    },
  ],
  webServer: {
    command: 'pnpm preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 10000,
  },
});
