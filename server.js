/**
 * mini_game server
 * - 정적 파일 서빙 (public/)
 * - 사다리게임 API (/api/ladder/...)
 * - SSE 실시간 동기화 (방 상태가 바뀌면 참가자 전원에게 push)
 *
 * 외부 의존성 없음: `node server.js` 만으로 동작.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // 방은 24시간 뒤 자동 삭제
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 2;

/** @type {Map<string, object>} roomId -> room */
const rooms = new Map();
/** @type {Map<string, Set<http.ServerResponse>>} roomId -> SSE 구독자 */
const subscribers = new Map();

// ---------------------------------------------------------------- utilities

const ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 헷갈리는 문자(I,L,O,0,1) 제외
function makeRoomId() {
  let id;
  do {
    id = Array.from(crypto.randomBytes(6), (b) => ID_CHARS[b % ID_CHARS.length]).join('');
  } while (rooms.has(id));
  return id;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLen);
}

// ------------------------------------------------------------- ladder logic

/**
 * 사다리 생성: n개의 세로줄 사이(gap 0..n-2)에 가로줄(rung)을 무작위 배치.
 * 같은 행에서 인접한 gap 두 개에 동시에 가로줄이 생기지 않도록 하고,
 * 모든 gap에 가로줄이 최소 1개는 있도록 보정한다.
 */
function generateLadder(n) {
  const rows = 12 + Math.floor(Math.random() * 5) + n; // 인원이 많을수록 촘촘하게
  const rungs = []; // [row, gap]
  const grid = Array.from({ length: rows }, () => new Array(n - 1).fill(false));

  for (let r = 0; r < rows; r++) {
    for (let g = 0; g < n - 1; g++) {
      if (g > 0 && grid[r][g - 1]) continue; // 인접 gap 동시 금지
      if (Math.random() < 0.33) grid[r][g] = true;
    }
  }
  // 가로줄이 하나도 없는 gap 보정
  for (let g = 0; g < n - 1; g++) {
    if (grid.some((row) => row[g])) continue;
    for (let tries = 0; tries < 100; tries++) {
      const r = Math.floor(Math.random() * rows);
      if ((g === 0 || !grid[r][g - 1]) && (g === n - 2 || !grid[r][g + 1])) {
        grid[r][g] = true;
        break;
      }
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let g = 0; g < n - 1; g++) {
      if (grid[r][g]) rungs.push([r, g]);
    }
  }
  return { rows, rungs };
}

/** 시작 칸 -> 도착 칸 매핑 계산 */
function computeMapping(n, ladder) {
  const byRow = new Map();
  for (const [r, g] of ladder.rungs) {
    if (!byRow.has(r)) byRow.set(r, new Set());
    byRow.get(r).add(g);
  }
  const mapping = [];
  for (let start = 0; start < n; start++) {
    let col = start;
    for (let r = 0; r < ladder.rows; r++) {
      const gaps = byRow.get(r);
      if (!gaps) continue;
      if (gaps.has(col)) col += 1;
      else if (col > 0 && gaps.has(col - 1)) col -= 1;
    }
    mapping.push(col);
  }
  return mapping;
}

// -------------------------------------------------------------- room state

function publicState(room) {
  return {
    id: room.id,
    purpose: room.purpose,
    size: room.size,
    results: room.results,
    slots: room.slots.map((s) => (s ? { name: s.name } : null)),
    status: room.status, // waiting | running
    ladder: room.ladder,
    mapping: room.mapping,
    startAt: room.startAt,
  };
}

function broadcast(roomId) {
  const subs = subscribers.get(roomId);
  if (!subs || subs.size === 0) return;
  const room = rooms.get(roomId);
  const payload = `event: state\ndata: ${JSON.stringify(room ? publicState(room) : { deleted: true })}\n\n`;
  for (const res of subs) res.write(payload);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      rooms.delete(id);
      const subs = subscribers.get(id);
      if (subs) {
        for (const res of subs) res.end();
        subscribers.delete(id);
      }
    }
  }
}, 60 * 1000).unref();

// SSE 연결 유지용 heartbeat
setInterval(() => {
  for (const subs of subscribers.values()) {
    for (const res of subs) res.write(': ping\n\n');
  }
}, 25 * 1000).unref();

// -------------------------------------------------------------- API routes

function handleCreateRoom(req, res) {
  readBody(req)
    .then((body) => {
      const purpose = cleanText(body.purpose, 80);
      const results = Array.isArray(body.results)
        ? body.results.map((r) => cleanText(r, 30)).filter(Boolean)
        : [];
      if (!purpose) return json(res, 400, { error: '사다리 목적을 입력해주세요.' });
      if (results.length < MIN_PLAYERS || results.length > MAX_PLAYERS) {
        return json(res, 400, { error: `결과 항목은 ${MIN_PLAYERS}~${MAX_PLAYERS}개여야 합니다.` });
      }
      const room = {
        id: makeRoomId(),
        purpose,
        size: results.length,
        results,
        slots: new Array(results.length).fill(null), // {name, clientId}
        status: 'waiting',
        ladder: null,
        mapping: null,
        startAt: null,
        createdAt: Date.now(),
      };
      rooms.set(room.id, room);
      json(res, 201, { roomId: room.id });
    })
    .catch((err) => json(res, 400, { error: err.message }));
}

function handleClaim(req, res, room) {
  readBody(req)
    .then((body) => {
      const name = cleanText(body.name, 16);
      const clientId = cleanText(body.clientId, 64);
      const slot = Number(body.slot);
      if (!name) return json(res, 400, { error: '이름을 입력해주세요.' });
      if (!clientId) return json(res, 400, { error: 'clientId가 없습니다.' });
      if (!Number.isInteger(slot) || slot < 0 || slot >= room.size) {
        return json(res, 400, { error: '잘못된 위치입니다.' });
      }
      if (room.status !== 'waiting') {
        return json(res, 409, { error: '이미 게임이 시작되었습니다.' });
      }
      const taken = room.slots[slot];
      if (taken && taken.clientId !== clientId) {
        return json(res, 409, { error: '이미 다른 사람이 선택한 위치입니다.' });
      }
      const dupName = room.slots.some((s, i) => s && s.name === name && s.clientId !== clientId && i !== slot);
      if (dupName) return json(res, 409, { error: '이미 사용 중인 이름입니다.' });

      // 같은 사람이 다른 칸을 눌렀으면 이동 처리
      for (let i = 0; i < room.size; i++) {
        if (room.slots[i] && room.slots[i].clientId === clientId) room.slots[i] = null;
      }
      room.slots[slot] = { name, clientId };

      // 모든 위치가 선택되면 자동 시작
      if (room.slots.every(Boolean)) {
        room.ladder = generateLadder(room.size);
        room.mapping = computeMapping(room.size, room.ladder);
        room.status = 'running';
        room.startAt = Date.now() + 3500; // 3초 카운트다운 후 시작
      }
      broadcast(room.id);
      json(res, 200, { ok: true, state: publicState(room) });
    })
    .catch((err) => json(res, 400, { error: err.message }));
}

function handleEvents(req, res, room) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: state\ndata: ${JSON.stringify(publicState(room))}\n\n`);
  if (!subscribers.has(room.id)) subscribers.set(room.id, new Set());
  subscribers.get(room.id).add(res);
  req.on('close', () => {
    const subs = subscribers.get(room.id);
    if (subs) {
      subs.delete(res);
      if (subs.size === 0) subscribers.delete(room.id);
    }
  });
}

function handleApi(req, res, pathname) {
  // POST /api/ladder/rooms
  if (pathname === '/api/ladder/rooms' && req.method === 'POST') {
    return handleCreateRoom(req, res);
  }
  const match = pathname.match(/^\/api\/ladder\/rooms\/([A-Z2-9]{6})(\/(events|claim))?$/);
  if (!match) return json(res, 404, { error: 'not found' });
  const room = rooms.get(match[1]);
  if (!room) return json(res, 404, { error: '존재하지 않거나 만료된 방입니다.' });

  if (!match[3] && req.method === 'GET') return json(res, 200, publicState(room));
  if (match[3] === 'claim' && req.method === 'POST') return handleClaim(req, res, room);
  if (match[3] === 'events' && req.method === 'GET') return handleEvents(req, res, room);
  return json(res, 405, { error: 'method not allowed' });
}

// ------------------------------------------------------------ static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  serveStatic(res, pathname);
});

server.listen(PORT, () => {
  console.log(`mini_game server listening on http://localhost:${PORT}`);
});
