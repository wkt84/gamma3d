import type { ColorMap } from './colormap.ts';
import { drawHistogram, themeFromCss, type BarHit, type HistSpec } from './histogram-chart.ts';
import { drawProfile, type ProfileGeometry, type ProfileSpec } from './profile-chart.ts';
import { drawSlice, FULL_VIEW, viewRect, type SliceImage, type SliceView } from './slice.ts';
import { m } from '../i18n/index.ts';

function setupCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** ホイール 1 スライス分の移動量 (px) */
const WHEEL_STEP = 50;

/** 断面を 1 枚表示するパネル (見出し・画像・カラーバー) */
export class SlicePanel {
  private readonly title: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly msg: HTMLElement;
  private readonly colorbar: HTMLElement;
  private image: SliceImage | null = null;
  private cross: [number, number] | null = null;
  private wheelAcc = 0;
  private view: SliceView = FULL_VIEW;
  private drag: { x: number; y: number; moved: boolean } | null = null;

  onPick: (u: number, v: number) => void = () => {};
  onHover: (uv: [number, number] | null) => void = () => {};
  onWheel: (dir: number) => void = () => {};
  /** Ctrl+ホイール: 倍率を f 倍に。anchor はマウス位置 (画像の幅・高さに対する割合) */
  onZoom: (f: number, anchor: [number, number]) => void = () => {};
  /** ドラッグ (拡大中のみ): 中心を画像の割合でずらす */
  onPan: (du: number, dv: number) => void = () => {};

  constructor(fig: HTMLElement, title: string, headExtra?: HTMLElement) {
    const head = el('div', 'panel-head');
    this.title = el('span', undefined, title);
    head.append(this.title);
    if (headExtra) head.append(headExtra);
    const body = el('div', 'panel-body');
    this.canvas = el('canvas');
    this.msg = el('div', 'panel-msg');
    body.append(this.canvas, this.msg);
    this.colorbar = el('div', 'colorbar');
    fig.append(head, body, this.colorbar);

    new ResizeObserver(() => this.redraw()).observe(body);

    // ダブルクリックでその点へ十字カーソルを移動 (= 他の断面の表示位置が変わる)
    this.canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const uv = this.hit(e);
      if (uv) this.onPick(uv[0], uv[1]);
    });
    // 拡大中はドラッグで表示位置を動かす
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.view.zoom === 1 || !this.image) return;
      this.drag = { x: e.clientX, y: e.clientY, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.drag && this.image) {
        const r = this.rect()!;
        const du = (e.clientX - this.drag.x) / r.w;
        const dv = (e.clientY - this.drag.y) / r.h;
        if (du || dv) {
          this.drag = { x: e.clientX, y: e.clientY, moved: true };
          this.canvas.classList.add('dragging');
          this.onPan(-du, -dv);
        }
        return;
      }
      this.onHover(this.hit(e));
    });
    const endDrag = () => {
      this.drag = null;
      this.canvas.classList.remove('dragging');
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('pointerleave', () => this.onHover(null));
    // ホイールでスライス送り。マウスのノッチは 1 回 1 スライス、トラックパッドの細かい量は累積して送る。
    // Ctrl (Mac は Cmd) を押しながら、またはトラックパッドのピンチでズーム
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const dy = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? e.deltaY : e.deltaY * 40;
        if (e.ctrlKey || e.metaKey) {
          const r = this.rect();
          if (!r) return;
          const rect = this.canvas.getBoundingClientRect();
          const anchor: [number, number] = [(e.clientX - rect.left - r.x) / r.w, (e.clientY - rect.top - r.y) / r.h];
          this.onZoom(Math.exp(-dy * 0.002), anchor);
          return;
        }
        if (Math.abs(dy) >= WHEEL_STEP) {
          this.wheelAcc = 0;
          this.onWheel(Math.sign(dy));
          return;
        }
        this.wheelAcc += dy;
        while (Math.abs(this.wheelAcc) >= WHEEL_STEP) {
          const dir = Math.sign(this.wheelAcc);
          this.wheelAcc -= dir * WHEEL_STEP;
          this.onWheel(dir);
        }
      },
      { passive: false },
    );
  }

  setTitle(t: string): void {
    this.title.textContent = t;
  }

  setView(view: SliceView): void {
    this.view = view;
    this.canvas.classList.toggle('zoomed', view.zoom > 1);
    this.redraw();
  }

  show(image: SliceImage, cross: [number, number] | null): void {
    this.image = image;
    this.cross = cross;
    this.msg.textContent = '';
    this.redraw();
  }

  message(text: string): void {
    this.image = null;
    this.msg.textContent = text;
    this.setColorMap(null);
    this.redraw();
  }

  setColorMap(cmap: ColorMap | null): void {
    this.colorbar.replaceChildren();
    if (!cmap) return;
    const bar = el('div', 'bar');
    bar.style.background = cmap.gradient;
    const ticks = el('div', 'ticks');
    for (const t of cmap.ticks) {
      const s = el('span', undefined, t.label);
      s.style.left = `${((t.value - cmap.min) / (cmap.max - cmap.min)) * 100}%`;
      ticks.append(s);
    }
    this.colorbar.append(bar, ticks);
    if (cmap.extras?.length) {
      const ex = el('div', 'extras');
      for (const x of cmap.extras) {
        const i = el('i');
        i.style.background = x.color;
        ex.append(i, x.label, ' ');
      }
      this.colorbar.append(ex);
    }
  }

  redraw(): void {
    const c = setupCanvas(this.canvas);
    if (!c) return;
    c.ctx.clearRect(0, 0, c.w, c.h);
    if (this.image) drawSlice(c.ctx, this.image, c.w, c.h, this.cross, undefined, this.view);
  }

  /** 画像の配置 (キャンバス内の CSS ピクセル) */
  private rect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.image) return null;
    const rect = this.canvas.getBoundingClientRect();
    return viewRect(this.image, rect.width, rect.height, this.view);
  }

  private hit(e: MouseEvent): [number, number] | null {
    if (!this.image) return null;
    const rect = this.canvas.getBoundingClientRect();
    const r = viewRect(this.image, rect.width, rect.height, this.view);
    const u = Math.floor(((e.clientX - rect.left - r.x) / r.w) * this.image.width);
    const v = Math.floor(((e.clientY - rect.top - r.y) / r.h) * this.image.height);
    if (u < 0 || v < 0 || u >= this.image.width || v >= this.image.height) return null;
    return [u, v];
  }
}

/** ヒストグラム 1 枚 (ホバーでビンの値を表示) */
export class HistogramView {
  private readonly canvas: HTMLCanvasElement;
  private readonly tip: HTMLElement;
  private readonly empty: HTMLElement;
  private spec: HistSpec | null = null;
  private hits: BarHit[] = [];
  private hover = -1;
  private readonly fig: HTMLElement;

  constructor(fig: HTMLElement, emptyText: string) {
    this.fig = fig;
    this.canvas = el('canvas');
    this.tip = el('div', 'tooltip');
    this.tip.hidden = true;
    this.empty = el('p', 'empty', emptyText);
    fig.append(this.canvas, this.tip, this.empty);
    fig.setAttribute('role', 'img');
    new ResizeObserver(() => this.redraw()).observe(fig);
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      this.tip.hidden = true;
      this.redraw();
    });
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => this.redraw());
  }

  setEmptyText(t: string): void {
    this.empty.textContent = t;
  }

  set(spec: HistSpec | null): void {
    this.spec = spec;
    this.empty.hidden = !!spec;
    this.canvas.hidden = !spec;
    this.fig.setAttribute('aria-label', spec ? `${spec.title}: ${spec.summary}` : '');
    this.redraw();
  }

  redraw(): void {
    if (!this.spec) return;
    const c = setupCanvas(this.canvas);
    if (!c) return;
    this.hits = drawHistogram(c.ctx, c.w, c.h, this.spec, themeFromCss(this.fig), this.hover);
  }

  private move(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // バーより広い当たり判定: 最も近いバーを選ぶ
    let best = -1;
    let bestD = Infinity;
    this.hits.forEach((h, i) => {
      const d = Math.abs(h.x + h.w / 2 - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0 || bestD > this.hits[best].w * 1.5) {
      this.tip.hidden = true;
      if (this.hover !== -1) {
        this.hover = -1;
        this.redraw();
      }
      return;
    }
    const h = this.hits[best];
    this.tip.hidden = false;
    this.tip.textContent = m().viewer.tooltip(h.label, h.count.toLocaleString(), h.percent.toFixed(2));
    const tw = this.tip.offsetWidth;
    const left = Math.min(rect.width - tw - 4, Math.max(4, h.x + h.w / 2 - tw / 2));
    this.tip.style.left = `${left}px`;
    this.tip.style.top = `${Math.max(4, e.clientY - rect.top - 36)}px`;
    if (this.hover !== best) {
      this.hover = best;
      this.redraw();
    }
  }
}

/** 線量プロファイル 1 枚 (ホバーで値を表示、ダブルクリックでその点へ十字カーソルを移動) */
export class ProfileView {
  private readonly canvas: HTMLCanvasElement;
  private readonly tip: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly fig: HTMLElement;
  private spec: ProfileSpec | null = null;
  private geometry: ProfileGeometry | null = null;
  private hover = -1;

  /** ホバー中の点の説明 (ツールチップの文言) */
  describe: (spec: ProfileSpec, i: number) => string = () => '';
  onPick: (i: number) => void = () => {};

  constructor(fig: HTMLElement, emptyText: string) {
    this.fig = fig;
    this.canvas = el('canvas');
    this.tip = el('div', 'tooltip');
    this.tip.hidden = true;
    this.empty = el('p', 'empty', emptyText);
    fig.append(this.canvas, this.tip, this.empty);
    fig.setAttribute('role', 'img');
    new ResizeObserver(() => this.redraw()).observe(fig);
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = -1;
      this.tip.hidden = true;
      this.redraw();
    });
    this.canvas.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const i = this.indexAt(e);
      if (i >= 0) this.onPick(i);
    });
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => this.redraw());
  }

  setEmptyText(t: string): void {
    this.empty.textContent = t;
  }

  set(spec: ProfileSpec | null): void {
    this.spec = spec;
    this.empty.hidden = !!spec;
    this.canvas.hidden = !spec;
    this.fig.setAttribute('aria-label', spec ? spec.title : '');
    if (spec && this.hover >= spec.positions.length) this.hover = -1;
    this.redraw();
    if (spec && this.hover >= 0 && !this.tip.hidden) this.tip.textContent = this.describe(spec, this.hover);
  }

  redraw(): void {
    if (!this.spec) return;
    const c = setupCanvas(this.canvas);
    if (!c) return;
    this.geometry = drawProfile(c.ctx, c.w, c.h, this.spec, themeFromCss(this.fig), this.hover);
  }

  private indexAt(e: MouseEvent): number {
    if (!this.spec || !this.geometry) return -1;
    const x = e.clientX - this.canvas.getBoundingClientRect().left;
    if (x < this.geometry.x0 - 8 || x > this.geometry.x1 + 8) return -1;
    return this.geometry.indexAt(x);
  }

  private move(e: PointerEvent): void {
    const i = this.indexAt(e);
    if (i < 0 || !this.spec) {
      this.tip.hidden = true;
      if (this.hover !== -1) {
        this.hover = -1;
        this.redraw();
      }
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    this.tip.hidden = false;
    this.tip.textContent = this.describe(this.spec, i);
    const tw = this.tip.offsetWidth;
    const x = e.clientX - rect.left;
    this.tip.style.left = `${Math.min(rect.width - tw - 4, Math.max(4, x + 12))}px`;
    this.tip.style.top = `${Math.max(4, e.clientY - rect.top - 36)}px`;
    if (this.hover !== i) {
      this.hover = i;
      this.redraw();
    }
  }
}
