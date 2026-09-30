import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { I18N_ATTRIBUTES, lookup } from '../src/i18n/index.ts';
import { ja } from '../src/i18n/ja.ts';
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
});
