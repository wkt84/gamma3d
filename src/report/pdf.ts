import type { jsPDF as JsPDF } from 'jspdf';
import type { AnalysisResult } from '../core/runner.ts';
import { formatScale, scaleFactor, type DoseScale, type DoseSet } from '../dicom/group.ts';
import { doseColorMap, gammaColorMap, type ColorMap } from '../ui/colormap.ts';
import { drawHistogram, LIGHT_CHART_THEME } from '../ui/histogram-chart.ts';
import { histSpecs, type DdUnit, type Derived } from '../ui/results.ts';
import { drawSlice, PLANES, renderSlice, voxelToImage, type Ijk, type Plane } from '../ui/slice.ts';
import type { Vec3 } from '../core/volume.ts';
import { judge, type ActionLevels, type Judgment } from '../core/judgment.ts';
import type { GammaStats } from '../core/stats.ts';
import type { RtPlan } from '../dicom/rtplan.ts';
import { m, text as msgText, type Msg } from '../i18n/index.ts';

export interface ReportSide {
  set: DoseSet;
  scale: DoseScale;
  plan: RtPlan | null;
}

export interface ReportInput {
  version: string;
  result: AnalysisResult;
  derived: Derived;
  ddUnit: DdUnit;
  ref: ReportSide;
  ev: ReportSide;
  displayMax: number;
  /** 比較先の平行移動 (mm) */
  shift: Vec3;
  /** 判定基準 (不正なら null で、判定は載せない) */
  levels: ActionLevels | null;
  /** 一括計算したときの条件の比較 (1 条件なら null) */
  comparison: { label: string; stats: GammaStats; selected: boolean }[] | null;
  warnings: Msg[];
  cursor: Ijk;
  includePatient: boolean;
  reviewer: string;
  comment: string;
}

const FONT = 'NotoSansJP';
let fontCache: Promise<{ regular: string; bold: string }> | null = null;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

/** 日本語フォントは PDF 出力時に初めて読み込む (約 5MB ×2、以後はキャッシュ) */
function loadFonts(): Promise<{ regular: string; bold: string }> {
  fontCache ??= (async () => {
    const get = async (file: string) => {
      const res = await fetch(`${import.meta.env.BASE_URL}fonts/${file}`);
      if (!res.ok) throw new Error(m().report.fontError(file));
      return toBase64(await res.arrayBuffer());
    };
    const [regular, bold] = await Promise.all([get('NotoSansJP-Regular.ttf'), get('NotoSansJP-Bold.ttf')]);
    return { regular, bold };
  })().catch((e) => {
    fontCache = null;
    throw e;
  });
  return fontCache;
}

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const pad2 = (n: number) => String(n).padStart(2, '0');
function stamp(d: Date, sep = ' '): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}${sep}${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function colorbarPng(cmap: ColorMap): string {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 8;
  const ctx = c.getContext('2d')!;
  for (let x = 0; x < 256; x++) {
    const v = cmap.min + ((x + 0.5) / 256) * (cmap.max - cmap.min);
    const rgb = cmap.rgb(v) ?? [0, 0, 0];
    ctx.fillStyle = `rgb(${rgb.join(',')})`;
    ctx.fillRect(x, 0, 1, 8);
  }
  return c.toDataURL('image/png');
}

export async function generateReport(input: ReportInput): Promise<Blob> {
  const [{ jsPDF }, fonts] = await Promise.all([import('jspdf'), loadFonts()]);
  const doc: JsPDF = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  doc.addFileToVFS('NotoSansJP-Regular.ttf', fonts.regular);
  doc.addFont('NotoSansJP-Regular.ttf', FONT, 'normal');
  doc.addFileToVFS('NotoSansJP-Bold.ttf', fonts.bold);
  doc.addFont('NotoSansJP-Bold.ttf', FONT, 'bold');

  const { result: r, derived: d } = input;
  const p = r.params;
  const t = m().pdf;
  const now = new Date();
  const W = 210;
  const M = 14;
  const CW = W - 2 * M;
  const ink = (g: number) => doc.setTextColor(g, g, g);

  const text = (s: string, x: number, y: number, size = 9, weight: 'normal' | 'bold' = 'normal', opts?: { align?: 'left' | 'right' | 'center' }) => {
    doc.setFont(FONT, weight);
    doc.setFontSize(size);
    doc.text(s, x, y, { baseline: 'top', ...opts });
  };

  const heading = (s: string, y: number): number => {
    ink(20);
    text(s, M, y, 11, 'bold');
    doc.setDrawColor(200);
    doc.setLineWidth(0.2);
    doc.line(M, y + 6, W - M, y + 6);
    return y + 9;
  };

  /** key-value の表を cols 列で並べ、下端の y を返す (値は折り返し可) */
  const kvTable = (rows: [string, string][], y0: number, cols = 1, keyW = 28): number => {
    const colW = CW / cols;
    let rowTop = y0;
    for (let i = 0; i < rows.length; i += cols) {
      let rowBottom = rowTop;
      rows.slice(i, i + cols).forEach(([k, v], c) => {
        const x = M + c * colW;
        ink(90);
        text(k, x, rowTop, 8.5);
        ink(15);
        const lines = doc.setFont(FONT, 'normal').setFontSize(8.5).splitTextToSize(v, colW - keyW - 2) as string[];
        doc.text(lines, x + keyW, rowTop, { baseline: 'top' });
        rowBottom = Math.max(rowBottom, rowTop + lines.length * 4.2 + 1);
      });
      rowTop = rowBottom;
    }
    return rowTop;
  };

  // ───── 1 ページ目 ─────
  ink(10);
  text(t.title, M, 13, 16, 'bold');
  ink(90);
  text(t.createdAt(stamp(now)), W - M, 15, 8.5, 'normal', { align: 'right' });

  let y = heading(t.data, 26);
  const side = (s: ReportSide) =>
    t.side(
      msgText(s.set.label),
      s.set.doses.length,
      msgText(s.set.summary),
      scaleFactor(s.scale) !== 1 ? formatScale(s.scale) : null,
      s.plan ? t.plan(s.plan.label || s.plan.name || s.plan.fileName, s.plan.fractions) : null,
    );
  const sameFor = input.ref.set.frameOfReferenceUID === input.ev.set.frameOfReferenceUID;
  const shifted = input.shift.some((v) => v !== 0);
  const [sx, sy, sz] = input.shift.map((v) => (v > 0 ? `+${v}` : `${v}`));
  const patient = input.includePatient
    ? t.patientValue(input.ref.set.patientName || m().side.noName, input.ref.set.patientId || '–')
    : t.hidden;
  y = kvTable(
    [
      [t.patient, patient],
      [t.ref, side(input.ref)],
      [t.eval, side(input.ev)],
      [t.frame, sameFor ? t.frameSame : shifted ? t.frameDifferentShifted : t.frameDifferent],
    ],
    y,
  );

  y = heading(t.conditions, y + 3);
  const [nx, ny, nz] = r.ref.dims;
  y = kvTable(
    [
      [t.criteria, `${p.ddPercent}% / ${p.dtaMm} mm`],
      [t.norm, p.local ? t.normLocal : 'Global'],
      [t.normDose, `${p.normDoseGy.toFixed(3)} Gy`],
      [t.gammaThreshold, `${p.gammaThresholdPercent}% (${((p.gammaThresholdPercent / 100) * p.normDoseGy).toFixed(3)} Gy)`],
      [t.ddThreshold, `${p.ddThresholdPercent}%${p.ddLowGradientOnly ? t.ddLowGradient(p.gradientThresholdPercentPerMm) : ''}`],
      [t.dtaTarget, t.dtaTargetValue(p.gradientThresholdPercentPerMm)],
      [t.cap, t.capValue(p.gammaCap, (p.gammaCap * p.dtaMm).toFixed(1))],
      [t.step, t.stepValue((p.dtaMm / p.stepsPerDta).toFixed(2))],
      [t.grid, t.gridValue(`${nx}×${ny}×${nz}`)],
      [t.evalInterp, t.evalInterpValue],
      [t.shift, shifted ? t.shiftValue(sx, sy, sz) : t.noShift],
      ...(input.levels ? [[t.levels, t.levelsValue(input.levels.tolerance, input.levels.action)] as [string, string]] : []),
    ],
    y,
    2,
    20,
  );

  // 結果
  y = heading(t.results, y + 3);
  const boxW = (CW - 8) / 3;
  const judgment = input.levels ? judge(d.gamma.passRate, input.levels) : null;
  const JUDGMENT_RGB: Record<Judgment, [number, number, number]> = { pass: [12, 130, 12], review: [190, 120, 0], fail: [208, 59, 59] };
  const JUDGMENT_MARK: Record<Judgment, string> = { pass: '✓', review: '!', fail: '×' };
  const boxes: { title: string; big: string; lines: [string, string][] }[] = [
    {
      title: t.gamma,
      big: `${fmt(d.gamma.passRate, 2)}%`,
      lines: [
        [t.evaluated, d.gamma.evaluated.toLocaleString()],
        [t.meanMedian, `${fmt(d.gamma.mean, 3)} / ${fmt(d.gamma.median, 3)}`],
        [t.p99, fmt(d.gamma.p99, 3)],
        [t.max, d.gamma.maxCapped ? `≥ ${p.gammaCap}` : fmt(d.gamma.max, 3)],
      ],
    },
    {
      title: t.ddBox(p.ddPercent),
      big: `${fmt(d.dd.passRate, 2)}%`,
      lines: [
        [t.evaluated, d.dd.evaluated.toLocaleString()],
        [t.meanSd, `${fmt(d.dd.meanPct, 2)} ± ${fmt(d.dd.sdPct, 2)}%`],
        [t.minMax, `${fmt(d.dd.minPct, 2)} / ${fmt(d.dd.maxPct, 2)}%`],
        ['', ''],
      ],
    },
    {
      title: t.dtaBox(p.dtaMm),
      big: `${fmt(d.dta.passRate, 2)}%`,
      lines: [
        [t.evaluated, d.dta.evaluated.toLocaleString()],
        [t.meanMedian, `${fmt(d.dta.mean, 2)} / ${fmt(d.dta.median, 2)} mm`],
        [t.notFound, t.points(d.dta.notFound.toLocaleString())],
        ['', ''],
      ],
    },
  ];
  boxes.forEach((b, i) => {
    const x = M + i * (boxW + 4);
    doc.setDrawColor(215);
    doc.setFillColor(248, 248, 246);
    doc.roundedRect(x, y, boxW, 38, 1.5, 1.5, 'FD');
    ink(80);
    text(b.title, x + 3, y + 2.5, 8.5, 'bold');
    ink(10);
    text(b.big, x + 3, y + 7, 17, 'bold');
    if (i === 0 && judgment) {
      // 判定は色だけでなく記号と文字でも示す
      doc.setTextColor(...JUDGMENT_RGB[judgment]);
      text(`${JUDGMENT_MARK[judgment]} ${m().judgment[judgment]}`, x + boxW - 3, y + 9, 11, 'bold', { align: 'right' });
    }
    b.lines.forEach(([k, v], li) => {
      if (!k) return;
      ink(100);
      text(k, x + 3, y + 17 + li * 4.6, 7.5);
      ink(20);
      text(v, x + boxW - 3, y + 17 + li * 4.6, 7.5, 'normal', { align: 'right' });
    });
  });
  y += 42;

  // 一括計算の比較表
  if (input.comparison) {
    y = heading(t.comparison, y + 1);
    const cols = [
      { h: m().compare.criteria, w: 50, align: 'left' as const },
      { h: m().compare.passRate, w: 30, align: 'right' as const },
      { h: m().compare.mean, w: 30, align: 'right' as const },
      { h: m().compare.p99, w: 30, align: 'right' as const },
      { h: m().compare.judgment, w: 42, align: 'right' as const },
    ];
    const row = (cells: string[], yy: number, weight: 'normal' | 'bold', colors?: ([number, number, number] | null)[]) => {
      let x = M;
      cols.forEach((c, ci) => {
        const color = colors?.[ci];
        if (color) doc.setTextColor(...color);
        else ink(weight === 'bold' ? 60 : 20);
        text(cells[ci], c.align === 'left' ? x + 1 : x + c.w - 1, yy, 8.5, weight, { align: c.align });
        x += c.w;
      });
    };
    row(cols.map((c) => c.h), y, 'bold');
    y += 5;
    for (const c of input.comparison) {
      const j = input.levels ? judge(c.stats.passRate, input.levels) : null;
      if (c.selected) {
        doc.setFillColor(238, 243, 251);
        doc.rect(M, y - 0.8, cols.reduce((a, col) => a + col.w, 0), 5, 'F');
      }
      row(
        [
          c.selected ? t.comparisonShown(c.label) : c.label,
          `${fmt(c.stats.passRate, 2)}%`,
          fmt(c.stats.mean, 3),
          fmt(c.stats.p99, 3),
          j ? `${JUDGMENT_MARK[j]} ${m().judgment[j]}` : '–',
        ],
        y,
        c.selected ? 'bold' : 'normal',
        [null, null, null, null, j ? JUDGMENT_RGB[j] : null],
      );
      y += 5;
    }
    y += 1;
  }

  // ヒストグラム
  y = heading(t.histograms, y + 1);
  const specs = histSpecs(r, d, input.ddUnit);
  const chartW = (CW - 8) / 3;
  const chartH = chartW * 0.72;
  specs.forEach((s, i) => {
    const c = document.createElement('canvas');
    const pw = 380;
    const ph = Math.round(pw * 0.72);
    c.width = pw * 2;
    c.height = ph * 2;
    const ctx = c.getContext('2d')!;
    ctx.scale(2, 2);
    drawHistogram(ctx, pw, ph, s, LIGHT_CHART_THEME);
    doc.addImage(c.toDataURL('image/png'), 'PNG', M + i * (chartW + 4), y, chartW, chartH);
  });
  y += chartH + 3;

  if (input.warnings.length) {
    y = heading(t.notes, y + 2);
    doc.setTextColor(150, 90, 0);
    const lines = doc.setFont(FONT, 'normal').setFontSize(8).splitTextToSize(input.warnings.map((w) => t.bullet(msgText(w))).join('\n'), CW) as string[];
    doc.text(lines.slice(0, 12), M, y, { baseline: 'top' });
  }

  // ───── 2 ページ目: 断面画像 ─────
  doc.addPage();
  const [cx, cy, cz] = [0, 1, 2].map((a) => r.ref.origin[a] + input.cursor[a] * r.ref.spacing[a]);
  y = heading(t.slices(cx.toFixed(1), cy.toFixed(1), cz.toFixed(1)), 13);
  const doseMap = doseColorMap(input.displayMax);
  const gMap = gammaColorMap(p.gammaCap);
  const bg: [number, number, number] = [10, 10, 10];
  const labelW = 16;
  const imgW = (CW - labelW - 6) / 3;
  const cols: { title: string; values: ArrayLike<number>; cmap: ColorMap }[] = [
    { title: t.ref, values: r.ref.data, cmap: doseMap },
    { title: t.eval, values: r.evalOnRef, cmap: doseMap },
    { title: t.gamma, values: r.gamma, cmap: gMap },
  ];
  cols.forEach((c, i) => {
    ink(40);
    text(c.title, M + labelW + i * (imgW + 3) + imgW / 2, y, 9, 'bold', { align: 'center' });
  });
  y += 6;
  const planes: Plane[] = ['axial', 'sagittal', 'coronal'];
  // 3 断面の高さ合計がページに収まるよう、行ごとの最大高さを決める
  const maxRowH = 62;
  for (const plane of planes) {
    const g = PLANES[plane];
    const physW = r.ref.dims[g.u] * r.ref.spacing[g.u];
    const physH = r.ref.dims[g.v] * r.ref.spacing[g.v];
    const h = Math.min(maxRowH, (imgW * physH) / physW);
    const w = (h * physW) / physH;
    ink(40);
    text(g.label, M, y + h / 2 - 2, 9, 'bold');
    cols.forEach((c, i) => {
      const img = renderSlice(r.ref, c.values, plane, input.cursor, c.cmap, bg);
      const canvas = document.createElement('canvas');
      const scale = 4;
      canvas.width = Math.round(w * scale * 2);
      canvas.height = Math.round(h * scale * 2);
      const ctx = canvas.getContext('2d')!;
      drawSlice(ctx, img, canvas.width, canvas.height, voxelToImage(plane, r.ref, input.cursor), 'rgba(255,255,255,0.6)');
      const x = M + labelW + i * (imgW + 3) + (imgW - w) / 2;
      doc.addImage(canvas.toDataURL('image/png'), 'PNG', x, y, w, h);
    });
    y += h + 4;
  }

  // カラーバー
  [doseMap, doseMap, gMap].forEach((cm, i) => {
    const x = M + labelW + i * (imgW + 3);
    doc.addImage(colorbarPng(cm), 'PNG', x, y, imgW, 2.5);
    ink(90);
    for (const t of cm.ticks) {
      const tx = x + ((t.value - cm.min) / (cm.max - cm.min)) * imgW;
      const align = t.value === cm.min ? 'left' : t.value === cm.max ? 'right' : 'center';
      text(t.label, tx, y + 3.3, 7, 'normal', { align });
    }
  });
  y += 12;

  // コメント・確認者
  y = heading(t.commentTitle, Math.max(y, 222));
  doc.setDrawColor(200);
  doc.rect(M, y, CW, 26);
  if (input.comment) {
    ink(20);
    const lines = doc.setFont(FONT, 'normal').setFontSize(9).splitTextToSize(input.comment, CW - 4) as string[];
    doc.text(lines.slice(0, 5), M + 2, y + 2, { baseline: 'top' });
  }
  y += 31;
  ink(40);
  text(t.reviewer, M, y, 9);
  doc.line(M + 14, y + 5, M + 90, y + 5);
  if (input.reviewer) text(input.reviewer, M + 16, y, 10);
  text(t.reviewDate, M + 100, y, 9);
  doc.line(M + 114, y + 5, W - M, y + 5);

  // フッター
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    ink(140);
    text(`Gamma3D v${input.version}`, M, 288, 7.5);
    text(`${i} / ${pages}`, W - M, 288, 7.5, 'normal', { align: 'right' });
  }

  return doc.output('blob');
}

export function reportFileName(input: Pick<ReportInput, 'includePatient' | 'ref'>): string {
  const d = new Date();
  const ts = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  const id = input.includePatient && input.ref.set.patientId ? `_${input.ref.set.patientId.replace(/[^\w.-]+/g, '_')}` : '';
  return `gamma3d${id}_${ts}.pdf`;
}
