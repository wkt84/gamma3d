import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

// E2E: 合成サンプルを生成し、本番ビルドを vite preview (COOP/COEP 付き) で配信して操作する
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1600, height: 1000 },
    // 画面の言語はブラウザの言語設定で決まる。既存のテストは日本語の画面で確かめる
    locale: 'ja-JP',
    // Service Worker (オフライン対応) は、それを確かめるテストでだけ有効にする
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 }, locale: 'ja-JP' } }],
  webServer: {
    command: `npm run gen:samples && npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
