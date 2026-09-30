#!/usr/bin/env bash
# 英語の PDF 用に、Noto Sans JP から U+0000–U+2FFF (ラテン文字・ギリシャ文字・記号) だけを取り出す。
# 日本語を含まない PDF では、約 5MB のフォントの代わりにこれ (約 240KB) を埋め込む (src/report/pdf.ts)。
# 必要なもの: uv (fonttools を uvx で実行する)
set -euo pipefail
cd "$(dirname "$0")/../public/fonts"
for w in Regular Bold; do
  uvx --from 'fonttools==4.*' pyftsubset "NotoSansJP-$w.ttf" \
    --unicodes='U+0000-2FFF' --layout-features='*' --no-hinting \
    --output-file="NotoSansJP-Latin-$w.ttf"
done
ls -l NotoSansJP-Latin-*.ttf
