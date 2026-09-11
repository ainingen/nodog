/**
 * 出題データの供給。
 * images.csv を読み、各 entry に次の2つを必ず持たせて返す。
 *   entry.bitmap … canvas に drawImage できるもの
 *   entry.src    … <img src> に入れられる URL
 * ダミー画像も同じ形に揃えるので、ゲーム側は実画像との差を意識しない。
 *
 * PLiCy はページ内の最初の canvas をサムネにする。DOM 上の canvas を
 * 1枚だけに保つため、ダミー画像の生成は OffscreenCanvas で行う。
 */
window.NoDog = window.NoDog || {};
(function (NoDog) {
  'use strict';

  var CSV_PATH = 'images.csv';
  var IMG_DIR = 'img/';
  var SIZE = 720;

  /* ダミー画像のお題。images.csv が空でも 60 問の一本道を通すために使う。
     ここの文字は tools/build_font.py がフォントのサブセットに拾う。 */
  var DUMMY_DOGS = ['トイプードル', 'しばいぬ', 'ゴールデン', 'チワワ', 'パグ',
                    'ぬれた犬', 'けだま', 'ボルゾイ', 'シーズー', 'ダックス',
                    'わんこの尻', 'ねてる犬'];
  var DUMMY_NOTS = ['からあげ', 'モップ', '食パン', 'ぬいぐるみ', 'クロワッサン',
                    'ざぶとん', 'たわし', '子ヤギ', 'アルパカ', 'もうふ',
                    'チキン', '茶色い何か'];

  /* --- CSV ------------------------------------------------------------ */

  /* images.csv は値にカンマも改行も入れない運用（README 参照）。 */
  function parseCsv(text) {
    var lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    var header = null, rows = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var cols = line.split(',').map(function (s) { return s.trim(); });
      if (!header) { header = cols; continue; }
      var row = {};
      for (var c = 0; c < header.length; c++) row[header[c]] = cols[c] || '';
      rows.push(row);
    }
    return rows;
  }

  function toEntry(row) {
    if (!row.filename) return null;
    var answer = row.answer === 'dog' ? 'dog' : row.answer === 'not' ? 'not' : null;
    if (!answer) return null;
    var level = parseInt(row.level, 10);
    if (!(level >= 1 && level <= 5)) return null;
    var trick = parseInt(row.trick, 10);
    return {
      filename: row.filename,
      answer: answer,
      level: level,
      trick: (trick >= 1 && trick <= 3) ? trick : 1,
      dummy: false,
      /* ダミーに落ちたときだけ絵に描く文字。label 列があればそれを使う。 */
      label: row.label || row.filename.replace(/^(dog|not)_\d+_/, '').replace(/\.\w+$/, '')
    };
  }

  function loadCsv() {
    return fetch(CSV_PATH, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (text) { return parseCsv(text).map(toEntry).filter(Boolean); })
      .catch(function (err) {
        /* file:// で直接開くと fetch が失敗する。その場合は全部ダミーで動かす。 */
        console.warn('[nodog] ' + CSV_PATH + ' を読めませんでした:', err.message);
        return [];
      });
  }

  /* --- ダミー画像 ------------------------------------------------------ */

  /* FNV-1a。色決めにしか使わないので強度は不要。 */
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return h >>> 0;
  }

  /* 日本語なので単語境界は使わず 1 文字ずつ詰める。 */
  function wrap(c, text, maxWidth) {
    var lines = [], line = '';
    for (var i = 0; i < text.length; i++) {
      var next = line + text[i];
      if (line && c.measureText(next).width > maxWidth) { lines.push(line); line = text[i]; }
      else { line = next; }
    }
    if (line) lines.push(line);
    return lines;
  }

  function makeOffscreen(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    /* OffscreenCanvas が無い環境向け。document に append しないので
       PLiCy のサムネ判定（最初の canvas）には影響しない。 */
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
  }

  /**
   * ダミー画像を 1 枚描く。
   * 色は filename のハッシュから決める。答え(dog/not)と相関させると
   * 色で解けてしまうので、そうしない。
   * 単色1面にしているのは、内側にもう一枚置くと写真の周りに枠が
   * 入れ子になっているように見えてしまうため。
   */
  function drawDummy(entry, ink) {
    var cv = makeOffscreen(SIZE, SIZE);
    var c = cv.getContext('2d');
    var h = hash(entry.filename);

    c.fillStyle = 'hsl(' + (h % 360) + ',' + (36 + (h >> 9) % 20) + '%,82%)';
    c.fillRect(0, 0, SIZE, SIZE);

    c.fillStyle = ink;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = '700 74px "Zen Maru Gothic", "Hiragino Maru Gothic ProN", "BIZ UDPGothic", sans-serif';
    var lines = wrap(c, entry.label || entry.filename, SIZE - 150);
    var lh = 86, top = SIZE / 2 - (lines.length - 1) * lh / 2;
    for (var i = 0; i < lines.length; i++) c.fillText(lines[i], SIZE / 2, top + i * lh);
    return cv;
  }

  function toBlob(cv) {
    if (cv.convertToBlob) return cv.convertToBlob({ type: 'image/webp' });
    return new Promise(function (resolve) { cv.toBlob(resolve, 'image/webp'); });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error(src)); };
      img.src = src;
    });
  }

  /* entry.bitmap と entry.src を必ず埋める。
     実画像が読めないときは黙ってダミーに落とし、ゲームを止めない。 */
  function prepare(entry, ink) {
    var asDummy = function () {
      entry.dummy = true;
      var cv = drawDummy(entry, ink);
      return toBlob(cv).then(function (blob) {
        entry.src = URL.createObjectURL(blob);
        return loadImage(entry.src);
      }).then(function (img) { entry.bitmap = img; return entry; });
    };

    if (entry.dummy) return asDummy();

    entry.src = IMG_DIR + entry.filename;
    return loadImage(entry.src)
      .then(function (img) { entry.bitmap = img; return entry; })
      .catch(function () {
        console.warn('[nodog] ' + entry.src + ' を読めないのでダミーにします');
        return asDummy();
      });
  }

  NoDog.assets = {
    DUMMY_DOGS: DUMMY_DOGS,
    DUMMY_NOTS: DUMMY_NOTS,
    loadCsv: loadCsv,
    prepare: prepare
  };
})(window.NoDog);
