/* 사다리 타기 클라이언트 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 12;
const COLORS = [
  '#38bdf8', '#f472b6', '#4ade80', '#facc15', '#a78bfa', '#fb923c',
  '#2dd4bf', '#f87171', '#c084fc', '#a3e635', '#60a5fa', '#fbbf24',
];
const PATH_STAGGER_MS = 2600; // i번째 참가자 경로 시작 간격
const PATH_DURATION_MS = 2200; // 경로 하나를 그리는 시간

// 브라우저(참가자) 식별자
let clientId = localStorage.getItem('ladder-client-id');
if (!clientId) {
  clientId = crypto.randomUUID();
  localStorage.setItem('ladder-client-id', clientId);
}

const roomId = new URLSearchParams(location.search).get('room');
let state = null;
let myName = '';
let animationStarted = false;

function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

// ============================================================ 방 만들기

function initCreateView() {
  showView('#view-create');
  let count = 4;
  const display = $('#count-display');
  const inputsBox = $('#result-inputs');

  function renderResultInputs() {
    const prev = [...inputsBox.querySelectorAll('input')].map((i) => i.value);
    inputsBox.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 30;
      input.placeholder = `결과 ${i + 1}`;
      input.value = prev[i] !== undefined ? prev[i] : (i === 0 ? '당첨' : '꽝');
      inputsBox.appendChild(input);
    }
  }

  document.querySelectorAll('.count-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      count = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, count + Number(btn.dataset.delta)));
      display.textContent = count;
      renderResultInputs();
    });
  });
  renderResultInputs();

  $('#btn-create').addEventListener('click', async () => {
    const purpose = $('#purpose').value.trim();
    const results = [...inputsBox.querySelectorAll('input')].map((i) => i.value.trim());
    const errorEl = $('#create-error');
    errorEl.textContent = '';
    if (!purpose) return (errorEl.textContent = '사다리의 목적을 입력해주세요.');
    if (results.some((r) => !r)) return (errorEl.textContent = '모든 결과 항목을 채워주세요.');

    $('#btn-create').disabled = true;
    try {
      const res = await fetch('/api/ladder/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose, results }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '방 생성에 실패했습니다.');
      location.href = `/ladder/?room=${data.roomId}`;
    } catch (err) {
      errorEl.textContent = err.message;
      $('#btn-create').disabled = false;
    }
  });
}

// ============================================================ 대기실

function inviteUrl() {
  return `${location.origin}/ladder/?room=${roomId}`;
}

function renderLobby() {
  showView('#view-lobby');
  $('#lobby-purpose').textContent = state.purpose;
  $('#invite-link').textContent = inviteUrl();

  const filled = state.slots.filter(Boolean).length;
  $('#lobby-progress').textContent = `위치 선택: ${filled} / ${state.size}`;

  const grid = $('#slot-grid');
  grid.innerHTML = '';
  state.slots.forEach((slot, i) => {
    const div = document.createElement('div');
    div.className = 'slot ' + (slot ? 'taken' : 'empty');
    if (slot && slot.name === myName) div.classList.add('mine');
    div.innerHTML = `<span class="num">위치 ${i + 1}</span><span class="who">${
      slot ? escapeHtml(slot.name) : '비어 있음'
    }</span>`;
    if (!slot) div.addEventListener('click', () => claimSlot(i));
    grid.appendChild(div);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function claimSlot(slot) {
  const errorEl = $('#lobby-error');
  errorEl.textContent = '';
  const name = $('#my-name').value.trim();
  if (!name) {
    errorEl.textContent = '먼저 이름을 입력해주세요.';
    $('#my-name').focus();
    return;
  }
  try {
    const res = await fetch(`/api/ladder/rooms/${roomId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot, name, clientId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '위치 선택에 실패했습니다.');
    myName = name;
    localStorage.setItem(`ladder-name-${roomId}`, name);
    state = data.state;
    render();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// ============================================================ 게임(애니메이션)

function renderGame() {
  showView('#view-game');
  $('#game-purpose').textContent = state.purpose;
  if (animationStarted) return;
  animationStarted = true;
  runCountdownThenAnimate();
}

function runCountdownThenAnimate() {
  const cd = $('#countdown');
  const tick = () => {
    const remain = state.startAt - Date.now();
    if (remain > 200) {
      cd.classList.remove('hidden');
      cd.textContent = Math.ceil(remain / 1000);
      requestAnimationFrame(tick);
    } else {
      cd.classList.add('hidden');
      animateLadder();
    }
  };
  tick();
}

function buildGeometry() {
  const n = state.size;
  const { rows, rungs } = state.ladder;
  const colW = 72;
  const rowH = 26;
  const padX = colW / 2;
  const padY = 16;
  const width = colW * n;
  const height = padY * 2 + rowH * (rows + 1);
  const colX = (i) => padX + i * colW;
  const rowY = (r) => padY + rowH * (r + 0.5) + rowH / 2;
  return { n, rows, rungs, width, height, colX, rowY, padY };
}

/** 시작 칸의 이동 경로(꺾은선 좌표 목록) 계산 */
function tracePath(geo, start) {
  const byRow = new Map();
  for (const [r, g] of geo.rungs) {
    if (!byRow.has(r)) byRow.set(r, new Set());
    byRow.get(r).add(g);
  }
  const pts = [];
  let col = start;
  pts.push([geo.colX(col), geo.padY]);
  for (let r = 0; r < geo.rows; r++) {
    const gaps = byRow.get(r);
    if (!gaps) continue;
    let next = col;
    if (gaps.has(col)) next = col + 1;
    else if (col > 0 && gaps.has(col - 1)) next = col - 1;
    if (next !== col) {
      pts.push([geo.colX(col), geo.rowY(r)]);
      pts.push([geo.colX(next), geo.rowY(r)]);
      col = next;
    }
  }
  pts.push([geo.colX(col), geo.height - geo.padY]);
  return { pts, end: col };
}

function drawBaseLadder(svg, geo) {
  svg.setAttribute('viewBox', `0 0 ${geo.width} ${geo.height}`);
  // 인원이 적을 때 화면 폭에 맞춰 과하게 커지지 않도록 사다리 영역 크기 제한
  const wrap = $('#ladder-wrap');
  wrap.style.width = '100%';
  wrap.style.maxWidth = `${geo.width * 1.6}px`;
  wrap.style.minWidth = `${geo.width}px`;
  wrap.style.margin = '0 auto';
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < geo.n; i++) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', geo.colX(i));
    line.setAttribute('x2', geo.colX(i));
    line.setAttribute('y1', geo.padY);
    line.setAttribute('y2', geo.height - geo.padY);
    line.setAttribute('stroke', 'var(--line)');
    line.setAttribute('stroke-width', '3');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
  }
  for (const [r, g] of geo.rungs) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', geo.colX(g));
    line.setAttribute('x2', geo.colX(g + 1));
    line.setAttribute('y1', geo.rowY(r));
    line.setAttribute('y2', geo.rowY(r));
    line.setAttribute('stroke', 'var(--line)');
    line.setAttribute('stroke-width', '3');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);
  }
}

function renderLabels(geo) {
  const top = $('#top-labels');
  const bottom = $('#bottom-labels');
  top.innerHTML = '';
  bottom.innerHTML = '';
  for (let i = 0; i < geo.n; i++) {
    const t = document.createElement('div');
    t.className = 'lb';
    t.textContent = state.slots[i] ? state.slots[i].name : `위치 ${i + 1}`;
    t.style.color = COLORS[i % COLORS.length];
    top.appendChild(t);

    const b = document.createElement('div');
    b.className = 'lb dim';
    b.textContent = '?';
    b.dataset.index = i;
    bottom.appendChild(b);
  }
}

// ---- 진행 위치 자동 추적: 사다리가 화면보다 클 때(특히 모바일) 그려지는 지점을 따라 스크롤
let followEnabled = true;
let followControlReady = false;
let followResumeTimer = null;

function setupFollowControl() {
  if (followControlReady) return;
  followControlReady = true;
  // 사용자가 직접 스크롤하면 자동 추적을 잠시 멈추고, 손을 떼면 다시 따라간다
  const pause = () => {
    followEnabled = false;
    clearTimeout(followResumeTimer);
    followResumeTimer = setTimeout(() => { followEnabled = true; }, 2500);
  };
  ['wheel', 'touchmove', 'mousedown'].forEach((ev) =>
    window.addEventListener(ev, pause, { passive: true })
  );
}

function followTip(svg, pt) {
  const vb = svg.viewBox.baseVal;
  const rect = svg.getBoundingClientRect();
  if (!vb.width || !vb.height || !rect.width) return;
  const x = rect.left + (pt.x / vb.width) * rect.width;
  const y = rect.top + (pt.y / vb.height) * rect.height;

  // 세로: 진행 지점이 화면 중앙 부근에 오도록 페이지를 부드럽게 스크롤
  const dy = y - window.innerHeight * 0.45;
  if (Math.abs(dy) > 6) window.scrollBy(0, dy * 0.18);

  // 가로: 인원이 많아 카드에 좌우 스크롤이 생기면 진행 지점을 따라 이동
  const scroller = svg.closest('.game-card');
  if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) {
    const srect = scroller.getBoundingClientRect();
    const dx = x - (srect.left + srect.width * 0.5);
    if (Math.abs(dx) > 6) scroller.scrollLeft += dx * 0.18;
  }
}

function animateLadder() {
  const geo = buildGeometry();
  const svg = $('#ladder-svg');
  svg.innerHTML = '';
  drawBaseLadder(svg, geo);
  renderLabels(geo);
  setupFollowControl();

  const ns = 'http://www.w3.org/2000/svg';
  const paths = [];
  for (let i = 0; i < geo.n; i++) {
    const { pts, end } = tracePath(geo, i);
    const d = pts.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', COLORS[i % COLORS.length]);
    path.setAttribute('stroke-width', '5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    const len = path.getTotalLength();
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    paths.push({ path, len, end, revealed: false });
  }

  // 모든 클라이언트가 startAt 기준 동일 타임라인으로 애니메이션 → 화면이 맞춰짐
  const animStart = state.startAt;
  function frame() {
    const now = Date.now();
    let done = true;
    let tip = null; // 지금 그려지고 있는 경로의 끝점 (스크롤 추적용)
    paths.forEach((p, i) => {
      const t = (now - animStart - i * PATH_STAGGER_MS) / PATH_DURATION_MS;
      const progress = Math.max(0, Math.min(1, t));
      p.path.style.strokeDashoffset = p.len * (1 - progress);
      if (progress > 0 && progress < 1) tip = p.path.getPointAtLength(p.len * progress);
      if (progress >= 1 && !p.revealed) {
        p.revealed = true;
        revealResult(i, p.end);
      }
      if (progress < 1) done = false;
    });
    if (tip && followEnabled) followTip(svg, tip);
    if (!done) requestAnimationFrame(frame);
    else showResultPanel();
  }
  requestAnimationFrame(frame);
}

function revealResult(startIdx, endIdx) {
  const lb = $(`#bottom-labels .lb[data-index="${endIdx}"]`);
  if (!lb) return;
  lb.textContent = state.results[endIdx];
  lb.classList.remove('dim');
  lb.style.color = COLORS[startIdx % COLORS.length];
}

function showResultPanel() {
  const list = $('#result-list');
  list.innerHTML = '';
  state.slots.forEach((slot, i) => {
    const li = document.createElement('li');
    const name = slot ? slot.name : `위치 ${i + 1}`;
    if (slot && slot.name === myName) li.classList.add('mine');
    li.innerHTML = `<span>${escapeHtml(name)}</span><span class="res" style="color:${
      COLORS[i % COLORS.length]
    }">${escapeHtml(state.results[state.mapping[i]])}</span>`;
    list.appendChild(li);
  });
  const panel = $('#result-panel');
  panel.classList.remove('hidden');
  // 연출이 끝나면 결과 목록이 보이도록 스크롤
  setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 150);
}

// ============================================================ 상태 동기화

function render() {
  if (!state) return;
  if (state.status === 'waiting') renderLobby();
  else if (state.status === 'running') renderGame();
}

function connectRoom() {
  myName = localStorage.getItem(`ladder-name-${roomId}`) || '';
  if (myName) {
    // 대기실 이름 입력칸에 미리 채워두기
    $('#my-name').value = myName;
  }
  const es = new EventSource(`/api/ladder/rooms/${roomId}/events`);
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
    // 방이 없으면 서버가 404를 반환해 스트림이 열리지 않음
    const res = await fetch(`/api/ladder/rooms/${roomId}`);
    if (res.status === 404) {
      es.close();
      showView('#view-notfound');
    }
  };
}

// ============================================================ 초기화

$('#btn-copy')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    $('#btn-copy').textContent = '복사됨!';
  } catch {
    // 클립보드 API가 막힌 환경(비 HTTPS 등) 대비
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
