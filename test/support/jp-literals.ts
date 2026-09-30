/**
 * ソースコード中の文字列リテラル (引用符・テンプレート) のうち、日本語を含むものを探す。
 * コメントは対象外。国際化の漏れを検出するテストで使う。
 */
const JP = /[぀-ヿ㐀-鿿！-～]/;

export interface Hit {
  line: number;
  text: string;
}

export function japaneseLiterals(src: string): Hit[] {
  const hits: Hit[] = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  // テンプレートの ${ } の中にいる間、波括弧の深さを積む
  const exprDepth: number[] = [];

  const report = (text: string, at: number) => {
    if (JP.test(text)) hits.push({ line: at, text: text.trim().slice(0, 80) });
  };

  /** テンプレートの文字列部分を ` か ${ まで読む。${ で止まったら true */
  const readTemplateChunk = (): boolean => {
    const start = line;
    let buf = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        buf += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        report(buf, start);
        return false;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        report(buf, start);
        return true;
      }
      if (c === '\n') line++;
      buf += c;
      i++;
    }
    report(buf, start);
    return false;
  };

  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = line;
      let buf = '';
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          buf += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        buf += src[i++];
      }
      i++;
      report(buf, start);
      continue;
    }
    if (c === '`') {
      i++;
      if (readTemplateChunk()) exprDepth.push(1);
      continue;
    }
    if (exprDepth.length) {
      if (c === '{') exprDepth[exprDepth.length - 1]++;
      else if (c === '}') {
        exprDepth[exprDepth.length - 1]--;
        if (exprDepth[exprDepth.length - 1] === 0) {
          exprDepth.pop();
          i++;
          // テンプレートの続きを読む
          if (readTemplateChunk()) exprDepth.push(1);
          continue;
        }
      }
    }
    i++;
  }
  return hits;
}
