/* 가위 바위 보 클라이언트 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
const HAND_EMOJI = { scissors: '✌️', rock: '✊', paper: '🖐️' };
const HAND_NAME = { scissors: '가위', rock: '바위', paper: '보' };

// 브라우저(참가자) 식별자 — 사다리와 공유
let clientId = localStorage.getItem('mg-client-id') || localStorage.getItem('ladder-client-id');
if (!clientId) clientId = crypto.randomUUID();
localStorage.setItem('mg-client-id', clientId);

const roomId = new URLSearchParams(location.search).get('room');
let state = null;
let myName = '';
let myMoveRound = 0; // 내가 마지막으로 낸 라운드 (라운드 바뀌면 선택 초기화)
let myMove = null;
let revealKey = null; // 같은 reveal 연출을 중복 실행하지 않기 위한 키

function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function myIndex() {
  if (!state || !myName) return -1;
  return state.players.findIndex((p) => p.name === myName);
}

function modeLabel(mode) {
  return mode === 'lose' ? '😱 끝까지 지는 한 명 뽑기' : '🏆 끝까지 이기는 한 명 뽑기';
}

// ============================================================ 방 만들기

function initCreateView() {
  showView('#view-create');
  let count = 4;
  let mode = 'lose';

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('selected', b === btn));
      $('#mode-hint').textContent =
        mode === 'lose'
          ? '끝까지 지는 한 명이 걸릴 때까지 라운드가 반복됩니다.'
          : '끝까지 이기는 한 명이 남을 때까지 라운드가 반복됩니다.';
    });
  });

  document.querySelectorAll('.count-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      count = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, count + Number(btn.dataset.delta)));
      $('#count-display').textContent = count;
    });
  });

  $('#btn-create').addEventListener('click', async () => {
    const purpose = $('#purpose').value.trim();
    const errorEl = $('#create-error');
    errorEl.textContent = '';
    if (!purpose) return (errorEl.textContent = '게임의 목적을 입력해주세요.');

    $('#btn-create').disabled = true;
    try {
      const res = await fetch('/api/rps/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose, size: count, mode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '방 생성에 실패했습니다.');
      location.href = `/rps/?room=${data.roomId}`;
    } catch (err) {
      errorEl.textContent = err.message;
      $('#btn-create').disabled = false;
    }
  });
}

// ============================================================ 대기실

function inviteUrl() {
  return `${location.origin}/rps/?room=${roomId}`;
}

function renderPlayerChips(container, { showPickState = false } = {}) {
  container.innerHTML = '';
  state.players.forEach((p) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    if (p.name === myName) chip.classList.add('me');
    if (!p.alive) chip.classList.add('out');
    let st = '';
    if (showPickState && p.alive) {
      st = p.picked ? ' <span class="st">✅</span>' : ' <span class="st">🤔</span>';
      if (p.picked) chip.classList.add('picked');
    }
    chip.innerHTML = escapeHtml(p.name) + st;
    container.appendChild(chip);
  });
}

function renderLobby() {
  showView('#view-lobby');
  $('#lobby-purpose').textContent = state.purpose;
  $('#lobby-mode').textContent = modeLabel(state.mode);
  $('#invite-link').textContent = inviteUrl();
  $('#lobby-progress').textContent = `참가: ${state.players.length} / ${state.size}`;
  renderPlayerChips($('#player-list'));

  const joined = myIndex() !== -1;
  $('#my-name').disabled = joined;
  $('#btn-join').disabled = joined;
  $('#btn-join').textContent = joined ? '참가 완료' : '참가하기';
}

async function join() {
  const errorEl = $('#lobby-error');
  errorEl.textContent = '';
  const name = $('#my-name').value.trim();
  if (!name) {
    errorEl.textContent = '이름을 입력해주세요.';
    $('#my-name').focus();
    return;
  }
  try {
    const res = await fetch(`/api/rps/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, clientId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '참가에 실패했습니다.');
    myName = name;
    localStorage.setItem(`rps-name-${roomId}`, name);
    state = data.state;
    render();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// ============================================================ 게임

function renderStage({ picks = null, shaking = false, advance = [], dropped = [] } = {}) {
  const stage = $('#stage');
  stage.innerHTML = '';
  state.players.forEach((p, i) => {
    if (!p.alive && !dropped.includes(i)) return; // 이전 라운드 탈락자는 무대에서 제외
    const f = document.createElement('div');
    f.className = 'fighter';
    if (shaking) f.classList.add('shaking');
    if (advance.includes(i)) f.classList.add('advance');
    if (dropped.includes(i)) f.classList.add('dropped');
    const hand = picks && picks[i] ? HAND_EMOJI[picks[i]] : '✊';
    f.innerHTML = `<span class="hand-emoji">${hand}</span><span class="nm">${escapeHtml(p.name)}</span>`;
    stage.appendChild(f);
  });
}

function renderPicking() {
  revealKey = null;
  $('#final-panel').classList.add('hidden');
  $('#round-label').textContent = `ROUND ${state.round}`;

  if (state.round !== myMoveRound) {
    myMove = null; // 새 라운드 → 선택 초기화
  }

  const me = myIndex();
  const iAmAlive = me !== -1 && state.players[me].alive;
  const aliveCnt = state.players.filter((p) => p.alive).length;
  const pickedCnt = state.players.filter((p) => p.alive && p.picked).length;

  renderStage({ shaking: true });
  const msg = $('#stage-msg');
  msg.classList.remove('chant');
  if (iAmAlive) {
    msg.textContent = myMove
      ? `제출 완료! 다른 사람을 기다리는 중... (${pickedCnt}/${aliveCnt})`
      : '무엇을 낼까요?';
  } else if (me !== -1) {
    msg.textContent =
      state.mode === 'lose' ? '통과! 남은 사람들의 대결을 지켜보세요 👀' : '탈락... 남은 대결을 지켜보세요 👀';
  } else {
    msg.textContent = `대결 진행 중... (${pickedCnt}/${aliveCnt})`;
  }

  const btns = $('#hand-buttons');
  btns.classList.toggle('hidden', !iAmAlive);
  document.querySelectorAll('.hand').forEach((b) => {
    b.classList.toggle('selected', b.dataset.move === myMove);
    b.disabled = false;
  });

  renderPlayerChips($('#player-status'), { showPickState: true });
}

function startReveal() {
  const { picks, outcome, revealAt } = state.reveal;
  const key = `${state.round}:${revealAt}`;
  if (revealKey === key) return;
  revealKey = key;

  $('#hand-buttons').classList.add('hidden');
  renderPlayerChips($('#player-status'));
  const msg = $('#stage-msg');

  const tick = () => {
    if (!state.reveal || revealKey !== key) return; // 다음 상태로 넘어감
    const remain = revealAt - Date.now();
    if (remain > 0) {
      renderStage({ shaking: true });
      msg.classList.add('chant');
      msg.textContent = remain > 2100 ? '가위~' : remain > 1000 ? '바위~' : '보!!';
      requestAnimationFrame(tick);
      return;
    }
    // 공개!
    msg.classList.remove('chant');
    if (outcome.tie) {
      renderStage({ picks });
      msg.textContent = '😅 무승부! 한 번 더!';
    } else {
      const aliveIdx = state.players.map((_, i) => i).filter((i) => state.players[i].alive);
      const droppedNow = aliveIdx.filter((i) => !outcome.advancing.includes(i));
      renderStage({ picks, advance: outcome.advancing, dropped: droppedNow });
      if (outcome.advancing.length === 1) {
        msg.textContent = '결판났다!';
      } else {
        msg.textContent =
          state.mode === 'lose'
            ? `${HAND_EMOJI[outcome.winningMove]} 이긴 사람은 통과! 진 사람끼리 한 번 더!`
            : `${HAND_EMOJI[outcome.winningMove]} ${HAND_NAME[outcome.winningMove]} 승리! 이긴 사람끼리 한 번 더!`;
      }
    }
  };
  tick();
}

function renderDone() {
  $('#round-label').textContent = `ROUND ${state.lastRound.round} — 최종 결과`;
  $('#hand-buttons').classList.add('hidden');
  $('#stage-msg').textContent = '';

  const winner = state.players[state.winner];
  const last = state.lastRound;
  const aliveInFinal = state.players
    .map((_, i) => i)
    .filter((i) => last.picks[i] !== null);
  renderStage({
    picks: last.picks,
    advance: [state.winner],
    dropped: aliveInFinal.filter((i) => i !== state.winner),
  });
  renderPlayerChips($('#player-status'));

  $('#final-emoji').textContent = state.mode === 'lose' ? '😱' : '🏆';
  $('#final-text').textContent =
    state.mode === 'lose' ? `${winner.name} 님 당첨!` : `${winner.name} 님 최종 승리!`;
  $('#final-sub').textContent = `"${state.purpose}" 의 주인공이 되었습니다!`;
  $('#final-panel').classList.remove('hidden');
  setTimeout(() => $('#final-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 150);
}

function renderGame() {
  showView('#view-game');
  $('#game-purpose').textContent = state.purpose;
  if (state.status === 'picking') renderPicking();
  else if (state.status === 'reveal') startReveal();
  else if (state.status === 'done') renderDone();
}

async function pick(move) {
  const errorEl = $('#game-error');
  errorEl.textContent = '';
  try {
    const res = await fetch(`/api/rps/rooms/${roomId}/pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move, clientId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '제출에 실패했습니다.');
    myMove = move;
    myMoveRound = state.round;
    state = data.state;
    render();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// ============================================================ 상태 동기화

function render() {
  if (!state) return;
  if (state.status === 'waiting') renderLobby();
  else renderGame();
}

function connectRoom() {
  myName = localStorage.getItem(`rps-name-${roomId}`) || '';
  if (myName) $('#my-name').value = myName;

  const es = new EventSource(`/api/rps/rooms/${roomId}/events`);
  es.addEventListener('state', (e) => {
    const next = JSON.parse(e.data);
    if (next.deleted) {
      es.close();
      showView('#view-notfound');
      return;
    }
    state = next;
    render();
  });
  es.onerror = async () => {
    const res = await fetch(`/api/rps/rooms/${roomId}`);
    if (res.status === 404) {
      es.close();
      showView('#view-notfound');
    }
  };
}

// ============================================================ 초기화

$('#btn-join')?.addEventListener('click', join);
$('#my-name')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});
document.querySelectorAll('.hand').forEach((b) => {
  b.addEventListener('click', () => pick(b.dataset.move));
});

$('#btn-copy')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    $('#btn-copy').textContent = '복사됨!';
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('#invite-link'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  setTimeout(() => ($('#btn-copy').textContent = '복사'), 1500);
});

if (roomId) connectRoom();
else initCreateView();
