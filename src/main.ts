import './style.css';
import { DEFAULT_PARAMS, type AnalysisParams } from './core/gamma.ts';
import { judge, validLevels, type ActionLevels, type Judgment } from './core/judgment.ts';
import { AnalysisCancelled, runAnalyses, type AnalysisResult } from './core/runner.ts';
import { gammaStats, type GammaStats } from './core/stats.ts';
import { maxValue, resampleTo, shiftVolume, type Vec3, type Volume } from './core/volume.ts';
import { buildDoseSets, scaled, scaleFactor, type DoseScale, type DoseSet } from './dicom/group.ts';
import { parseRtDose, peekModality, type RtDose } from './dicom/rtdose.ts';
import { parseRtPlan, type RtPlan } from './dicom/rtplan.ts';
import { ddColorMap, doseColorMap, dtaColorMap, gammaColorMap, gradientColorMap, type ColorMap, type DoseWindow } from './ui/colormap.ts';
import { HistogramView, ProfileView, SlicePanel } from './ui/components.ts';
import { extractProfile } from './ui/profile.ts';
import type { ProfileSpec } from './ui/profile-chart.ts';
import { derive, histSpecs, type DdUnit, type Derived } from './ui/results.ts';
import { FULL_VIEW, imageToVoxel, panView, PLANES, renderSlice, voxelToImage, zoomView, type Ijk, type Plane, type SliceView } from './ui/slice.ts';
import {
  applyTranslations,
  currentLang,
  errorMsg,
  initialLang,
  LANGUAGES,
  LocalizedError,
  m,
  onLangChange,
  setLang,
  setMessages,
  text,
  type Lang,
  type Messages,
  type Msg,
} from './i18n/index.ts';
import {
  browserStorage,
  normalizeName,
  parseFile as parsePresetFile,
  PresetStore,
  serialize as serializePresets,
  validateParams,
  type PresetParams,
} from './ui/presets.ts';

// ───────── 状態 ─────────

type SideKey = 'ref' | 'eval';
interface Side {
  key: SideKey;
  root: HTMLElement;
  doses: RtDose[];
  sets: DoseSet[];
  selected: DoseSet | null;
  notices: Msg[];
  fileCount: number;
  /** 一緒に読み込んだ RTPLAN (分割回数の換算とビーム名の表示に使う) */
  plans: RtPlan[];
}

type MapMode = 'gamma' | 'dd' | 'dta' | 'grad';

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

const sides: Record<SideKey, Side> = {
  ref: { key: 'ref', root: $('[data-side="ref"]'), doses: [], sets: [], selected: null, notices: [], fileCount: 0, plans: [] },
  eval: { key: 'eval', root: $('[data-side="eval"]'), doses: [], sets: [], selected: null, notices: [], fileCount: 0, plans: [] },
};

let plane: Plane = 'axial';
let cursor: Ijk = [0, 0, 0];
let mapMode: MapMode = 'gamma';
let ddUnit: DdUnit = 'percent';
/** 表示用: 比較元 (係数適用済み) と、比較元格子へ補間した比較先 */
let display: { ref: Volume; evalOnRef: Float32Array | null; max: number } | null = null;
/** 解析結果 (一括計算では条件ごと) と、表示中の結果 */
let results: AnalysisResult[] = [];
let resultStats: GammaStats[] = [];
let result: AnalysisResult | null = null;
let derived: Derived | null = null;

/** 一括計算する標準の 4 条件 (DD %, DTA mm) */
const STANDARD_CRITERIA: [number, number][] = [
  [3, 3],
  [3, 2],
  [2, 2],
  [1, 1],
];
let stale = false;
let abort: AbortController | null = null;

const BG: [number, number, number] = [10, 10, 10];

// ───────── 言語 ─────────

const LANG_KEY = 'gamma3d.lang';
function savedLang(): string | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}
setMessages(LANGUAGES[initialLang(location.search, savedLang(), navigator.languages ?? [navigator.language])].messages);
applyTranslations();

const langSelect = $<HTMLSelectElement>('#lang');
for (const [key, { name }] of Object.entries(LANGUAGES)) langSelect.add(new Option(name, key));
langSelect.value = currentLang();
langSelect.addEventListener('change', () => {
  const lang = langSelect.value as Lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // 保存できなくても、この画面では切り替える
  }
  setLang(lang);
});

/** 状態表示の欄と、その文言 (言語を切り替えたら作り直す) */
const statusMsgs = new Map<HTMLElement, Msg>();
function setStatus(el: HTMLElement, msg: Msg | null): void {
  if (msg) statusMsgs.set(el, msg);
  else statusMsgs.delete(el);
  el.textContent = msg ? text(msg) : '';
}

// ───────── ビュー ─────────

const MAP_MODES = ['gamma', 'dd', 'dta', 'grad'] as const;
const mapSelect = document.createElement('select');
for (const v of MAP_MODES) mapSelect.add(new Option('', v));
const ddUnitSelect = document.createElement('select');
ddUnitSelect.add(new Option('%', 'percent'));
ddUnitSelect.add(new Option('Gy', 'gy'));
const mapHead = document.createElement('span');
mapHead.style.display = 'flex';
mapHead.style.gap = '6px';
mapHead.append(mapSelect, ddUnitSelect);

const panelRef = new SlicePanel($('#panel-ref'), '');
const panelEval = new SlicePanel($('#panel-eval'), '');
const panelMap = new SlicePanel($('#panel-map'), '', mapHead);
const panels = [panelRef, panelEval, panelMap];
const charts = [new HistogramView($('#chart-dd'), ''), new HistogramView($('#chart-dta'), ''), new HistogramView($('#chart-gamma'), '')];
const AXES = [0, 1, 2] as const;
const profiles = AXES.map((a) => new ProfileView($(`#profile-${'xyz'[a]}`), ''));
let showProfiles = false;

const slider = $<HTMLInputElement>('#slice');
const sliceLabel = $('#slice-label');
const readout = $('#readout');

/** 画面で組み立てる固定の文言 (HTML の data-i18n 以外) を現在の言語で入れる */
function localizeStatic(): void {
  const v = m().viewer;
  $('#app-meta').textContent = m().app.meta(__APP_VERSION__);
  mapSelect.setAttribute('aria-label', v.mapType);
  MAP_MODES.forEach((mode, i) => (mapSelect.options[i].text = v.maps[mode]));
  ddUnitSelect.setAttribute('aria-label', v.ddUnit);
  panelRef.setTitle(v.refPanel);
  panelEval.setTitle(v.evalPanel);
  panelMap.setTitle(v.mapPanel);
  charts[0].setEmptyText(v.histEmpty.dd);
  charts[1].setEmptyText(v.histEmpty.dta);
  charts[2].setEmptyText(v.histEmpty.gamma);
  profiles.forEach((p) => p.setEmptyText(m().profile.empty));
}
localizeStatic();

function currentMap(): { values: ArrayLike<number>; cmap: ColorMap } | null {
  if (!result || !derived) return null;
  const p = result.params;
  switch (mapMode) {
    case 'gamma':
      return { values: result.gamma, cmap: gammaColorMap(p.gammaCap) };
    case 'dd':
      return ddUnit === 'percent'
        ? { values: derived.ddPct, cmap: ddColorMap(2 * p.ddPercent, '%') }
        : { values: result.dd, cmap: ddColorMap((2 * p.ddPercent * p.normDoseGy) / 100, 'Gy') };
    case 'dta':
      return { values: result.dta, cmap: dtaColorMap(p.gammaCap * p.dtaMm) };
    case 'grad':
      return { values: result.grad, cmap: gradientColorMap(3 * p.gradientThresholdPercentPerMm) };
  }
}

function renderViews(): void {
  if (!display) {
    panels.forEach((p) => p.message(m().viewer.loadRef));
    sliceLabel.textContent = '–';
    return;
  }
  const grid = display.ref;
  const cross = voxelToImage(plane, grid, cursor);
  const doseMap = doseColorMap(display.max, doseWindow());

  panelRef.show(renderSlice(grid, grid.data, plane, cursor, doseMap, BG), cross);
  panelRef.setColorMap(doseMap);

  if (display.evalOnRef) {
    panelEval.show(renderSlice(grid, display.evalOnRef, plane, cursor, doseMap, BG), cross);
    panelEval.setColorMap(doseMap);
  } else {
    panelEval.message(m().viewer.loadEval);
  }

  const map = currentMap();
  if (map) {
    panelMap.show(renderSlice(grid, map.values, plane, cursor, map.cmap, BG), cross);
    panelMap.setColorMap(map.cmap);
  } else {
    panelMap.message(m().viewer.afterRun);
  }
  ddUnitSelect.hidden = mapMode !== 'dd';

  const w = PLANES[plane].w;
  const pos = grid.origin[w] + cursor[w] * grid.spacing[w];
  sliceLabel.textContent = `${cursor[w] + 1}/${grid.dims[w]}  ${'xyz'[w]} = ${pos.toFixed(1)} mm`;
  showReadout(cursor);
  renderProfiles();
}

// ───────── ズーム・表示範囲 ─────────

/** 断面ごとの拡大表示 (3 パネルで共通) */
const views: Record<Plane, SliceView> = { axial: FULL_VIEW, coronal: FULL_VIEW, sagittal: FULL_VIEW };
const zoomReset = $<HTMLButtonElement>('#zoom-reset');

function applyView(): void {
  const v = views[plane];
  panels.forEach((p) => p.setView(v));
  zoomReset.hidden = v.zoom === 1;
  zoomReset.textContent = m().viewer.zoom(v.zoom.toFixed(1));
}

for (const p of panels) {
  p.onZoom = (f, anchor) => {
    views[plane] = zoomView(views[plane], f, anchor);
    applyView();
  };
  p.onPan = (du, dv) => {
    views[plane] = panView(views[plane], du, dv);
    applyView();
  };
}
zoomReset.addEventListener('click', () => {
  views[plane] = FULL_VIEW;
  applyView();
});

const winMin = $<HTMLInputElement>('#win-min');
const winMax = $<HTMLInputElement>('#win-max');
const winCut = $<HTMLInputElement>('#win-cut');

/** 線量の表示範囲。不正な欄は赤枠にして既定値 (0 – 最大線量、隠さない) を使う */
function doseWindow(): Partial<DoseWindow> {
  const max = winMax.value.trim() === '' ? (display?.max ?? 1) : Number(winMax.value);
  const min = winMin.value.trim() === '' ? 0 : Number(winMin.value);
  const cut = winCut.value.trim() === '' ? 0 : Number(winCut.value);
  const rangeOk = Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max > min;
  const cutOk = Number.isFinite(cut) && cut >= 0 && cut < 100;
  winMin.setAttribute('aria-invalid', String(!rangeOk));
  winMax.setAttribute('aria-invalid', String(!rangeOk));
  winCut.setAttribute('aria-invalid', String(!cutOk));
  return {
    ...(rangeOk ? { min, max } : {}),
    lowCut: cutOk ? ((display?.max ?? 0) * cut) / 100 : 0,
  };
}

for (const input of [winMin, winMax, winCut]) input.addEventListener('change', () => renderViews());
// メニューの外をクリックしたら閉じる
const windowMenu = $<HTMLDetailsElement>('.window-menu');
document.addEventListener('pointerdown', (e) => {
  if (windowMenu.open && !windowMenu.contains(e.target as Node)) windowMenu.open = false;
});

$('#view-reset').addEventListener('click', () => {
  for (const k of Object.keys(views) as Plane[]) views[k] = FULL_VIEW;
  winMin.value = '0';
  winMax.value = '';
  winCut.value = '0';
  applyView();
  renderViews();
});

/** 十字カーソルを通る x・y・z 方向の線量プロファイル (γ は解析後に下の帯へ) */
function renderProfiles(): void {
  if (!showProfiles) return;
  if (!display) {
    profiles.forEach((p) => p.set(null));
    return;
  }
  const grid = display.ref;
  const t = m().profile;
  for (const axis of AXES) {
    const pr = extractProfile(grid, [grid.data, display.evalOnRef, result?.gamma ?? null], cursor, axis);
    const [refV, evalV, gammaV] = pr.values;
    const others = AXES.filter((a) => a !== axis).map((a) => `${'xyz'[a]} = ${(grid.origin[a] + cursor[a] * grid.spacing[a]).toFixed(1)}`);
    const spec: ProfileSpec = {
      title: t.title('xyz'[axis], others[0], others[1]),
      xLabel: t.xLabel('xyz'[axis]),
      positions: pr.positions,
      cursorIndex: pr.cursorIndex,
      series: [
        { label: t.ref, values: refV!, color: 'series1', dashed: false },
        ...(evalV ? [{ label: t.eval, values: evalV, color: 'series2' as const, dashed: true }] : []),
      ],
      doseMax: display.max,
      doseUnit: 'Gy',
      gamma: gammaV && result ? { values: gammaV, cap: result.params.gammaCap, label: 'γ' } : null,
    };
    profiles[axis].set(spec);
  }
}

profiles.forEach((view, axis) => {
  view.describe = (spec, i) => {
    const f = (v: number, d: number) => (Number.isNaN(v) ? '–' : v.toFixed(d));
    const parts = [`${'xyz'[axis]} = ${spec.positions[i].toFixed(1)} mm`];
    for (const s of spec.series) parts.push(`${s.label} ${f(s.values[i], 3)} Gy`);
    if (spec.gamma) parts.push(`γ ${f(spec.gamma.values[i], 2)}`);
    return parts.join(m().viewer.separator);
  };
  view.onPick = (i) => {
    if (!display) return;
    cursor[axis] = i;
    syncSlider();
    renderViews();
  };
});

const gridEl = $('.grid');
for (const b of $$<HTMLButtonElement>('.bottom-view button')) {
  b.addEventListener('click', () => {
    showProfiles = b.dataset.bottom === 'profile';
    gridEl.classList.toggle('show-profiles', showProfiles);
    $$<HTMLButtonElement>('.bottom-view button').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
    renderProfiles();
  });
}

function renderCharts(): void {
  if (!result || !derived) {
    charts.forEach((c) => c.set(null));
    return;
  }
  histSpecs(result, derived, ddUnit).forEach((s, i) => charts[i].set(s));
}

function showReadout(ijk: Ijk): void {
  if (!display) {
    readout.textContent = '';
    return;
  }
  const g = display.ref;
  const n = ijk[0] + g.dims[0] * (ijk[1] + g.dims[1] * ijk[2]);
  const pos = [0, 1, 2].map((a) => (g.origin[a] + ijk[a] * g.spacing[a]).toFixed(1)).join(', ');
  const f = (v: number | undefined, d: number) => (v === undefined || Number.isNaN(v) ? '–' : v === Infinity ? m().viewer.notFound : v.toFixed(d));
  const parts = [`(${pos}) mm`, `Ref ${f(g.data[n], 3)} Gy`];
  if (display.evalOnRef) parts.push(`Eval ${f(display.evalOnRef[n], 3)} Gy`);
  if (result && derived) {
    parts.push(`γ ${f(result.gamma[n], 2)}`);
    parts.push(`DD ${f(derived.ddPct[n], 2)}%`);
    parts.push(`DTA ${f(result.dta[n], 2)} mm`);
    parts.push(`${m().viewer.gradient} ${f(result.grad[n], 1)}%/mm`);
  }
  readout.textContent = parts.join(m().viewer.separator);
  readout.title = readout.textContent;
}

function syncSlider(): void {
  if (!display) return;
  const w = PLANES[plane].w;
  slider.max = String(display.ref.dims[w] - 1);
  slider.value = String(cursor[w]);
}

for (const p of panels) {
  p.onPick = (u, v) => {
    if (!display) return;
    cursor = imageToVoxel(plane, display.ref, u, v, cursor);
    renderViews();
  };
  p.onHover = (uv) => {
    if (!display) return;
    showReadout(uv ? imageToVoxel(plane, display.ref, uv[0], uv[1], cursor) : cursor);
  };
  p.onWheel = (dir) => {
    if (!display) return;
    const w = PLANES[plane].w;
    cursor[w] = Math.max(0, Math.min(display.ref.dims[w] - 1, cursor[w] - dir));
    syncSlider();
    renderViews();
  };
}

slider.addEventListener('input', () => {
  cursor[PLANES[plane].w] = Number(slider.value);
  renderViews();
});

for (const b of $$<HTMLButtonElement>('.plane button')) {
  b.addEventListener('click', () => {
    plane = b.dataset.plane as Plane;
    $$('.plane button').forEach((x) => x.classList.toggle('active', x === b));
    syncSlider();
    applyView();
    renderViews();
  });
}

mapSelect.addEventListener('change', () => {
  mapMode = mapSelect.value as MapMode;
  renderViews();
});
ddUnitSelect.addEventListener('change', () => {
  ddUnit = ddUnitSelect.value as DdUnit;
  renderViews();
  renderCharts();
});

// ───────── データ読み込み ─────────

async function filesFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise((res) => (entry as FileSystemFileEntry).file((f) => res([f]), () => res([])));
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const all: FileSystemEntry[] = [];
    // readEntries は一度に全件を返さないことがあるため、空になるまで繰り返す
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break;
      all.push(...batch);
    }
    return (await Promise.all(all.map(filesFromEntry))).flat();
  }
  return [];
}

async function loadFiles(side: Side, files: File[]): Promise<void> {
  const summary = $('.set-summary', side.root);
  $('.dose-info', side.root).hidden = false;
  const doses: RtDose[] = [];
  const plans: RtPlan[] = [];
  const notices: Msg[] = [];
  let skipped = 0;
  const candidates = files.filter((f) => !f.name.startsWith('.'));
  for (let i = 0; i < candidates.length; i++) {
    const f = candidates[i];
    summary.textContent = m().side.loading(i + 1, candidates.length);
    const name = f.webkitRelativePath || f.name;
    try {
      // 先頭だけで Modality を判定し、CT など RTDOSE / RTPLAN 以外は本体を読まない
      const modality = peekModality(new Uint8Array(await f.slice(0, 65536).arrayBuffer()));
      if (modality === 'RTDOSE') doses.push(parseRtDose(await f.arrayBuffer(), name));
      else if (modality === 'RTPLAN') plans.push(parseRtPlan(await f.arrayBuffer(), name));
      else skipped++;
    } catch (e) {
      notices.push(e instanceof Error ? errorMsg(e) : (t) => t.side.loadFailed(name));
    }
  }
  if (skipped) notices.push((t) => t.side.skipped(skipped));
  if (!doses.length) notices.push((t) => t.side.noRtdose);

  side.doses = doses;
  side.plans = plans;
  side.fileCount = candidates.length;
  side.sets = buildDoseSets(doses);
  side.selected = side.sets[0] ?? null;
  side.notices = notices;
  renderSide(side);
  onDataChanged(true);
}

function renderSide(side: Side): void {
  $('.dose-info', side.root).hidden = side.fileCount === 0;
  const select = $<HTMLSelectElement>('.set-select', side.root);
  select.replaceChildren(...side.sets.map((s) => new Option(text(s.label), s.id)));
  select.disabled = side.sets.length < 2;
  if (side.selected) select.value = side.selected.id;
  const s = side.selected;
  $('.set-summary', side.root).textContent = s ? `${s.patientName || m().side.noName} / ${s.patientId || '–'}\n${text(s.summary)}` : '';
  $('.set-summary', side.root).style.whiteSpace = 'pre-line';
  // 選択中の線量が参照するプラン
  const plan = planOf(side);
  const planInfo = $('.plan-info', side.root);
  planInfo.hidden = !plan;
  planInfo.textContent = plan ? m().side.plan(plan.label || plan.name || plan.fileName, plan.fractions, plan.beams.length) : '';
  const perFraction = $<HTMLButtonElement>('.per-fraction', side.root);
  perFraction.hidden = !plan?.fractions || plan.fractions < 2;
  if (plan?.fractions) perFraction.textContent = m().side.perFraction(plan.fractions);

  const list = $('.file-list', side.root);
  $('summary', list).textContent = m().side.fileCount(side.doses.length, side.plans.length, side.fileCount);
  // ビーム番号に、対応する RTPLAN のビーム名と MU を添える
  const planBeams = (d: RtDose) => side.plans.find((p) => p.sopInstanceUID === d.referencedPlanUID)?.beams ?? [];
  const beamName = (d: RtDose, n: number) => {
    const b = planBeams(d).find((pb) => pb.number === n);
    return b ? m().side.beam(n, b.name, b.meterset === null ? null : b.meterset.toFixed(1)) : `#${n}`;
  };
  $('ul', list).replaceChildren(
    ...side.doses.map((d) => {
      const li = document.createElement('li');
      const beams = d.referencedBeamNumbers.length ? ` ${d.referencedBeamNumbers.map((n) => beamName(d, n)).join(', ')}` : '';
      li.textContent = `${d.fileName} (${d.summationType}${beams})`;
      return li;
    }),
    ...side.plans.map((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.fileName} (RTPLAN ${p.label || p.name})`;
      return li;
    }),
  );
  const planNotices: Msg[] = side.plans.length && s && !plan ? [(t) => t.side.planMismatch] : [];
  $('.warnings', side.root).replaceChildren(
    ...[...side.notices, ...(s?.warnings ?? []), ...planNotices].map((w) => {
      const li = document.createElement('li');
      li.textContent = text(w);
      return li;
    }),
  );
}

/** 選択中の線量が参照する RTPLAN (読み込んでいなければ null) */
function planOf(side: Side): RtPlan | null {
  const uid = side.selected?.planUID;
  return (uid && side.plans.find((p) => p.sopInstanceUID === uid)) || null;
}

/** 係数 x / y を読む。不正な値の欄は赤枠にし、その欄は 1 として扱う */
function scaleOf(side: Side): DoseScale {
  const read = (sel: string) => {
    const input = $<HTMLInputElement>(sel, side.root);
    const v = Number(input.value);
    const ok = input.value.trim() !== '' && Number.isFinite(v) && v > 0;
    input.setAttribute('aria-invalid', String(!ok));
    return ok ? v : 1;
  };
  const s = { num: read('.scale-num'), den: read('.scale-den') };
  const f = scaleFactor(s);
  $('.scale-value', side.root).textContent = s.num === 1 && s.den === 1 ? '' : m().side.scaleValue(Number(f.toPrecision(6)));
  return s;
}

const factorOf = (side: Side): number => scaleFactor(scaleOf(side));

const shiftInputs = $$<HTMLInputElement>('.shift', sides.eval.root);

/** 比較先の平行移動 (mm)。不正な値の欄は赤枠にし、0 として扱う */
function shiftOf(): Vec3 {
  const s: Vec3 = [0, 0, 0];
  for (const input of shiftInputs) {
    const v = input.value.trim() === '' ? 0 : Number(input.value);
    const ok = Number.isFinite(v);
    input.setAttribute('aria-invalid', String(!ok));
    s[Number(input.dataset.axis)] = ok ? v : 0;
  }
  return s;
}

const isShifted = (s: Vec3) => s.some((v) => v !== 0);
const formatShift = (s: Vec3) => s.map((v) => (v > 0 ? `+${v}` : `${v}`)) as [string, string, string];

/** 解析に使う比較先 (係数と平行移動を適用したもの) */
function evalVolume(set: DoseSet): Volume {
  return shiftVolume(scaled(set.volume, factorOf(sides.eval)), shiftOf());
}

/** データ・係数が変わったとき: 結果を破棄して表示を作り直す */
function onDataChanged(resetCursor: boolean): void {
  if (result) setStatus(runStatus, null);
  results = [];
  resultStats = [];
  result = null;
  derived = null;
  stale = false;
  const ref = sides.ref.selected;
  const ev = sides.eval.selected;
  if (ref) {
    const refVol = scaled(ref.volume, factorOf(sides.ref));
    let evalOnRef: Float32Array | null = null;
    let max = maxValue(refVol.data);
    if (ev) {
      evalOnRef = resampleTo(evalVolume(ev), refVol, NaN).data;
      for (let n = 0; n < evalOnRef.length; n++) if (evalOnRef[n] > max) max = evalOnRef[n];
    }
    const sameGrid = display && display.ref.dims.join() === refVol.dims.join();
    display = { ref: refVol, evalOnRef, max };
    if (resetCursor || !sameGrid) cursor = argmax(refVol);
    if (!sameGrid) {
      for (const k of Object.keys(views) as Plane[]) views[k] = FULL_VIEW;
      applyView();
    }
  } else {
    display = null;
  }
  updateNormDose();
  syncSlider();
  renderViews();
  renderCharts();
  renderSummary();
  updateButtons();
}

function argmax(v: Volume): Ijk {
  let best = 0;
  for (let n = 1; n < v.data.length; n++) if (v.data[n] > v.data[best]) best = n;
  const [nx, ny] = v.dims;
  return [best % nx, Math.floor(best / nx) % ny, Math.floor(best / (nx * ny))];
}

for (const side of Object.values(sides)) {
  const zone = $('.dropzone', side.root);
  const fileInput = $<HTMLInputElement>('.file-input', side.root);
  const dirInput = $<HTMLInputElement>('.dir-input', side.root);
  zone.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.pick-dir')) return;
    fileInput.click();
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  $('.pick-dir', side.root).addEventListener('click', (e) => {
    e.preventDefault();
    dirInput.click();
  });
  for (const input of [fileInput, dirInput]) {
    input.addEventListener('change', () => {
      if (input.files?.length) void loadFiles(side, [...input.files]);
      input.value = '';
    });
  }
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const items = [...(e.dataTransfer?.items ?? [])];
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => !!x);
    const files = entries.length ? (await Promise.all(entries.map(filesFromEntry))).flat() : [...(e.dataTransfer?.files ?? [])];
    if (files.length) void loadFiles(side, files);
  });
  $<HTMLSelectElement>('.set-select', side.root).addEventListener('change', (e) => {
    side.selected = side.sets.find((s) => s.id === (e.target as HTMLSelectElement).value) ?? null;
    renderSide(side);
    onDataChanged(true);
  });
  for (const sel of ['.scale-num', '.scale-den']) {
    $<HTMLInputElement>(sel, side.root).addEventListener('change', () => onDataChanged(false));
  }
  // 分割回数で割って 1 回分にする (係数 1 / n)
  $('.per-fraction', side.root).addEventListener('click', () => {
    const n = planOf(side)?.fractions;
    if (!n) return;
    $<HTMLInputElement>('.scale-num', side.root).value = '1';
    $<HTMLInputElement>('.scale-den', side.root).value = String(n);
    onDataChanged(false);
  });
}

for (const input of shiftInputs) input.addEventListener('change', () => onDataChanged(false));
$('.shift-reset', sides.eval.root).addEventListener('click', () => {
  shiftInputs.forEach((i) => (i.value = '0'));
  onDataChanged(false);
});

/** 比較元と比較先を入れ替える (線量・候補・警告・係数)。解析結果は破棄する */
const swapBtn = $<HTMLButtonElement>('#swap');
swapBtn.addEventListener('click', () => {
  const a = sides.ref;
  const b = sides.eval;
  [a.doses, b.doses] = [b.doses, a.doses];
  [a.sets, b.sets] = [b.sets, a.sets];
  [a.selected, b.selected] = [b.selected, a.selected];
  [a.notices, b.notices] = [b.notices, a.notices];
  [a.fileCount, b.fileCount] = [b.fileCount, a.fileCount];
  [a.plans, b.plans] = [b.plans, a.plans];
  for (const sel of ['.scale-num', '.scale-den']) {
    const x = $<HTMLInputElement>(sel, a.root);
    const y = $<HTMLInputElement>(sel, b.root);
    [x.value, y.value] = [y.value, x.value];
  }
  // 比較先を s 動かすのは比較元を −s 動かすのと同じなので、入れ替えたら向きを反転して位置関係を保つ
  for (const input of shiftInputs) {
    const v = Number(input.value);
    if (Number.isFinite(v) && v !== 0) input.value = String(-v);
  }
  renderSide(a);
  renderSide(b);
  onDataChanged(true);
});

// ───────── 解析条件 ─────────

const num = (id: string) => Number($<HTMLInputElement>(id).value);
const preset = $<HTMLSelectElement>('#preset');
const normAuto = $<HTMLInputElement>('#p-normauto');
const normInput = $<HTMLInputElement>('#p-normdose');

function updateNormDose(): void {
  normInput.disabled = normAuto.checked;
  if (normAuto.checked) normInput.value = display ? maxValue(display.ref.data).toFixed(3) : '';
}

normAuto.addEventListener('change', () => {
  updateNormDose();
  markStale();
});

function markStale(): void {
  if (result && !stale) {
    stale = true;
    setStatus($('#run-status'), (t) => t.run.stale);
  }
}

/** 画面の入力欄の値 (検証前) */
function formValues(): PresetParams {
  return {
    ddPercent: num('#p-dd'),
    dtaMm: num('#p-dta'),
    local: $<HTMLInputElement>('input[name="norm"]:checked').value === 'local',
    normAuto: normAuto.checked,
    normDoseGy: normAuto.checked ? null : num('#p-normdose'),
    gammaThresholdPercent: num('#p-gthr'),
    ddThresholdPercent: num('#p-ddthr'),
    ddLowGradientOnly: $<HTMLInputElement>('#p-ddlow').checked,
    gradientThresholdPercentPerMm: num('#p-grad'),
    gammaCap: num('#p-cap'),
    stepsPerDta: Math.round(num('#p-steps')),
    toleranceLevel: num('#p-tol'),
    actionLevel: num('#p-act'),
  };
}

/** 判定基準。不正なら欄を赤枠にして null */
function levelsOf(): ActionLevels | null {
  const l = { tolerance: num('#p-tol'), action: num('#p-act') };
  const ok = validLevels(l);
  for (const id of ['#p-tol', '#p-act']) $(id).setAttribute('aria-invalid', String(!ok));
  return ok ? l : null;
}

/** 入力欄に条件を入れる */
function applyForm(p: PresetParams): void {
  const set = (id: string, v: number) => ($<HTMLInputElement>(id).value = String(v));
  set('#p-dd', p.ddPercent);
  set('#p-dta', p.dtaMm);
  $<HTMLInputElement>(`input[name="norm"][value="${p.local ? 'local' : 'global'}"]`).checked = true;
  normAuto.checked = p.normAuto;
  if (!p.normAuto && p.normDoseGy !== null) normInput.value = String(p.normDoseGy);
  set('#p-gthr', p.gammaThresholdPercent);
  set('#p-ddthr', p.ddThresholdPercent);
  $<HTMLInputElement>('#p-ddlow').checked = p.ddLowGradientOnly;
  set('#p-grad', p.gradientThresholdPercentPerMm);
  set('#p-cap', p.gammaCap);
  set('#p-steps', p.stepsPerDta);
  set('#p-tol', p.toleranceLevel);
  set('#p-act', p.actionLevel);
  levelsOf();
  renderSummary();
  updateNormDose();
  markStale();
}

/** 条件を検証し、不正なら理由を投げる。requireNormDose: 基準線量の値まで確かめるか (解析実行時) */
function checkForm(p: PresetParams, requireNormDose: boolean): void {
  type Key = keyof Messages['params']['invalid'];
  const bad = (cond: boolean, key: Key) => {
    if (cond) throw new LocalizedError((t) => t.params.invalid[key]);
  };
  bad(!(p.ddPercent > 0), 'dd');
  bad(!(p.dtaMm > 0), 'dta');
  if (requireNormDose || !p.normAuto) bad(!(num('#p-normdose') > 0), 'normDose');
  bad(!(p.gammaThresholdPercent >= 0 && p.gammaThresholdPercent < 100), 'gammaThreshold');
  bad(!(p.ddThresholdPercent >= 0 && p.ddThresholdPercent < 100), 'ddThreshold');
  bad(!(p.gradientThresholdPercentPerMm >= 0), 'gradient');
  bad(!(p.gammaCap >= 1 && p.gammaCap <= 3), 'cap');
  bad(!(p.stepsPerDta >= 2 && p.stepsPerDta <= 20), 'steps');
  bad(!validLevels({ tolerance: p.toleranceLevel, action: p.actionLevel }), 'levels');
}

function readParams(): AnalysisParams {
  const f = formValues();
  checkForm(f, true);
  const { normAuto: _auto, normDoseGy: _norm, toleranceLevel: _tol, actionLevel: _act, ...rest } = f;
  return { ...DEFAULT_PARAMS, ...rest, normDoseGy: num('#p-normdose') };
}

// ───────── プリセット ─────────

const SAVED_PREFIX = 'saved:';
const presetStore = new PresetStore(browserStorage());
const savedGroup = document.createElement('optgroup');
preset.insertBefore(savedGroup, preset.querySelector('option[value="custom"]'));
const presetStatus = $('#preset-status');
const presetDelete = $<HTMLButtonElement>('#preset-delete');

function renderPresetOptions(selected?: string): void {
  savedGroup.replaceChildren(...presetStore.all().map((p) => new Option(p.name, SAVED_PREFIX + p.name)));
  savedGroup.hidden = savedGroup.children.length === 0;
  if (selected !== undefined) preset.value = selected;
  presetDelete.disabled = !preset.value.startsWith(SAVED_PREFIX);
}

/** 入力欄の値に合う選択肢にする (保存した条件のままならそのまま、違えば標準の基準か「カスタム」) */
function syncPresetSelect(): void {
  const f = formValues();
  if (preset.value.startsWith(SAVED_PREFIX)) {
    const saved = presetStore.get(preset.value.slice(SAVED_PREFIX.length));
    if (saved && JSON.stringify(saved.params) === JSON.stringify(validateParams(f))) return;
  }
  const key = `${f.ddPercent},${f.dtaMm}`;
  preset.value = [...preset.options].some((o) => o.value === key) ? key : 'custom';
  presetDelete.disabled = true;
}

preset.addEventListener('change', () => {
  presetDelete.disabled = !preset.value.startsWith(SAVED_PREFIX);
  if (preset.value === 'custom') return;
  if (preset.value.startsWith(SAVED_PREFIX)) {
    const saved = presetStore.get(preset.value.slice(SAVED_PREFIX.length));
    if (saved) applyForm(saved.params);
    return;
  }
  const [dd, dta] = preset.value.split(',');
  $<HTMLInputElement>('#p-dd').value = dd;
  $<HTMLInputElement>('#p-dta').value = dta;
  markStale();
});

$$<HTMLInputElement>('.params input').forEach((i) => {
  if (i.closest('.presets')) return;
  i.addEventListener('input', syncPresetSelect);
  i.addEventListener('change', () => {
    syncPresetSelect();
    // 判定基準は計算に影響しないので、再解析せずに判定だけ更新する
    if (i.classList.contains('level')) renderSummary();
    else markStale();
  });
});

$('#preset-save').addEventListener('click', () => {
  const name = normalizeName($<HTMLInputElement>('#preset-name').value);
  if (!name) {
    setStatus(presetStatus, (t) => t.presets.nameRequired);
    return;
  }
  const f = formValues();
  try {
    checkForm(f, false);
  } catch (e) {
    const reason = errorMsg(e);
    setStatus(presetStatus, (t) => t.presets.invalidParams(reason(t)));
    return;
  }
  const params = validateParams(f);
  if (!params) return;
  const existed = !!presetStore.get(name);
  presetStore.save(name, params);
  renderPresetOptions(SAVED_PREFIX + name);
  setStatus(presetStatus, (t) => (existed ? t.presets.overwritten(name) : t.presets.saved(name)));
});

presetDelete.addEventListener('click', () => {
  if (!preset.value.startsWith(SAVED_PREFIX)) return;
  const name = preset.value.slice(SAVED_PREFIX.length);
  presetStore.remove(name);
  renderPresetOptions();
  syncPresetSelect();
  setStatus(presetStatus, (t) => t.presets.deleted(name));
});

$('#preset-export').addEventListener('click', () => {
  const all = presetStore.all();
  if (!all.length) {
    setStatus(presetStatus, (t) => t.presets.noneToExport);
    return;
  }
  const url = URL.createObjectURL(new Blob([serializePresets(all)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'gamma3d-presets.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  setStatus(presetStatus, (t) => t.presets.exported(all.length));
});

const presetFile = $<HTMLInputElement>('#preset-file');
$('#preset-import').addEventListener('click', () => presetFile.click());
presetFile.addEventListener('change', async () => {
  const file = presetFile.files?.[0];
  presetFile.value = '';
  if (!file) return;
  try {
    const { presets, rejected } = parsePresetFile(await file.text());
    presetStore.import(presets);
    renderPresetOptions();
    syncPresetSelect();
    setStatus(presetStatus, (t) => t.presets.imported(presets.length, rejected));
  } catch {
    setStatus(presetStatus, (t) => t.presets.importError);
  }
});

renderPresetOptions();
if (!presetStore.persistent) setStatus(presetStatus, (t) => t.presets.notPersistent);

// ───────── 解析実行 ─────────

const runBtn = $<HTMLButtonElement>('#run');
const cancelBtn = $<HTMLButtonElement>('#cancel');
const pdfBtn = $<HTMLButtonElement>('#pdf');
const progress = $<HTMLProgressElement>('#progress');
const runStatus = $('#run-status');

function updateButtons(): void {
  const running = !!abort;
  swapBtn.disabled = running || (sides.ref.fileCount === 0 && sides.eval.fileCount === 0);
  runBtn.disabled = running || !display?.evalOnRef;
  cancelBtn.hidden = !running;
  pdfBtn.disabled = running || !result;
}

runBtn.addEventListener('click', async () => {
  if (!display || !sides.eval.selected) return;
  let params: AnalysisParams;
  try {
    params = readParams();
  } catch (e) {
    setStatus(runStatus, errorMsg(e));
    return;
  }
  abort = new AbortController();
  progress.hidden = false;
  progress.value = 0;
  setStatus(runStatus, (t) => t.run.running);
  updateButtons();
  try {
    const ev = evalVolume(sides.eval.selected);
    const batch = $<HTMLInputElement>('#p-batch').checked;
    const list = batch ? STANDARD_CRITERIA.map(([dd, dta]) => ({ ...params, ddPercent: dd, dtaMm: dta })) : [params];
    results = await runAnalyses(display.ref, ev, list, (f) => (progress.value = f), abort.signal);
    resultStats = results.map((r) => gammaStats(r.gamma, r.params.gammaCap));
    stale = false;
    const r0 = results[0];
    const n = results.length;
    setStatus(runStatus, (t) => t.run.done((r0.elapsedMs / 1000).toFixed(1), r0.workers, r0.sharedMemory, t.run.engine[r0.engine], n));
    // 入力欄の条件と同じものがあればそれを、なければ最初の条件を表示する
    selectResult(Math.max(0, list.findIndex((p) => p.ddPercent === params.ddPercent && p.dtaMm === params.dtaMm)));
  } catch (e) {
    const err = errorMsg(e);
    setStatus(runStatus, e instanceof AnalysisCancelled ? (t) => t.run.cancelled : (t) => t.run.error(err(t)));
  } finally {
    abort = null;
    progress.hidden = true;
    updateButtons();
  }
});

cancelBtn.addEventListener('click', () => abort?.abort());

/** 比較元・比較先の組み合わせに関する注意事項 */
function crossWarnings(): Msg[] {
  const out: Msg[] = [];
  const a = sides.ref.selected;
  const b = sides.eval.selected;
  if (a && b) {
    if (a.frameOfReferenceUID !== b.frameOfReferenceUID) {
      const shift = shiftOf();
      const [x, y, z] = formatShift(shift);
      out.push(isShifted(shift) ? (t) => t.summary.warnFrameOfReferenceShifted(`(${x}, ${y}, ${z})`) : (t) => t.summary.warnFrameOfReference);
    }
    if (a.patientId !== b.patientId) out.push((t) => t.summary.warnPatientId(a.patientId || '–', b.patientId || '–'));
  }
  if (result) {
    const p = result.params;
    const thr = (p.gammaThresholdPercent / 100) * p.normDoseGy;
    let outside = 0;
    for (let n = 0; n < result.evalOnRef.length; n++) if (Number.isNaN(result.evalOnRef[n]) && result.ref.data[n] >= thr) outside++;
    if (outside) out.push((t) => t.summary.warnOutside(outside.toLocaleString()));
  }
  return out;
}

const JUDGMENT_ICON: Record<Judgment, string> = { pass: '✓', review: '!', fail: '✕' };

/** 判定の表示 (色だけでなくアイコンと文字でも示す) */
function judgmentBadge(j: Judgment, levels: ActionLevels | null): HTMLElement {
  const b = document.createElement('span');
  b.className = `judgment ${j}`;
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = JUDGMENT_ICON[j];
  const label = document.createElement('strong');
  label.textContent = m().judgment[j];
  b.append(icon, label);
  if (levels) {
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = m().judgment.levels(levels.tolerance, levels.action);
    b.append(note);
  }
  return b;
}

function stat(label: string, value: string, sub: string, cls = ''): HTMLElement {
  const d = document.createElement('div');
  d.className = `stat ${cls}`;
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'value';
  v.textContent = value;
  const s = document.createElement('span');
  s.className = 'sub';
  s.textContent = sub;
  d.append(l, v, s);
  return d;
}

/** 表示する結果を切り替える (一括計算の比較表から) */
function selectResult(i: number): void {
  if (!display || !results[i]) return;
  result = results[i];
  derived = derive(result);
  display.evalOnRef = result.evalOnRef;
  renderViews();
  renderCharts();
  renderSummary();
}

const criteriaLabel = (p: AnalysisParams) => `${p.ddPercent}%/${p.dtaMm}mm`;

/** 一括計算の比較表 (行を選ぶと表示を切り替える) */
function comparisonTable(): HTMLElement {
  const t = m().compare;
  const f = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : '–');
  const levels = levelsOf();
  const table = document.createElement('table');
  table.className = 'compare';
  const caption = table.createCaption();
  caption.textContent = t.title;
  const head = table.createTHead().insertRow();
  for (const h of [t.criteria, t.passRate, t.mean, t.p99, t.judgment]) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = h;
    head.append(th);
  }
  const body = table.createTBody();
  results.forEach((r, i) => {
    const st = resultStats[i];
    const row = body.insertRow();
    const current = r === result;
    row.className = current ? 'selected' : '';
    const cell = row.insertCell();
    const btn = document.createElement('button');
    btn.textContent = criteriaLabel(r.params);
    btn.setAttribute('aria-pressed', String(current));
    btn.addEventListener('click', () => selectResult(i));
    cell.append(btn);
    row.insertCell().textContent = `${f(st.passRate, 2)}%`;
    row.insertCell().textContent = f(st.mean, 3);
    row.insertCell().textContent = f(st.p99, 3);
    const jc = row.insertCell();
    const j = levels ? judge(st.passRate, levels) : null;
    if (j && levels) jc.append(judgmentBadge(j, null));
  });
  return table;
}

function renderSummary(): void {
  const box = $('#summary');
  const warnings = crossWarnings();
  const nodes: HTMLElement[] = [];
  const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
  const s = m().summary;
  if (result && derived) {
    const p = result.params;
    const g = derived.gamma;
    const gammaTile = stat(
      s.gammaLabel(p.ddPercent, p.dtaMm, p.local, p.gammaThresholdPercent),
      `${f(g.passRate, 2)}%`,
      s.gammaSub(g.evaluated.toLocaleString(), f(g.mean, 2), f(g.p99, 2), g.maxCapped ? `≥${p.gammaCap}` : f(g.max, 2)),
    );
    const levels = levelsOf();
    const j = levels ? judge(g.passRate, levels) : null;
    if (j && levels) gammaTile.querySelector('.value')!.after(judgmentBadge(j, levels));
    nodes.push(
      gammaTile,
      stat(
        s.ddLabel(p.ddPercent),
        `${f(derived.dd.passRate, 1)}%`,
        s.ddSub(derived.dd.evaluated.toLocaleString(), f(derived.dd.meanPct, 2), f(derived.dd.sdPct, 2)),
      ),
      stat(
        s.dtaLabel(p.dtaMm, p.gradientThresholdPercentPerMm),
        `${f(derived.dta.passRate, 1)}%`,
        s.dtaSub(derived.dta.evaluated.toLocaleString(), f(derived.dta.mean, 2), derived.dta.notFound.toLocaleString()),
      ),
    );
    if (results.length > 1) nodes.push(comparisonTable());
  } else if (!display || !sides.eval.selected) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = s.empty;
    nodes.push(p);
  }
  if (warnings.length) {
    const ul = document.createElement('ul');
    ul.className = 'warnings';
    ul.style.alignSelf = 'center';
    ul.replaceChildren(
      ...warnings.map((w) => {
        const li = document.createElement('li');
        li.textContent = text(w);
        return li;
      }),
    );
    nodes.push(ul);
  }
  box.replaceChildren(...nodes);
}

// ───────── PDF ─────────

pdfBtn.addEventListener('click', async () => {
  if (!result || !derived || !display || !sides.ref.selected || !sides.eval.selected) return;
  const status = $('#pdf-status');
  pdfBtn.disabled = true;
  setStatus(status, (t) => t.report.creating);
  try {
    const { generateReport, reportFileName } = await import('./report/pdf.ts');
    const input = {
      version: __APP_VERSION__,
      result,
      derived,
      ddUnit,
      ref: { set: sides.ref.selected, scale: scaleOf(sides.ref), plan: planOf(sides.ref) },
      ev: { set: sides.eval.selected, scale: scaleOf(sides.eval), plan: planOf(sides.eval) },
      displayMax: display.max,
      doseWindow: doseWindow(),
      shift: shiftOf(),
      levels: levelsOf(),
      comparison: results.length > 1 ? results.map((r, i) => ({ label: criteriaLabel(r.params), stats: resultStats[i], selected: r === result })) : null,
      warnings: [...crossWarnings(), ...sides.ref.selected.warnings, ...sides.eval.selected.warnings, ...(stale ? [(t: Messages) => t.report.staleWarning] : [])],
      cursor: [...cursor] as Ijk,
      includePatient: $<HTMLInputElement>('#r-patient').checked,
      reviewer: $<HTMLInputElement>('#r-reviewer').value.trim(),
      comment: $<HTMLTextAreaElement>('#r-comment').value.trim(),
    };
    const blob = await generateReport(input);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = reportFileName(input);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    const file = a.download;
    setStatus(status, (t) => t.report.done(file));
  } catch (e) {
    const err = errorMsg(e);
    setStatus(status, (t) => t.run.error(err(t)));
  } finally {
    updateButtons();
  }
});

// 言語の切り替え: 文言を入れ直し、表示中のものを作り直す
onLangChange(() => {
  applyTranslations();
  localizeStatic();
  applyView();
  savedGroup.label = m().presets.savedGroup;
  for (const side of Object.values(sides)) {
    if (side.fileCount) renderSide(side);
    scaleOf(side);
  }
  renderViews();
  renderCharts();
  renderSummary();
  for (const [el, msg] of statusMsgs) el.textContent = text(msg);
});

// 初期表示
savedGroup.label = m().presets.savedGroup;
renderViews();
renderSummary();
renderCharts();
updateButtons();
