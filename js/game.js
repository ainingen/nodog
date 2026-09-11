/**
 * ゲーム本体。タイトル → プレイ → 0.3秒リザルト → 次問 → ゲームオーバー／クリア。
 */
window.NoDog = window.NoDog || {};
(function (NoDog) {
  'use strict';

  var LEVELS = [
    { no: 1, name: '入門',           limit: 2.0 },
    { no: 2, name: 'なんとなく犬',   limit: 1.5 },
    { no: 3, name: '茶色い奴ら',     limit: 1.0 },
    { no: 4, name: '尻',             limit: 0.75 },
    { no: 5, name: 'DOG HELL',       limit: 0.5 }
  ];
  var QUESTIONS_PER_LEVEL = 12;
  var START_LIFE = 3;
  var RESULT_MS = 300;      // 判定表示。仕様どおり 0.3 秒で即次へ。
  var INPUT_LOCK_MS = 400;  // 直前のタップが次の画面に貫通しないようにする。

  var el = {};
  var pool = [];   // images.csv 全件
  var deck = [];   // 今回の出題順（60問）
  var state = 'boot';
  var run = null;
  var qStartedAt = 0;
  var resultStartedAt = 0;
  var lockUntil = 0;

  function $(id) { return document.getElementById(id); }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** 面ごとに QUESTIONS_PER_LEVEL 問。枚数が足りない面は山を作り直して埋める。 */
  function buildDeck() {
    var out = [];
    LEVELS.forEach(function (lv) {
      var src = pool.filter(function (e) { return e.level === lv.no; });
      if (!src.length) return;
      var bag = [];
      for (var i = 0; i < QUESTIONS_PER_LEVEL; i++) {
        if (!bag.length) bag = shuffle(src);
        var e = bag.pop();
        out.push({ entry: e, level: lv });
      }
    });
    return out;
  }

  /* ---------------- 画面遷移 ---------------- */

  function setScreen(name) {
    ['title', 'over'].forEach(function (s) {
      el['screen_' + s].classList.toggle('hidden', s !== name);
    });
    el.hud.classList.toggle('hidden', name !== null);
    el.playfield.classList.toggle('hidden', name !== null);
  }

  function toTitle() {
    state = 'title';
    setScreen('title');
  }

  function startRun() {
    deck = buildDeck();
    if (!deck.length) return;
    run = {
      index: 0,
      life: START_LIFE,
      score: 0,
      combo: 0,
      maxCombo: 0,
      misses: [],
      reached: deck[0].level
    };
    setScreen(null);
    showQuestion();
  }

  function current() { return deck[run.index]; }

  function showQuestion() {
    var q = current();
    run.reached = q.level;
    state = 'play';
    qStartedAt = performance.now();
    drawStage(q.entry.image);
    el.verdict.className = 'verdict hidden';
    renderHud();
    setBar(1);
  }

  /* ---------------- 判定 ---------------- */

  function comboMultiplier(combo) {
    return Math.min(3.0, 1.0 + Math.floor(combo / 10) * 0.5);
  }

  /** choice: 'dog' | 'not' | null(時間切れ) */
  function answer(choice) {
    if (state !== 'play') return;
    var q = current();
    var limitMs = q.level.limit * 1000;
    var remain = Math.max(0, limitMs - (performance.now() - qStartedAt));
    var correct = choice !== null && choice === q.entry.answer;

    if (correct) {
      run.combo++;
      run.maxCombo = Math.max(run.maxCombo, run.combo);
      var gained = (100 + Math.round(remain / limitMs * 100)) * comboMultiplier(run.combo);
      run.score += Math.round(gained);
    } else {
      run.combo = 0;
      run.life--;
      run.misses.push({ entry: q.entry, choice: choice });
    }

    state = 'result';
    resultStartedAt = performance.now();
    setBar(correct ? remain / limitMs : 0);
    showVerdict(q.entry.answer, correct);
    renderHud();
  }

  function showVerdict(answerOf, correct) {
    el.verdict.textContent = answerOf === 'dog' ? 'DOG! 🐕' : 'NOT DOG!';
    el.verdict.className = 'verdict ' + (correct ? 'ok' : 'ng');
  }

  function afterResult() {
    if (run.life <= 0) { finish(false); return; }
    run.index++;
    if (run.index >= deck.length) { finish(true); return; }
    showQuestion();
  }

  /* ---------------- 終了 ---------------- */

  function finish(cleared) {
    state = cleared ? 'clear' : 'gameover';
    lockUntil = performance.now() + INPUT_LOCK_MS;
    el.overTitle.textContent = cleared ? 'COMPLETE! 🐕' : 'GAME OVER';
    el.overTitle.className = cleared ? 'over-title clear' : 'over-title';
    el.overScore.textContent = run.score.toLocaleString();
    el.overStats.textContent =
      '到達：' + run.reached.no + '面 ' + run.reached.name +
      '　/　' + Math.min(run.index + (cleared ? 0 : 1), deck.length) + '問目' +
      '　/　最大コンボ ' + run.maxCombo;
    renderMisses();
    setScreen('over');
  }

  function renderMisses() {
    el.misses.innerHTML = '';
    if (!run.misses.length) {
      el.missesNote.textContent = 'ノーミス。';
      return;
    }
    el.missesNote.textContent = '間違えた画像';
    run.misses.forEach(function (m) {
      var item = document.createElement('div');
      item.className = 'miss';

      var thumb = document.createElement('canvas');
      thumb.width = thumb.height = 120;
      thumb.className = 'miss-thumb';
      thumb.getContext('2d').drawImage(m.entry.image, 0, 0, 120, 120);

      var cap = document.createElement('p');
      cap.className = 'miss-cap';
      cap.textContent = m.choice === null
        ? 'あなたは固まりました（時間切れ）'
        : 'あなたはこれを' + (m.choice === 'dog' ? '犬' : '犬以外') + 'だと思いました';

      var truth = document.createElement('p');
      truth.className = 'miss-truth';
      truth.textContent = m.entry.answer === 'dog' ? '正解：犬' : '正解：犬以外';

      item.appendChild(thumb);
      item.appendChild(cap);
      item.appendChild(truth);
      el.misses.appendChild(item);
    });
  }

  /* ---------------- 描画 ---------------- */

  function drawStage(image) {
    var ctx = el.stage.getContext('2d');
    ctx.clearRect(0, 0, el.stage.width, el.stage.height);
    ctx.drawImage(image, 0, 0, el.stage.width, el.stage.height);
  }

  function setBar(ratio) {
    el.bar.style.transform = 'scaleX(' + Math.max(0, Math.min(1, ratio)) + ')';
  }

  function renderHud() {
    var q = current();
    el.levelName.textContent = q.level.no + '面 ' + q.level.name;
    el.qCount.textContent = ((run.index % QUESTIONS_PER_LEVEL) + 1) + ' / ' + QUESTIONS_PER_LEVEL;
    el.life.textContent = '🐕'.repeat(Math.max(0, run.life)) + '·'.repeat(Math.max(0, START_LIFE - run.life));
    el.score.textContent = run.score.toLocaleString();
    el.combo.textContent = run.combo > 0 ? run.combo + ' COMBO' : '';
    el.combo.classList.toggle('hot', run.combo >= 10 && run.combo % 10 === 0);
  }

  /* ---------------- 入力 ---------------- */

  function handleTap(x, isRightButton, isMouse) {
    var now = performance.now();
    if (state === 'title') {
      if (now < lockUntil) return;
      startRun();
      return;
    }
    if (state === 'gameover' || state === 'clear') {
      if (now < lockUntil) return;
      startRun();
      return;
    }
    if (state !== 'play') return;
    // PC は左右クリック、タッチは画面の左右半分。
    var choice = isMouse
      ? (isRightButton ? 'not' : 'dog')
      : (x < window.innerWidth / 2 ? 'dog' : 'not');
    answer(choice);
  }

  function bindInput() {
    window.addEventListener('pointerdown', function (e) {
      handleTap(e.clientX, e.button === 2, e.pointerType === 'mouse');
    });
    window.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', function (e) {
      var k = e.key;
      var dog = k === 'ArrowLeft' || k === 'z' || k === 'Z' || k === ' ';
      var not = k === 'ArrowRight' || k === 'x' || k === 'X';
      if (!dog && !not) return;
      e.preventDefault();
      if (state === 'play') answer(dog ? 'dog' : 'not');
      else handleTap(window.innerWidth / 2 - 1, false, false);
    });
  }

  /* ---------------- ループ ---------------- */

  function loop(ts) {
    requestAnimationFrame(loop);
    if (state === 'play') {
      var limitMs = current().level.limit * 1000;
      var remain = limitMs - (ts - qStartedAt);
      setBar(remain / limitMs);
      if (remain <= 0) answer(null); // 時間切れは誤答扱い
    } else if (state === 'result') {
      if (ts - resultStartedAt >= RESULT_MS) afterResult();
    }
  }

  /* ---------------- 起動 ---------------- */

  function boot() {
    ['hud', 'playfield', 'stage', 'verdict', 'bar', 'levelName', 'qCount', 'life',
     'score', 'combo', 'misses', 'missesNote', 'overTitle', 'overScore', 'overStats',
     'loading'].forEach(function (id) { el[id] = $(id); });
    el.screen_title = $('screenTitle');
    el.screen_over = $('screenOver');

    NoDog.images.load()
      .then(function (entries) {
        pool = entries;
        return NoDog.assets.preload(entries);
      })
      .then(function () {
        el.loading.classList.add('hidden');
        bindInput();
        toTitle();
        requestAnimationFrame(loop);
      })
      .catch(function (err) {
        el.loading.textContent = '画像リストの読み込みに失敗しました: ' + err.message;
        console.error(err);
      });
  }

  NoDog.game = {
    boot: boot,
    LEVELS: LEVELS,
    QUESTIONS_PER_LEVEL: QUESTIONS_PER_LEVEL,
    // 自動プレイでの動作確認用。読み取り専用。
    debug: {
      state: function () { return state; },
      current: function () { return state === 'play' ? current() : null; },
      run: function () { return run; },
      deckSize: function () { return deck.length; }
    }
  };
})(window.NoDog);
