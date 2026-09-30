import { describe, expect, it } from 'vitest';
import { extractProfile } from '../src/ui/profile.ts';

describe('線量プロファイル', () => {
  // 値 = 100·k + 10·j + i の 4×3×2 格子
  const grid = { dims: [4, 3, 2] as [number, number, number], spacing: [2, 3, 5] as [number, number, number], origin: [-3, 10, 100] as [number, number, number] };
  const data = Float32Array.from({ length: 24 }, (_, n) => 100 * Math.floor(n / 12) + 10 * (Math.floor(n / 4) % 3) + (n % 4));

  it('十字カーソルを通る各軸方向の値と座標を取り出す', () => {
    const x = extractProfile(grid, [data], [1, 2, 1], 0);
    expect([...x.values[0]!]).toEqual([120, 121, 122, 123]);
    expect([...x.positions]).toEqual([-3, -1, 1, 3]);
    expect(x.cursorIndex).toBe(1);

    const y = extractProfile(grid, [data], [3, 0, 1], 1);
    expect([...y.values[0]!]).toEqual([103, 113, 123]);
    expect([...y.positions]).toEqual([10, 13, 16]);

    const z = extractProfile(grid, [data, null], [2, 1, 0], 2);
    expect([...z.values[0]!]).toEqual([12, 112]);
    expect(z.values[1]).toBeNull();
    expect([...z.positions]).toEqual([100, 105]);
  });
});
