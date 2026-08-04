#!/usr/bin/env node
// chat-relay server: HTTP + long polling + JSONL persistence
// Standard library only.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = parseInt(process.env.CHAT_PORT || '7777', 10);
const HOST = process.env.CHAT_HOST || '127.0.0.1';
const DATA_DIR = process.env.CHAT_HOME || path.join(os.homedir(), '.chat');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');

fs.mkdirSync(ROOMS_DIR, { recursive: true });

const ROOM_NAME_RE = /^[a-zA-Z0-9_.\-]{1,64}$/;
function validRoom(name) {
  return typeof name === 'string' && ROOM_NAME_RE.test(name);
}

// rooms: Map<string, { messages: Message[], waiters: Set<Waiter> }>
const rooms = new Map();

function roomFile(name) {
  return path.join(ROOMS_DIR, `${name}.jsonl`);
}

function loadRoom(name) {
  const file = roomFile(name);
  const messages = [];
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch (e) {
        // skip malformed lines
      }
    }
  }
  return messages;
}

function ensureRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    r = { messages: loadRoom(name), waiters: new Set() };
    rooms.set(name, r);
  }
  return r;
}

function nextId(r) {
  return r.messages.length > 0 ? r.messages[r.messages.length - 1].id + 1 : 1;
}

function appendMessage(room, from, body) {
  const r = ensureRoom(room);
  const msg = {
    id: nextId(r),
    ts: new Date().toISOString(),
    from,
    body,
  };
  r.messages.push(msg);
  fs.appendFileSync(roomFile(room), JSON.stringify(msg) + '\n');
  // notify matching waiters
  for (const w of [...r.waiters]) {
    if (msg.id > w.since && msg.from !== w.exclude) {
      r.waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve([msg]);
    }
  }
  return msg;
}

function fetchSince(room, since, exclude) {
  const r = ensureRoom(room);
  return r.messages.filter(m => m.id > since && (!exclude || m.from !== exclude));
}

// Long-poll for messages newer than `since` (excluding `exclude`'s own posts).
// Returns { promise, cancel }: `promise` resolves with the matching messages,
// or with [] once `blockSec` elapses. `cancel` unregisters the waiter (used on
// client disconnect); it does not settle the promise.
function waitFor(room, since, exclude, blockSec) {
  const existing = fetchSince(room, since, exclude);
  if (existing.length > 0) {
    return { promise: Promise.resolve(existing), cancel: () => {} };
  }
  const r = ensureRoom(room);
  const waiter = { since, exclude, resolve: null };
  const promise = new Promise((resolve) => {
    waiter.resolve = resolve;
    waiter.timer = setTimeout(() => {
      r.waiters.delete(waiter);
      resolve([]);
    }, blockSec * 1000);
    r.waiters.add(waiter);
  });
  const cancel = () => {
    if (r.waiters.has(waiter)) {
      r.waiters.delete(waiter);
      clearTimeout(waiter.timer);
    }
  };
  return { promise, cancel };
}

function listRooms() {
  if (!fs.existsSync(ROOMS_DIR)) return [];
  return fs.readdirSync(ROOMS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.slice(0, -'.jsonl'.length));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendText(res, 200, 'ok\n');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/rooms') {
    sendJson(res, 200, listRooms());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/shutdown') {
    sendText(res, 200, 'bye\n');
    setTimeout(() => process.exit(0), 50);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      sendText(res, 400, 'invalid json\n');
      return;
    }
    const { room, from, body: msgBody } = body;
    if (!validRoom(room)) { sendText(res, 400, 'invalid room\n'); return; }
    if (typeof from !== 'string' || !from) { sendText(res, 400, 'missing from\n'); return; }
    if (typeof msgBody !== 'string') { sendText(res, 400, 'body must be string\n'); return; }
    const msg = appendMessage(room, from, msgBody);
    sendJson(res, 200, msg);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/messages') {
    const room = url.searchParams.get('room');
    if (!validRoom(room)) { sendText(res, 400, 'invalid room\n'); return; }
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const exclude = url.searchParams.get('exclude') || '';
    const block = parseInt(url.searchParams.get('block') || '0', 10);
    const limit = parseInt(url.searchParams.get('limit') || '0', 10);

    let messages;
    if (block > 0) {
      const safeBlock = Math.min(Math.max(block, 1), 3600);
      const pending = waitFor(room, since, exclude, safeBlock);
      req.on('close', pending.cancel); // drop the waiter if the client goes away
      messages = await pending.promise;
    } else if (limit > 0) {
      const r = ensureRoom(room);
      messages = r.messages.slice(-limit);
    } else {
      messages = fetchSince(room, since, exclude);
    }

    if (messages.length === 0 && block > 0) {
      res.writeHead(204);
      res.end();
      return;
    }
    sendJson(res, 200, messages);
    return;
  }

  sendText(res, 404, 'not found\n');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    // swallow errors from client disconnect during long-poll
    if (!res.headersSent) {
      sendText(res, 500, `server error: ${err.message}\n`);
    }
  });
});

// long-poll friendliness: no timeout on inbound requests
server.requestTimeout = 0;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, HOST, () => {
  const pidFile = path.join(DATA_DIR, 'server.pid');
  fs.writeFileSync(pidFile, String(process.pid));
  console.log(`chat-relay listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} already in use`);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
