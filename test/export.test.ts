import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { newUid, writeRtDose, type RtDoseSpec } from '../scripts/dicom-writer.ts';
import { parseRtDose } from '../src/dicom/rtdose.ts';
import { toNrrd } from '../src/export/nrrd.ts';
import { crc32, zip } from '../src/export/zip.ts';

/** 患者座標の 1 次関数 (ボクセルの位置が正しければ値が一致する) */
const field = (x: number, y: number, z: number) => 3 + 0.01 * x + 0.02 * y + 0.03 * z;

/** iop の向きで並べた RTDOSE を書き出す */
function rtdose(ipp: [number, number, number], iop: RtDoseSpec['iop'] = [1, 0, 0, 0, 1, 0]): Uint8Array {
  const [cols, rows] = [7, 5];
  const frameOffsets = [0, 2.5, 5, 7.5];
  const spacing: [number, number] = [2, 3];
  const sliceSign = iop![0] * iop![4];
  const dose = new Float32Array(cols * rows * frameOffsets.length);
  for (let k = 0; k < frameOffsets.length; k++)
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        dose[c + cols * (r + rows * k)] = field(ipp[0] + iop![0] * c * spacing[0], ipp[1] + iop![4] * r * spacing[1], ipp[2] + sliceSign * frameOffsets[k]);
  const uid = newUid();
  return writeRtDose({
    cols,
    rows,
    frames: frameOffsets.length,
    spacing,
    ipp,
    iop,
    frameOffsets,
    dose,
    summationType: 'PLAN',
    planUID: '1.2.3.4',
    patientName: 'TEST^PATIENT',
    patientId: 'P001',
    seriesDescription: 'test',
    studyUID: uid + '.1',
    seriesUID: uid + '.2',
    sopUID: uid + '.3',
    forUID: '1.2.3.9',
  });
}

/** 最小限の NRRD 読み込み (ヘッダーの主なフィールドと float32 のデータ) */
function readNrrd(bytes: Uint8Array) {
  const text = new TextDecoder('latin1').decode(bytes);
  const end = text.indexOf('\n\n');
  const fields = new Map<string, string>();
  const keyValues = new Map<string, string>();
  for (const line of text.slice(0, end).split('\n').slice(1)) {
    if (line.startsWith('#')) continue;
    const kv = line.indexOf(':=');
    if (kv >= 0) keyValues.set(line.slice(0, kv), line.slice(kv + 2));
    else {
      const i = line.indexOf(': ');
      fields.set(line.slice(0, i), line.slice(i + 2));
    }
  }
  const vec = (s: string) => s.replace(/[()]/g, '').split(',').map(Number);
  const body = bytes.subarray(end + 2);
  const raw = fields.get('encoding') === 'gzip' ? gunzipSync(body) : body;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const data = Float32Array.from({ length: raw.byteLength / 4 }, (_, n) => dv.getFloat32(4 * n, fields.get('endian') === 'little'));
  return {
    fields,
    keyValues,
    sizes: fields.get('sizes')!.split(' ').map(Number),
    origin: vec(fields.get('space origin')!),
    directions: fields.get('space directions')!.split(' ').map(vec),
    data,
  };
}

describe('NRRD の書き出し', () => {
  for (const [name, iop] of [
    ['標準の向き', [1, 0, 0, 0, 1, 0]],
    ['x・y が反転した向き', [-1, 0, 0, 0, -1, 0]],
  ] as const) {
    for (const gzip of [true, false]) {
      it(`${name}の RTDOSE: 読み戻した格子と座標が元の RTDOSE と一致する (${gzip ? 'gzip' : 'raw'})`, async () => {
        const ipp: [number, number, number] = [-5.5, 12, -30];
        const dose = parseRtDose(rtdose(ipp, [...iop]).slice().buffer, 'a.dcm');
        const v = dose.volume;
        const n = readNrrd(await toNrrd(v, v.data, { gzip, keyValues: { gamma3d_quantity: 'dose' } }));
        expect(n.fields.get('space')).toBe('left-posterior-superior');
        expect(n.fields.get('type')).toBe('float');
        expect(n.keyValues.get('gamma3d_quantity')).toBe('dose');
        expect(n.sizes).toEqual([7, 5, 4]);
        expect(n.directions).toEqual([
          [2, 0, 0],
          [0, 3, 0],
          [0, 0, 2.5],
        ]);
        // 標準の向きなら原点は ImagePositionPatient そのもの
        if (iop[0] === 1) expect(n.origin).toEqual(ipp);
        // 各ボクセルの位置 (原点 + 添字 × 方向) で、元の線量の関数と一致する
        for (let k = 0; k < 4; k++)
          for (let j = 0; j < 5; j++)
            for (let i = 0; i < 7; i++) {
              const x = n.origin[0] + i * n.directions[0][0];
              const y = n.origin[1] + j * n.directions[1][1];
              const z = n.origin[2] + k * n.directions[2][2];
              expect(n.data[i + 7 * (j + 5 * k)]).toBeCloseTo(field(x, y, z), 4);
            }
      });
    }
  }

  it('格子と配列の大きさが違えばエラー', async () => {
    await expect(toNrrd({ dims: [2, 2, 2], spacing: [1, 1, 1], origin: [0, 0, 0] }, new Float32Array(7))).rejects.toThrow();
  });
});

describe('ZIP の書き出し', () => {
  it('CRC-32 が既知の値と一致する', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('Python の zipfile で壊れていないと判定され、中身が一致する', () => {
    const files = [
      { name: 'a.txt', data: new TextEncoder().encode('hello') },
      { name: '日本語.json', data: new TextEncoder().encode('{"x":1}') },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ];
    const dir = mkdtempSync(join(tmpdir(), 'gamma3d-zip-'));
    const path = join(dir, 't.zip');
    writeFileSync(path, zip(files));
    const out = execFileSync('python3', [
      '-c',
      'import sys, zipfile, json; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({i.filename: z.read(i).decode() for i in z.infolist()}, ensure_ascii=False))',
      path,
    ]).toString();
    expect(JSON.parse(out)).toEqual({ 'a.txt': 'hello', '日本語.json': '{"x":1}', 'empty.bin': '' });
  });
});

describe('CSV のセル', () => {
  it('カンマ・引用符・改行を含む値は引用符で囲み、NaN・null は空欄にする', async () => {
    const { csvCell } = await import('../src/export/results.ts');
    expect(csvCell('PLAN: a, b')).toBe('"PLAN: a, b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(1.5)).toBe('1.5');
    expect(csvCell(NaN)).toBe('');
    expect(csvCell(Infinity)).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
  });
});
