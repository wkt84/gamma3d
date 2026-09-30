import { describe, expect, it } from 'vitest';
import { decodeDicomText, formatPersonName } from '../src/dicom/charset.ts';

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const ESC = 0x1b;

describe('DICOM の文字コード', () => {
  it('ISO 2022 IR 13 / IR 87: 半角カナ (エスケープなし) と漢字 (ESC $ B) を読む', () => {
    // DICOM 規格 PS3.5 附属書 H の例: ﾔﾏﾀﾞ^ﾀﾛｳ=山田^太郎=やまだ^たろう
    const pn = bytes(
      [0xd4, 0xcf, 0xc0, 0xde],
      '^',
      [0xc0, 0xdb, 0xb3],
      '=',
      [ESC, 0x24, 0x42, 0x3b, 0x33, 0x45, 0x44, ESC, 0x28, 0x4a],
      '^',
      [ESC, 0x24, 0x42, 0x42, 0x40, 0x4f, 0x3a, ESC, 0x28, 0x4a],
      '=',
      [ESC, 0x24, 0x42, 0x24, 0x64, 0x24, 0x5e, 0x24, 0x40, ESC, 0x28, 0x4a],
      '^',
      [ESC, 0x24, 0x42, 0x24, 0x3f, 0x24, 0x6d, 0x24, 0x26, ESC, 0x28, 0x4a],
    );
    const s = decodeDicomText(pn, 'ISO 2022 IR 13\\ISO 2022 IR 87');
    expect(s).toBe('ﾔﾏﾀﾞ^ﾀﾛｳ=山田^太郎=やまだ^たろう');
    expect(formatPersonName(s)).toBe('山田 太郎 (ﾔﾏﾀﾞ ﾀﾛｳ)');
  });

  it('ISO 2022 IR 6 と IR 87 (先頭がローマ字) も読む', () => {
    const pn = bytes('Yamada^Tarou=', [ESC, 0x24, 0x42, 0x3b, 0x33, 0x45, 0x44, ESC, 0x28, 0x42], '^', [ESC, 0x24, 0x42, 0x42, 0x40, 0x4f, 0x3a, ESC, 0x28, 0x42]);
    expect(formatPersonName(decodeDicomText(pn, '\\ISO 2022 IR 87'))).toBe('山田 太郎 (Yamada Tarou)');
  });

  it('ISO_IR 192 (UTF-8)、ISO_IR 13 (半角カナ)、既定 (Latin-1)', () => {
    expect(decodeDicomText(new TextEncoder().encode('前立腺 VMAT'), 'ISO_IR 192')).toBe('前立腺 VMAT');
    expect(decodeDicomText(new Uint8Array([0xd4, 0xcf, 0xc0, 0xde]), 'ISO_IR 13')).toBe('ﾔﾏﾀﾞ');
    expect(decodeDicomText(bytes('M', [0xfc], 'ller'), 'ISO_IR 100')).toBe('Müller');
    expect(decodeDicomText(bytes('PLAN'), '')).toBe('PLAN');
  });

  it('人名の表示', () => {
    expect(formatPersonName('SAMPLE^PHANTOM')).toBe('SAMPLE PHANTOM');
    expect(formatPersonName('=山田^太郎')).toBe('山田 太郎');
    expect(formatPersonName('')).toBe('');
  });
});
