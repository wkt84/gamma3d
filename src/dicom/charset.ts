import type { DataSet } from 'dicom-parser';

/**
 * SpecificCharacterSet (0008,0005) に従って DICOM の文字列要素を読む。
 * dicom-parser の string() は Latin-1 として読むため、日本語の患者名などが文字化けする。
 *
 * 対応: ISO_IR 192 (UTF-8)、ISO 2022 IR 87 / IR 159 (JIS、エスケープシーケンスで切り替え)、
 * ISO 2022 IR 13 と ISO_IR 13 (JIS X 0201 の半角カナ)、それ以外は Latin-1 として読む。
 */

const decoders = new Map<string, TextDecoder>();
function decoder(label: string): TextDecoder {
  let d = decoders.get(label);
  if (!d) {
    d = new TextDecoder(label);
    decoders.set(label, d);
  }
  return d;
}

/**
 * ISO 2022 の文字列を読む。漢字 (ESC $ B など) は iso-2022-jp のデコーダーに任せ、
 * エスケープなしで現れる 0xA1–0xDF (ISO 2022 IR 13 の半角カナ) はここで変換する。
 */
function decodeIso2022(bytes: Uint8Array): string {
  let out = '';
  let start = 0;
  const flush = (end: number) => {
    if (end > start) out += decoder('iso-2022-jp').decode(bytes.subarray(start, end));
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    // 2 バイト文字 (ESC $ B の後) は 0x21–0x7E なので、この範囲の単独バイトは半角カナと判断できる
    if (b >= 0xa1 && b <= 0xdf) {
      flush(i);
      out += String.fromCharCode(0xff61 + (b - 0xa1));
      start = i + 1;
    }
  }
  flush(bytes.length);
  return out;
}

/** バイト列を文字列にする。charset は SpecificCharacterSet の値 (複数値は \ 区切り) */
export function decodeDicomText(bytes: Uint8Array, charset: string): string {
  const terms = charset
    .split('\\')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  if (terms.includes('ISO_IR 192')) return decoder('utf-8').decode(bytes);
  if (terms.some((t) => t.startsWith('ISO 2022'))) return decodeIso2022(bytes);
  if (terms[0] === 'ISO_IR 13') return decoder('shift_jis').decode(bytes);
  return decoder('latin1').decode(bytes);
}

/** データセットの SpecificCharacterSet (シーケンス内の項目には書かれないので、ルートのものを渡す) */
export const charsetOf = (root: DataSet): string => root.string('x00080005') ?? '';

/** 文字列要素を SpecificCharacterSet に従って読み、前後の空白と末尾の NUL を除く */
export function readText(ds: DataSet, tag: string, charset: string): string {
  const el = ds.elements[tag];
  if (!el || el.length === 0) return '';
  const bytes = (ds.byteArray as Uint8Array).subarray(el.dataOffset, el.dataOffset + el.length);
  return decodeDicomText(bytes, charset).replace(/\0+$/, '').trim();
}

/**
 * PN (人名) を表示用にする。"ﾔﾏﾀﾞ^ﾀﾛｳ=山田^太郎" のような「ローマ字等=漢字=よみ」の組は
 * "山田 太郎 (ﾔﾏﾀﾞ ﾀﾛｳ)" にする。成分の区切り (^) は空白にする。
 */
export function formatPersonName(pn: string): string {
  const groups = pn.split('=').map((g) => g.split('^').map((c) => c.trim()).filter(Boolean).join(' '));
  const [alphabetic = '', ideographic = ''] = groups;
  if (ideographic && alphabetic) return `${ideographic} (${alphabetic})`;
  return ideographic || alphabetic || groups.find(Boolean) || '';
}
