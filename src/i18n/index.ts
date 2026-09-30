import { ja, type Messages } from './ja.ts';

export type { Messages };

let current: Messages = ja;

/** 現在の言語の辞書 */
export function m(): Messages {
  return current;
}

export function setMessages(messages: Messages): void {
  current = messages;
}

/**
 * あとで文字列にする文言。読み込み時の警告などを「その時点の言語の文字列」で固定せず、
 * 表示するたびに現在の言語で作れるようにする。
 */
export type Msg = (m: Messages) => string;

export const text = (msg: Msg): string => msg(current);

/** 固定の文字列 (ファイル名や DICOM の値など、翻訳しないもの) を Msg にする */
export const raw =
  (s: string): Msg =>
  () =>
    s;

/** 文言つきの例外。message は投げた時点の言語、msg で後から別の言語でも作れる */
export class LocalizedError extends Error {
  readonly msg: Msg;
  constructor(msg: Msg) {
    super(msg(current));
    this.msg = msg;
  }
}

/** 任意の例外を Msg にする */
export const errorMsg = (e: unknown): Msg => (e instanceof LocalizedError ? e.msg : raw(e instanceof Error ? e.message : String(e)));

/** "viewer.maps.gamma" のようなキーで文字列を引く (HTML の data-i18n 用)。文字列でなければ undefined */
export function lookup(key: string, messages: Messages = current): string | undefined {
  let v: unknown = messages;
  for (const part of key.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return typeof v === 'string' ? v : undefined;
}

/** data-i18n 系の属性に対応する設定先 */
const ATTRS: [string, (el: HTMLElement, s: string) => void][] = [
  ['data-i18n', (el, s) => (el.textContent = s)],
  ['data-i18n-title', (el, s) => (el.title = s)],
  ['data-i18n-aria-label', (el, s) => el.setAttribute('aria-label', s)],
  ['data-i18n-placeholder', (el, s) => el.setAttribute('placeholder', s)],
];

export const I18N_ATTRIBUTES = ATTRS.map(([a]) => a);

/** root 以下の data-i18n* 属性を持つ要素に、現在の言語の文字列を入れる */
export function applyTranslations(root: ParentNode = document): void {
  for (const [attr, set] of ATTRS) {
    root.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((el) => {
      const key = el.getAttribute(attr)!;
      const s = lookup(key);
      if (s === undefined) throw new Error(`i18n: unknown key "${key}"`);
      set(el, s);
    });
  }
  document.documentElement.lang = current.lang;
}
