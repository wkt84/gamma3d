import './style.css';
import { DEFAULT_PARAMS, type AnalysisParams } from './core/gamma.ts';
import { AnalysisCancelled, runAnalysis, type AnalysisResult } from './core/runner.ts';
import { maxValue, resampleTo, type Volume } from './core/volume.ts';
import { buildDoseSets, scaled, scaleFactor, type DoseScale, type DoseSet } from './dicom/group.ts';
import { isRtDose, parseRtDose, type RtDose } from './dicom/rtdose.ts';
import { ddColorMap, doseColorMap, dtaColorMap, gammaColorMap, gradientColorMap, type ColorMap } from './ui/colormap.ts';
import { HistogramView, SlicePanel } from './ui/components.ts';
import { derive, histSpecs, type DdUnit, type Derived } from './ui/results.ts';
import { imageToVoxel, PLANES, renderSlice, voxelToImage, type Ijk, type Plane } from './ui/slice.ts';
import { applyTranslations, errorMsg, m, text, type Messages, type Msg } from './i18n/index.ts';
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
}

type MapMode = 'gamma' | 'dd' | 'dta' | 'grad';

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

const sides: Record<SideKey, Side> = {
  ref: { key: 'ref', root: $('[data-side="ref"]'), doses: [], sets: [], selected: null, notices: [], fileCount: 0 },
  eval: { key: 'eval', root: $('[data-side="eval"]'), doses: [], sets: [], selected: null, notices: [], fileCount: 0 },
};

let plane: Plane = 'axial';
let cursor: Ijk = [0, 0, 0];
let mapMode: MapMode = 'gamma';
let ddUnit: DdUnit = 'percent';
/** 表示用: 比較元 (係数適用済み) と、比較元格子へ補間した比較先 */
let display: { ref: Volume; evalOnRef: Float32Array | null; max: number } | null = null;
let result: AnalysisResult | null = null;
let derived: Derived | null = null;
let stale = false;
let abort: AbortController | null = null;

const BG: [number, number, number] = [10, 10, 10];

applyTranslations();

// ───────── ビュー ─────────

const mapSelect = document.createElement('select');
mapSelect.setAttribute('aria-label', m().viewer.mapType);
for (const v of ['gamma', 'dd', 'dta', 'grad'] as const) {
  mapSelect.add(new Option(m().viewer.maps[v], v));
}
const ddUnitSelect = document.createElement('select');
ddUnitSelect.setAttribute('aria-label', m().viewer.ddUnit);
ddUnitSelect.add(new Option('%', 'percent'));
ddUnitSelect.add(new Option('Gy', 'gy'));
const mapHead = document.createElement('span');
mapHead.style.display = 'flex';
mapHead.style.gap = '6px';
mapHead.append(mapSelect, ddUnitSelect);

const panelRef = new SlicePanel($('#panel-ref'), m().viewer.refPanel);
const panelEval = new SlicePanel($('#panel-eval'), m().viewer.evalPanel);
const panelMap = new SlicePanel($('#panel-map'), m().viewer.mapPanel, mapHead);
const panels = [panelRef, panelEval, panelMap];
const charts = [
  new HistogramView($('#chart-dd'), m().viewer.histEmpty.dd),
  new HistogramView($('#chart-dta'), m().viewer.histEmpty.dta),
  new HistogramView($('#chart-gamma'), m().viewer.histEmpty.gamma),
];

const slider = $<HTMLInputElement>('#slice');
const sliceLabel = $('#slice-label');
const readout = $('#readout');

$('#app-meta').textContent = m().app.meta(__APP_VERSION__);

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
  const doseMap = doseColorMap(display.max);

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
  const notices: Msg[] = [];
  let skipped = 0;
  const candidates = files.filter((f) => !f.name.startsWith('.'));
  for (let i = 0; i < candidates.length; i++) {
    const f = candidates[i];
    summary.textContent = m().side.loading(i + 1, candidates.length);
    const name = f.webkitRelativePath || f.name;
    try {
      // 先頭だけで Modality を判定し、CT など RTDOSE 以外は本体を読まない
      const head = new Uint8Array(await f.slice(0, 65536).arrayBuffer());
      if (!isRtDose(head)) {
        skipped++;
        continue;
      }
      doses.push(parseRtDose(await f.arrayBuffer(), name));
    } catch (e) {
      notices.push(e instanceof Error ? errorMsg(e) : (t) => t.side.loadFailed(name));
    }
  }
  if (skipped) notices.push((t) => t.side.skipped(skipped));
  if (!doses.length) notices.push((t) => t.side.noRtdose);

  side.doses = doses;
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
  const list = $('.file-list', side.root);
  $('summary', list).textContent = m().side.fileCount(side.doses.length, side.fileCount);
  $('ul', list).replaceChildren(
    ...side.doses.map((d) => {
      const li = document.createElement('li');
      const beams = d.referencedBeamNumbers.length ? ` #${d.referencedBeamNumbers.join(',')}` : '';
      li.textContent = `${d.fileName} (${d.summationType}${beams})`;
      return li;
    }),
  );
  $('.warnings', side.root).replaceChildren(
    ...[...side.notices, ...(s?.warnings ?? [])].map((w) => {
      const li = document.createElement('li');
      li.textContent = text(w);
      return li;
    }),
  );
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

/** データ・係数が変わったとき: 結果を破棄して表示を作り直す */
function onDataChanged(resetCursor: boolean): void {
  if (result) runStatus.textContent = '';
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
      evalOnRef = resampleTo(scaled(ev.volume, factorOf(sides.eval)), refVol, NaN).data;
      for (let n = 0; n < evalOnRef.length; n++) if (evalOnRef[n] > max) max = evalOnRef[n];
    }
    const sameGrid = display && display.ref.dims.join() === refVol.dims.join();
    display = { ref: refVol, evalOnRef, max };
    if (resetCursor || !sameGrid) cursor = argmax(refVol);
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
}

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
  for (const sel of ['.scale-num', '.scale-den']) {
    const x = $<HTMLInputElement>(sel, a.root);
    const y = $<HTMLInputElement>(sel, b.root);
    [x.value, y.value] = [y.value, x.value];
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
    $('#run-status').textContent = m().run.stale;
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
  };
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
  updateNormDose();
  markStale();
}

/** 条件を検証し、不正なら理由を投げる。requireNormDose: 基準線量の値まで確かめるか (解析実行時) */
function checkForm(p: PresetParams, requireNormDose: boolean): void {
  const bad = (cond: boolean, msg: string) => {
    if (cond) throw new Error(msg);
  };
  const e = m().params.invalid;
  bad(!(p.ddPercent > 0), e.dd);
  bad(!(p.dtaMm > 0), e.dta);
  if (requireNormDose || !p.normAuto) bad(!(num('#p-normdose') > 0), e.normDose);
  bad(!(p.gammaThresholdPercent >= 0 && p.gammaThresholdPercent < 100), e.gammaThreshold);
  bad(!(p.ddThresholdPercent >= 0 && p.ddThresholdPercent < 100), e.ddThreshold);
  bad(!(p.gradientThresholdPercentPerMm >= 0), e.gradient);
  bad(!(p.gammaCap >= 1 && p.gammaCap <= 3), e.cap);
  bad(!(p.stepsPerDta >= 2 && p.stepsPerDta <= 20), e.steps);
}

function readParams(): AnalysisParams {
  const f = formValues();
  checkForm(f, true);
  const { normAuto: _auto, normDoseGy: _norm, ...rest } = f;
  return { ...DEFAULT_PARAMS, ...rest, normDoseGy: num('#p-normdose') };
}

// ───────── プリセット ─────────

const SAVED_PREFIX = 'saved:';
const presetStore = new PresetStore(browserStorage());
const savedGroup = document.createElement('optgroup');
savedGroup.label = m().presets.savedGroup;
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
    markStale();
  });
});

$('#preset-save').addEventListener('click', () => {
  const t = m().presets;
  const name = normalizeName($<HTMLInputElement>('#preset-name').value);
  if (!name) {
    presetStatus.textContent = t.nameRequired;
    return;
  }
  const f = formValues();
  try {
    checkForm(f, false);
  } catch (e) {
    presetStatus.textContent = t.invalidParams((e as Error).message);
    return;
  }
  const params = validateParams(f);
  if (!params) return;
  const existed = !!presetStore.get(name);
  presetStore.save(name, params);
  renderPresetOptions(SAVED_PREFIX + name);
  presetStatus.textContent = existed ? t.overwritten(name) : t.saved(name);
});

presetDelete.addEventListener('click', () => {
  if (!preset.value.startsWith(SAVED_PREFIX)) return;
  const name = preset.value.slice(SAVED_PREFIX.length);
  presetStore.remove(name);
  renderPresetOptions();
  syncPresetSelect();
  presetStatus.textContent = m().presets.deleted(name);
});

$('#preset-export').addEventListener('click', () => {
  const t = m().presets;
  const all = presetStore.all();
  if (!all.length) {
    presetStatus.textContent = t.noneToExport;
    return;
  }
  const url = URL.createObjectURL(new Blob([serializePresets(all)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'gamma3d-presets.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  presetStatus.textContent = t.exported(all.length);
});

const presetFile = $<HTMLInputElement>('#preset-file');
$('#preset-import').addEventListener('click', () => presetFile.click());
presetFile.addEventListener('change', async () => {
  const file = presetFile.files?.[0];
  presetFile.value = '';
  if (!file) return;
  const t = m().presets;
  try {
    const { presets, rejected } = parsePresetFile(await file.text());
    presetStore.import(presets);
    renderPresetOptions();
    syncPresetSelect();
    presetStatus.textContent = t.imported(presets.length, rejected);
  } catch {
    presetStatus.textContent = t.importError;
  }
});

renderPresetOptions();
if (!presetStore.persistent) presetStatus.textContent = m().presets.notPersistent;

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
    runStatus.textContent = (e as Error).message;
    return;
  }
  abort = new AbortController();
  progress.hidden = false;
  progress.value = 0;
  runStatus.textContent = m().run.running;
  updateButtons();
  try {
    const ev = scaled(sides.eval.selected.volume, factorOf(sides.eval));
    result = await runAnalysis(display.ref, ev, params, (f) => (progress.value = f), abort.signal);
    derived = derive(result);
    stale = false;
    display.evalOnRef = result.evalOnRef;
    runStatus.textContent = m().run.done((result.elapsedMs / 1000).toFixed(1), result.workers, result.sharedMemory);
    renderViews();
    renderCharts();
    renderSummary();
  } catch (e) {
    runStatus.textContent = e instanceof AnalysisCancelled ? m().run.cancelled : m().run.error((e as Error).message);
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
    if (a.frameOfReferenceUID !== b.frameOfReferenceUID) out.push((t) => t.summary.warnFrameOfReference);
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

function renderSummary(): void {
  const box = $('#summary');
  const warnings = crossWarnings();
  const nodes: HTMLElement[] = [];
  const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
  const s = m().summary;
  if (result && derived) {
    const p = result.params;
    const g = derived.gamma;
    nodes.push(
      stat(
        s.gammaLabel(p.ddPercent, p.dtaMm, p.local, p.gammaThresholdPercent),
        `${f(g.passRate, 2)}%`,
        s.gammaSub(g.evaluated.toLocaleString(), f(g.mean, 2), f(g.p99, 2), g.maxCapped ? `≥${p.gammaCap}` : f(g.max, 2)),
      ),
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
  status.textContent = m().report.creating;
  try {
    const { generateReport, reportFileName } = await import('./report/pdf.ts');
    const input = {
      version: __APP_VERSION__,
      result,
      derived,
      ddUnit,
      ref: { set: sides.ref.selected, scale: scaleOf(sides.ref) },
      ev: { set: sides.eval.selected, scale: scaleOf(sides.eval) },
      displayMax: display.max,
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
    status.textContent = m().report.done(a.download);
  } catch (e) {
    status.textContent = m().run.error((e as Error).message);
  } finally {
    updateButtons();
  }
});

// 初期表示
renderViews();
renderSummary();
renderCharts();
updateButtons();
