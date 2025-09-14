// --- 設定 ---
const ROUND_TIME = 20.0;     // 1問の制限時間(秒)
const CPU_CORRECT_P = 0.7;   // CPUが正解する確率
const CPU_TIME_MEAN = 12;    // CPUの解答平均秒
const CPU_TIME_JITTER = 6;   // ばらつき（±）

// --- 状態 ---
let cards = [];
let dungeons = [];
let selectedCard = null;
let selectedDungeonIds = [];

let myHP = 0, cpuHP = 0, myMaxHP = 0, cpuMaxHP = 0;
let quizPool = [];   // 出題リスト（自分2つ + CPU2つの合体）
let cur = -1;

let timerId = null;
let remain = ROUND_TIME;
let answered = false;

// --- ユーティリティ ---
const $ = (sel) => document.querySelector(sel);
const log = (t) => { const d = document.createElement('div'); d.textContent = t; $('#log').prepend(d); };

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

// 残り時間→倍率 (20sで2倍、10sで1倍、0sで0倍の直線)
function timeMultiplier(rem){
  const m = rem / 10.0;     // 20→2, 10→1, 0→0
  return clamp(m, 0, 2);
}

// カードのタイプに応じた攻撃値
function attackOf(card){
  const t = card.type.toUpperCase();
  if (t === 'PHY') return card.phy;
  if (t === 'CHE') return card.che;
  return card.bio;
}

// --- 初期化 ---
async function loadAll() {
  const [cardsRes, dungRes] = await Promise.all([
    fetch('data/cards.json'),
    fetch('data/dungeons.json')
  ]);
  cards = await cardsRes.json();
  dungeons = await dungRes.json();

  // SRカードのみ（今はSR運用のため）
  const sr = cards.filter(c => c.rarity === 'SR');

  // カード選択
  const sel = $('#cardSelect');
  sr.forEach(c => {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = `${c.name}（${c.type} / HP${c.hp}）`;
    sel.appendChild(o);
  });

  // ダンジョン選択（チェック2つ）
  const box = $('#dungeonList');
  dungeons.forEach(d => {
    const id = `d_${d.id}`;
    const label = document.createElement('label');
    label.style.marginRight = '1rem';
    label.innerHTML = `<input type="checkbox" id="${id}" value="${d.id}"> ${d.name}`;
    box.appendChild(label);
  });

  // スタートイベント
  $('#startBtn').addEventListener('click', startGame);
}

async function startGame() {
  // カード決定
  const name = $('#cardSelect').value;
  selectedCard = cards.find(c => c.name === name);
  myHP = myMaxHP = selectedCard.hp;
  // CPUはランダムで別カード（なければ同じでもOK）
  const cpuCard = (cards.filter(c => c.rarity === 'SR' && c.name !== name)[0] || selectedCard);
  cpuHP = cpuMaxHP = cpuCard.hp;

  // ダンジョン選択チェック
  const checked = [...document.querySelectorAll('#dungeonList input[type="checkbox"]:checked')].map(i => i.value);
  if (checked.length !== 2) { alert('ダンジョンは2つ選んでください'); return; }
  selectedDungeonIds = checked;

  // CPU側も2つ適当に選ぶ（今は同じにしておく）
  const opponentDungeonIds = checked;

  // 出題プールを合体してシャッフル
  function pickProblems(ids){
    return ids.flatMap(id => (dungeons.find(d => d.id === id)?.problems || []));
  }
  quizPool = [...pickProblems(selectedDungeonIds), ...pickProblems(opponentDungeonIds)];
  quizPool = quizPool.sort(() => Math.random() - 0.5);

  // UI切替
  $('#setup').style.display = 'none';
  $('#battle').style.display = '';
  updateHpBars();
  nextRound();
}

function updateHpBars(){
  $('#myHpText').textContent = Math.max(0, Math.ceil(myHP));
  $('#cpuHpText').textContent = Math.max(0, Math.ceil(cpuHP));
  $('#myHpBar').style.width = `${clamp(myHP / myMaxHP, 0, 1) * 100}%`;
  $('#cpuHpBar').style.width = `${clamp(cpuHP / cpuMaxHP, 0, 1) * 100}%`;
}

function nextRound(){
  cur++;
  if (myHP <= 0 || cpuHP <= 0){ endGame(); return; }
  if (cur >= quizPool.length){ endGame(true); return; }

  $('#roundNo').textContent = cur + 1;
  $('#msg').textContent = '';

  const prob = quizPool[cur];
  $('#question').textContent = prob.q;

  const choices = $('#choices'); choices.innerHTML = '';
  prob.choices.forEach((ch, idx) => {
    const b = document.createElement('button');
    b.textContent = ch;
    b.addEventListener('click', () => answer(idx));
    choices.appendChild(b);
  });

  // タイマースタート
  answered = false;
  remain = ROUND_TIME;
  if (timerId) clearInterval(timerId);
  timerId = setInterval(tick, 100);
  tick();
}

function tick(){
  remain = Math.max(0, remain - 0.1);
  $('#timeLeft').textContent = `${remain.toFixed(1)}s`;
  $('#timerBar').style.width = `${(remain / ROUND_TIME) * 100}%`;

  if (remain <= 0){
    clearInterval(timerId);
    if (!answered) answer(null, true); // 時間切れ
  }
}

function answer(choiceIdx, timeup=false){
  if (answered) return;
  answered = true;
  clearInterval(timerId);

  const prob = quizPool[cur];
  const correct = (choiceIdx === prob.answer);

  // プレイヤーのダメージ計算
  const myAtk = attackOf(selectedCard);
  const myMult = timeMultiplier(remain);
  const myDmg = (correct && !timeup) ? Math.round(myAtk * myMult) : 0;

  // CPUの解答を同時処理（今は確率で正解、ランダム時間）
  const cpuTimeUsed = clamp(CPU_TIME_MEAN + (Math.random()*2-1)*CPU_TIME_JITTER, 1, 19);
  const cpuRemain = ROUND_TIME - cpuTimeUsed;
  const cpuCorrect = Math.random() < CPU_CORRECT_P;
  const cpuAtk = myAtk; // 簡易化：同じSR帯で近い数値なので同等扱い
  const cpuMult = timeMultiplier(cpuRemain);
  const cpuDmg = cpuCorrect ? Math.round(cpuAtk * cpuMult) : 0;

  // 同時に適用
  cpuHP -= myDmg;
  myHP  -= cpuDmg;
  updateHpBars();

  // メッセージ
  $('#msg').textContent = correct ? `正解！ 与ダメージ ${myDmg}` : '不正解… 与ダメージ 0';
  log(`あなた: 残り${remain.toFixed(1)}s × 倍率${myMult.toFixed(2)} → ${myDmg}ダメージ`);
  log(`CPU   : 残り${cpuRemain.toFixed(1)}s × 倍率${cpuMult.toFixed(2)} → ${cpuDmg}ダメージ`);

  setTimeout(() => {
    if (myHP <= 0 || cpuHP <= 0){ endGame(); }
    else { nextRound(); }
  }, 800);
}

function endGame(noMoreQuestions=false){
  $('#choices').innerHTML = '';
  if (myHP <= 0 && cpuHP <= 0){
    $('#msg').textContent = '引き分け！';
  } else if (myHP <= 0){
    $('#msg').textContent = 'あなたの負け…';
  } else if (cpuHP <= 0){
    $('#msg').textContent = 'あなたの勝ち！';
  } else if (noMoreQuestions){
    $('#msg').textContent = (myHP > cpuHP) ? '時間切れ：あなたの勝ち！' :
                            (myHP < cpuHP) ? '時間切れ：あなたの負け…' : '時間切れ：引き分け';
  }
}

loadAll().catch(e => {
  console.error(e);
  alert('データ読み込みに失敗しました。ファイルパスを確認してください。');
});
