/**
 * テスト・サンプル生成用の最小限の RTDOSE 書き出し (Explicit VR Little Endian)。
 * アプリ本体では使わない。
 */

export interface RtDoseSpec {
  cols: number;
  rows: number;
  frames: number;
  /** [列方向間隔, 行方向間隔] (mm) = [dx, dy] */
  spacing: [number, number];
  /** 先頭ピクセルの患者座標 */
  ipp: [number, number, number];
  iop?: [number, number, number, number, number, number];
  frameOffsets: number[];
  /** ファイル内の並び (列が最速、次に行、次にフレーム) の線量 (Gy) */
  dose: Float32Array;
  summationType: 'PLAN' | 'BEAM' | 'FRACTION';
  planUID: string;
  beamNumber?: number;
  patientName: string;
  patientId: string;
  seriesDescription: string;
  studyUID: string;
  seriesUID: string;
  sopUID: string;
  forUID: string;
}

const RT_DOSE_CLASS = '1.2.840.10008.5.1.4.1.1.481.2';
const RT_PLAN_CLASS = '1.2.840.10008.5.1.4.1.1.481.5';
const EXPLICIT_LE = '1.2.840.10008.1.2.1';

let uidCounter = 0;
export function newUid(): string {
  uidCounter++;
  return `2.25.${Date.now()}${String(uidCounter).padStart(4, '0')}${Math.floor(Math.random() * 1e6)}`;
}

const LONG_VR = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);
const enc = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function el(tag: number, vr: string, value: Uint8Array): Uint8Array {
  const long = LONG_VR.has(vr);
  const head = new Uint8Array(long ? 12 : 8);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, tag >>> 16, true);
  dv.setUint16(2, tag & 0xffff, true);
  head[4] = vr.charCodeAt(0);
  head[5] = vr.charCodeAt(1);
  if (long) dv.setUint32(8, value.length, true);
  else dv.setUint16(6, value.length, true);
  return concat([head, value]);
}

function text(tag: number, vr: string, s: string): Uint8Array {
  let b: Uint8Array = enc.encode(s);
  if (b.length % 2) b = concat([b, new Uint8Array([vr === 'UI' ? 0 : 0x20])]);
  return el(tag, vr, b);
}

function ds(n: number): string {
  let s = String(Number(n.toPrecision(10)));
  if (s.length > 16) s = n.toExponential(8);
  return s;
}

function us(tag: number, v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return el(tag, 'US', b);
}

function item(content: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  const dv = new DataView(head.buffer);
  dv.setUint16(0, 0xfffe, true);
  dv.setUint16(2, 0xe000, true);
  dv.setUint32(4, content.length, true);
  return concat([head, content]);
}

function seq(tag: number, items: Uint8Array[]): Uint8Array {
  return el(tag, 'SQ', concat(items.map(item)));
}

export function writeRtDose(s: RtDoseSpec): Uint8Array {
  const n = s.cols * s.rows * s.frames;
  if (s.dose.length !== n) throw new Error('dose length mismatch');
  let max = 0;
  for (let m = 0; m < n; m++) if (s.dose[m] > max) max = s.dose[m];
  const scaling = Number(ds(max > 0 ? max / 2 ** 31 : 1));
  const px = new Uint32Array(n);
  for (let m = 0; m < n; m++) px[m] = Math.max(0, Math.round(s.dose[m] / scaling));

  const beamSeq =
    s.beamNumber !== undefined
      ? [
          seq(0x300c0020, [
            concat([seq(0x300c0004, [text(0x300c0006, 'IS', String(s.beamNumber))]), text(0x300c0022, 'IS', '1')]),
          ]),
        ]
      : [];

  const body = concat([
    text(0x00080016, 'UI', RT_DOSE_CLASS),
    text(0x00080018, 'UI', s.sopUID),
    text(0x00080060, 'CS', 'RTDOSE'),
    text(0x00080070, 'LO', 'gamma3d-sample'),
    text(0x0008103e, 'LO', s.seriesDescription),
    text(0x00100010, 'PN', s.patientName),
    text(0x00100020, 'LO', s.patientId),
    text(0x0020000d, 'UI', s.studyUID),
    text(0x0020000e, 'UI', s.seriesUID),
    text(0x00200032, 'DS', s.ipp.map(ds).join('\\')),
    text(0x00200037, 'DS', (s.iop ?? [1, 0, 0, 0, 1, 0]).map(ds).join('\\')),
    text(0x00200052, 'UI', s.forUID),
    us(0x00280002, 1),
    text(0x00280004, 'CS', 'MONOCHROME2'),
    text(0x00280008, 'IS', String(s.frames)),
    us(0x00280010, s.rows),
    us(0x00280011, s.cols),
    text(0x00280030, 'DS', `${ds(s.spacing[1])}\\${ds(s.spacing[0])}`),
    us(0x00280100, 32),
    us(0x00280101, 32),
    us(0x00280102, 31),
    us(0x00280103, 0),
    text(0x30040002, 'CS', 'GY'),
    text(0x30040004, 'CS', 'PHYSICAL'),
    text(0x3004000a, 'CS', s.summationType),
    text(0x3004000c, 'DS', s.frameOffsets.map(ds).join('\\')),
    text(0x3004000e, 'DS', ds(scaling)),
    seq(0x300c0002, [concat([text(0x00081150, 'UI', RT_PLAN_CLASS), text(0x00081155, 'UI', s.planUID), ...beamSeq])]),
    el(0x7fe00010, 'OW', new Uint8Array(px.buffer)),
  ]);

  const metaBody = concat([
    el(0x00020001, 'OB', new Uint8Array([0, 1])),
    text(0x00020002, 'UI', RT_DOSE_CLASS),
    text(0x00020003, 'UI', s.sopUID),
    text(0x00020010, 'UI', EXPLICIT_LE),
    text(0x00020012, 'UI', '2.25.1234567890'),
  ]);
  const groupLen = new Uint8Array(4);
  new DataView(groupLen.buffer).setUint32(0, metaBody.length, true);

  return concat([new Uint8Array(128), enc.encode('DICM'), el(0x00020000, 'UL', groupLen), metaBody, body]);
}
