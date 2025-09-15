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

// 戦績用
let myCorrect = 0, cpuCorrect = 0, myTimeSum = 0, roundsAnswered = 0;

// DOMヘルパ
const $ = (sel) => document.querySelector(sel);
const log = (t) => { const d = document.createElement('div'); d.textContent = t; $('#log').prepend(d); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 20s→2.0倍、10s→1.0倍、0s→0倍（直線）
const timeMultiplier = (rem) => clamp(rem / 10.0, 0, 2);

// 文字の表記ゆれ吸収
function norm(s) {
  return (s ?? '').toString()
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[₀₁₂₃₄₅₆₇₈₉]/g, (c) => '0123456789'['₀₁₂₃₄₅₆₇₈₉'.indexOf(c)])
    .replace(/\s+/g, '');
}

// 正誤判定（answers/answerText/regex/choices+answer に対応）
function isCorrect(prob, input) {
  const n = norm(input);
  if (prob.regex) { try { return new RegExp(prob.regex, 'i').test(input); } catch(e) {} }
  if (Array.isArray(prob.answers)) return prob.answers.some(a => norm(a) === n);
  if (typeof prob.answerText === 'string') return norm(prob.answerText) === n;
  if (typeof prob.answer === 'string') return norm(prob.answer) === n;
  if (typeof prob.answer === 'number' && Array.isArray(prob.choices)) {
    const text = prob.choices[prob.answer];
    return norm(text) === n;
  }
  return false;
}

// カードタイプの攻撃力
function attackOf(card){
  const t = card.type.toUpperCase();
  if (t === 'PHY') return card.phy;
  if (t === 'CHE') return card.che;
  return card.bio;
}

// ---- ローカル保存（プロフィール＆戦績） ----
const PROFILE_KEY = 'scb_profile';
const RESULT_KEY  = 'scb_results';

function loadProfile(){
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}'); } catch { return {}; }
}
function saveProfile(p){
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}
function loadResults(){
  try { return JSON.parse(localStorage.getItem(RESULT_KEY) || '[]'); } catch { return []; }
}
function saveResults(arr){
  localStorage.setItem(RESULT_KEY, JSON.stringify(arr));
}
function exportCSV(){
  const rows = loadResults();
  const head = ['timestamp','student_id','nickname','card','type','my_hp_end','my_hp_max','cpu_hp_end','cpu_hp_max','dungeons','rounds','my_correct','cpu_correct','my_avg_time'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const vals = [
      r.ts, r.sid, csvSafe(r.nick), r.card, r.type,
      r.myHpEnd, r.myHpMax, r.cpuHpEnd, r.cpuHpMax,
      `"${r.dungeons}"`, r.rounds, r.myCorrect, r.cpuCorrect, r.myAvgTime
    ];
    lines.push(vals.join(','));
  }
  const bom = '\uFEFF'; // Excel向けUTF-8 BOM
  const blob = new Blob([bom + lines.join('\n')], {type: 'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'scb_results.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function csvSafe(s){ return (s ?? '').toString().replace(/"/g,'""'); }

// ---- 初期化 ----
async function loadAll() {
  const [cardsRes, dungRes] = await Promise.all([
    fetch('data/cards.json', {cache:'no-store'}),
    fetch('data/dungeons.json', {cache:'no-store'})
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

  // プロフィールロード
  const prof = loadProfile();
  if (prof.sid) $('#studentId').value = prof.sid;
  if (prof.nick) $('#nickname').value = prof.nick;

  // イベント
  $('#saveProfile').onclick = onSaveProfile;
  $('#exportCsv').onclick = exportCSV;
  $('#startBtn').addEventListener('click', startGame);
  $('#submitBtn').onclick = () => answerFromInput();
  $('#answerInput').onkeydown = (e) => { if (e.key === 'Enter') answerFromInput(); };
}

function onSaveProfile(){
  const sid = $('#studentId').value.trim();
  const nick = $('#nickname').value.trim();
  const msg = $('#profileMsg');

  if (!/^\d{8}$/.test(sid)) { msg.textContent = '生徒IDは8桁の数字で入力してください。'; return; }
  if (!nick) { msg.textContent = 'ニックネームを入力してください。'; return; }
  saveProfile({ sid, nick });
  msg.textContent = '保存しました。';
  setTimeout(()=> msg.textContent='', 1500);
}

async function startGame() {
  // プロフィール必須
  const { sid, nick } = loadProfile();
  if (!sid || !nick) { alert('先に生徒IDとニックネームを保存してください。'); return; }

  // カード決定
  const name = $('#cardSelect').value;
  selectedCard = cards.find(c => c.name === name);
  myHP = myMaxHP = selectedCard.hp;

  // CPUはランダムで別カード（なければ同じでもOK）
  const cpuCard = (cards.filter(c => c.rarity === 'SR' && c.name !== name)[0] || selectedCard);
  cpuHP = cpuMaxHP = cpuCard.hp;

  // ダンジョン選択
  const checked = [...document.querySelectorAll('#dungeonList input[type="checkbox"]:checked')].map(i => i.value);
  if (checked.length !== 2) { alert('ダンジョンは2つ選んでください'); return; }
  selectedDungeonIds = checked;
  const opponentDungeonIds = checked; // 今は同じ

  // 出題プールを合体してシャッフル
  function pickProblems(ids){
    return ids.flatMap(id => (dungeons.find(d => d.id === id)?.problems || []));
  }
  quizPool = [...pickProblems(selectedDungeonIds), ...pickProblems(opponentDungeonIds)]
              .sort(() => Math.random() - 0.5);

  // 戦績カウンタ初期化
  myCorrect = 0; cpuCorrect = 0; myTimeSum = 0; roundsAnswered = 0;

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

  // 入力欄をリセット＆フォーカス
  const $in = $('#answerInput');
  $in.value = '';
  setTimeout(() => $in.focus(), 50);

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
    if (!answered) answerFromInput(true); // 時間切れ
  }
}

function answerFromInput(timeup=false){
  if (answered) return;
  answered = true;
  clearInterval(timerId);

  const input = $('#answerInput').value;
  const prob = quizPool[cur];

  const correct = !timeup && isCorrect(prob, input);

  // プレイヤー側
  const myAtk = attackOf(selectedCard);
  const myMult = timeMultiplier(remain);
  const myDmg = correct ? Math.round(myAtk * myMult) : 0;

  // CPU（確率で正解、ランダム速度）
  const cpuTimeUsed = clamp(CPU_TIME_MEAN + (Math.random()*2-1)*CPU_TIME_JITTER, 1, 19);
  const cpuRemain = ROUND_TIME - cpuTimeUsed;
  const cpuCorrectFlag = Math.random() < CPU_CORRECT_P;
  const cpuAtk = myAtk; // 簡易
  const cpuMult = timeMultiplier(cpuRemain);
  const cpuDmg = cpuCorrectFlag ? Math.round(cpuAtk * cpuMult) : 0;

  // ダメージ適用
  cpuHP -= myDmg;
  myHP  -= cpuDmg;
  updateHpBars();

  // 戦績カウント
  roundsAnswered++;
  if (correct) myCorrect++;
  if (cpuCorrectFlag) cpuCorrect++;
  const myTimeUsed = ROUND_TIME - remain;
  myTimeSum += myTimeUsed;

  // 表示
  $('#msg').textContent = correct ? `正解！ 与ダメージ ${myDmg}` :
                                   (timeup ? '時間切れ… 与ダメージ 0' : '不正解… 与ダメージ 0');
  log(`あなた: 残り${remain.toFixed(1)}s × 倍率${myMult.toFixed(2)} → ${myDmg}ダメージ`);
  log(`CPU   : 残り${cpuRemain.toFixed(1)}s × 倍率${cpuMult.toFixed(2)} → ${cpuDmg}ダメージ`);

  setTimeout(() => {
    if (myHP <= 0 || cpuHP <= 0){ endGame(); }
    else { nextRound(); }
  }, 700);
}

function endGame(noMoreQuestions=false){
  let resultLabel = '';
  if (myHP <= 0 && cpuHP <= 0){ resultLabel = 'draw'; $('#msg').textContent = '引き分け！'; }
  else if (myHP <= 0){ resultLabel = 'lose'; $('#msg').textContent = 'あなたの負け…'; }
  else if (cpuHP <= 0){ resultLabel = 'win'; $('#msg').textContent = 'あなたの勝ち！'; }
  else if (noMoreQuestions){
    if (myHP > cpuHP){ resultLabel = 'win'; $('#msg').textContent = '時間切れ：あなたの勝ち！'; }
    else if (myHP < cpuHP){ resultLabel = 'lose'; $('#msg').textContent = '時間切れ：あなたの負け…'; }
    else { resultLabel = 'draw'; $('#msg').textContent = '時間切れ：引き分け'; }
  }

  // 戦績保存
  const prof = loadProfile();
  const rec = {
    ts: new Date().toISOString(),
    sid: prof.sid || '',
    nick: prof.nick || '',
    card: selectedCard?.name || '',
    type: selectedCard?.type || '',
    myHpEnd: Math.max(0, Math.ceil(myHP)),
    myHpMax: myMaxHP,
    cpuHpEnd: Math.max(0, Math.ceil(cpuHP)),
    cpuHpMax: cpuMaxHP,
    dungeons: selectedDungeonIds.join('|'),
    rounds: quizPool.length,
    myCorrect, cpuCorrect,
    myAvgTime: roundsAnswered>0 ? (myTimeSum/roundsAnswered).toFixed(2) : '0.00',
    result: resultLabel
  };
  const all = loadResults();
  all.push(rec);
  saveResults(all);
  log(`戦績を保存しました（${resultLabel}）。CSVは上のボタンから出力できます。`);
}

loadAll().catch(e => {
  console.error(e);
  alert('データ読み込みに失敗しました。ファイルパスを確認してください。');
});
