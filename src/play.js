// ================= 設定 =================
const LIMIT_MS      = 20000;   // 1問の制限時間(ミリ秒)
const PENALTY_RATE  = 0.5;     // 不正解ペナルティの係数（与ダメ基準の何割）
const CPU_ACCURACY  = 0.85;    // CPUの正答率
const CPU_MIN_MS    = 6000;    // CPUの最短解答時間
const CPU_MAX_MS    = 18000;   // CPUの最長解答時間

// ================= ユーティリティ =================
const ALL_SCREENS = ['setupBox','choiceBox','rpsBox','countBox','battleBox','logBox','resultBox'];
const el = (id) => document.getElementById(id);

/** 指定した画面だけ表示（その他は非表示） */
const only = (...ids) => {
  ALL_SCREENS.forEach(id => {
    const n = el(id);
    if (!n) return;
    n.classList.remove('active');
    n.style.display = 'none';
  });
  ids.forEach(id => {
    const n = el(id);
    if (!n) return;
    n.classList.add('active');
    // カウントダウンは中央寄せしたいので flex、それ以外は block
    n.style.display = (id === 'countBox') ? 'flex' : 'block';
  });
};

const log = (s) => { const box = el('log'); box.textContent += s + '\n'; box.scrollTop = box.scrollHeight; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmtHp = (x) => Math.max(0, Math.round(x));
const normalize = (s) => String(s ?? '').trim().toLowerCase();

// じゃんけん（PHY▶CHE▶BIO▶PHY）
const beats = { phy:'che', che:'bio', bio:'phy' };
const rpsOutcome = (a, b) => a === b ? 0 : (beats[a] === b ? 1 : -1);

// 残り時間倍率：20s→2.0、10s→1.0、10s未満は1.0に頭打ち
const timeMult = (remainMs) => {
  const remain = remainMs / 1000;
  return clamp(1 + (remain - 10) / 10, 1, 2);
};

// ================= データ =================
let cards = [];   // data/cards.json（{name,type,hp,phy,che,bio,image}）
let dgs   = [];   // data/dungeons.json の dungeons（{id,name,questions:[{q,a}]}）

// ================= 対戦状態 =================
let player = null, cpu = null;
let myDungeonIds = [], cpuDungeonIds = [];
let pool = [];                      // 今セットの出題プール
let match = { p:0, c:0, set:0 };    // セットスコアとカウント

let pChoice = 'phy', cChoice = 'phy';
let pRpsMul = 1.0,  cRpsMul = 1.0;

let round = 0, currentQ = null, qDeadline = 0;
let rafId = null, cpuTimerId = null, endTimerId = null, chooseTimerId = null, chooseDeadline = 0;

// ================= 画面表示補助 =================
const setBars = () => {
  el('pHp').textContent = fmtHp(player.hp);
  el('cHp').textContent = fmtHp(cpu.hp);
  el('pHpBar').style.width = clamp(player.hp / player.hpMax * 100, 0, 100) + '%';
  el('cHpBar').style.width = clamp(cpu.hp / cpu.hpMax * 100, 0, 100) + '%';
};
const getAtkBy = (c, t) => t === 'phy' ? c.phy : (t === 'che' ? c.che : c.bio);
const statLine = (c) => `TYPE:${c.type.toUpperCase()} / HP:${c.hp} / PHY:${c.phy} / CHE:${c.che} / BIO:${c.bio}`;

// ================= ロード =================
async function loadAll(){
  const cj = await fetch('data/cards.json', {cache:'no-store'}).then(r => r.json());
  const dj = await fetch('data/dungeons.json', {cache:'no-store'}).then(r => r.json());
  cards = cj;
  dgs   = dj.dungeons;

  // セレクトと画像プレビュー
  const pSel = el('playerCard'), cSel = el('cpuCard');
  cards.forEach((c, i) => {
    const o1 = document.createElement('option'); o1.value = i; o1.textContent = `${c.name} (${c.type})`; pSel.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = i; o2.textContent = `${c.name} (${c.type})`; cSel.appendChild(o2);
  });
  // 初期選択（例：0=自分, 2=CPU）
  pSel.value = 0;
  cSel.value = Math.min(2, cards.length - 1);

  const updatePreview = () => {
    const p = cards[Number(pSel.value)];
    const c = cards[Number(cSel.value)];
    if (p) {
      el('pCardImg').src = p.image;
      el('pStats').textContent = statLine(p);
    }
    if (c) {
      el('cCardImg').src = c.image;
      el('cStats').textContent = statLine(c);
    }
  };
  pSel.onchange = updatePreview;
  cSel.onchange = updatePreview;
  updatePreview();

  // ダンジョンチェック
  const mkChecks = (rootId) => {
    const root = el(rootId); root.innerHTML = '';
    dgs.forEach(d => {
      const id = `${rootId}_${d.id}`;
      root.insertAdjacentHTML('beforeend',
        `<label style="display:inline-block;margin-right:10px">
           <input type="checkbox" id="${id}" value="${d.id}"> ${d.name}
         </label>`);
    });
  };
  mkChecks('myDungeons');
  mkChecks('cpuDungeons');

  // ボタン・フォーム
  el('startBtn').onclick = startMatch;
  el('answerForm').addEventListener('submit', onSubmit);
  el('toHome').onclick = () => { window.location.href = './index.html'; };
  el('retry').onclick  = () => {
    only('setupBox','logBox');
    el('log').textContent = '';
    el('setCounter').textContent = '0';
    el('scoreP').textContent = '0';
    el('scoreC').textContent = '0';
    el('pChoicePill').textContent = '-';
    el('cChoicePill').textContent = '-';
    el('rpsNote').textContent = '';
  };

  // タイプラジオ即時反映
  document.querySelectorAll('input[name="atype"]').forEach(r => {
    r.addEventListener('change', () => {
      const v = document.querySelector('input[name="atype"]:checked')?.value;
      el('pChoicePill').textContent = v ? `あなた:${v.toUpperCase()}` : '-';
    });
  });
}
document.addEventListener('DOMContentLoaded', loadAll);

// ================= 共通処理 =================
const pickSelected = (rootId) => {
  const ids = [];
  dgs.forEach(d => {
    const cb = document.getElementById(`${rootId}_${d.id}`);
    if (cb && cb.checked) ids.push(d.id);
  });
  return ids.slice(0, 2);
};

const buildPool = (idsA, idsB) => {
  const set = new Set([...idsA, ...idsB]);
  pool = [];
  dgs.filter(d => set.has(d.id)).forEach(d => {
    // ここで設問タイプは使わない（偏り防止）
    pool.push(...d.questions.map(q => ({ q: q.q, a: q.a, dungeon: d.id })));
  });
  // シャッフル
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
};

// ================= マッチ進行 =================
function startMatch(){
  // カード
  player = { ...cards[Number(el('playerCard').value)] };
  cpu    = { ...cards[Number(el('cpuCard').value)] };
  player.hpMax = player.hp; cpu.hpMax = cpu.hp;
  setBars();

  // ダンジョン（足りない分は自動補完で2つにする）
  const allIds = dgs.map(d => d.id);
  const pushIf = (arr, id) => { if (!arr.includes(id)) arr.push(id); };

  myDungeonIds  = pickSelected('myDungeons');
  cpuDungeonIds = pickSelected('cpuDungeons');

  for (const id of allIds) { if (myDungeonIds.length  >= 2) break; pushIf(myDungeonIds, id); }
  for (const id of allIds) { if (cpuDungeonIds.length >= 2) break; pushIf(cpuDungeonIds, id); }

  // 初期化
  match = { p:0, c:0, set:0 };
  el('scoreP').textContent = '0';
  el('scoreC').textContent = '0';
  el('log').textContent = '';
  el('setCounter').textContent = '0';
  el('pChoicePill').textContent = '-';
  el('cChoicePill').textContent = '-';
  el('rpsNote').textContent = '';

  // 進行
  nextSet();

  // 画面
  only('choiceBox','logBox');
}

function nextSet(){
  match.set++;
  el('setCounter').textContent = String(match.set);

  // HPリセット
  player.hp = player.hpMax;
  cpu.hp    = cpu.hpMax;
  setBars();

  // 出題プール構築
  buildPool(myDungeonIds, cpuDungeonIds);
  round = 0;

  // タイプ選択へ
  startChoicePhase();
}

// ================= タイプ選択 → じゃんけん結果 → カウントダウン =================
function bestType(c){
  const arr = [['phy', c.phy], ['che', c.che], ['bio', c.bio]];
  arr.sort((a,b) => b[1] - a[1]);
  return arr[0][0];
}

function startChoicePhase(){
  only('choiceBox','logBox');
  el('choiceResult').textContent = '';
  el('pChoicePill').textContent  = '-';
  el('cChoicePill').textContent  = '-';
  el('rpsNote').textContent      = '';
  pChoice = null; cChoice = null; pRpsMul = 1.0; cRpsMul = 1.0;

  // CPUはランダムで決めておく
  cChoice = ['phy','che','bio'][Math.floor(Math.random()*3)];

  // 5秒カウント
  chooseDeadline = performance.now() + 5000;
  const tick = () => {
    const remain = Math.max(0, chooseDeadline - performance.now());
    el('choiceTimer').textContent = (remain / 1000).toFixed(1) + 's';
    if (remain <= 0) {
      finalizeChoices(true);
      return;
    }
    chooseTimerId = requestAnimationFrame(tick);
  };
  chooseTimerId = requestAnimationFrame(tick);

  el('lockChoice').onclick = () => finalizeChoices(false);
}

function finalizeChoices(autoPick){
  cancelAnimationFrame(chooseTimerId);

  if (!pChoice) {
    const sel = document.querySelector('input[name="atype"]:checked');
    pChoice = sel ? sel.value : (autoPick ? bestType(player) : bestType(player));
  }

  const out = rpsOutcome(pChoice, cChoice);
  if (out === 1) { pRpsMul = 1.5; cRpsMul = 0.5; }
  else if (out === -1) { pRpsMul = 0.5; cRpsMul = 1.5; }
  else { pRpsMul = 1.0; cRpsMul = 1.0; }

  el('pChoicePill').textContent = `あなた:${pChoice.toUpperCase()}`;
  el('cChoicePill').textContent = `CPU:${cChoice.toUpperCase()}`;
  el('rpsNote').textContent = `（倍率 あなた×${pRpsMul.toFixed(1)} / CPU×${cRpsMul.toFixed(1)}）`;

  // じゃんけん結果画面（5秒表示）
  only('rpsBox','logBox');
  const res = out === 1 ? 'あなたの勝ち' : (out === -1 ? 'CPUの勝ち' : 'あいこ');
  el('rpsSummary').textContent =
    `あなた:${pChoice.toUpperCase()} / CPU:${cChoice.toUpperCase()} → じゃんけん結果：${res}\n` +
    `倍率 あなた×${pRpsMul.toFixed(1)} / CPU×${cRpsMul.toFixed(1)}（5秒後にカウントダウン）`;
  log(`セット${match.set}: タイプ あなた=${pChoice.toUpperCase()} / CPU=${cChoice.toUpperCase()} → ${res}`);

  setTimeout(startCountdown, 5000);
}

function startCountdown(){
  only('countBox','logBox');
  let n = 5;
  el('countNum').textContent = String(n);
  const id = setInterval(() => {
    n--;
    el('countNum').textContent = String(n);
    if (n <= 0) {
      clearInterval(id);
      startBattle();
    }
  }, 1000);
}

// ================= バトル・出題 =================
function startBattle(){
  only('battleBox','logBox');
  nextQuestion();
}

function nextQuestion(){
  if (player.hp <= 0 || cpu.hp <= 0) {
    return finishSet(cpu.hp <= 0 ? 'p' : 'c');
  }
  if (pool.length === 0) {
    log('問題が尽きました（引き分け相当で次セットへ）');
    return finishSet(match.p === match.c ? 'c' : (match.p > match.c ? 'p' : 'c'));
  }

  round++;
  const q = pool.shift();
  currentQ = { ...q, ended:false };
  el('roundInfo').textContent = `ROUND ${round}`;
  el('question').textContent  = q.q;
  el('answerInput').value = '';
  el('answerInput').disabled = false;
  el('answerInput').focus();

  // 毎問タイマーをリセット（20秒）
  const start = performance.now();
  qDeadline   = start + LIMIT_MS;

  const rafTick = () => {
    const remain = Math.max(0, qDeadline - performance.now());
    el('timerLabel').textContent = (remain / 1000).toFixed(1) + 's';
    if (remain <= 0) {
      // 時間切れ → 不正解ペナルティ（残り0s）
      applyPenalty(remain);
      finishQuestion();
    } else {
      rafId = requestAnimationFrame(rafTick);
    }
  };
  rafId = requestAnimationFrame(rafTick);

  // CPU の擬似解答
  const cpuCorrect = Math.random() < CPU_ACCURACY;
  const cpuTime    = CPU_MIN_MS + Math.random() * (CPU_MAX_MS - CPU_MIN_MS);
  if (cpuCorrect && cpuTime < LIMIT_MS) {
    cpuTimerId = setTimeout(() => {
      if (!currentQ || currentQ.ended) return;
      const remain = Math.max(0, qDeadline - performance.now());
      applyDamage('c', remain);   // CPU 正解 → 与ダメ
      finishQuestion();           // 即次の問題へ
    }, cpuTime);
  } else {
    cpuTimerId = setTimeout(() => { /* 不正解: 何もしない（次はプレイヤー側イベントで） */ }, LIMIT_MS);
  }

  endTimerId = setTimeout(() => { /* safety */ }, LIMIT_MS + 50);
}

// ================= セット終了 =================
function finishSet(winner){
  if (winner === 'p') match.p++; else match.c++;
  el('scoreP').textContent = String(match.p);
  el('scoreC').textContent = String(match.c);
  log(`=== セット${match.set}: ${winner === 'p' ? 'あなたの勝ち' : 'CPUの勝ち'}（${match.p}-${match.c}） ===`);

  if (match.p === 2 || match.c === 2 || match.set === 3) {
    // マッチ終了 → 結果画面
    const msg = match.p === match.c ? '引き分け' : (match.p > match.c ? 'マッチ勝利！' : 'マッチ敗北…');
    el('resultText').textContent = `結果: あなた ${match.p} - ${match.c} CPU → ${msg}`;
    only('resultBox','logBox');
  } else {
    setTimeout(nextSet, 800);
  }
}

// ================= ダメージ＆ペナルティ =================
function applyDamage(side, remainMs){
  const atkType = side === 'p' ? pChoice : cChoice;
  const unit    = side === 'p' ? player  : cpu;
  const rpsMul  = side === 'p' ? pRpsMul : cRpsMul;
  const base    = getAtkBy(unit, atkType);
  const mult    = timeMult(remainMs);
  const dmg     = Math.round(base * rpsMul * mult);

  if (side === 'p') cpu.hp -= dmg; else player.hp -= dmg;
  setBars();
  log(`${side === 'p' ? 'あなた' : 'CPU'} 正解 → ${atkType.toUpperCase()}基礎${base} × RPS${rpsMul.toFixed(1)} × 時間${mult.toFixed(2)} = ${dmg} dmg`);
}

function applyPenalty(remainMs){
  // プレイヤー不正解時の自傷ダメージ
  const atkType = pChoice;
  const base    = getAtkBy(player, atkType);
  const mult    = timeMult(remainMs);
  const dmg     = Math.round(base * pRpsMul * mult * PENALTY_RATE);
  player.hp -= dmg;
  setBars();
  log(`あなた 不正解 → ペナルティ ${atkType.toUpperCase()}基礎${base} × RPS${pRpsMul.toFixed(1)} × 時間${mult.toFixed(2)} × 係数${PENALTY_RATE} = ${dmg} self-dmg`);
}

// ================= 入力イベント =================
function onSubmit(e){
  e.preventDefault();
  if (!currentQ || currentQ.ended) return;

  const ans    = el('answerInput').value;
  const ok     = normalize(ans) === normalize(currentQ.a);
  const remain = Math.max(0, qDeadline - performance.now());

  if (ok) {
    applyDamage('p', remain);
  } else {
    applyPenalty(remain);
  }
  finishQuestion(); // 即次の問題へ
}

function finishQuestion(){
  if (!currentQ || currentQ.ended) return;
  currentQ.ended = true;
  cancelAnimationFrame(rafId);
  clearTimeout(cpuTimerId);
  clearTimeout(endTimerId);

  setTimeout(nextQuestion, 300);
}
