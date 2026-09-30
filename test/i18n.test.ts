import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { I18N_ATTRIBUTES, initialLang, lookup } from '../src/i18n/index.ts';
import { en } from '../src/i18n/en.ts';
import { ja } from '../src/i18n/ja.ts';
import { fontSetFor } from '../src/report/pdf.ts';
import { fontCodePoints } from './support/cmap.ts';
import { japaneseLiterals } from './support/jp-literals.ts';

const root = new URL('../', import.meta.url).pathname;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(`${dir}/${f}`).isDirectory() ? walk(`${dir}/${f}`) : [`${dir}/${f}`]));

describe('国際化', () => {
  it('日本語の文字列リテラルの検出 (テスト用ヘルパー自体の確認)', () => {
    const src = [
      "const a = 'abc'; // コメントの日本語は対象外",
      '/* ブロックコメントも対象外 */',
      'const b = "日本語";',
      'const c = `x ${f(`内側`)} 外側`;',
    ].join('\n');
    expect(japaneseLiterals(src).map((h) => [h.line, h.text])).toEqual([
      [3, '日本語'],
      [4, '内側'],
      [4, '外側'],
    ]);
  });

  it('src/ (辞書を除く) の文字列リテラルに日本語が直接書かれていない', () => {
    const hits = walk(`${root}src`)
      .filter((f) => f.endsWith('.ts') && !f.includes('/src/i18n/'))
      .flatMap((f) => japaneseLiterals(readFileSync(f, 'utf8')).map((h) => `${f.slice(root.length)}:${h.line} ${h.text}`));
    expect(hits).toEqual([]);
  });

  it('index.html に日本語が直接書かれておらず、data-i18n のキーがすべて辞書にある', () => {
    const html = readFileSync(`${root}index.html`, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    expect(html.match(/[぀-ヿ㐀-鿿]+/g) ?? []).toEqual([]);
    const keys = I18N_ATTRIBUTES.flatMap((attr) => [...html.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((mt) => mt[1]));
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter((k) => lookup(k, ja) === undefined)).toEqual([]);
  });

  it('英語の辞書は日本語の辞書と同じキーを持つ', () => {
    const keys = (o: object, prefix = ''): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
    expect(keys(en)).toEqual(keys(ja));
  });

  it('英語の文言はすべて英語 PDF 用のフォント (latin) で表示できる', () => {
    const latin = fontCodePoints(`${root}public/fonts/NotoSansJP-Latin-Regular.ttf`);
    const bold = fontCodePoints(`${root}public/fonts/NotoSansJP-Latin-Bold.ttf`);
    // 値の入る文言は、いくつかの引数の組で呼んで文字を集める
    const samples: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === 'string') samples.push(v);
      else if (typeof v === 'function') {
        for (const arg of [2, 1, 'x', true, false, null]) samples.push(String((v as (...a: unknown[]) => unknown)(...Array(v.length).fill(arg))));
      } else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(en);
    const chars = new Set([...samples.join('')].map((c) => c.codePointAt(0)!));
    const missing = [...chars].filter((c) => c >= 0x20 && (!latin.has(c) || !bold.has(c))).map((c) => String.fromCodePoint(c));
    expect(missing).toEqual([]);
    expect(samples.join('')).not.toMatch(/[^\x00-\u2fff]/);
  });

  it('最初の言語は ?lang=、保存した選択、ブラウザの言語設定の順に決まる', () => {
    expect(initialLang('?lang=en', 'ja', ['ja-JP'])).toBe('en');
    expect(initialLang('?lang=xx', 'ja', ['en-US'])).toBe('ja');
    expect(initialLang('', null, ['fr-FR', 'ja-JP', 'en'])).toBe('ja');
    expect(initialLang('', 'bogus', ['EN-gb'])).toBe('en');
    expect(initialLang('', null, ['fr', 'de'])).toBe('en');
    expect(initialLang('', null, [])).toBe('en');
  });

  it('PDF のフォント: 英語でデータにも日本語がなければ latin、それ以外は full', () => {
    expect(fontSetFor('en', ['PLAN: Prostate (VMAT)', 'DOE^JOHN', 'γ ≥ 1 ✓'])).toBe('latin');
    expect(fontSetFor('en', ['PLAN', '山田 太郎 (ﾔﾏﾀﾞ ﾀﾛｳ)'])).toBe('full');
    expect(fontSetFor('en', ['홍길동'])).toBe('full');
    expect(fontSetFor('ja', ['PLAN'])).toBe('full');
  });
});
