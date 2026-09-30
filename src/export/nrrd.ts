import type { Volume } from '../core/volume.ts';

/**
 * NRRD (3D Slicer などで開ける 3 次元画像形式) の書き出し。
 * 格子は RTDOSE を読み込んだときの座標 (DICOM の患者座標 = LPS、軸は x・y・z に揃えたもの) のまま書く。
 */

export interface NrrdOptions {
  /** ヘッダーに書く追加の key:=value (量の名前・単位など) */
  keyValues?: Record<string, string>;
  /** gzip で圧縮するか (既定: CompressionStream が使えれば圧縮) */
  gzip?: boolean;
}

const num = (v: number) => String(Number(v.toPrecision(10)));

export function nrrdHeader(grid: Pick<Volume, 'dims' | 'spacing' | 'origin'>, encoding: 'raw' | 'gzip', keyValues: Record<string, string> = {}): string {
  const [sx, sy, sz] = grid.spacing.map(num);
  const lines = [
    'NRRD0004',
    '# gamma3d',
    'type: float',
    'dimension: 3',
    'space: left-posterior-superior',
    `sizes: ${grid.dims.join(' ')}`,
    `space directions: (${sx},0,0) (0,${sy},0) (0,0,${sz})`,
    'kinds: domain domain domain',
    'endian: little',
    `encoding: ${encoding}`,
    `space origin: (${grid.origin.map(num).join(',')})`,
    'space units: "mm" "mm" "mm"',
    ...Object.entries(keyValues).map(([k, v]) => `${k}:=${v.replace(/[\r\n]/g, ' ')}`),
  ];
  return lines.join('\n') + '\n\n';
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 格子上の値 (i + nx·(j + ny·k) の並び) を NRRD のバイト列にする */
export async function toNrrd(grid: Pick<Volume, 'dims' | 'spacing' | 'origin'>, data: Float32Array, options: NrrdOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const [nx, ny, nz] = grid.dims;
  if (data.length !== nx * ny * nz) throw new Error(`NRRD: data length ${data.length} does not match ${nx}×${ny}×${nz}`);
  // little endian の float32 (実行環境のバイト順によらないよう DataView で書く)
  const raw = new Uint8Array(data.length * 4);
  const view = new DataView(raw.buffer);
  for (let n = 0; n < data.length; n++) view.setFloat32(4 * n, data[n], true);
  const useGzip = options.gzip ?? typeof CompressionStream !== 'undefined';
  const body = useGzip ? await gzip(raw) : raw;
  const header = new TextEncoder().encode(nrrdHeader(grid, useGzip ? 'gzip' : 'raw', options.keyValues));
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}
