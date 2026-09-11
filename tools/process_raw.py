#!/usr/bin/env python3
"""raw/ の元画像を webp に変換して img/ と images.csv を更新する。

置き場所と命名（raw/ は .gitignore 済み、コミットされない）:

    raw/<面>/<answer>[_t<trick>]_<slug>.png

      raw/1/dog_poodle.png          -> 面1 / 犬   / trick=1
      raw/3/not_t3_karaage.png      -> 面3 / 犬以外 / trick=3
      raw/dog_l5_t3_oshiri.png      -> 面5 も _l<N> で直接指定できる

    answer は dog / not。trick 省略時は 1。拡張子は png/jpg/jpeg/webp。

出力は img/<answer>_<通番>_<slug>.webp（例 dog_012_poodle.webp）。
通番は既存 images.csv から引き継ぐので、再実行しても既存画像の番号は動かない。
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow が必要です: pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "raw"
IMG_DIR = ROOT / "img"
CSV_PATH = ROOT / "images.csv"

SRC_EXT = {".png", ".jpg", ".jpeg", ".webp"}
CSV_HEADER = ["filename", "answer", "level", "trick"]

# README の構成表: 面 -> (制限時間, ひっかけ率, 問数)
LEVELS = {
    1: ("2.0秒", 0.3, 12),
    2: ("1.5秒", 0.6, 12),
    3: ("1.0秒", 0.8, 12),
    4: ("0.75秒", 0.9, 12),
    5: ("0.5秒", 1.0, 12),
}

# dog_l3_t2_karaage / not_karaage
NAME_RE = re.compile(
    r"^(?P<answer>dog|not)"
    r"(?:_l(?P<level>[1-5]))?"
    r"(?:_t(?P<trick>[1-3]))?"
    r"_(?P<slug>[a-z0-9]+(?:_[a-z0-9]+)*)$"
)
OUT_RE = re.compile(r"^(?P<answer>dog|not)_(?P<num>\d{3})_(?P<slug>.+)\.webp$")


class Problem(Exception):
    pass


def parse_source(path: Path) -> dict:
    """raw/ 配下の 1 ファイルを {answer, level, trick, slug} に読み解く。"""
    m = NAME_RE.match(path.stem.lower())
    if not m:
        raise Problem(
            f"ファイル名が読めません: {path.name}"
            " (例: dog_poodle.png / not_t3_karaage.png)"
        )

    level = m.group("level")
    if level is None:
        # 親ディレクトリ名 (raw/3/...) を面番号として使う
        parent = path.parent.name
        if path.parent != RAW_DIR and parent.isdigit():
            level = parent
    if level is None:
        raise Problem(
            f"面が分かりません: {path.relative_to(RAW_DIR)}"
            " (raw/<1-5>/ に置くか _l<N> を付けてください)"
        )
    if int(level) not in LEVELS:
        raise Problem(f"面は 1-5 です: {path.relative_to(RAW_DIR)}")

    return {
        "answer": m.group("answer"),
        "level": int(level),
        "trick": int(m.group("trick") or 1),
        "slug": m.group("slug"),
    }


def load_existing_numbers() -> dict[tuple[str, str], int]:
    """(answer, slug) -> 通番。既存の番号を維持するために使う。"""
    numbers: dict[tuple[str, str], int] = {}
    names: list[str] = []

    if CSV_PATH.exists():
        with CSV_PATH.open(encoding="utf-8", newline="") as f:
            names += [row["filename"] for row in csv.DictReader(f) if row.get("filename")]
    names += [p.name for p in IMG_DIR.glob("*.webp")]

    for name in names:
        m = OUT_RE.match(name)
        if m:
            numbers[(m.group("answer"), m.group("slug"))] = int(m.group("num"))
    return numbers


def to_square(im: Image.Image, size: int, fit: str) -> Image.Image:
    """正方形に整えて size×size へ。crop は中央切り出し、pad は白で余白埋め。"""
    if fit == "crop":
        return ImageOps.fit(im, (size, size), method=Image.LANCZOS, centering=(0.5, 0.5))
    return ImageOps.pad(im, (size, size), method=Image.LANCZOS, color=(255, 255, 255))


def convert(src: Path, dst: Path, size: int, quality: int, fit: str) -> None:
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            flat = Image.new("RGB", im.size, (255, 255, 255))
            flat.paste(im, mask=im.split()[-1])
            im = flat
        else:
            im = im.convert("RGB")
        to_square(im, size, fit).save(dst, "WEBP", quality=quality, method=6)


def report(rows: list[dict]) -> None:
    """README の構成表と突き合わせて過不足を出す（警告のみ）。"""
    print("\n面  問数        犬/犬以外   ひっかけ(trick>=2)")
    for level, (limit, trick_rate, want) in LEVELS.items():
        at = [r for r in rows if r["level"] == level]
        if not at:
            continue
        dog = sum(1 for r in at if r["answer"] == "dog")
        tricky = sum(1 for r in at if r["trick"] >= 2)
        mark = " " if len(at) == want else "!"
        print(
            f"{level}{mark} {len(at):2d}/{want} ({limit:>6})"
            f"  {dog:2d}/{len(at) - dog:<2d}"
            f"      {tricky:2d}/{len(at)} (目標 {trick_rate:.0%})"
        )

    total = len(rows)
    print(f"\n合計 {total}/60 問")
    if total != 60:
        print("! 全60問になっていません（プロトタイプ中なら無視して構いません）")

    if IMG_DIR.exists():
        kb = sum(p.stat().st_size for p in IMG_DIR.glob("*.webp")) / 1024
        print(f"img/ 合計 {kb:.0f} KB")


def main() -> int:
    ap = argparse.ArgumentParser(description="raw/ の元画像を webp 化して images.csv を更新する")
    ap.add_argument("--size", type=int, default=512, help="出力の一辺 px (既定 512)")
    ap.add_argument("--quality", type=int, default=82, help="webp 品質 (既定 82)")
    ap.add_argument("--fit", choices=["crop", "pad"], default="crop",
                    help="正方形化の方法 (既定 crop=中央切り出し)")
    ap.add_argument("--force", action="store_true", help="出力が新しくても変換し直す")
    ap.add_argument("--dry-run", action="store_true", help="書き込まず結果だけ表示する")
    args = ap.parse_args()

    if not RAW_DIR.is_dir():
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        print(f"raw/ を作りました。元画像を置いてから実行してください: {RAW_DIR}")
        return 0

    sources = sorted(p for p in RAW_DIR.rglob("*")
                     if p.is_file() and p.suffix.lower() in SRC_EXT)
    if not sources:
        print(f"raw/ に画像がありません: {RAW_DIR}")
        return 0

    entries, problems = [], []
    for src in sources:
        try:
            meta = parse_source(src)
        except Problem as e:
            problems.append(str(e))
            continue
        meta["src"] = src
        entries.append(meta)

    # 通番の割り当て: 既存分は据え置き、新規は最大値の次から
    numbers = load_existing_numbers()
    next_num = max(numbers.values(), default=0) + 1
    entries.sort(key=lambda e: (e["level"], e["answer"], e["slug"]))
    for e in entries:
        key = (e["answer"], e["slug"])
        if key not in numbers:
            numbers[key] = next_num
            next_num += 1
        e["num"] = numbers[key]
        e["filename"] = f"{e['answer']}_{e['num']:03d}_{e['slug']}.webp"

    seen: dict[str, Path] = {}
    for e in entries:
        if e["filename"] in seen:
            problems.append(
                f"出力名が衝突します: {e['filename']}"
                f" ({seen[e['filename']].name} と {e['src'].name})"
            )
        seen[e["filename"]] = e["src"]

    if problems:
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        return 1

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    converted = skipped = 0
    for e in entries:
        dst = IMG_DIR / e["filename"]
        fresh = dst.exists() and dst.stat().st_mtime >= e["src"].stat().st_mtime
        if fresh and not args.force:
            skipped += 1
            continue
        rel = e["src"].relative_to(RAW_DIR)
        print(f"  {rel} -> img/{e['filename']}")
        if not args.dry_run:
            convert(e["src"], dst, args.size, args.quality, args.fit)
        converted += 1

    rows = sorted(entries, key=lambda e: (e["level"], e["num"]))
    if not args.dry_run:
        with CSV_PATH.open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow(CSV_HEADER)
            for e in rows:
                w.writerow([e["filename"], e["answer"], e["level"], e["trick"]])

    print(f"\n変換 {converted} 枚 / 据え置き {skipped} 枚"
          f"{' (dry-run: 書き込みなし)' if args.dry_run else ''}")
    report(rows)

    stale = [p.name for p in IMG_DIR.glob("*.webp") if p.name not in seen]
    if stale:
        print("\n! raw/ に元画像が無い img/ のファイル（消すか raw/ に戻してください）:")
        for name in sorted(stale):
            print(f"  img/{name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
