import http from 'node:http';
import crypto from 'node:crypto';
import { Server } from 'socket.io';
import { getCache } from '@vercel/functions';

const rooms = new Map();

function getRuntimeCache() {
  if (!process.env.VERCEL && !process.env.VERCEL_ENV) return null;
  try {
    return getCache({ namespace: 'cast-v1' });
  } catch {
    return null;
  }
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function sanitizeRoomId(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}

function sanitizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, 500)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const id = String(item.id || '').trim().slice(0, 64);
      const text = String(item.text ?? '').trim().slice(0, 2000);
      if (!id || !text) return null;
      return {
        id,
        text,
        createdAt: Number(item.createdAt) || Date.now(),
      };
    })
    .filter(Boolean);
}

function publicState(room) {
  if (!room) {
    return { roomId: '', items: [], version: 0, updatedAt: 0 };
  }
  return {
    roomId: room.roomId,
    items: room.items || [],
    version: room.version || 0,
    updatedAt: room.updatedAt || 0,
  };
}

async function loadRoom(roomId) {
  const cleanId = sanitizeRoomId(roomId);
  if (!cleanId) return null;

  const memRoom = rooms.get(cleanId) || null;
  let cacheRoom = null;

  const cache = getRuntimeCache();
  if (cache) {
    try {
      cacheRoom = await cache.get(`room:${cleanId}`);
    } catch {
      cacheRoom = null;
    }
  }

  if (memRoom && cacheRoom) {
    const best = (cacheRoom.version || 0) > (memRoom.version || 0) ? cacheRoom : memRoom;
    rooms.set(cleanId, best);
    return best;
  }

  const resolved = cacheRoom || memRoom;
  if (resolved) {
    rooms.set(cleanId, resolved);
  }
  return resolved;
}

async function saveRoom(room) {
  if (!room || !room.roomId) return;
  rooms.set(room.roomId, room);
  const cache = getRuntimeCache();
  if (cache) {
    try {
      await cache.set(`room:${room.roomId}`, room, {
        ttl: 86400,
        tags: [`room:${room.roomId}`],
        name: 'cast-room-state',
      });
    } catch {
      // Ignore runtime cache errors outside Vercel environment
    }
  }
}

function verifyOrClaimHost(room, hostSecret) {
  if (!hostSecret || typeof hostSecret !== 'string' || hostSecret.length < 8) {
    return false;
  }
  const secretHash = hashSecret(hostSecret);
  if (!room.hostTokenHash) {
    room.hostTokenHash = secretHash;
    return true;
  }
  return room.hostTokenHash === secretHash;
}

async function reconcileHostState(io, roomId, hostSecret, incoming, forceUpdate = false) {
  const cleanId = sanitizeRoomId(roomId);
  if (!cleanId) return { ok: false, error: 'invalid_room' };

  let room = await loadRoom(cleanId);
  if (!room) {
    room = {
      roomId: cleanId,
      hostTokenHash: null,
      items: [],
      version: 0,
      updatedAt: Date.now(),
    };
  }

  if (!verifyOrClaimHost(room, hostSecret)) {
    return { ok: false, error: 'unauthorized', state: publicState(room) };
  }

  if (incoming && Array.isArray(incoming.items)) {
    const incomingVersion = Number(incoming.version) || 0;
    const currentVersion = room.version || 0;

    if (
      forceUpdate ||
      incomingVersion > currentVersion ||
      (currentVersion === 0 && incoming.items.length > 0)
    ) {
      room.items = sanitizeItems(incoming.items);
      room.version = Math.max(currentVersion + 1, incomingVersion);
      room.updatedAt = Date.now();
      await saveRoom(room);
      io.to(cleanId).emit('room:state', publicState(room));
      return { ok: true, state: publicState(room) };
    }
  }

  await saveRoom(room);
  return { ok: true, state: publicState(room) };
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

let ioInstance;

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET') {
    const roomId = sanitizeRoomId(parsedUrl.searchParams.get('r') || parsedUrl.searchParams.get('roomId') || '');
    if (!roomId) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: 'cast-socket-io' }));
      return;
    }

    const room = await loadRoom(roomId);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, state: publicState(room || { roomId, items: [], version: 0, updatedAt: 0 }) }));
    return;
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body || !body.roomId) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
      return;
    }

    const result = await reconcileHostState(
      ioInstance,
      body.roomId,
      body.hostSecret,
      { items: body.items, version: body.version },
      Boolean(body.force)
    );

    res.statusCode = result.ok ? 200 : 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
    return;
  }

  res.statusCode = 405;
  res.end('Method Not Allowed');
});

// Normalize /api/socket-io prefix before Engine.IO inspects req.url
const origEmit = server.emit.bind(server);
server.emit = function (event, ...args) {
  if ((event === 'request' || event === 'upgrade') && args[0] && typeof args[0].url === 'string') {
    const req = args[0];
    if (event === 'upgrade' || req.url.includes('EIO=') || req.url.includes('/socket.io')) {
      const qIndex = req.url.indexOf('?');
      const query = qIndex !== -1 ? req.url.slice(qIndex) : '';
      req.url = '/socket.io/' + query;
    } else if (req.url.startsWith('/api/socket-io')) {
      const rest = req.url.slice('/api/socket-io'.length);
      req.url = rest.startsWith('/') ? rest : '/' + rest;
    }
  }
  return origEmit(event, ...args);
};

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingInterval: 10000,
  pingTimeout: 8000,
  transports: ['websocket', 'polling'],
});

ioInstance = io;

io.on('connection', (socket) => {
  socket.on('room:join', async (payload, ack) => {
    try {
      const roomId = sanitizeRoomId(payload?.roomId);
      if (!roomId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'invalid_room' });
        return;
      }

      socket.join(roomId);
      socket.data.roomId = roomId;

      if (payload?.hostSecret) {
        const result = await reconcileHostState(
          io,
          roomId,
          payload.hostSecret,
          payload.state,
          false
        );
        if (typeof ack === 'function') ack(result);
        socket.emit('room:state', result.state);
        return;
      }

      const room = await loadRoom(roomId);
      const state = publicState(room || { roomId, items: [], version: 0, updatedAt: 0 });
      if (typeof ack === 'function') ack({ ok: true, state });
      socket.emit('room:state', state);
    } catch (err) {
      console.error('Error in room:join:', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  socket.on('room:update', async (payload, ack) => {
    try {
      const roomId = sanitizeRoomId(payload?.roomId || socket.data.roomId);
      if (!roomId) {
        if (typeof ack === 'function') ack({ ok: false, error: 'invalid_room' });
        return;
      }

      socket.join(roomId);
      const result = await reconcileHostState(
        io,
        roomId,
        payload?.hostSecret,
        { items: payload?.items, version: payload?.version },
        true
      );
      if (typeof ack === 'function') ack(result);
    } catch (err) {
      console.error('Error in room:update:', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

  socket.on('room:ping', (_payload, ack) => {
    if (typeof ack === 'function') {
      ack({ ok: true, ts: Date.now() });
    }
  });
});

// Periodically sync active rooms from Runtime Cache across Fluid Compute instances
const syncInterval = setInterval(async () => {
  const cache = getRuntimeCache();
  if (!cache) return;

  for (const [roomId, sockets] of io.sockets.adapter.rooms.entries()) {
    if (!sockets || sockets.size === 0) continue;
    // Skip per-socket default rooms
    if (io.sockets.sockets.has(roomId)) continue;

    try {
      const cached = await cache.get(`room:${roomId}`);
      if (cached) {
        const mem = rooms.get(roomId);
        if (!mem || (cached.version || 0) > (mem.version || 0)) {
          rooms.set(roomId, cached);
          io.to(roomId).emit('room:state', publicState(cached));
        }
      }
    } catch {
      // Ignore cache poll errors
    }
  }
}, 1500);

if (typeof syncInterval.unref === 'function') {
  syncInterval.unref();
}

export default server;
