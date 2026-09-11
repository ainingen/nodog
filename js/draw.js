/**
 * canvas への描画。DOM 上の canvas はこの1枚だけ（PLiCy のサムネ対策）。
 *
 * 論理サイズは常に 720x720。実ピクセルは devicePixelRatio に合わせ、
 * setTransform で 720 系に合わせ直すので、呼ぶ側は 0..720 で考えればよい。
 * 角丸24px・輪8px のような「CSS px で指定されている寸法」は px() で
 * 論理単位に直す。表示サイズが変わっても見た目の太さが変わらない。
 */
window.NoDog = window.NoDog || {};
(function (NoDog) {
  'use strict';

  var L = 720;                 // 論理サイズ
  var PLAY_INSET = 44;         // プレイ中の写真の余白（輪を置く分だけ広い）
  var BIG_INSET = 24;          // タイトル・結果の写真の余白
  var FONT = '"Zen Maru Gothic", "Hiragino Maru Gothic ProN", "BIZ UDPGothic", sans-serif';

  var canvas = null, ctx = null, cssSize = L;

  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /** CSS px を論理単位に直す。 */
  function px(n) { return n * L / cssSize; }

  function resize() {
    cssSize = canvas.clientWidth || L;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var backing = Math.round(cssSize * dpr);
    if (canvas.width !== backing) { canvas.width = backing; canvas.height = backing; }
    var s = backing / L;
    ctx.setTransform(s, 0, 0, s, 0, 0);
  }

  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', function () { resize(); NoDog.draw.repaint(); });
  }

  /* --- 形 -------------------------------------------------------------- */

  function roundRectPath(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /**
   * 角丸長方形の輪郭を、12時から時計回りに並べた区間の列にする。
   * 「残り時間に比例して時計回りに消えていく」輪はこれを部分的に描いて作る。
   */
  function outline(x, y, w, h, r) {
    var segs = [
      { line: [x + w / 2, y, x + w - r, y] },
      { arc: [x + w - r, y + r, r, -Math.PI / 2, 0] },
      { line: [x + w, y + r, x + w, y + h - r] },
      { arc: [x + w - r, y + h - r, r, 0, Math.PI / 2] },
      { line: [x + w - r, y + h, x + r, y + h] },
      { arc: [x + r, y + h - r, r, Math.PI / 2, Math.PI] },
      { line: [x, y + h - r, x, y + r] },
      { arc: [x + r, y + r, r, Math.PI, Math.PI * 1.5] },
      { line: [x + r, y, x + w / 2, y] }
    ];
    var total = 0;
    segs.forEach(function (s) {
      s.len = s.line
        ? Math.hypot(s.line[2] - s.line[0], s.line[3] - s.line[1])
        : s.arc[2] * (s.arc[4] - s.arc[3]);
      s.at = total;
      total += s.len;
    });
    return { segs: segs, total: total };
  }

  /** 輪郭の from..to（0..1）だけを描く。 */
  function strokeArcOfOutline(c, o, from, to) {
    var a = from * o.total, b = to * o.total;
    if (b - a < 0.001) return;
    c.beginPath();
    var started = false;
    o.segs.forEach(function (s) {
      var s0 = Math.max(a, s.at), s1 = Math.min(b, s.at + s.len);
      if (s1 <= s0) return;
      var t0 = (s0 - s.at) / s.len, t1 = (s1 - s.at) / s.len;
      if (s.line) {
        var x0 = s.line[0] + (s.line[2] - s.line[0]) * t0,
            y0 = s.line[1] + (s.line[3] - s.line[1]) * t0,
            x1 = s.line[0] + (s.line[2] - s.line[0]) * t1,
            y1 = s.line[1] + (s.line[3] - s.line[1]) * t1;
        if (!started) { c.moveTo(x0, y0); started = true; } else { c.lineTo(x0, y0); }
        c.lineTo(x1, y1);
      } else {
        var cx = s.arc[0], cy = s.arc[1], r = s.arc[2];
        var a0 = s.arc[3] + (s.arc[4] - s.arc[3]) * t0,
            a1 = s.arc[3] + (s.arc[4] - s.arc[3]) * t1;
        if (!started) { c.moveTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r); started = true; }
        c.arc(cx, cy, r, a0, a1);
      }
    });
    c.stroke();
  }

  /* --- 部品 ------------------------------------------------------------ */

  function clear() {
    ctx.fillStyle = token('--bg') || '#FFF8E7';
    ctx.fillRect(0, 0, L, L);
  }

  /** 写真を角丸で描く。正方形前提だが、比率が違ってもはみ出さないよう収める。 */
  function photo(entry, x, y, size) {
    var r = px(24);
    ctx.save();
    roundRectPath(ctx, x, y, size, size, r);
    ctx.clip();
    ctx.fillStyle = token('--milk') || '#EFE3CC';
    ctx.fillRect(x, y, size, size);
    if (entry && entry.bitmap) {
      var iw = entry.bitmap.width || size, ih = entry.bitmap.height || size;
      var sc = Math.max(size / iw, size / ih);   // 角丸内を埋める
      var w = iw * sc, h = ih * sc;
      ctx.drawImage(entry.bitmap, x + (size - w) / 2, y + (size - h) / 2, w, h);
    }
    ctx.restore();
  }

  /** 1行に収まる字の大きさを探す。 */
  function fitFont(c, text, maxWidth, start, weight) {
    var size = start;
    do {
      c.font = weight + ' ' + size + 'px ' + FONT;
      if (c.measureText(text).width <= maxWidth) break;
      size -= 2;
    } while (size > 12);
    return size;
  }

  /* --- 画面 ------------------------------------------------------------ */

  /**
   * タイトル。写真の下 1/3 に地色の帯を重ね、その上に題名を置く。
   * canvas だけ切り出しても「写真＋題名」で成立する構図にしてある。
   */
  function title(entry, text) {
    clear();
    var x = BIG_INSET, size = L - BIG_INSET * 2;
    photo(entry, x, x, size);

    var r = px(24);
    ctx.save();
    roundRectPath(ctx, x, x, size, size, r);
    ctx.clip();

    var bandH = size / 3, bandY = x + size - bandH;
    var paper = token('--paper') || '#FFF8E7';
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = paper;
    ctx.fillRect(x, bandY, size, bandH);
    ctx.globalAlpha = 1;

    ctx.fillStyle = token('--ink') || '#4A3728';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, text, size * 0.84, 96, '700');
    ctx.fillText(text, x + size / 2, bandY + bandH / 2);
    ctx.restore();
  }

  /**
   * プレイ中。写真と、その外周 8px を回るタイマーの輪。
   * 輪は 12 時から時計回りに消えていく。残り 25% で色が変わる。
   */
  function play(entry, remain, shakeX) {
    ctx.save();
    if (shakeX) ctx.translate(px(shakeX), 0);   // shakeX は CSS px
    clear();
    var x = PLAY_INSET, size = L - PLAY_INSET * 2;
    photo(entry, x, x, size);

    var gap = px(8), width = px(8);
    var off = gap + width / 2;
    var o = outline(x - off, x - off, size + off * 2, size + off * 2, px(24) + off);
    ctx.lineWidth = width;
    ctx.lineCap = 'butt';
    /* 減った分を --milk で残す。輪だけだと角丸のどこが端なのか読めず、
       残量が一目で分からない。 */
    ctx.strokeStyle = token('--milk') || '#EFE3CC';
    strokeArcOfOutline(ctx, o, 0, 1);
    ctx.strokeStyle = remain <= 0.25
      ? (token('--sakura') || '#F2A9B4')
      : (token('--honey') || '#E8B04B');
    strokeArcOfOutline(ctx, o, 1 - remain, 1);
    ctx.restore();
  }

  /** 写真だけを大きく。結果画面の裏（＝サムネ）用。 */
  function still(entry) {
    clear();
    photo(entry, BIG_INSET, BIG_INSET, L - BIG_INSET * 2);
  }

  /**
   * 判定スタンプ。写真の 60% の丸を -8 度傾けて重ねる。
   * grow は 0..1。1.4 倍から 1.0 へ、1回だけ行き過ぎて戻る。
   */
  function stamp(lines, ok, grow) {
    var x = PLAY_INSET, size = L - PLAY_INSET * 2;
    var d = size * 0.6, cx = x + size / 2, cy = x + size / 2;

    /* easeOutBack。1 を超える瞬間があるので scale が 1.0 を下回って戻る。 */
    var c1 = 1.70158, c3 = c1 + 1, p = grow - 1;
    var eased = 1 + c3 * p * p * p + c1 * p * p;
    var scale = 1.4 - 0.4 * eased;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-8 * Math.PI / 180);
    ctx.scale(scale, scale);

    ctx.fillStyle = ok ? (token('--wakaba') || '#A8D5A2') : (token('--sakura') || '#F2A9B4');
    ctx.beginPath();
    ctx.arc(0, 0, d / 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var longest = lines.reduce(function (a, b) { return a.length >= b.length ? a : b; });
    var fs = fitFont(ctx, longest, d * 0.76, 96, '700');
    var lh = fs * 1.12, top = -(lines.length - 1) * lh / 2;
    for (var i = 0; i < lines.length; i++) ctx.fillText(lines[i], 0, top + i * lh);
    ctx.restore();
  }

  NoDog.draw = {
    init: init,
    resize: resize,
    title: title,
    play: play,
    still: still,
    stamp: stamp,
    /* 直近の描画をやり直す。game.js が差し替える。 */
    repaint: function () {}
  };
})(window.NoDog);
