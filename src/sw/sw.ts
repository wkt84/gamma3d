/**
 * オフライン対応の Service Worker。
 * ビルド時に、配信するファイルの一覧 (アプリ本体・Worker・WASM・フォントなど) が __PRECACHE__ に埋め込まれる
 * (vite.config.ts の precachePlugin)。インストール時にすべてキャッシュし、以後はキャッシュから返す。
 *
 * - 共有メモリ (SharedArrayBuffer) には COOP/COEP ヘッダーが必要なので、キャッシュする応答はサーバーの
 *   ヘッダーごと保存し、そのまま返す。
 * - 新しい版は、ブラウザが sw.js の変化を検知してインストールし、待機状態になる。画面側で「更新」が
 *   押されたら (SKIP_WAITING) 切り替える。解析中の画面を勝手に再読み込みしないため。
 */

/// <reference lib="webworker" />

// モジュールにして、self を Service Worker の型で宣言し直す (出力には export は残らない)
export {};
declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE__: { version: string; files: string[] };

const MANIFEST = __PRECACHE__;
const CACHE = `gamma3d-${MANIFEST.version}`;
/** ナビゲーション (どの URL で開いても) に返すページ */
const INDEX = new URL('./', self.registration.scope).href;

/** リダイレクトを経た応答はナビゲーションに使えないので、ヘッダーを保ったまま作り直す */
async function clean(res: Response): Promise<Response> {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        MANIFEST.files.map(async (file) => {
          const url = new URL(file, self.registration.scope).href;
          // HTTP キャッシュを通さず取り直す (古い版が混ざらないように)
          const res = await fetch(url, { cache: 'reload' });
          if (!res.ok) throw new Error(`precache failed: ${url} (${res.status})`);
          await cache.put(url === new URL('index.html', self.registration.scope).href ? INDEX : url, await clean(res));
        }),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('gamma3d-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // ページを開く要求は、クエリ (?lang= など) によらずキャッシュしたページを返す。
      // モジュールのスクリプトは Origin 付きで要求され、サーバーの応答に Vary: Origin があると一致しないため、
      // Vary は見ない (キャッシュするのは同じオリジンの、内容でファイル名が決まるファイルだけ)
      const hit = req.mode === 'navigate' ? await cache.match(INDEX) : await cache.match(req, { ignoreVary: true });
      if (hit) return hit;
      return fetch(req);
    })(),
  );
});
