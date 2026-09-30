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

// ───────── 状態 ─────────

type SideKey = 'ref' | 'eval';
interface Side {
  key: SideKey;
  root: HTMLElement;
  doses: RtDose[];
  sets: DoseSet[];
  selected: DoseSet | null;
  notices: string[];
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

// ───────── ビュー ─────────

const mapSelect = document.createElement('select');
mapSelect.setAttribute('aria-label', 'マップの種類');
for (const [v, label] of [
  ['gamma', 'ガンマ'],
  ['dd', '線量差'],
  ['dta', 'DTA'],
  ['grad', '線量勾配'],
] as const) {
  mapSelect.add(new Option(label, v));
}
const ddUnitSelect = document.createElement('select');
ddUnitSelect.setAttribute('aria-label', '線量差の単位');
ddUnitSelect.add(new Option('%', 'percent'));
ddUnitSelect.add(new Option('Gy', 'gy'));
const mapHead = document.createElement('span');
mapHead.style.display = 'flex';
mapHead.style.gap = '6px';
mapHead.append(mapSelect, ddUnitSelect);

const panelRef = new SlicePanel($('#panel-ref'), '比較元 (Ref)');
const panelEval = new SlicePanel($('#panel-eval'), '比較先 (Eval)');
const panelMap = new SlicePanel($('#panel-map'), 'マップ', mapHead);
const panels = [panelRef, panelEval, panelMap];
const charts = [
  new HistogramView($('#chart-dd'), '線量差ヒストグラム'),
  new HistogramView($('#chart-dta'), 'DTA ヒストグラム'),
  new HistogramView($('#chart-gamma'), 'ガンマヒストグラム'),
];

const slider = $<HTMLInputElement>('#slice');
const sliceLabel = $('#slice-label');
const readout = $('#readout');

$('#app-meta').textContent = `v${__APP_VERSION__} ・ データはブラウザ内でのみ処理されます`;

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
    panels.forEach((p) => p.message('比較元の RTDOSE を読み込んでください'));
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
    panelEval.message('比較先の RTDOSE を読み込んでください');
  }

  const m = currentMap();
  if (m) {
    panelMap.show(renderSlice(grid, m.values, plane, cursor, m.cmap, BG), cross);
    panelMap.setColorMap(m.cmap);
  } else {
    panelMap.message('解析を実行すると表示されます');
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
  const f = (v: number | undefined, d: number) => (v === undefined || Number.isNaN(v) ? '–' : v === Infinity ? '未検出' : v.toFixed(d));
  const parts = [`(${pos}) mm`, `Ref ${f(g.data[n], 3)} Gy`];
  if (display.evalOnRef) parts.push(`Eval ${f(display.evalOnRef[n], 3)} Gy`);
  if (result && derived) {
    parts.push(`γ ${f(result.gamma[n], 2)}`);
    parts.push(`DD ${f(derived.ddPct[n], 2)}%`);
    parts.push(`DTA ${f(result.dta[n], 2)} mm`);
    parts.push(`勾配 ${f(result.grad[n], 1)}%/mm`);
  }
  readout.textContent = parts.join('  ・  ');
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
  const notices: string[] = [];
  let skipped = 0;
  const candidates = files.filter((f) => !f.name.startsWith('.'));
  for (let i = 0; i < candidates.length; i++) {
    const f = candidates[i];
    summary.textContent = `読み込み中… ${i + 1}/${candidates.length}`;
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
      notices.push(e instanceof Error ? e.message : `${name}: 読み込みに失敗しました`);
    }
  }
  if (skipped) notices.push(`RTDOSE 以外の ${skipped} ファイルを無視しました`);
  if (!doses.length) notices.push('RTDOSE が見つかりませんでした');

  side.doses = doses;
  side.fileCount = candidates.length;
  side.sets = buildDoseSets(doses);
  side.selected = side.sets[0] ?? null;
  side.notices = notices;
  renderSide(side);
  onDataChanged(true);
}

function renderSide(side: Side): void {
  const select = $<HTMLSelectElement>('.set-select', side.root);
  select.replaceChildren(...side.sets.map((s) => new Option(s.label, s.id)));
  select.disabled = side.sets.length < 2;
  if (side.selected) select.value = side.selected.id;
  const s = side.selected;
  $('.set-summary', side.root).textContent = s ? `${s.patientName || '(氏名なし)'} / ${s.patientId || '–'}\n${s.summary}` : '';
  $('.set-summary', side.root).style.whiteSpace = 'pre-line';
  const list = $('.file-list', side.root);
  $('summary', list).textContent = `RTDOSE ${side.doses.length} / ${side.fileCount} ファイル`;
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
      li.textContent = w;
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
  $('.scale-value', side.root).textContent = s.num === 1 && s.den === 1 ? '' : `= ${Number(f.toPrecision(6))} 倍`;
  return s;
}

const factorOf = (side: Side): number => scaleFactor(scaleOf(side));

/** データ・係数が変わったとき: 結果を破棄して表示を作り直す */
function onDataChanged(resetCursor: boolean): void {
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

preset.addEventListener('change', () => {
  if (preset.value === 'custom') return;
  const [dd, dta] = preset.value.split(',');
  $<HTMLInputElement>('#p-dd').value = dd;
  $<HTMLInputElement>('#p-dta').value = dta;
  markStale();
});

for (const id of ['#p-dd', '#p-dta']) {
  $(id).addEventListener('input', () => {
    const key = `${num('#p-dd')},${num('#p-dta')}`;
    preset.value = [...preset.options].some((o) => o.value === key) ? key : 'custom';
  });
}

$$<HTMLInputElement>('.params input').forEach((i) => i.addEventListener('change', markStale));

function markStale(): void {
  if (result && !stale) {
    stale = true;
    $('#run-status').textContent = '解析条件が変更されています。再解析してください。';
  }
}

function readParams(): AnalysisParams {
  const p: AnalysisParams = {
    ...DEFAULT_PARAMS,
    ddPercent: num('#p-dd'),
    dtaMm: num('#p-dta'),
    local: $<HTMLInputElement>('input[name="norm"]:checked').value === 'local',
    normDoseGy: num('#p-normdose'),
    gammaThresholdPercent: num('#p-gthr'),
    ddThresholdPercent: num('#p-ddthr'),
    ddLowGradientOnly: $<HTMLInputElement>('#p-ddlow').checked,
    gradientThresholdPercentPerMm: num('#p-grad'),
    gammaCap: num('#p-cap'),
    stepsPerDta: Math.round(num('#p-steps')),
  };
  const bad = (cond: boolean, msg: string) => {
    if (cond) throw new Error(msg);
  };
  bad(!(p.ddPercent > 0), 'DD は正の値を指定してください');
  bad(!(p.dtaMm > 0), 'DTA は正の値を指定してください');
  bad(!(p.normDoseGy > 0), '基準線量は正の値を指定してください');
  bad(!(p.gammaThresholdPercent >= 0 && p.gammaThresholdPercent < 100), 'γ 閾値は 0–100% で指定してください');
  bad(!(p.ddThresholdPercent >= 0 && p.ddThresholdPercent < 100), 'DD 閾値は 0–100% で指定してください');
  bad(!(p.gradientThresholdPercentPerMm >= 0), '勾配閾値は 0 以上で指定してください');
  bad(!(p.gammaCap >= 1 && p.gammaCap <= 3), 'γ 上限は 1–3 で指定してください');
  bad(!(p.stepsPerDta >= 2 && p.stepsPerDta <= 20), '探索分割数は 2–20 で指定してください');
  return p;
}

// ───────── 解析実行 ─────────

const runBtn = $<HTMLButtonElement>('#run');
const cancelBtn = $<HTMLButtonElement>('#cancel');
const pdfBtn = $<HTMLButtonElement>('#pdf');
const progress = $<HTMLProgressElement>('#progress');
const runStatus = $('#run-status');

function updateButtons(): void {
  const running = !!abort;
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
  runStatus.textContent = '計算中…';
  updateButtons();
  try {
    const ev = scaled(sides.eval.selected.volume, factorOf(sides.eval));
    result = await runAnalysis(display.ref, ev, params, (f) => (progress.value = f), abort.signal);
    derived = derive(result);
    stale = false;
    display.evalOnRef = result.evalOnRef;
    runStatus.textContent = `完了: ${(result.elapsedMs / 1000).toFixed(1)} 秒 (${result.workers} スレッド${result.sharedMemory ? '' : '、共有メモリなし'})`;
    renderViews();
    renderCharts();
    renderSummary();
  } catch (e) {
    runStatus.textContent = e instanceof AnalysisCancelled ? '中止しました' : `エラー: ${(e as Error).message}`;
  } finally {
    abort = null;
    progress.hidden = true;
    updateButtons();
  }
});

cancelBtn.addEventListener('click', () => abort?.abort());

/** 比較元・比較先の組み合わせに関する注意事項 */
function crossWarnings(): string[] {
  const out: string[] = [];
  const a = sides.ref.selected;
  const b = sides.eval.selected;
  if (a && b) {
    if (a.frameOfReferenceUID !== b.frameOfReferenceUID) out.push('比較元と比較先の FrameOfReferenceUID が異なります (位置合わせは行っていません)');
    if (a.patientId !== b.patientId) out.push(`比較元と比較先の患者 ID が異なります (${a.patientId || '–'} / ${b.patientId || '–'})`);
  }
  if (result) {
    const p = result.params;
    const thr = (p.gammaThresholdPercent / 100) * p.normDoseGy;
    let outside = 0;
    for (let n = 0; n < result.evalOnRef.length; n++) if (Number.isNaN(result.evalOnRef[n]) && result.ref.data[n] >= thr) outside++;
    if (outside) out.push(`γ 閾値以上の比較元 ${outside.toLocaleString()} 点が比較先の範囲外のため評価対象外です`);
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
  if (result && derived) {
    const p = result.params;
    const g = derived.gamma;
    nodes.push(
      stat(
        `ガンマ パス率 (${p.ddPercent}%/${p.dtaMm}mm ${p.local ? 'Local' : 'Global'}, 閾値 ${p.gammaThresholdPercent}%)`,
        `${f(g.passRate, 2)}%`,
        `n=${g.evaluated.toLocaleString()} ・ 平均 ${f(g.mean, 2)} ・ γ1% ${f(g.p99, 2)} ・ 最大 ${g.maxCapped ? `≥${p.gammaCap}` : f(g.max, 2)}`,
      ),
      stat(
        `線量差 ±${p.ddPercent}% 以内`,
        `${f(derived.dd.passRate, 1)}%`,
        `n=${derived.dd.evaluated.toLocaleString()} ・ 平均 ${f(derived.dd.meanPct, 2)} ± ${f(derived.dd.sdPct, 2)}%`,
      ),
      stat(
        `DTA ≤ ${p.dtaMm} mm (勾配 ≥ ${p.gradientThresholdPercentPerMm}%/mm)`,
        `${f(derived.dta.passRate, 1)}%`,
        `n=${derived.dta.evaluated.toLocaleString()} ・ 平均 ${f(derived.dta.mean, 2)} mm ・ 未検出 ${derived.dta.notFound.toLocaleString()}`,
      ),
    );
  } else if (!display || !sides.eval.selected) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '比較元と比較先の RTDOSE を読み込み、「解析実行」を押してください。';
    nodes.push(p);
  }
  if (warnings.length) {
    const ul = document.createElement('ul');
    ul.className = 'warnings';
    ul.style.alignSelf = 'center';
    ul.replaceChildren(
      ...warnings.map((w) => {
        const li = document.createElement('li');
        li.textContent = w;
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
  status.textContent = 'レポートを作成中… (初回はフォントの読み込みに時間がかかります)';
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
      warnings: [...crossWarnings(), ...sides.ref.selected.warnings, ...sides.eval.selected.warnings, ...(stale ? ['レポート作成時点で解析条件が変更されています (表示中の結果は変更前の条件によるもの)'] : [])],
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
    status.textContent = `${a.download} を出力しました (表示中の断面位置の画像を掲載)`;
  } catch (e) {
    status.textContent = `エラー: ${(e as Error).message}`;
  } finally {
    updateButtons();
  }
});

// 初期表示
renderViews();
renderCharts();
updateButtons();
