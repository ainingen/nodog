/**
 * 出題画像の供給。
 * USE_DUMMY = true の間は canvas で描いたダミー画像を使う（外部ファイル不要）。
 * false にすると img/<filename> を読みに行く。どちらも entry.image に
 * drawImage 可能なオブジェクトが入る、という点だけがゲーム本体との約束。
 */
window.NoDog = window.NoDog || {};
(function (NoDog) {
  'use strict';

  var USE_DUMMY = true;
  var IMG_DIR = 'img/';
  var SIZE = 512;

  /* FNV-1a。ファイル名から色を決めるだけなので強度は不要。 */
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h >>> 0;
  }

  /** 文字列を canvas 幅に収まる行に分割する（日本語なので1文字ずつ詰める）。 */
  function wrap(ctx, text, maxWidth) {
    var lines = [];
    var line = '';
    for (var i = 0; i < text.length; i++) {
      var next = line + text[i];
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = text[i];
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * ダミー画像を1枚描く。
   * 色は filename のハッシュから決める。答え（dog/not）とは相関させない
   * ——色で正解が分かるとプロトタイプの意味がなくなるため。
   */
  function drawDummy(entry) {
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    var ctx = canvas.getContext('2d');
    var h = hash(entry.filename);
    var hue = h % 360;
    var hue2 = (hue + 35 + (h >> 9) % 60) % 360;

    var bg = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    bg.addColorStop(0, 'hsl(' + hue + ',62%,58%)');
    bg.addColorStop(1, 'hsl(' + hue2 + ',58%,38%)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, SIZE, SIZE);

    // 被写体のかわりの図形。実画像に置き換わる場所の目印。
    ctx.fillStyle = 'hsla(' + hue2 + ',70%,88%,0.22)';
    ctx.beginPath();
    ctx.arc(SIZE * 0.5, SIZE * 0.46, SIZE * 0.31, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = SIZE * 0.016;
    roundRect(ctx, SIZE * 0.05, SIZE * 0.05, SIZE * 0.9, SIZE * 0.9, SIZE * 0.06);
    ctx.stroke();

    // ラベル。長い名前でも収まるまでフォントを縮める。
    var maxWidth = SIZE * 0.82;
    var fontSize = SIZE * 0.155;
    var lines;
    do {
      ctx.font = '700 ' + fontSize + 'px "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif';
      lines = wrap(ctx, entry.label, maxWidth);
      if (lines.length <= 3) break;
      fontSize *= 0.85;
    } while (fontSize > SIZE * 0.06);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = fontSize * 0.22;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.fillStyle = '#fff';
    var lh = fontSize * 1.18;
    var top = SIZE * 0.5 - (lines.length - 1) * lh / 2;
    for (var i = 0; i < lines.length; i++) {
      ctx.strokeText(lines[i], SIZE / 2, top + i * lh);
      ctx.fillText(lines[i], SIZE / 2, top + i * lh);
    }

    ctx.font = '500 ' + SIZE * 0.045 + 'px "Hiragino Sans", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = SIZE * 0.012;
    ctx.strokeText('DUMMY', SIZE / 2, SIZE * 0.9);
    ctx.fillText('DUMMY', SIZE / 2, SIZE * 0.9);

    return canvas;
  }

  function loadReal(entry) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () {
        console.warn('[nodog] 画像を読めないためダミーで代用:', entry.filename);
        resolve(drawDummy(entry));
      };
      img.src = IMG_DIR + entry.filename;
    });
  }

  /** 全問ぶんの画像を用意して entry.image に入れる（事前プリロード）。 */
  function preload(entries) {
    if (USE_DUMMY) {
      entries.forEach(function (e) { e.image = drawDummy(e); });
      return Promise.resolve(entries);
    }
    return Promise.all(entries.map(function (e) {
      return loadReal(e).then(function (img) { e.image = img; });
    })).then(function () { return entries; });
  }

  NoDog.assets = { preload: preload, drawDummy: drawDummy, SIZE: SIZE, USE_DUMMY: USE_DUMMY };
})(window.NoDog);
