import { readFileSync } from 'node:fs';

/** TrueType フォントの cmap (format 4 / 12) から、収録している文字コードの集合を読む */
export function fontCodePoints(path: string): Set<number> {
  const buf = readFileSync(path);
  const u16 = (o: number) => buf.readUInt16BE(o);
  const u32 = (o: number) => buf.readUInt32BE(o);
  const numTables = u16(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + 16 * i;
    if (buf.toString('latin1', rec, rec + 4) === 'cmap') cmap = u32(rec + 8);
  }
  if (cmap < 0) throw new Error(`${path}: no cmap table`);
  const out = new Set<number>();
  const n = u16(cmap + 2);
  for (let i = 0; i < n; i++) {
    const sub = cmap + u32(cmap + 4 + 8 * i + 4);
    const format = u16(sub);
    if (format === 4) {
      const segX2 = u16(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = u16(ends + 2 * s);
        const start = u16(starts + 2 * s);
        const delta = u16(deltas + 2 * s);
        const rangeOffset = u16(ranges + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const glyph = rangeOffset === 0 ? (c + delta) & 0xffff : u16(ranges + 2 * s + rangeOffset + 2 * (c - start));
          if (glyph !== 0) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = u32(sub + 12);
      for (let g = 0; g < groups; g++) {
        const o = sub + 16 + 12 * g;
        for (let c = u32(o); c <= u32(o + 4); c++) out.add(c);
      }
    }
  }
  return out;
}
