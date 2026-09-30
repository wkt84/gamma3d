import * as dicomParserNs from 'dicom-parser';
import type { DataSet } from 'dicom-parser';
import type { Volume } from '../core/volume.ts';

// dicom-parser は UMD 配布のため、環境によって default 側に実体がある
const dicomParser: typeof dicomParserNs =
  (dicomParserNs as unknown as { default?: typeof dicomParserNs }).default ?? dicomParserNs;

export interface RtDose {
  fileName: string;
  sopInstanceUID: string;
  seriesInstanceUID: string;
  studyInstanceUID: string;
  frameOfReferenceUID: string;
  patientName: string;
  patientId: string;
  seriesDescription: string;
  manufacturer: string;
  /** PLAN / BEAM / FRACTION / BRACHY / CONTROL_POINT / RECORD / MULTI_PLAN など */
  summationType: string;
  doseUnits: string;
  doseType: string;
  referencedPlanUID: string | null;
  referencedBeamNumbers: number[];
  instanceCreationDate: string;
  volume: Volume;
  warnings: string[];
}

const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
const SUPPORTED_TS = new Set([TS_IMPLICIT_LE, '1.2.840.10008.1.2.1']);

export class NotRtDoseError extends Error {}

function parse(bytes: Uint8Array, untilTag?: string): DataSet {
  try {
    return dicomParser.parseDicom(bytes, untilTag ? { untilTag } : undefined);
  } catch (e) {
    // プリアンブル・メタ情報のないファイル (暗黙的 VR リトルエンディアン) を試す
    try {
      return dicomParser.parseDicom(bytes, { TransferSyntaxUID: TS_IMPLICIT_LE, ...(untilTag ? { untilTag } : {}) });
    } catch {
      throw e;
    }
  }
}

/**
 * ファイル先頭だけを読んで RTDOSE かどうかを判定する (フォルダ内の CT 等を素早く除外するため)。
 * untilTag は完全一致で止まるため Modality 自体を指定する。途中で切れた場合も、
 * dicom-parser は解析済みの要素を例外の dataSet に入れて返すので、それも見る。
 */
export function isRtDose(bytes: Uint8Array): boolean {
  const modality = (ds: DataSet | undefined) => (ds?.string('x00080060') ?? '').trim().toUpperCase();
  try {
    return modality(parse(bytes, 'x00080060')) === 'RTDOSE';
  } catch (e) {
    return modality((e as { dataSet?: DataSet } | null)?.dataSet) === 'RTDOSE';
  }
}

const str = (ds: DataSet, tag: string): string => (ds.string(tag) ?? '').trim();

function numbers(ds: DataSet, tag: string): number[] {
  const n = ds.numStringValues(tag) ?? 0;
  const out: number[] = [];
  for (let m = 0; m < n; m++) {
    const v = ds.floatString(tag, m);
    if (v === undefined || !Number.isFinite(v)) throw new Error(`タグ ${tag} の値が不正です`);
    out.push(v);
  }
  return out;
}

function requireNumbers(ds: DataSet, tag: string, name: string, count?: number): number[] {
  if (!ds.elements[tag]) throw new Error(`${name} (${tag}) がありません`);
  const v = numbers(ds, tag);
  if (count !== undefined && v.length !== count) throw new Error(`${name} の要素数が不正です (${v.length})`);
  return v;
}

/** 方向余弦が座標軸 (±1) にほぼ一致すれば、その軸番号と符号を返す。 */
function axisOf(v: number[]): { axis: number; sign: number } | null {
  for (let a = 0; a < 3; a++) {
    if (Math.abs(Math.abs(v[a]) - 1) < 1e-3 && Math.abs(v[(a + 1) % 3]) < 1e-3 && Math.abs(v[(a + 2) % 3]) < 1e-3) {
      return { axis: a, sign: Math.sign(v[a]) };
    }
  }
  return null;
}

export function parseRtDose(buffer: ArrayBuffer, fileName: string): RtDose {
  const bytes = new Uint8Array(buffer);
  const ds = parse(bytes);
  const warnings: string[] = [];

  const modality = str(ds, 'x00080060').toUpperCase();
  if (modality !== 'RTDOSE') throw new NotRtDoseError(`${fileName}: RTDOSE ではありません (Modality=${modality || '不明'})`);

  const ts = str(ds, 'x00020010');
  if (ts && !SUPPORTED_TS.has(ts)) {
    throw new Error(`${fileName}: 非対応の転送構文です (${ts})。非圧縮リトルエンディアンのみ対応しています。`);
  }

  const rows = ds.uint16('x00280010');
  const cols = ds.uint16('x00280011');
  const frames = ds.intString('x00280008') ?? 1;
  if (!rows || !cols) throw new Error(`${fileName}: Rows/Columns がありません`);
  const bits = ds.uint16('x00280100') ?? 0;
  const pixelRep = ds.uint16('x00280103') ?? 0;
  const samples = ds.uint16('x00280002') ?? 1;
  if (samples !== 1) throw new Error(`${fileName}: SamplesPerPixel=${samples} は非対応です`);
  if (bits !== 16 && bits !== 32) throw new Error(`${fileName}: BitsAllocated=${bits} は非対応です`);

  const ipp = requireNumbers(ds, 'x00200032', 'ImagePositionPatient', 3);
  const iop = requireNumbers(ds, 'x00200037', 'ImageOrientationPatient', 6);
  const ps = requireNumbers(ds, 'x00280030', 'PixelSpacing', 2);
  const scaling = ds.floatString('x3004000e') ?? 1;
  if (!ds.elements['x3004000e']) warnings.push('DoseGridScaling がないため 1 として扱いました');

  let offsets: number[];
  if (frames > 1) {
    offsets = requireNumbers(ds, 'x3004000c', 'GridFrameOffsetVector', frames);
  } else {
    offsets = ds.elements['x3004000c'] ? numbers(ds, 'x3004000c').slice(0, 1) : [0];
    if (offsets.length === 0) offsets = [0];
  }

  // 向き: 行方向 = ±X、列方向 = ±Y の Axial 系のみ対応
  const rowAx = axisOf(iop.slice(0, 3));
  const colAx = axisOf(iop.slice(3, 6));
  if (!rowAx || !colAx || rowAx.axis !== 0 || colAx.axis !== 1) {
    throw new Error(`${fileName}: 非対応の向きです (ImageOrientationPatient=${iop.join('\\')})。Axial 系のみ対応しています。`);
  }
  // スライス方向 = 行 × 列 (z 成分の符号)
  const sliceSign = rowAx.sign * colAx.sign;

  // ピクセルデータ
  const pxEl = ds.elements['x7fe00010'];
  if (!pxEl) throw new Error(`${fileName}: PixelData がありません`);
  if (pxEl.encapsulatedPixelData) throw new Error(`${fileName}: 圧縮されたピクセルデータは非対応です`);
  const nPix = rows * cols * frames;
  const bytesPer = bits / 8;
  if (pxEl.length < nPix * bytesPer) throw new Error(`${fileName}: PixelData の長さが不足しています`);
  const raw = bytes.slice(pxEl.dataOffset, pxEl.dataOffset + nPix * bytesPer).buffer;
  const px: ArrayLike<number> =
    bits === 32
      ? pixelRep ? new Int32Array(raw) : new Uint32Array(raw)
      : pixelRep ? new Int16Array(raw) : new Uint16Array(raw);

  // 各軸の患者座標 (ボクセル中心)
  const dx = ps[1];
  const dy = ps[0];
  // GridFrameOffsetVector: 先頭が 0 なら IPP からの相対値、そうでなければ z の絶対値 (旧形式)。
  // どちらの場合も「先頭との差」を取れば IPP からの相対値になる。
  const zRel = offsets.map((o) => o - offsets[0]);
  const zPos = zRel.map((r) => ipp[2] + sliceSign * r);

  // z を昇順に並べ替えるためのフレーム順
  const frameOrder = zPos.map((z, f) => ({ z, f })).sort((a, b) => a.z - b.z);
  const zs = frameOrder.map((o) => o.z);

  const flipX = rowAx.sign < 0;
  const flipY = colAx.sign < 0;
  const originX = flipX ? ipp[0] - (cols - 1) * dx : ipp[0];
  const originY = flipY ? ipp[1] - (rows - 1) * dy : ipp[1];

  // 並べ替えた (x, y 昇順、z はフレーム順) 配列を作る
  const plane = rows * cols;
  const sorted = new Float32Array(nPix);
  for (let kk = 0; kk < frames; kk++) {
    const f = frameOrder[kk].f;
    for (let r = 0; r < rows; r++) {
      const j = flipY ? rows - 1 - r : r;
      for (let c = 0; c < cols; c++) {
        const i = flipX ? cols - 1 - c : c;
        sorted[i + cols * j + plane * kk] = px[c + cols * r + plane * f] * scaling;
      }
    }
  }

  // z 間隔の一様性チェック。不均一なら最小間隔で再サンプリングする
  let dz = 1;
  let data: Float32Array = sorted;
  let nz = frames;
  if (frames > 1) {
    const diffs = zs.slice(1).map((z, m) => z - zs[m]);
    const minD = Math.min(...diffs);
    const maxD = Math.max(...diffs);
    if (minD <= 1e-6) throw new Error(`${fileName}: GridFrameOffsetVector に重複した位置があります`);
    if (maxD - minD > 0.01) {
      dz = minD;
      nz = Math.round((zs[frames - 1] - zs[0]) / dz) + 1;
      data = resampleZ(sorted, plane, zs, zs[0], dz, nz);
      warnings.push(`スライス間隔が不均一なため ${dz.toFixed(2)} mm 間隔に再サンプリングしました`);
    } else {
      dz = (zs[frames - 1] - zs[0]) / (frames - 1);
    }
  }

  const units = str(ds, 'x30040002').toUpperCase();
  if (units && units !== 'GY') warnings.push(`線量単位が ${units} です (Gy 以外)`);

  // ReferencedRTPlanSequence
  let referencedPlanUID: string | null = null;
  const referencedBeamNumbers: number[] = [];
  const planSeq = ds.elements['x300c0002']?.items?.[0]?.dataSet;
  if (planSeq) {
    referencedPlanUID = str(planSeq, 'x00081155') || null;
    for (const fg of planSeq.elements['x300c0020']?.items ?? []) {
      for (const b of fg.dataSet?.elements['x300c0004']?.items ?? []) {
        const num = b.dataSet?.intString('x300c0006');
        if (num !== undefined) referencedBeamNumbers.push(num);
      }
    }
  }

  return {
    fileName,
    sopInstanceUID: str(ds, 'x00080018'),
    seriesInstanceUID: str(ds, 'x0020000e'),
    studyInstanceUID: str(ds, 'x0020000d'),
    frameOfReferenceUID: str(ds, 'x00200052'),
    patientName: str(ds, 'x00100010').replace(/\^+/g, ' ').trim(),
    patientId: str(ds, 'x00100020'),
    seriesDescription: str(ds, 'x0008103e'),
    manufacturer: str(ds, 'x00080070'),
    summationType: str(ds, 'x3004000a').toUpperCase() || 'UNKNOWN',
    doseUnits: units,
    doseType: str(ds, 'x30040004').toUpperCase(),
    referencedPlanUID,
    referencedBeamNumbers,
    instanceCreationDate: str(ds, 'x00080012'),
    volume: {
      dims: [cols, rows, nz],
      spacing: [dx, dy, dz],
      origin: [originX, originY, zs[0]],
      data,
    },
    warnings,
  };
}

function resampleZ(src: Float32Array, plane: number, zs: number[], z0: number, dz: number, nz: number): Float32Array {
  const out = new Float32Array(plane * nz);
  let seg = 0;
  for (let k = 0; k < nz; k++) {
    const z = z0 + k * dz;
    while (seg < zs.length - 2 && zs[seg + 1] < z) seg++;
    const t = Math.min(1, Math.max(0, (z - zs[seg]) / (zs[seg + 1] - zs[seg])));
    const a = seg * plane;
    const b = (seg + 1) * plane;
    for (let p = 0; p < plane; p++) out[k * plane + p] = src[a + p] + (src[b + p] - src[a + p]) * t;
  }
  return out;
}
