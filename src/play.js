// ================= 設定 =================
const LIMIT_MS      = 20000;   // 1問の制限時間(ミリ秒)
const PENALTY_RATE  = 0.5;     // 不正解ペナルティ係数
const CPU_ACCURACY  = 0.85;    // CPU正答率
const CPU_MIN_MS    = 6000;    // CPU最短解答
const CPU_MAX_MS    = 18000;   // CPU最長解答

// ================= ユーティリティ =================
const ALL_SCREENS = ['setupBox','choiceBox','rpsBox','countBox','battleBox','logBox','betweenBox','resultBox'];
const el = (id) => document.getElementById(id);
const only = (...ids) => {
  ALL_SCREENS.forEach(id => {
    const n = el(id); if (!n) return;
    n.classList.remove('active'); n.style.display = 'none';
  });
  ids.forEach(id => {
    const n = el(id); if (!n) return;
    n.classList.add('active');
    n.style.display = (id === 'countBox') ? 'flex' : 'block';
  });
};
const log = (s) => { const box = el('log'); box.textContent += s + '\n'; box.scrollTop = box.scrollHeight; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmtHp = (x) => Math.max(0, Math.round(x));
const normalize = (s) => String(s ?? '').trim().toLowerCase();

// === セット結果を localStorage に保存 ===
function saveSetResult({ winner, selectedType, matchSet, pStats, cStats, pCard, cCard }) {
  const key = 'scb_results_v1';
  const rec = {
    t: new Date().toISOString(),
    set: matchSet,
    type: selectedType,
    winner, // 'p' | 'c'
    player: {
      correct: pStats.correct,
      total:   pStats.total,
      avgSec:  pStats.times.length ? (pStats.times.reduce((a,b)=>a+b,0)/pStats.times.length) : null
    },
    cpu: {
      correct: cStats.correct,
      total:   cStats.total,
      avgSec:  cStats.times.length ? (cStats.times.reduce((a,b)=>a+b,0)/cStats.times.length) : null
    },
    cards: { player: pCard?.name, cpu: cCard?.name }
  };
  const arr = JSON.parse(localStorage.getItem(key) || '[]');
  arr.push(rec);
  localStorage.setItem(key, JSON.stringify(arr));
}

// じゃんけん（PHY▶CHE▶BIO▶PHY）
const beats = { phy:'che', che:'bio', bio:'phy' };
const rpsOutcome = (a, b) => a === b ? 0 : (beats[a] === b ? 1 : -1);

// 残り時間倍率：20s→2.0、10s→1.0、10s未満は1.0
const timeMult = (remainMs) => {
  const remain = remainMs / 1000;
  return clamp(1 + (remain - 10) / 10, 1, 2);
};

// ================= データ =================
let cards = [];   // data/cards.json（{name,type,hp,phy,che,bio,image}）
let dgs   = [];   // data/dungeons.json の dungeons（{id,name,questions:[{q,a}]}）

// ================= 対戦状態 =================
// === 戦績（1セットぶん） ===
let statsP = { correct: 0, total: 0, times: [] }; // あなた
let statsC = { correct: 0, total: 0, times: [] }; // CPU

let player = null, cpu = null;
let myDungeonIds = [], cpuDungeonIds = [];
let pPool = [], cPool = [];   // プレイヤー/CPUで独立プール
let match = { p:0, c:0, set:0 };

let pChoice='phy', cChoice='phy';
let pRpsMul=1.0,  cRpsMul=1.0;

let setOver = false;
let setToken = 0;            // ★ セット識別トークン（古いコールバック無効化用）

// プレイヤー用の現在問題とタイマー
let pQ = null, pDeadline = 0, pRafId = null, pEndTimerId = null, pNextQTimerId = null;

// CPU用の現在問題とタイマー
let cQ = null, cDeadline = 0, cAnswerTimerId = null, cEndTimerId = null, cNextQTimerId = null;

// セット間の準備フラグ
let pReadyNext = false, cReadyNext = false;

// 選択/カウント制御
let chooseTimerId = null, chooseDeadline = 0, choiceFinalized = false;
let countdownId = null;

// ================= 画面表示補助 =================
const setBars = () => {
  el('pHp').textContent = fmtHp(player.hp);
  el('cHp').textContent = fmtHp(cpu.hp);
  el('pHpBar').style.width = clamp(player.hp / player.hpMax * 100, 0, 100) + '%';
  el('cHpBar').style.width = clamp(cpu.hp / cpu.hpMax * 100, 0, 100) + '%';
};
const getAtkBy = (c, t) => t==='phy' ? c.phy : (t==='che' ? c.che : c.bio);
const statLine = (c) => `TYPE:${c.type.toUpperCase()} / HP:${c.hp} / PHY:${c.phy} / CHE:${c.che} / BIO:${c.bio}`;

// ================= ロード =================
async function loadAll(){
  const cj = await fetch('data/cards.json', {cache:'no-store'}).then(r => r.json());
  const dj = await fetch('data/dungeons.json', {cache:'no-store'}).then(r => r.json());
  cards = cj; dgs = dj.dungeons;

  // セレクトと画像プレビュー
  const pSel = el('playerCard'), cSel = el('cpuCard');
  cards.forEach((c, i) => {
    const o1 = document.createElement('option'); o1.value = i; o1.textContent = `${c.name} (${c.type})`; pSel.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = i; o2.textContent = `${c.name} (${c.type})`; cSel.appendChild(o2);
  });
  pSel.value = 0;
  cSel.value = Math.min(2, cards.length-1);

  const updatePreview = () => {
    const p = cards[Number(pSel.value)];
    const c = cards[Number(cSel.value)];
    if (p){ el('pCardImg').src = p.image; el('pStats').textContent = statLine(p); }
    if (c){ el('cCardImg').src = c.image; el('cStats').textContent = statLine(c); }
  };
  pSel.onchange = updatePreview; cSel.onchange = updatePreview; updatePreview();

  // ダンジョンチェック
  const mkChecks = (rootId) => {
    const root = el(rootId); root.innerHTML='';
    dgs.forEach(d=>{
      const id = `${rootId}_${d.id}`;
      root.insertAdjacentHTML('beforeend',
        `<label style="display:inline-block;margin-right:10px">
           <input type="checkbox" id="${id}" value="${d.id}"> ${d.name}
         </label>`);
    });
  };
  mkChecks('myDungeons'); mkChecks('cpuDungeons');

  // ボタン・フォーム
  el('startBtn').onclick = startMatch;
  el('answerForm').addEventListener('submit', onSubmit);
  el('toHome').onclick = () => { window.location.href = './index.html'; };
  el('retry').onclick  = () => {
    only('setupBox','logBox');
    el('log').textContent='';
    el('setCounter').textContent='0';
    el('scoreP').textContent='0';
    el('scoreC').textContent='0';
    el('pChoicePill').textContent='-';
    el('cChoicePill').textContent='-';
    el('rpsNote').textContent='';
  };
  el('nextSetBtn').onclick = onPlayerReadyNext;

  // ラジオ即時反映
  document.querySelectorAll('input[name="atype"]').forEach(r=>{
    r.addEventListener('change', ()=>{
      const v = document.querySelector('input[name="atype"]:checked')?.value;
      el('pChoicePill').textContent = v ? `あなた:${v.toUpperCase()}` : '-';
    });
  });
}
document.addEventListener('DOMContentLoaded', loadAll);

// ================= 共通処理 =================
const pickSelected = (rootId)=>{
  const ids=[];
  dgs.forEach(d=>{
    const cb = document.getElementById(`${rootId}_${d.id}`);
    if(cb && cb.checked) ids.push(d.id);
  });
  return ids.slice(0,2);
};
const makePoolFrom = (ids)=>{
  const set = new Set(ids);
  const arr = [];
  dgs.filter(d=>set.has(d.id)).forEach(d=>{
    arr.push(...d.questions.map(q=>({q:q.q, a:q.a, dungeon:d.id})));
  });
  // シャッフル
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
};

// すべてのタイマー/RAFを止める（次セット前や終了時に必ず呼ぶ）
function clearAllTimers(){
  // 選択・カウントダウン
  if (chooseTimerId) cancelAnimationFrame(chooseTimerId), chooseTimerId=null;
  if (countdownId) clearInterval(countdownId), countdownId=null;

  // プレイヤー側
  if (pRafId) cancelAnimationFrame(pRafId), pRafId=null;
  if (pEndTimerId) clearTimeout(pEndTimerId), pEndTimerId=null;
  if (pNextQTimerId) clearTimeout(pNextQTimerId), pNextQTimerId=null;

  // CPU側
  if (cAnswerTimerId) clearTimeout(cAnswerTimerId), cAnswerTimerId=null;
  if (cEndTimerId) clearTimeout(cEndTimerId), cEndTimerId=null;
  if (cNextQTimerId) clearTimeout(cNextQTimerId), cNextQTimerId=null;
}

// ================= マッチ進行 =================
function startMatch(){
  // カード
  player = {...cards[Number(el('playerCard').value)]};
  cpu    = {...cards[Number(el('cpuCard').value)]};
  player.hpMax = player.hp; cpu.hpMax = cpu.hp; setBars();

  // ダンジョン（不足は自動補完）
  const allIds = dgs.map(d=>d.id);
  const pushIf =(arr,id)=>{ if(!arr.includes(id)) arr.push(id); };
  myDungeonIds  = pickSelected('myDungeons');
  cpuDungeonIds = pickSelected('cpuDungeons');
  for(const id of allIds){ if(myDungeonIds.length>=2) break;  pushIf(myDungeonIds,id); }
  for(const id of allIds){ if(cpuDungeonIds.length>=2) break; pushIf(cpuDungeonIds,id); }

  // スコア初期化
  match={p:0,c:0,set:0};
  el('scoreP').textContent='0'; el('scoreC').textContent='0';
  el('setCounter').textContent='0';
  el('log').textContent='';
  el('pChoicePill').textContent='-'; el('cChoicePill').textContent='-'; el('rpsNote').textContent='';

  nextSet();
}

function nextSet(){
  // ★ 古いタイマーは完全停止
  clearAllTimers();

  // ★ セット識別トークンを更新（古いコールバック無効化）
  setToken++;

  match.set++; el('setCounter').textContent=String(match.set);

  // HPを確実に満タンへ
  player.hp = player.hpMax; cpu.hp = cpu.hpMax; setBars();
    // 戦績リセット（このセットの集計）
  statsP = { correct: 0, total: 0, times: [] };
  statsC = { correct: 0, total: 0, times: [] };


  // 出題プールは双方独立（同一合体元から別シャッフル）
  const idsMerged = [...new Set([...myDungeonIds, ...cpuDungeonIds])];
  pPool = makePoolFrom(idsMerged);
  cPool = makePoolFrom(idsMerged);

  setOver = false;

  // タイプ選択へ
  startChoicePhase();
}

// ================= タイプ選択 → じゃんけん結果 → カウントダウン =================
function bestType(c){
  const arr=[['phy',c.phy],['che',c.che],['bio',c.bio]];
  arr.sort((a,b)=>b[1]-a[1]); return arr[0][0];
}

function startChoicePhase(){
  only('choiceBox','logBox');
  el('choiceResult').textContent='';
  el('pChoicePill').textContent='-'; el('cChoicePill').textContent='-'; el('rpsNote').textContent='';
  pChoice=null; cChoice=null; pRpsMul=1.0; cRpsMul=1.0;

  // ★ 二重実行防止
  choiceFinalized = false;

  // CPU はランダム選択
  cChoice = ['phy','che','bio'][Math.floor(Math.random()*3)];

  // 5秒カウント
  chooseDeadline = performance.now()+5000;
  const myToken = setToken;
  const tick=()=>{
    if (myToken !== setToken) return;  // 古い選択タイマーを無効化
    const remain=Math.max(0, chooseDeadline - performance.now());
    el('choiceTimer').textContent=(remain/1000).toFixed(1)+'s';
    if(remain<=0){ finalizeChoices(true); return; }
    chooseTimerId = requestAnimationFrame(tick);
  };
  if (chooseTimerId) cancelAnimationFrame(chooseTimerId);
  chooseTimerId = requestAnimationFrame(tick);

  el('lockChoice').onclick = ()=>finalizeChoices(false);
}

function finalizeChoices(autoPick){
  if (choiceFinalized) return; // ★ 二重起動ブロック
  choiceFinalized = true;

  if (chooseTimerId) cancelAnimationFrame(chooseTimerId), chooseTimerId=null;

  if(!pChoice){
    const sel=document.querySelector('input[name="atype"]:checked');
    pChoice = sel?sel.value : (autoPick?bestType(player):bestType(player));
  }

  const out=rpsOutcome(pChoice,cChoice);
  if(out===1){ pRpsMul=1.5; cRpsMul=0.5; }
  else if(out===-1){ pRpsMul=0.5; cRpsMul=1.5; }
  else { pRpsMul=1.0; cRpsMul=1.0; }

  el('pChoicePill').textContent=`あなた:${pChoice.toUpperCase()}`;
  el('cChoicePill').textContent=`CPU:${cChoice.toUpperCase()}`;
  el('rpsNote').textContent=`（倍率 あなた×${pRpsMul.toFixed(1)} / CPU×${cRpsMul.toFixed(1)}）`;

  // じゃんけん結果（5秒）
  only('rpsBox','logBox');
  const res = out===1?'あなたの勝ち':(out===-1?'CPUの勝ち':'あいこ');
  el('rpsSummary').textContent =
    `あなた:${pChoice.toUpperCase()} / CPU:${cChoice.toUpperCase()} → じゃんけん結果：${res}\n` +
    `倍率 あなた×${pRpsMul.toFixed(1)} / CPU×${cRpsMul.toFixed(1)}（5秒後にカウントダウン）`;
  log(`セット${match.set}: タイプ あなた=${pChoice.toUpperCase()} / CPU=${cChoice.toUpperCase()} → ${res}`);

  setTimeout(startCountdown, 5000);
}

function startCountdown(){
  only('countBox','logBox');
  // ★ 二重起動防止（既存があれば消す）
  if (countdownId) clearInterval(countdownId), countdownId=null;

  let n=5; el('countNum').textContent=String(n);
  const myToken = setToken;
  countdownId = setInterval(()=>{
    if (myToken !== setToken) { clearInterval(countdownId); countdownId=null; return; }
    n--; el('countNum').textContent=String(n);
    if(n<=0){
      clearInterval(countdownId); countdownId=null;
      startBattle();
    }
  },1000);
}

// ================= バトル開始（完全独立進行） =================
function startBattle(){
  only('battleBox','logBox');
  startPlayerQuestion(); // プレイヤー用UIの問題進行
  startCpuQuestion();    // CPUは裏で独立進行（UI更新なし）
}

// ---- プレイヤー側ループ ----
function startPlayerQuestion(){
  if(setOver) return;
  if(player.hp<=0 || cpu.hp<=0) return endSet();

  if(pPool.length===0){
    log('（あなた側）問題が尽きました'); 
    return endSet();
  }

  const q = pPool.shift();
  pQ = {...q};
  el('roundInfo').textContent = 'ROUND (あなた)';
  el('question').textContent  = q.q;
  el('answerInput').value=''; el('answerInput').disabled=false; el('answerInput').focus();

  const start = performance.now();
  pDeadline   = start + LIMIT_MS;

  const myToken = setToken;
  const rafTick = ()=>{
    if (myToken !== setToken || setOver) return;
    const remain=Math.max(0, pDeadline - performance.now());
    el('timerLabel').textContent=(remain/1000).toFixed(1)+'s';
    if(remain<=0){
      applyPenalty('p', 0);
      pNextQTimerId = setTimeout(()=>{ if (myToken !== setToken) return; startPlayerQuestion(); }, 150);
    }else{
      pRafId = requestAnimationFrame(rafTick);
    }
  };
  if (pRafId) cancelAnimationFrame(pRafId);
  pRafId = requestAnimationFrame(rafTick);
  if (pEndTimerId) clearTimeout(pEndTimerId);
  pEndTimerId = setTimeout(()=>{/* safety */}, LIMIT_MS+50);
}

// ---- CPU側ループ（UIには触れない）----
function startCpuQuestion(){
  if(setOver) return;
  if(player.hp<=0 || cpu.hp<=0) return endSet();

  if(cPool.length===0){
    log('（CPU側）問題が尽きました');
    return endSet();
  }

  const q = cPool.shift();
  cQ = {...q};
  const cpuCorrect = Math.random() < CPU_ACCURACY;
  const cpuTime    = CPU_MIN_MS + Math.random()*(CPU_MAX_MS - CPU_MIN_MS);
  const start      = performance.now();
  cDeadline        = start + LIMIT_MS;

  const myToken = setToken;
  if (cAnswerTimerId) clearTimeout(cAnswerTimerId);
  cAnswerTimerId = setTimeout(()=>{
    if (myToken !== setToken || setOver) return;
    const remain = Math.max(0, cDeadline - performance.now());
    if(cpuCorrect){
      statsC.total++;
  　　const elapsedCpu = Math.min(cpuTime, LIMIT_MS) / 1000;
  　　statsC.times.push(elapsedCpu);
  　　statsC.correct++;
      applyDamage('c', remain);   // CPUの与ダメ
    }else{
      statsC.total++;
  　　const elapsedCpu = Math.min(cpuTime, LIMIT_MS) / 1000;
  　　statsC.times.push(elapsedCpu);
      applyPenalty('c', remain);  // CPUの自傷
    }
    cNextQTimerId = setTimeout(()=>{ if (myToken !== setToken) return; startCpuQuestion(); }, 100);
  }, Math.min(cpuTime, LIMIT_MS));

  if (cEndTimerId) clearTimeout(cEndTimerId);
  cEndTimerId = setTimeout(()=>{/* safety */}, LIMIT_MS+50);
}

// ================= ダメージ＆ペナルティ =================
function applyDamage(side, remainMs){
  if(setOver) return;
  const atkType = side==='p' ? pChoice : cChoice;
  const unit    = side==='p' ? player  : cpu;
  const rpsMul  = side==='p' ? pRpsMul : cRpsMul;
  const base    = getAtkBy(unit, atkType);
  const mult    = timeMult(remainMs);
  const dmg     = Math.round(base * rpsMul * mult);

  if(side==='p'){ cpu.hp -= dmg; } else { player.hp -= dmg; }
  setBars();
  log(`${side==='p'?'あなた':'CPU'} 正解 → ${atkType.toUpperCase()}基礎${base} × RPS${rpsMul.toFixed(1)} × 時間${mult.toFixed(2)} = ${dmg} dmg`);

  if(player.hp<=0 || cpu.hp<=0) endSet();
}

function applyPenalty(side, remainMs){
  if(setOver) return;
  const atkType = side==='p' ? pChoice : cChoice;
  const unit    = side==='p' ? player  : cpu;
  const rpsMul  = side==='p' ? pRpsMul : cRpsMul;
  const base    = getAtkBy(unit, atkType);
  const mult    = timeMult(remainMs);
  const dmg     = Math.round(base * rpsMul * mult * PENALTY_RATE);

  if(side==='p'){ player.hp -= dmg; } else { cpu.hp -= dmg; }
  setBars();
  log(`${side==='p'?'あなた':'CPU'} 不正解 → ペナルティ ${atkType.toUpperCase()}基礎${base} × RPS${rpsMul.toFixed(1)} × 時間${mult.toFixed(2)} × 係数${PENALTY_RATE} = ${dmg} self-dmg`);

  if(player.hp<=0 || cpu.hp<=0) endSet();
}

// ================= 入力（あなた側） =================
function onSubmit(e){
  e.preventDefault();
  if(setOver) return;
  if(!pQ) return;

  const ans    = el('answerInput').value;
  const ok     = normalize(ans) === normalize(pQ.a);
  const remain = Math.max(0, pDeadline - performance.now());
    // 戦績（あなた）
  statsP.total++;
  const elapsedMs = LIMIT_MS - remain; // 回答にかかった時間
  statsP.times.push(elapsedMs / 1000);
  if (ok) statsP.correct++;


  if (pRafId) cancelAnimationFrame(pRafId), pRafId=null;
  if (pEndTimerId) clearTimeout(pEndTimerId), pEndTimerId=null;

  if(ok){ applyDamage('p', remain); }
  else { applyPenalty('p', remain); }

  const myToken = setToken;
  pNextQTimerId = setTimeout(()=>{ if (myToken !== setToken) return; startPlayerQuestion(); }, 150); // あなた側だけ次へ
}

// ================= セット終了 → 待機（両者準備OKで次セット） =================
function endSet(){
  if(setOver) return;
  setOver = true;

  // ★ 全タイマー停止（残りが次セットに食い込まないように）
  clearAllTimers();

  // 勝敗集計
  let winner = null;
  if(player.hp<=0 && cpu.hp<=0){
    // 同時ダウン → 残HP比較。同点ならCPU勝ち等のルール
    winner = (player.hp === cpu.hp) ? 'c' : (player.hp > cpu.hp ? 'p' : 'c');
  }else{
    winner = (cpu.hp<=0) ? 'p' : 'c';
  }
  if(winner==='p') match.p++; else match.c++;
  el('scoreP').textContent=String(match.p);
  el('scoreC').textContent=String(match.c);
    // ローカル保存（このセットの結果）
  const winnerCode = (player.hp<=0 && cpu.hp<=0)
    ? ((player.hp === cpu.hp) ? 'c' : (player.hp > cpu.hp ? 'p' : 'c'))
    : (cpu.hp<=0 ? 'p' : 'c');

  saveSetResult({
    winner: winnerCode,
    selectedType: pChoice || 'phy',
    matchSet: match.set,
    pStats: statsP,
    cStats: statsC,
    pCard: player,
    cCard: cpu
  });


  // マッチ終了か？
  if(match.p===2 || match.c===2 || match.set===3){
    const msg = match.p===match.c ? '引き分け' : (match.p>match.c?'マッチ勝利！':'マッチ敗北…');
    el('resultText').textContent = `結果: あなた ${match.p} - ${match.c} CPU → ${msg}`;
    only('resultBox','logBox');
    return;
  }

  // セット間待機（両者準備OK）
  pReadyNext=false; cReadyNext=false;
  el('betweenText').textContent = `セット${match.set} 終了：${winner==='p'?'あなたの勝ち':'CPUの勝ち'}（現在スコア あなた ${match.p} - ${match.c} CPU）`;
  el('readyStatus').textContent = 'あなた：未準備 ／ CPU：未準備';
  only('betweenBox','logBox');

  // CPUは少し遅れて自動で準備OK
  setTimeout(()=>{ cReadyNext = true; updateReadyStatus(); tryStartNextSetWhenBothReady(); }, 1200 + Math.random()*800);
}

function onPlayerReadyNext(){
  pReadyNext = true;
  updateReadyStatus();
  tryStartNextSetWhenBothReady();
}

function updateReadyStatus(){
  const me = pReadyNext ? 'あなた：準備OK' : 'あなた：未準備';
  const op = cReadyNext ? 'CPU：準備OK' : 'CPU：未準備';
  el('readyStatus').textContent = `${me} ／ ${op}`;
}

function tryStartNextSetWhenBothReady(){
  if(!(pReadyNext && cReadyNext)) return;
  nextSet();                  // HPリセット＆トークン更新＆全タイマー初期化
  only('choiceBox','logBox'); // 次セットのタイプ選択へ
}

// ================= 起動時バインド（最後） =================
el('startBtn')?.addEventListener('click', startMatch);
el('answerForm')?.addEventListener('submit', onSubmit);

