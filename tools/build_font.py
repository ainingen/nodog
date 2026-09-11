#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Zen Maru Gothic を「実際に使う文字」だけに削って index.html に埋め込む。

PLiCy は外部通信なしなので、フォントも同梱するしかない。全部入れると
1書体で数MBあるため、UI 文言と images.csv の label 列に出てくる文字だけを
pyftsubset で残し、woff2 にして index.html の
  /* FONT:BEGIN */ ... /* FONT:END */
の間に base64 で書き込む。

文言を変えたら実行し直すこと:
  python tools/build_font.py

必要なもの: fonttools[woff] (pip install fonttools brotli)
"""

import base64
import io
import os
import re
import subprocess
import sys
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(REPO_ROOT, "tools", ".fontcache")
INDEX = os.path.join(REPO_ROOT, "index.html")

# Google Fonts が配る Zen Maru Gothic (OFL) の TTF。
FACES = [
    ("500", "https://fonts.gstatic.com/s/zenmarugothic/v19/"
            "o-0XIpIxzW5b-RxT-6A8jWAtCp-cGWtCPA.ttf"),
    ("700", "https://fonts.gstatic.com/s/zenmarugothic/v19/"
            "o-0XIpIxzW5b-RxT-6A8jWAtCp-cUW1CPA.ttf"),
]

# 数字・記号など、ソースに出ていなくても必要になりうる分。
BASE_CHARS = (
    "0123456789"
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    " .,:;/×-_!?()[]%'\"+&#@"
    "！？、。…「」・　"
)

BEGIN = "/* FONT:BEGIN */"
END = "/* FONT:END */"


def strip_js_comments(src):
    """// と /* */ を落とす。自前のソースにしか使わないので簡易実装で足りる。"""
    src = re.sub(r"/\*.*?\*/", " ", src, flags=re.S)
    src = re.sub(r"(?m)^\s*//.*$", " ", src)
    return src


def chars_from_js(path):
    """JS からは文字列リテラルの中身だけを拾う。コメントの漢字は入れない。"""
    src = strip_js_comments(io.open(path, encoding="utf-8").read())
    out = set()
    for m in re.finditer(r"'([^'\\\n]*)'|\"([^\"\\\n]*)\"", src):
        out.update(m.group(1) or m.group(2) or "")
    return out


def chars_from_html(path):
    """HTML からはコメント・script・style を除いた地の文とタイトルを拾う。"""
    src = io.open(path, encoding="utf-8").read()
    src = re.sub(r"<!--.*?-->", " ", src, flags=re.S)
    src = re.sub(r"<script.*?</script>", " ", src, flags=re.S)
    src = re.sub(r"<style.*?</style>", " ", src, flags=re.S)
    src = re.sub(r"<[^>]*>", " ", src)
    return set(src)


def chars_from_csv(path):
    """images.csv は label 列を優先。無ければ全セルを見る。"""
    if not os.path.isfile(path):
        return set()
    lines = io.open(path, encoding="utf-8-sig").read().splitlines()
    if not lines:
        return set()
    header = [c.strip() for c in lines[0].split(",")]
    idx = header.index("label") if "label" in header else None
    out = set()
    for line in lines[1:]:
        cells = [c.strip() for c in line.split(",")]
        picked = [cells[idx]] if idx is not None and idx < len(cells) else cells
        for cell in picked:
            out.update(cell)
    return out


def collect_chars():
    chars = set(BASE_CHARS)
    chars |= chars_from_html(INDEX)
    js_dir = os.path.join(REPO_ROOT, "js")
    for name in sorted(os.listdir(js_dir)):
        if name.endswith(".js"):
            chars |= chars_from_js(os.path.join(js_dir, name))
    chars |= chars_from_csv(os.path.join(REPO_ROOT, "images.csv"))
    # 制御文字と、埋め込みに不要な文字を落とす。
    return {c for c in chars if c.isprintable() and not c.isspace()} | {" "}


def fetch(url, dest):
    if os.path.isfile(dest):
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print("取得:", url)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as res, open(dest, "wb") as fh:
        fh.write(res.read())
    return dest


def subset(src, out, chars):
    text_file = out + ".chars.txt"
    with io.open(text_file, "w", encoding="utf-8") as fh:
        fh.write("".join(sorted(chars)))
    cmd = [
        sys.executable, "-m", "fontTools.subset", src,
        "--text-file=" + text_file,
        "--flavor=woff2",
        "--layout-features=",
        "--no-hinting",
        "--desubroutinize",
        "--output-file=" + out,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    os.remove(text_file)
    return out


def main():
    chars = collect_chars()
    print("使う文字: %d 種" % len(chars))

    blocks = []
    for weight, url in FACES:
        ttf = fetch(url, os.path.join(CACHE, "ZenMaruGothic-%s.ttf" % weight))
        woff2 = subset(ttf, os.path.join(CACHE, "subset-%s.woff2" % weight), chars)
        data = open(woff2, "rb").read()
        print("  weight %s: %.1f KB" % (weight, len(data) / 1024))
        b64 = base64.b64encode(data).decode("ascii")
        blocks.append(
            "@font-face{font-family:'Zen Maru Gothic';font-style:normal;"
            "font-weight:%s;font-display:swap;"
            "src:url(data:font/woff2;base64,%s) format('woff2')}" % (weight, b64)
        )

    html = io.open(INDEX, encoding="utf-8").read()
    if BEGIN not in html or END not in html:
        print("index.html に %s / %s の目印がありません。" % (BEGIN, END), file=sys.stderr)
        return 2
    head, rest = html.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    html = head + BEGIN + "\n" + "\n".join(blocks) + "\n" + END + tail
    io.open(INDEX, "w", encoding="utf-8", newline="\n").write(html)

    size = os.path.getsize(INDEX)
    print("index.html: %.1f KB %s" % (size / 1024, "OK" if size < 500 * 1024 else "← 500KB 超過"))
    return 0 if size < 500 * 1024 else 1


if __name__ == "__main__":
    sys.exit(main())
