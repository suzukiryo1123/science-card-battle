// ===== 基本ユーティリティ =====
const el = (id) => document.getElementById(id);
const log = (s) => { const box = el('log'); box.textContent += s + '\n'; box.scrollTop = box.scrollHeight; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmtHp = (x) => Math.max(0, Math.round(x));
const normalize = (s) => String(s ?? '').trim().toLowerCase();

// RPS: PHY > CHE > BIO > PHY
const beats = { phy: 'che', che: 'bio', bio: 'phy' };
const rpsOutcome = (a, b) => a === b ? 0 : (beats[a] === b ? 1 : -1);

// 残り時間倍率: 20s→2.0, 10s→1.0, 10s未満は1.0
const LIMIT = 20000; // ms
const timeMult = (remainMs) => {
  const remain = remainMs / 1000;
  return clamp(1 + (remain - 10) / 10, 1, 2);
};

// ===== データ =====
let cards = [];         // data/cards.json
let dgs = [];           // data/dungeons.json の dungeons 配列
let myDungeonIds = [];  // 2つ保持
let cpuDungeonIds = []; // 2つ保持

// ===== マッチ・セット状態 =====
let player = null;    // {hpMax, hp, name, phy, che, bio, type,...}
let cpu = null;
let match = { p: 0, c: 0, set: 0 }; // セットカウント
let pChoice = 'phy', cChoice = 'phy'; // 今セットのタイプ選択
let pRpsMul = 1.0, cRpsMul = 1.0;     // 今セットのじゃんけん倍率
let pool = [];        // 今セットの出題プール
let round = 0;

// 現在の問題サイクル
let currentQ = null;
let qDeadline = 0;
let rafId = null;
let endTimerId = null;
let cpuTimerId = null;
let chooseTimerId = null;
let chooseDeadline = 0;

// ===== 画面補助 =====
const setBars = () => {
  el('pHp').textContent = fmtHp(player.hp);
  el('cHp').textContent = fmtHp(cpu.hp);
  el('pHpBar').style.width = clamp(player.hp / player.hpMax * 100, 0, 100) + '%';
  el('cHpBar').style.width = clamp(cpu.hp / cpu.hpMax * 100, 0, 100) + '%';
};
const statLine = (c) => `TYPE:${c.type.toUpperCase()} | PHY:${c.phy} CHE:${c.che} BIO:${c.bio}`;
const getAtkByType = (c, t) => t === 'phy' ? c.phy : t === 'che' ? c.che : c.bio;

// ===== ロード =====
async function loadAll() {
  const cj = await fetch('data/cards.json').then(r => r.json());
  const dj = await fetch('data/dungeons.json').then(r => r.json());
  cards = cj;
  dgs = dj.dungeons;

  // セレクト
  const pSel = el('playerCard');
  const cSel = el('cpuCard');
  cards.forEach((c, i) => {
    const a = document.createElement('option');
    a.value = i; a.textContent = `${c.name} (${c.type})`; pSel.appendChild(a);
    const b = document.createElement('option');
    b.value = i; b.textContent = `${c.name} (${c.type})`; cSel.appendChild(b);
  });
  pSel.value = 0;
  cSel.value = 2;

  // ダンジョンチェック
  const mkChecks = (rootId) => {
    const root = el(rootId); root.innerHTML = '';
    dgs.forEach(d => {
      const id = `${rootId}_${d.id}`;
      root.insertAdjacentHTML('beforeend',
        `<label style="display:inline-block;margin-right:8px">
           <input type="checkbox" id="${id}" value="${d.id}"> ${d.name}
         </label>`);
    });
  };
  mkChecks('myDungeons');
  mkChecks('cpuDungeons');
}

// ===== ダンジョンプール =====
function pickSelected(rootId) {
  const ids = [];
  dgs.forEach(d => {
    const cb = document.getElementById(`${rootId}_${d.id}`);
    if (cb && cb.checked) ids.push(d.id);
  });
  return ids.slice(0, 2);
}

function buildPool(idsA, idsB) {
  const set = new Set([...idsA, ...idsB]);
  pool = [];
  dgs.filter(d => set.has(d.id)).forEach(d => {
    // 問題の type はダメージ計算に使わない（無視）
    pool.push(...d.questions.map(q => ({ q: q.q, a: q.a, dungeon: d.id })));
  });
  // シャッフル
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
}

// ===== マッチ・セット進行 =====
function beginMatch() {
  match = { p: 0, c: 0, set: 0 };
  el('scoreP').textContent = '0';
  el('scoreC').textContent = '0';
  beginSet();
}

function beginSet() {
  match.set++;
  el('setCounter').textContent = String(match.set);

  // HP リセット
  player.hp = player.hpMax;
  cpu.hp = cpu.hpMax;
  setBars();

  // 出題プール再構成
  buildPool(myDungeonIds, cpuDungeonIds);
  round = 0;

  // タイプ選択フェーズ
  startChoicePhase();
}

function finishSet(winner) {
  if (winner === 'p') match.p++; else if (winner === 'c') match.c++;
  el('scoreP').textContent = String(match.p);
  el('scoreC').textContent = String(match.c);

  log(`\n=== セット結果: ${winner === 'p' ? 'あなたの勝ち' : 'CPUの勝ち'}（${match.p}-${match.c}） ===\n`);

  if (match.p === 2 || match.c === 2 || match.set === 3) {
    const msg = match.p === match.c ? '引き分け！' : (match.p > match.c ? 'マッチ勝利！' : 'マッチ敗北…');
    log(`*** マッチ終了: ${msg} ***`);
    el('question').textContent = 'マッチ終了（もう一度やるには「マッチ開始」）';
    el('answerInput').disabled = true;
  } else {
    // 次セット
    setTimeout(beginSet, 1000);
  }
}

// ===== タイプ選択（5秒） =====
function bestType(c) {
  const arr = [['phy', c.phy], ['che', c.che], ['bio', c.bio]];
  arr.sort((a, b) => b[1] - a[1]);
  return arr[0][0];
}

function startChoicePhase() {
  // 初期表示
  el('choiceBox').style.display = '';
  el('choiceResult').textContent = '';
  el('pChoicePill').textContent = '-';
  el('cChoicePill').textContent = '-';
  el('rpsNote').textContent = '';
  pChoice = null; cChoice = null; pRpsMul = 1.0; cRpsMul = 1.0;

  // CPU 先に決めておく（ランダムでもOK）
  const choices = ['phy','che','bio'];
  cChoice = choices[Math.floor(Math.random()*3)];

  // 5秒カウント
  chooseDeadline = performance.now() + 5000;
  const tick = () => {
    const remain = Math.max(0, chooseDeadline - performance.now());
    el('choiceTimer').textContent = (remain/1000).toFixed(1) + 's';
    if (remain <= 0) return finalizeChoices(true);
    chooseTimerId = requestAnimationFrame(tick);
  };
  chooseTimerId = requestAnimationFrame(tick);

  // 確定ボタン
  el('lockChoice').onclick = () => finalizeChoices(false);
}

function finalizeChoices(autoPick) {
  cancelAnimationFrame(chooseTimerId);

  // プレイヤー選択
  if (!pChoice) {
    const sel = document.querySelector('input[name="atype"]:checked');
    pChoice = sel ? sel.value : (autoPick ? bestType(player) : bestType(player));
  }

  // じゃんけん倍率設定
  const out = rpsOutcome(pChoice, cChoice);
  if (out === 1) { pRpsMul = 1.5; cRpsMul = 0.5; }
  else if (out === -1) { pRpsMul = 0.5; cRpsMul = 1.5; }
  else { pRpsMul = 1.0; cRpsMul = 1.0; }

  el('pChoicePill').textContent = `あなた:${pChoice.toUpperCase()}`;
  el('cChoicePill').textContent = `CPU:${cChoice.toUpperCase()}`;
  el('rpsNote').textContent =
    `（倍率 あなた×${pRpsMul.toFixed(1)} / CPU×${cRpsMul.toFixed(1)}）`;
  el('choiceResult').textContent = 'タイプ確定。出題を開始します。';
  el('choiceBox').style.display = 'none';

  log(`セット${match.set}: タイプ選択 あなた=${pChoice.toUpperCase()} / CPU=${cChoice.toUpperCase()} → 倍率 あなた×${pRpsMul} / CPU×${cRpsMul}`);

  // 出題開始
  nextQuestion();
}

// ===== 出題・判定 =====
function nextQuestion() {
  if (player.hp <= 0 || cpu.hp <= 0) {
    return finishSet(player.hp <= 0 && cpu.hp <= 0 ? (match.p > match.c ? 'p' : 'c') : (cpu.hp <= 0 ? 'p' : 'c'));
  }
  if (pool.length === 0) {
    log('問題が尽きました（引き分け扱いで次セット）');
    return finishSet(match.p === match.c ? 'c' : (match.p > match.c ? 'p' : 'c')); // 形だけ決着
  }

  round++;
  const q = pool.shift();
  currentQ = { ...q, pDone:false, cDone:false, ended:false };
  el('roundInfo').textContent = `ROUND ${round}`;
  el('question').textContent = q.q;
  el('answerInput').value = '';
  el('answerInput').disabled = false;
  el('answerInput').focus();

  // タイマー
  const start = performance.now();
  qDeadline = start + LIMIT;
  const rafTick = () => {
    const remain = Math.max(0, qDeadline - performance.now());
    el('timerLabel').textContent = (remain/1000).toFixed(1) + 's';
    if (remain <= 0) {
      finishQuestion(); // 時間切れ
    } else {
      rafId = requestAnimationFrame(rafTick);
    }
  };
  rafId = requestAnimationFrame(rafTick);

  // CPUの擬似解答（正答率85%、6〜18秒で回答）
  const cpuCorrect = Math.random() < 0.85;
  const cpuTime = 6000 + Math.random() * 12000;
  if (cpuCorrect && cpuTime < LIMIT) {
    cpuTimerId = setTimeout(() => {
      if (currentQ && !currentQ.cDone && !currentQ.ended) {
        currentQ.cDone = true;
        const remain = Math.max(0, qDeadline - performance.now());
        applyDamage('c', remain); // c の与ダメは「CPUが正解した時点」で適用
      }
    }, cpuTime);
  }
  // 時間切れまでの保険
  endTimerId = setTimeout(finishQuestion, LIMIT + 20);
}

function applyDamage(side, remainMs) {
  // side === 'p' → プレイヤーが与ダメ, 'c' → CPUが与ダメ
  const atkType = side === 'p' ? pChoice : cChoice;
  const unit = side === 'p' ? player : cpu;
  const rpsMul = side === 'p' ? pRpsMul : cRpsMul;
  const base = getAtkByType(unit, atkType);
  const dmg = Math.round(base * rpsMul * timeMult(remainMs));

  if (side === 'p') {
    cpu.hp -= dmg;
  } else {
    player.hp -= dmg;
  }
  setBars();

  log(
    `${side === 'p' ? 'あなた' : 'CPU'} 正解 → ` +
    `${atkType.toUpperCase()}基礎${base} × RPS${rpsMul.toFixed(1)} × 時間${timeMult(remainMs).toFixed(2)} = ${dmg} dmg`
  );

  if (player.hp <= 0 || cpu.hp <= 0) {
    currentQ.ended = true;
    clearTimeout(endTimerId);
    cancelAnimationFrame(rafId);
    if (cpuTimerId) clearTimeout(cpuTimerId);
    setTimeout(() => finishSet(cpu.hp <= 0 ? 'p' : 'c'), 200);
  }
}

function finishQuestion() {
  if (!currentQ || currentQ.ended) return;
  currentQ.ended = true;

  // クリア
  clearTimeout(endTimerId);
  cancelAnimationFrame(rafId);
  if (cpuTimerId) clearTimeout(cpuTimerId);

  // 次へ
  setTimeout(nextQuestion, 400);
}

// ===== 入力イベント =====
function onSubmit(e) {
  e.preventDefault();
  if (!currentQ || currentQ.pDone || currentQ.ended) return;

  const ans = el('answerInput').value;
  const correct = normalize(ans) === normalize(currentQ.a);
  const remain = Math.max(0, qDeadline - performance.now());

  if (correct) {
    currentQ.pDone = true;
    applyDamage('p', remain); // プレイヤーは解いた瞬間に与ダメ
  } else {
    log('あなた 不正解');
  }

  // 両方解き終わっていたら早めに次へ
  if (currentQ && currentQ.pDone && currentQ.cDone && !currentQ.ended) {
    finishQuestion();
  }
}

// ===== スタートボタン =====
function startClicked() {
  // カード選択
  const pIdx = Number(el('playerCard').value);
  const cIdx = Number(el('cpuCard').value);
  player = { ...cards[pIdx] }; cpu = { ...cards[cIdx] };
  player.hpMax = player.hp; cpu.hpMax = cpu.hp;
  el('pStats').textContent = statLine(player);
  el('cStats').textContent = statLine(cpu);
  setBars();

  // ダンジョン選択
  myDungeonIds = pickSelected('myDungeons');
  cpuDungeonIds = pickSelected('cpuDungeons');
  if (myDungeonIds.length !== 2 || cpuDungeonIds.length !== 2) {
    alert('ダンジョンは各自2つずつ選んでください');
    return;
  }

  // ログとUI初期化
  el('log').textContent = '';
  el('question').textContent = 'タイプ選択待ち…';
  el('answerInput').disabled = true;

  beginMatch();
}

// ===== 起動 =====
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  el('startBtn').addEventListener('click', startClicked);
  el('answerForm').addEventListener('submit', onSubmit);

  // ラジオ選択の更新を反映（確定前でも pill に出す）
  document.querySelectorAll('input[name="atype"]').forEach(r =>
    r.addEventListener('change', () => {
      const v = document.querySelector('input[name="atype"]:checked')?.value;
      el('pChoicePill').textContent = v ? `あなた:${v.toUpperCase()}` : '-';
    })
  );
});
