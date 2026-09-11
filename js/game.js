/**
 * ゲーム本体。状態遷移・入力・スコアは従来どおりで、見た目だけを
 * 『これ、わんこ？』の指示書に合わせてある。
 *
 * 動かすものは3つだけ：タイマーの輪、判定スタンプ、誤答の揺れ。
 * それ以外の遷移アニメーションは入れない。
 */
window.NoDog = window.NoDog || {};
(function (NoDog) {
  'use strict';

  var assets = NoDog.assets, draw = NoDog.draw;

  /* --- 設定 ------------------------------------------------------------ */

  var STAGES = [
    { name: '入門',       limit: 2.00, targetTrick: 1 },
    { name: 'なんとなく犬', limit: 1.50, targetTrick: 1 },
    { name: '茶色い奴ら',  limit: 1.00, targetTrick: 2 },
    { name: '尻',         limit: 0.75, targetTrick: 2 },
    { name: 'わんこ地獄',  limit: 0.50, targetTrick: 3 }
  ];
  var PER_STAGE = 12;
  var MAX_LIFE = 3;
  var VERDICT_MS = 300;
  var GROW_MS = 120;     // スタンプが 1.4 倍から戻るまで
  var SHAKE_MS = 80;     // 誤答時の揺れ（2往復）
  var TILTS = [-4, 3, -2];

  var TEXT = {
    title: 'これ、わんこ？',
    dog: 'わんこ',
    not: 'わんこじゃない',
    stampDog: ['わんこ！'],
    stampNot: ['わんこ', 'じゃない！'],
    over: 'おつかれさま',
    clear: 'ぜんぶ わかった！',
    thoughtDog: 'あなたがわんこだと思ったもの',
    thoughtNot: 'あなたがわんこじゃないと思ったもの',
    noAnswer: 'こたえられなかったもの',
    really: 'ほんとは'
  };

  var reduced = window.matchMedia &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- DOM ------------------------------------------------------------- */

  var $ = function (id) { return document.getElementById(id); };
  var el = {};
  ['stage', 'hud', 'life', 'stageName', 'qCount', 'score', 'combo',
   'footer', 'result', 'resultTitle', 'resultScore', 'resultReach', 'resultBody',
   'loading', 'note'].forEach(function (id) { el[id] = $(id); });

  /* --- 面ごとの地色 ----------------------------------------------------- */

  function hex(c) {
    return [parseInt(c.substr(1, 2), 16), parseInt(c.substr(3, 2), 16), parseInt(c.substr(5, 2), 16)];
  }
  function mix(a, b, t) {
    var x = hex(a), y = hex(b);
    return 'rgb(' + x.map(function (v, i) {
      return Math.round(v + (y[i] - v) * t);
    }).join(',') + ')';
  }
  function cssVar(n) {
    return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  }

  /* 1面は生成り、面が上がるごとに色温度を下げ、最終面だけ夜の紺に入れ替える。
     最終面の合図は夜に変わること自体で足りるので、他の演出は足さない。 */
  function applyStageColor(idx) {
    var paper = cssVar('--paper'), night = cssVar('--night');
    var last = idx >= STAGES.length - 1;
    document.body.classList.toggle('night', last);
    document.documentElement.style.setProperty(
      '--bg', last ? night : mix(paper, night, (idx / (STAGES.length - 2)) * 0.15));
  }

  /* --- 出題順 ----------------------------------------------------------- */

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  var dummySeq = 0;
  function makeDummy(level, answer) {
    var pool = answer === 'dog' ? assets.DUMMY_DOGS : assets.DUMMY_NOTS;
    var label = pool[dummySeq % pool.length];
    dummySeq++;
    return {
      filename: answer + '_d' + dummySeq + '_' + level,
      answer: answer, level: level, trick: STAGES[level - 1].targetTrick,
      dummy: true, label: label
    };
  }

  /* 各面 12 問。実画像が足りない分はダミーで埋めるので、
     images.csv が空でも 60 問の一本道が通る。 */
  function buildDeck(entries) {
    var deck = [];
    for (var lv = 1; lv <= STAGES.length; lv++) {
      var target = STAGES[lv - 1].targetTrick;
      var pool = shuffle(entries.filter(function (e) { return e.level === lv; }));
      pool.sort(function (a, b) { return Math.abs(a.trick - target) - Math.abs(b.trick - target); });

      var picked = pool.slice(0, PER_STAGE);
      while (picked.length < PER_STAGE && pool.length > 0) picked.push(pool[picked.length % pool.length]);
      var i = 0;
      while (picked.length < PER_STAGE) {
        picked.push(makeDummy(lv, (i + lv) % 2 === 0 ? 'dog' : 'not'));
        i++;
      }
      deck = deck.concat(shuffle(picked));
    }
    return deck;
  }

  /* タイトルの1枚は trick が高いものを固定で選ぶ。
     サムネが毎回変わると困るので、ここだけはランダムにしない。 */
  function pickCover(entries) {
    var real = entries.slice().sort(function (a, b) {
      return (b.trick - a.trick) || (a.filename < b.filename ? -1 : 1);
    });
    if (real.length) return real[0];
    return { filename: 'cover_karaage', answer: 'not', level: 1, trick: 3,
             dummy: true, label: 'からあげ' };
  }

  /* --- 状態 ------------------------------------------------------------- */

  var state = null, deck = [], cover = null, rafId = 0;

  function newState() {
    return {
      index: 0, score: 0, combo: 0, bestCombo: 0, life: MAX_LIFE,
      correct: 0, misses: [], phase: 'title', startedAt: 0, limit: 0
    };
  }

  function stageIdx() {
    return Math.min(STAGES.length - 1, Math.floor(state.index / PER_STAGE));
  }
  function comboMultiplier(combo) {
    return Math.min(3.0, 1.0 + Math.floor(combo / 10) * 0.5);
  }
  function num(n) { return n.toLocaleString('en-US'); }

  /* --- HUD -------------------------------------------------------------- */

  function renderHud() {
    var idx = stageIdx();
    el.stageName.textContent = (idx + 1) + '面 ' + STAGES[idx].name;
    el.qCount.textContent = (state.index % PER_STAGE + 1) + '/' + PER_STAGE;
    el.score.textContent = num(state.score);
    var mul = comboMultiplier(state.combo);
    el.combo.textContent = mul > 1 ? '×' + mul.toFixed(1) : '';
    for (var i = 0; i < el.life.children.length; i++) {
      el.life.children[i].classList.toggle('lost', i >= state.life);
    }
  }

  /* --- 画面 ------------------------------------------------------------- */

  function showTitle() {
    state = newState();
    applyStageColor(0);
    el.hud.hidden = true;
    el.footer.hidden = false;
    el.result.hidden = true;
    draw.repaint = function () { draw.title(cover, TEXT.title); };
    draw.repaint();
  }

  function start() {
    var keep = deck;
    state = newState();
    deck = keep;
    state.phase = 'question';
    el.hud.hidden = false;
    el.footer.hidden = true;
    el.result.hidden = true;
    state.index = 0;
    nextQuestion();
  }

  function nextQuestion() {
    if (state.index >= deck.length) { finish(true); return; }
    var idx = stageIdx();
    applyStageColor(idx);
    state.limit = STAGES[idx].limit * 1000;
    state.startedAt = performance.now();
    state.phase = 'question';
    renderHud();

    var entry = deck[state.index];
    draw.repaint = function () { draw.play(entry, currentRemain()); };
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  function currentRemain() {
    return Math.max(0, Math.min(1, 1 - (performance.now() - state.startedAt) / state.limit));
  }

  function tick() {
    if (state.phase !== 'question') return;
    var remain = currentRemain();
    draw.play(deck[state.index], remain);
    if (remain <= 0) { judge(null); return; }
    rafId = requestAnimationFrame(tick);
  }

  /* choice: 'dog' | 'not' | null(時間切れ) */
  function judge(choice) {
    if (state.phase !== 'question') return;
    cancelAnimationFrame(rafId);
    state.phase = 'verdict';

    var entry = deck[state.index];
    var remain = currentRemain();
    var ok = choice === entry.answer;

    if (ok) {
      state.combo++;
      state.bestCombo = Math.max(state.bestCombo, state.combo);
      state.correct++;
      state.score += Math.round((100 + Math.round(remain * 100)) * comboMultiplier(state.combo));
    } else {
      state.combo = 0;
      state.life--;
      state.misses.push({ entry: entry, choice: choice });
    }
    renderHud();

    var lines = entry.answer === 'dog' ? TEXT.stampDog : TEXT.stampNot;
    var began = performance.now();

    draw.repaint = function () { draw.verdict(entry, remain, lines, ok, 1, 0); };

    (function frame(now) {
      var t = now === undefined ? 0 : now - began;
      var grow = reduced ? 1 : Math.min(1, t / GROW_MS);
      var shake = 0;
      if (!ok && !reduced && t < SHAKE_MS) shake = 3 * Math.sin(t / SHAKE_MS * Math.PI * 4);
      draw.verdict(entry, remain, lines, ok, grow, shake);
      if (t < VERDICT_MS) rafId = requestAnimationFrame(frame);
    })(began);

    setTimeout(function () {
      cancelAnimationFrame(rafId);
      state.index++;
      if (state.life <= 0) finish(false);
      else nextQuestion();
    }, VERDICT_MS);
  }

  /* --- 結果 ------------------------------------------------------------- */

  function card(entry, caption, i) {
    var fig = document.createElement('figure');
    fig.className = 'card';
    fig.style.setProperty('--tilt', TILTS[i % TILTS.length] + 'deg');
    var tape = document.createElement('span');
    tape.className = 'tape';
    var img = document.createElement('img');
    img.src = entry.src;
    img.alt = '';
    /* 「ほんとは」と答えを別の行にする。まとめて入れると
       「ほんとは わんこじゃ / ない」のような割れ方をする。 */
    var cap = document.createElement('figcaption');
    var lead = document.createElement('span');
    lead.className = 'lead';
    lead.textContent = TEXT.really;
    var body = document.createElement('span');
    body.textContent = caption;
    cap.appendChild(lead);
    cap.appendChild(body);
    fig.appendChild(img);
    fig.appendChild(tape);
    if (caption) fig.appendChild(cap);
    return fig;
  }

  function group(heading, items) {
    if (!items.length) return null;
    var sec = document.createElement('section');
    sec.className = 'group';
    var h = document.createElement('h3');
    h.textContent = heading;
    var box = document.createElement('div');
    box.className = 'cards';
    items.forEach(function (m, i) {
      box.appendChild(card(m.entry,
        m.entry.answer === 'dog' ? TEXT.dog : TEXT.not, i));
    });
    sec.appendChild(h);
    sec.appendChild(box);
    return sec;
  }

  function finish(cleared) {
    cancelAnimationFrame(rafId);
    state.phase = 'over';
    el.hud.hidden = true;
    el.footer.hidden = true;

    /* 結果画面の裏の canvas には写真を大きく出しておく（サムネ対策）。 */
    var last = state.misses.length ? state.misses[state.misses.length - 1].entry : cover;
    draw.repaint = function () { draw.still(last); };
    draw.repaint();

    el.resultTitle.textContent = cleared ? TEXT.clear : TEXT.over;
    el.resultScore.textContent = num(state.score);
    var reached = Math.min(STAGES.length - 1,
      Math.floor(Math.max(0, state.index - 1) / PER_STAGE));
    el.resultReach.textContent = (reached + 1) + '面 ' + STAGES[reached].name + ' でおしまい';

    el.resultBody.innerHTML = '';
    if (cleared) {
      /* 完全クリアは誤答一覧の代わりに全 60 枚を格子で並べる。 */
      var grid = document.createElement('div');
      grid.className = 'grid';
      deck.forEach(function (e) {
        var img = document.createElement('img');
        img.src = e.src; img.alt = '';
        grid.appendChild(img);
      });
      el.resultBody.appendChild(grid);
    } else {
      var thoughtDog = state.misses.filter(function (m) { return m.choice === 'dog'; });
      var thoughtNot = state.misses.filter(function (m) { return m.choice === 'not'; });
      var timeout = state.misses.filter(function (m) { return m.choice === null; });
      [group(TEXT.thoughtDog, thoughtDog),
       group(TEXT.thoughtNot, thoughtNot),
       group(TEXT.noAnswer, timeout)].forEach(function (g) {
        if (g) el.resultBody.appendChild(g);
      });
    }
    el.result.hidden = false;
  }

  /* --- 入力（pointerdown に統一。従来のまま） ----------------------------- */

  function act(choice) {
    if (state.phase === 'title' || state.phase === 'over') start();
    else if (state.phase === 'question') judge(choice);
    /* 判定表示中の入力は捨てる（連打での取りこぼし防止） */
  }

  function bindInput() {
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      var choice = (e.pointerType === 'mouse')
        ? (e.button === 2 ? 'not' : 'dog')                      // PC：左右クリック
        : (e.clientX < window.innerWidth / 2 ? 'dog' : 'not');  // スマホ：画面左右半分
      act(choice);
    });
    document.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      var k = e.code;
      if (k === 'ArrowLeft' || k === 'KeyZ' || k === 'Space') { e.preventDefault(); act('dog'); }
      else if (k === 'ArrowRight' || k === 'KeyX') { e.preventDefault(); act('not'); }
      else if (k === 'Enter' && (state.phase === 'title' || state.phase === 'over')) start();
    });
  }

  /* --- 起動 ------------------------------------------------------------- */

  function boot() {
    state = newState();
    draw.init(el.stage);
    applyStageColor(0);
    draw.title(null, TEXT.title);   // 読み込み中も canvas を空にしない

    /* canvas に字を描く前にフォントの用意を待つ。 */
    var fonts = document.fonts ? document.fonts.ready : Promise.resolve();

    fonts.then(function () { return assets.loadCsv(); }).then(function (entries) {
      deck = buildDeck(entries);
      cover = pickCover(entries);
      var real = deck.filter(function (e) { return !e.dummy; }).length;
      el.note.textContent = entries.length === 0
        ? 'images.csv に画像がありません。ダミー画像で動かしています。'
        : 'images.csv：' + entries.length + ' 枚（出題 ' + deck.length + ' 問中 ' + real + ' 問が実画像）';

      var ink = cssVar('--ink') || '#4A3728';
      var all = deck.indexOf(cover) === -1 ? deck.concat([cover]) : deck;
      return Promise.all(all.map(function (e) { return assets.prepare(e, ink); }));
    }).then(function () {
      el.loading.hidden = true;
      bindInput();
      showTitle();
    }).catch(function (err) {
      console.error('[nodog] 起動に失敗:', err);
      el.loading.textContent = '読み込みに失敗しました';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.NoDog);
