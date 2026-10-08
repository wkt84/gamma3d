import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// COOP/COEP を付けて crossOriginIsolated にし、Worker 間で SharedArrayBuffer を使えるようにする。
// 本番 (Vercel) では vercel.json で同じヘッダーを付与する。
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** public/ 以下のファイル (配信時のパス) */
function publicFiles(dir = 'public', prefix = ''): string[] {
  return readdirSync(dir).flatMap((f) => {
    const path = `${dir}/${f}`;
    return statSync(path).isDirectory() ? publicFiles(path, `${prefix}${f}/`) : [`${prefix}${f}`];
  });
}

/**
 * オフライン対応 (PWA): src/sw/sw.ts を sw.js としてビルドし、配信するファイルの一覧と版 (内容のハッシュ) を埋め込む。
 * 一覧はビルド結果 (アプリ本体・Worker・WASM) と public/ (フォント・アイコン・マニフェスト) から作る。
 */
function precachePlugin(): Plugin {
  return {
    name: 'gamma3d-precache',
    apply: 'build',
    config: () => ({
      build: {
        rollupOptions: {
          input: { main: 'index.html', sw: 'src/sw/sw.ts' },
          output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js') },
        },
      },
    }),
    // index.html は Vite の HTML プラグインが generateBundle で出力するので、その後に動かす
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const sw = bundle['sw.js'];
        if (!sw || sw.type !== 'chunk') throw new Error('precache: sw.js was not built');
        const hash = createHash('sha256');
        const built = Object.keys(bundle)
          .filter((f) => f !== 'sw.js' && !f.endsWith('.map'))
          .sort();
        for (const f of built) {
          const out = bundle[f];
          hash.update(f).update(out.type === 'chunk' ? out.code : out.source);
        }
        const pub = publicFiles()
          .filter((f) => !f.endsWith('.txt'))
          .sort();
        for (const f of pub) hash.update(f).update(readFileSync(`public/${f}`));
        const manifest = { version: `${pkg.version}-${hash.digest('hex').slice(0, 12)}`, files: [...built, ...pub] };
        if (!sw.code.includes('__PRECACHE__')) throw new Error('precache: placeholder not found in sw.js');
        sw.code = sw.code.replaceAll('__PRECACHE__', JSON.stringify(manifest));
      },
    },
  };
}

export default defineConfig({
  plugins: [precachePlugin()],
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
