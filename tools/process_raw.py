#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""raw/ の Midjourney PNG を img/ の webp に変換し、CSV を更新する。

やること:
  1. raw/ の画像のファイル名からプロンプト冒頭を取り出す
     (先頭の "ainingen_" を落とし、末尾の UUID の手前まで)
  2. images_master.csv の prompt 列と前方一致で行を特定する
  3. その行の answer/level/trick と filename の整合を検査する
     (--dry-run でも走るので、投入前に記入ミスを洗い出せる)
  4. 中央を正方形に切り、長辺 512px の webp (品質80) を img/<filename>.webp に書く
  5. 変換できた行の generated を 1 にする
  6. generated=1 の行だけで images.csv (filename,answer,level,trick) を作り直す
  7. 同じ行に候補画像が複数あったら img/_dup/ に退避して報告する
  8. 照合できなかったファイル・記入ミスの行を一覧で報告する

使い方:
  python tools/process_raw.py             # 実行
  python tools/process_raw.py --dry-run   # 何もせず結果だけ見る
  python tools/process_raw.py --force     # 既にある webp も作り直す

必要なもの: Pillow (pip install Pillow)
"""

import argparse
import csv
import os
import re
import shutil
import sys

# --- 既定値 ---------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULT_RAW = "raw"
DEFAULT_IMG = "img"
DEFAULT_MASTER = "images_master.csv"
DEFAULT_OUT = "images.csv"
DEFAULT_PREFIX = "ainingen"
DEFAULT_QUALITY = 80
DEFAULT_SIZE = 512

DUP_DIRNAME = "_dup"
RAW_EXTS = (".png", ".jpg", ".jpeg", ".webp")

# images.csv に書き出す列。README の仕様どおり。
OUT_COLUMNS = ["filename", "answer", "level", "trick"]

# 出力ファイル名の頭には答えを埋める規約 (dog_012_poodle.webp)。
NAME_PREFIX_RE = re.compile(r"^(dog|not)_", re.I)

# generated 列で真と見なす値。Excel は真偽値を大文字 TRUE で書くので大小は無視する。
TRUTHY = ("1", "true")

# 8-4-4-4-12 の UUID。Midjourney のファイル名末尾に付く。
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
# UUID が無い古い形式向けの保険。16進の塊。
HEXBLOB_RE = re.compile(r"^[0-9a-f]{8,}$", re.I)

# 前方一致の誤爆よけ。これより短い冒頭は照合しない。
MIN_HEAD_LEN = 8


# --- 小道具 ---------------------------------------------------------------

def normalize(text):
    """照合用に正規化する。

    Midjourney はプロンプトの空白も記号もアンダースコアに潰すので、
    こちら側も英数字以外をすべて空白 1 個に潰してから比べる。
    """
    return re.sub(r"[\W_]+", " ", (text or ""), flags=re.UNICODE).lower().strip()


def extract_head(stem, prefix):
    """ファイル名の stem からプロンプト冒頭を取り出す。

    'ainingen_a_brown_dog_on_grass_3f2c1b4a-....-b3c4d5e6f7a8_0'
      -> 'a_brown_dog_on_grass'

    返り値は (冒頭文字列, 確度)。確度は UUID を見つけられたかどうか。
    """
    tokens = [t for t in stem.split("_") if t != ""]

    # 末尾から UUID を探す。見つかったらその手前までがプロンプト。
    cut = None
    for i in range(len(tokens) - 1, -1, -1):
        if UUID_RE.match(tokens[i]):
            cut = i
            break
    confident = cut is not None

    if cut is None:
        # UUID が無い形式。末尾の連番と 16進の塊だけ削る。
        cut = len(tokens)
        while cut > 0 and tokens[cut - 1].isdigit():
            cut -= 1
        if cut > 0 and HEXBLOB_RE.match(tokens[cut - 1]):
            cut -= 1

    tokens = tokens[:cut]

    # 先頭のアカウント名を落とす。
    if prefix and tokens and tokens[0].lower() == prefix.lower():
        tokens = tokens[1:]

    return "_".join(tokens), confident


def webp_name(filename):
    """master の filename 列を実際の出力ファイル名にする。

    'dog_012_poodle' でも 'dog_012_poodle.webp' でも同じ結果になるようにする。
    """
    name = (filename or "").strip()
    if not name:
        return ""
    base, ext = os.path.splitext(name)
    if ext.lower() in (".webp", ".png", ".jpg", ".jpeg"):
        return base + ".webp"
    return name + ".webp"


def truthy(value):
    """generated 列の真偽。Excel が書く TRUE も受け付ける。"""
    return str(value or "").strip().lower() in TRUTHY


def is_blank_row(row):
    """Excel が末尾に足しがちな空行を検査対象から外す。"""
    return not any((v or "").strip() for v in row.values())


def validate_row(row):
    """master の 1 行を検査して、問題の理由を並べて返す。問題なしなら空。

    ここで弾かなかった誤りは images.csv に入ったあと js/assets.js に
    黙って読み飛ばされ、出題されない理由が追えなくなる。値の誤りは
    変換前に全部ここで捕まえる。
    """
    problems = []

    out_name = webp_name(row.get("filename"))
    answer = (row.get("answer") or "").strip()
    level = (row.get("level") or "").strip()
    trick = (row.get("trick") or "").strip()

    if not out_name:
        problems.append("filename が空")

    if answer not in ("dog", "not"):
        problems.append("answer が dog/not でない: %s" % (answer or "(空欄)"))

    if not (level.isdigit() and 1 <= int(level) <= 5):
        problems.append("level が 1〜5 の整数でない: %s" % (level or "(空欄)"))

    if not (trick.isdigit() and 1 <= int(trick) <= 3):
        problems.append("trick が 1〜3 の整数でない: %s" % (trick or "(空欄)"))

    # 答えはファイル名にも埋める。食い違うと出題の正解が入れ替わってしまう。
    if out_name:
        m = NAME_PREFIX_RE.match(out_name)
        if not m:
            problems.append("filename が dog_/not_ で始まらない: %s" % out_name)
        elif answer in ("dog", "not") and m.group(1).lower() != answer:
            problems.append("filename と answer が矛盾: %s に answer=%s"
                            % (out_name, answer))

    return problems


def unique_path(path):
    """既にあるなら _2, _3 … を足して空いている名前を返す。"""
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    n = 2
    while os.path.exists("%s_%d%s" % (base, n, ext)):
        n += 1
    return "%s_%d%s" % (base, n, ext)


def read_master(path):
    """master CSV を読む。Excel が付ける BOM も扱う。"""
    with open(path, "rb") as fh:
        head = fh.read(3)
    encoding = "utf-8-sig" if head == b"\xef\xbb\xbf" else "utf-8"
    with open(path, "r", encoding=encoding, newline="") as fh:
        reader = csv.DictReader(fh)
        fieldnames = list(reader.fieldnames or [])
        rows = [dict(r) for r in reader]
    return fieldnames, rows, encoding


def write_csv(path, fieldnames, rows, encoding):
    """壊れた CSV を残さないよう、一時ファイルに書いてから置き換える。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding=encoding, newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, lineterminator="\n",
                                extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: (row.get(k) or "") for k in fieldnames})
    os.replace(tmp, path)


def convert(src, dst, size, quality):
    """中央を正方形に切り、長辺 size の webp にする。拡大はしない。"""
    from PIL import Image, ImageOps

    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA" if "A" in im.getbands() else "RGB")

        w, h = im.size
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        im = im.crop((left, top, left + side, top + side))

        if side > size:
            im = im.resize((size, size), Image.LANCZOS)

        os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
        im.save(dst, "WEBP", quality=quality, method=6)


# --- 本体 -----------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(
        description="raw/ の Midjourney PNG を img/ の webp にして CSV を更新する")
    parser.add_argument("--raw", default=DEFAULT_RAW, help="元画像のフォルダ (既定: raw)")
    parser.add_argument("--img", default=DEFAULT_IMG, help="出力先フォルダ (既定: img)")
    parser.add_argument("--master", default=DEFAULT_MASTER,
                        help="管理表 CSV (既定: images_master.csv)")
    parser.add_argument("--out", default=DEFAULT_OUT,
                        help="ゲームが読む CSV (既定: images.csv)")
    parser.add_argument("--prefix", default=DEFAULT_PREFIX,
                        help="ファイル名先頭で削るアカウント名 (既定: ainingen)")
    parser.add_argument("--size", type=int, default=DEFAULT_SIZE, help="長辺px (既定: 512)")
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY,
                        help="webp 品質 (既定: 80)")
    parser.add_argument("--force", action="store_true", help="既にある webp も作り直す")
    parser.add_argument("--dry-run", action="store_true", help="書き込まずに結果だけ表示する")
    args = parser.parse_args(argv)

    os.chdir(REPO_ROOT)

    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Pillow が入っていません。`pip install Pillow` を実行してください。", file=sys.stderr)
        return 2

    raw_dir, img_dir = args.raw, args.img
    dup_dir = os.path.join(img_dir, DUP_DIRNAME)

    # raw/ は .gitignore 対象のまま。無ければ作るだけ作って終わる。
    if not os.path.isdir(raw_dir):
        os.makedirs(raw_dir, exist_ok=True)
        print("%s/ を作成しました。ここに Midjourney の PNG を入れてください。" % raw_dir)
        return 0

    if not os.path.isfile(args.master):
        print("%s が見つかりません。" % args.master, file=sys.stderr)
        return 2

    fieldnames, rows, encoding = read_master(args.master)

    if "prompt" not in fieldnames:
        print("%s に prompt 列がありません。見つかった列: %s"
              % (args.master, ", ".join(fieldnames) or "(なし)"), file=sys.stderr)
        return 2
    if "filename" not in fieldnames:
        print("%s に filename 列がありません。見つかった列: %s"
              % (args.master, ", ".join(fieldnames)), file=sys.stderr)
        return 2
    if "generated" not in fieldnames:
        fieldnames.append("generated")
        for row in rows:
            row.setdefault("generated", "0")
        print("%s に generated 列が無かったので追加します。" % args.master)

    missing_cols = [c for c in OUT_COLUMNS if c not in fieldnames]
    if missing_cols:
        print("注意: %s に %s 列がありません。%s では空欄になります。"
              % (args.master, "/".join(missing_cols), args.out))

    # 記入ミスは変換前にまとめて捕まえる。画像がまだ無い行も見るので、
    # --dry-run だけで master 全体を検算できる。
    row_problems = {}
    for idx, row in enumerate(rows):
        if is_blank_row(row):
            continue
        found = validate_row(row)
        if found:
            row_problems[idx] = found

    # 行ごとの正規化済みプロンプトを先に用意する。
    prompts = [normalize(row.get("prompt")) for row in rows]

    files = sorted(
        f for f in os.listdir(raw_dir)
        if os.path.isfile(os.path.join(raw_dir, f))
        and os.path.splitext(f)[1].lower() in RAW_EXTS
    )

    matched = {}        # 行番号 -> [ファイル名, ...]
    unmatched = []      # (ファイル名, 冒頭, 理由)

    for fname in files:
        stem = os.path.splitext(fname)[0]
        head, confident = extract_head(stem, args.prefix)
        head_norm = normalize(head)

        if len(head_norm) < MIN_HEAD_LEN:
            unmatched.append((fname, head, "プロンプト冒頭を取り出せない"
                              + ("" if confident else " (UUID が見つからない)")))
            continue

        # 本命: master のプロンプトがファイル名の冒頭で始まる。
        cands = [i for i, p in enumerate(prompts) if p and p.startswith(head_norm)]
        # 保険: プロンプト全体がファイル名に収まっている場合。
        if not cands:
            cands = [i for i, p in enumerate(prompts)
                     if p and len(p) >= MIN_HEAD_LEN and head_norm.startswith(p)]

        if not cands:
            unmatched.append((fname, head, "一致する prompt が無い"))
            continue

        if len(cands) > 1:
            exact = [i for i in cands if prompts[i] == head_norm]
            if len(exact) == 1:
                cands = exact
            else:
                unmatched.append((fname, head, "prompt が %d 行に一致して絞れない (行 %s)"
                                  % (len(cands), ", ".join(str(i + 2) for i in cands))))
                continue

        matched.setdefault(cands[0], []).append(fname)

    # --- 変換 ---
    converted, skipped, dups, failed = [], [], [], []

    for idx in sorted(matched):
        row = rows[idx]
        group = sorted(matched[idx])
        out_name = webp_name(row.get("filename"))

        # 検査を通らない行は、退避も含めて一切触らない。
        if idx in row_problems:
            for f in group:
                failed.append((f, "master 行 %d: %s"
                               % (idx + 2, " / ".join(row_problems[idx]))))
            continue

        winner, rest = group[0], group[1:]
        dst = os.path.join(img_dir, out_name)

        if os.path.exists(dst) and not args.force:
            skipped.append((winner, out_name))
        else:
            try:
                if not args.dry_run:
                    convert(os.path.join(raw_dir, winner), dst, args.size, args.quality)
                converted.append((winner, out_name))
            except Exception as exc:  # 1枚の失敗で全体を止めない
                failed.append((winner, "変換に失敗: %s" % exc))
                continue

        row["generated"] = "1"

        # 同じ行に複数候補。採用した 1 枚以外は退避する。
        for f in rest:
            target = unique_path(os.path.join(dup_dir, f))
            if not args.dry_run:
                os.makedirs(dup_dir, exist_ok=True)
                shutil.move(os.path.join(raw_dir, f), target)
            dups.append((f, out_name, os.path.relpath(target)))

    # --- CSV 書き出し ---
    # 検査を通らない行は、前回の generated=1 が残っていても images.csv に出さない。
    generated_rows = [r for i, r in enumerate(rows)
                      if truthy(r.get("generated")) and i not in row_problems]
    generated_rows.sort(key=lambda r: (str(r.get("level", "")), str(r.get("filename", ""))))

    out_rows = []
    for r in generated_rows:
        out_rows.append({
            "filename": webp_name(r.get("filename")),
            "answer": (r.get("answer") or "").strip(),
            "level": (r.get("level") or "").strip(),
            "trick": (r.get("trick") or "").strip(),
        })

    if not args.dry_run:
        write_csv(args.master, fieldnames, rows, encoding)
        write_csv(args.out, OUT_COLUMNS, out_rows, "utf-8")

    # --- 報告 ---
    tag = " (dry-run: 何も書いていません)" if args.dry_run else ""
    print("")
    print("== 結果%s ==" % tag)
    print("raw/ の画像: %d 枚 / master: %d 行" % (len(files), len(rows)))
    print("変換: %d / 既存のためスキップ: %d / 重複退避: %d / 失敗: %d / 未照合: %d"
          % (len(converted), len(skipped), len(dups), len(failed), len(unmatched)))
    print("master の記入ミス: %d 行" % len(row_problems))
    print("%s: generated=1 の %d 行" % (args.out, len(out_rows)))

    if row_problems:
        print("\n-- master の記入ミス (この行は変換しない) --")
        for idx in sorted(row_problems):
            print("  行 %d  [%s]  %s"
                  % (idx + 2,
                     "画像あり" if idx in matched else "画像なし",
                     (rows[idx].get("filename") or "(filename 空欄)").strip()))
            for why in row_problems[idx]:
                print("      %s" % why)

    if converted:
        print("\n-- 変換した画像 --")
        for src, dst in converted:
            print("  %s -> %s/%s" % (src, img_dir, dst))

    if skipped:
        print("\n-- 既に webp があるのでスキップ (--force で作り直し) --")
        for src, dst in skipped:
            print("  %s -> %s/%s" % (src, img_dir, dst))

    if dups:
        print("\n-- 同じ行に複数の候補があったので退避 --")
        for src, dst, moved in dups:
            print("  %s (%s の候補) -> %s" % (src, dst, moved))

    if failed:
        print("\n-- 失敗 --")
        for src, why in failed:
            print("  %s: %s" % (src, why))

    if unmatched:
        print("\n-- 照合できなかったファイル --")
        for src, head, why in unmatched:
            print("  %s" % src)
            print("      冒頭: %s" % (head or "(取り出せず)"))
            print("      理由: %s" % why)

    return 1 if (failed or unmatched or row_problems) else 0


if __name__ == "__main__":
    sys.exit(main())
