/**
 * images.csv の読み込みとパース。
 * ゲーム本体は「画像リスト = images.csv」しか知らない。
 */
window.NoDog = window.NoDog || {};
(function (NoDog) {
  'use strict';

  var CSV_PATH = 'images.csv';

  /**
   * 引用符なしの単純な CSV を配列に変換する。
   * images.csv は値にカンマ・改行を含めない運用（README 参照）。
   */
  function parse(text) {
    var lines = text.replace(/\r\n?/g, '\n').split('\n');
    var header = null;
    var rows = [];
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

  /** CSV 1 行をゲームが扱う出題データにする。不正な行は null。 */
  function toEntry(row) {
    if (!row.filename) return null;
    var answer = row.answer === 'dog' ? 'dog' : row.answer === 'not' ? 'not' : null;
    if (!answer) return null;
    var level = parseInt(row.level, 10);
    if (!(level >= 1 && level <= 5)) return null;
    return {
      filename: row.filename,
      answer: answer,
      level: level,
      trick: parseInt(row.trick, 10) || 1,
      // label はダミー画像に描く文字。実画像に差し替えたら表示に使わない。
      label: row.label || row.filename.replace(/^(dog|not)_\d+_/, '').replace(/\.\w+$/, '')
    };
  }

  /**
   * images.csv を読む。file:// 直開きなど fetch が使えない環境では
   * tools/build-fallback.sh が生成した NoDog.IMAGES_CSV_FALLBACK を使う。
   */
  function load() {
    return fetch(CSV_PATH, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .catch(function (err) {
        if (!NoDog.IMAGES_CSV_FALLBACK) throw err;
        console.warn('[nodog] ' + CSV_PATH + ' を fetch できないため同梱データを使用:', err.message);
        return NoDog.IMAGES_CSV_FALLBACK;
      })
      .then(function (text) {
        var entries = parse(text).map(toEntry).filter(Boolean);
        if (!entries.length) throw new Error(CSV_PATH + ' に有効な行がありません');
        return entries;
      });
  }

  NoDog.images = { CSV_PATH: CSV_PATH, parse: parse, toEntry: toEntry, load: load };
})(window.NoDog);
