import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// COOP/COEP を付けて crossOriginIsolated にし、Worker 間で SharedArrayBuffer を使えるようにする。
// 本番 (Vercel) では vercel.json で同じヘッダーを付与する。
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
