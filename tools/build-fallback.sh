#!/bin/sh
# images.csv から js/images-fallback.js を生成する。
# file:// で index.html を直接開いたときのフォールバック用。
# images.csv を編集したら必ず実行すること。
set -eu
cd "$(dirname "$0")/.."
{
  echo '/* 自動生成ファイル。編集しないこと。 images.csv を変更したら tools/build-fallback.sh を実行する。 */'
  echo 'window.NoDog = window.NoDog || {};'
  printf 'window.NoDog.IMAGES_CSV_FALLBACK = '
  awk 'BEGIN{printf "["} {gsub(/\\/,"\\\\"); gsub(/"/,"\\\""); printf "%s\"%s\"", (NR>1?",\n":"\n"), $0} END{printf "\n].join(\"\\n\");\n"}' images.csv
} > js/images-fallback.js
echo "generated js/images-fallback.js from images.csv"
