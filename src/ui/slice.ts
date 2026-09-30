import type { ColorMap } from './colormap.ts';

export type Plane = 'axial' | 'sagittal' | 'coronal';

/**
 * 断面の軸割り当て。u = 画像の横、v = 画像の縦、w = 断面に垂直な軸。
 * - Axial: 左右 = x (患者左が画像右)、上下 = y (前が上)
 * - Coronal: 左右 = x、上下 = z (頭側が上)
 * - Sagittal: 左右 = y (前が左)、上下 = z (頭側が上)
 */
export const PLANES: Record<Plane, { u: 0 | 1 | 2; v: 0 | 1 | 2; w: 0 | 1 | 2; flipV: boolean; label: string }> = {
  axial: { u: 0, v: 1, w: 2, flipV: false, label: 'Axial' },
  coronal: { u: 0, v: 2, w: 1, flipV: true, label: 'Coronal' },
  sagittal: { u: 1, v: 2, w: 0, flipV: true, label: 'Sagittal' },
};

export interface Grid {
  dims: [number, number, number];
  spacing: [number, number, number];
  origin: [number, number, number];
}

export interface SliceImage {
  width: number;
  height: number;
  /** 1 ピクセルの物理サイズ (mm) */
  pixelW: number;
  pixelH: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export type Ijk = [number, number, number];

export function sliceIndex(plane: Plane, ijk: Ijk): number {
  return ijk[PLANES[plane].w];
}

export function imageToVoxel(plane: Plane, grid: Grid, u: number, v: number, ijk: Ijk): Ijk {
  const g = PLANES[plane];
  const out: Ijk = [...ijk];
  out[g.u] = u;
  out[g.v] = g.flipV ? grid.dims[g.v] - 1 - v : v;
  return out;
}

export function voxelToImage(plane: Plane, grid: Grid, ijk: Ijk): [number, number] {
  const g = PLANES[plane];
  const v = ijk[g.v];
  return [ijk[g.u], g.flipV ? grid.dims[g.v] - 1 - v : v];
}

export function renderSlice(
  grid: Grid,
  values: ArrayLike<number>,
  plane: Plane,
  ijk: Ijk,
  cmap: ColorMap,
  background: [number, number, number],
): SliceImage {
  const g = PLANES[plane];
  const [nx, ny] = grid.dims;
  const width = grid.dims[g.u];
  const height = grid.dims[g.v];
  const stride = [1, nx, nx * ny];
  const base = ijk[g.w] * stride[g.w];
  const rgba = new Uint8ClampedArray(width * height * 4);
  let p = 0;
  for (let row = 0; row < height; row++) {
    const v = g.flipV ? height - 1 - row : row;
    const rowBase = base + v * stride[g.v];
    for (let col = 0; col < width; col++, p += 4) {
      const c = cmap.rgb(values[rowBase + col * stride[g.u]]) ?? background;
      rgba[p] = c[0];
      rgba[p + 1] = c[1];
      rgba[p + 2] = c[2];
      rgba[p + 3] = 255;
    }
  }
  return { width, height, pixelW: grid.spacing[g.u], pixelH: grid.spacing[g.v], rgba };
}

/** 画像を矩形内にアスペクト比を保って配置したときの位置 (CSS ピクセル) */
export function fitRect(img: Pick<SliceImage, 'width' | 'height' | 'pixelW' | 'pixelH'>, w: number, h: number) {
  const physW = img.width * img.pixelW;
  const physH = img.height * img.pixelH;
  const scale = Math.min(w / physW, h / physH);
  const dw = physW * scale;
  const dh = physH * scale;
  return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
}

/** 拡大表示の状態。zoom は全体表示に対する倍率、center は表示の中心 (画像の幅・高さに対する割合 0–1) */
export interface SliceView {
  zoom: number;
  center: [number, number];
}

export const FULL_VIEW: SliceView = { zoom: 1, center: [0.5, 0.5] };
export const MAX_ZOOM = 16;

/** 拡大表示を考慮した画像の配置 (CSS ピクセル)。キャンバスからはみ出すことがある */
export function viewRect(img: Pick<SliceImage, 'width' | 'height' | 'pixelW' | 'pixelH'>, w: number, h: number, view: SliceView = FULL_VIEW) {
  const base = fitRect(img, w, h);
  const rw = base.w * view.zoom;
  const rh = base.h * view.zoom;
  return { x: w / 2 - view.center[0] * rw, y: h / 2 - view.center[1] * rh, w: rw, h: rh };
}

/** 倍率を f 倍にする。anchor (画像上の割合 0–1) の点が画面上で動かないように中心をずらす */
export function zoomView(view: SliceView, f: number, anchor: [number, number]): SliceView {
  const zoom = Math.max(1, Math.min(MAX_ZOOM, view.zoom * f));
  if (zoom === 1) return FULL_VIEW;
  const k = view.zoom / zoom;
  return clampView({ zoom, center: [anchor[0] - (anchor[0] - view.center[0]) * k, anchor[1] - (anchor[1] - view.center[1]) * k] });
}

/** 中心を (du, dv) (画像の幅・高さに対する割合) だけずらす */
export function panView(view: SliceView, du: number, dv: number): SliceView {
  return view.zoom === 1 ? FULL_VIEW : clampView({ zoom: view.zoom, center: [view.center[0] + du, view.center[1] + dv] });
}

/** 画像の外を中心にしない (どこまで動かしても画像の一部は見えている) */
function clampView(v: SliceView): SliceView {
  const c = (x: number) => Math.max(0, Math.min(1, x));
  return { zoom: v.zoom, center: [c(v.center[0]), c(v.center[1])] };
}

/**
 * 断面画像をキャンバスに描く (ピクセルは補間せず等倍ブロックで表示)。
 * cross が与えられればボクセル中心に十字線を描く。view で拡大表示する (PDF は全体表示)。
 */
export function drawSlice(
  ctx: CanvasRenderingContext2D,
  img: SliceImage,
  w: number,
  h: number,
  cross: [number, number] | null,
  crossColor = 'rgba(255,255,255,0.55)',
  view: SliceView = FULL_VIEW,
): void {
  const tmp = document.createElement('canvas');
  tmp.width = img.width;
  tmp.height = img.height;
  tmp.getContext('2d')!.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  const r = viewRect(img, w, h, view);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, r.x, r.y, r.w, r.h);
  if (cross) {
    const cx = r.x + ((cross[0] + 0.5) / img.width) * r.w;
    const cy = r.y + ((cross[1] + 0.5) / img.height) * r.h;
    ctx.save();
    ctx.strokeStyle = crossColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(r.x, Math.round(cy) + 0.5);
    ctx.lineTo(r.x + r.w, Math.round(cy) + 0.5);
    ctx.moveTo(Math.round(cx) + 0.5, r.y);
    ctx.lineTo(Math.round(cx) + 0.5, r.y + r.h);
    ctx.stroke();
    ctx.restore();
  }
}
