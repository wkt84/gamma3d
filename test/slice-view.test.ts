import { describe, expect, it } from 'vitest';
import { FULL_VIEW, MAX_ZOOM, panView, viewRect, zoomView } from '../src/ui/slice.ts';

describe('断面の拡大表示', () => {
  const img = { width: 100, height: 50, pixelW: 1, pixelH: 2 }; // 物理サイズ 100 × 100 mm

  it('全体表示では画像を枠に収めて中央に置く', () => {
    expect(viewRect(img, 300, 200, FULL_VIEW)).toEqual({ x: 50, y: 0, w: 200, h: 200 });
  });

  it('ズームしてもマウス位置 (anchor) の点は画面上で動かない', () => {
    const anchor: [number, number] = [0.8, 0.3];
    const before = viewRect(img, 300, 200, FULL_VIEW);
    const v = zoomView(FULL_VIEW, 2, anchor);
    const after = viewRect(img, 300, 200, v);
    const at = (r: typeof before) => [r.x + anchor[0] * r.w, r.y + anchor[1] * r.h];
    expect(v.zoom).toBe(2);
    expect(at(after)[0]).toBeCloseTo(at(before)[0]);
    expect(at(after)[1]).toBeCloseTo(at(before)[1]);
  });

  it('倍率は 1 – 上限に収まり、1 に戻すと中心もリセットされる', () => {
    expect(zoomView(FULL_VIEW, 1000, [0.5, 0.5]).zoom).toBe(MAX_ZOOM);
    const z = zoomView(FULL_VIEW, 3, [0.9, 0.9]);
    expect(zoomView(z, 0.01, [0.1, 0.1])).toEqual(FULL_VIEW);
  });

  it('ずらす量は画像の割合で、中心は画像の外に出ない。全体表示ではずらさない', () => {
    const z = zoomView(FULL_VIEW, 4, [0.5, 0.5]);
    expect(panView(z, 0.1, -0.2).center).toEqual([0.6, 0.3]);
    expect(panView(z, 5, -5).center).toEqual([1, 0]);
    expect(panView(FULL_VIEW, 0.3, 0.3)).toEqual(FULL_VIEW);
  });
});
