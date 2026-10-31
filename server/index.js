import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomInt } from 'node:crypto';

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(',') ?? 'http://localhost:5173' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'get-together' }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.CLIENT_ORIGIN?.split(',') ?? 'http://localhost:5173', methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 20000
});

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ROOM_SIZE = 20;

function makeCode() {
  for (let tries = 0; tries < 100; tries++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[randomInt(CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate room code');
}
function safeRoom(room) {
  return {
    code: room.code, hostId: room.hostId, controlMode: room.controlMode,
    state: room.state, queue: room.queue,
    participants: [...room.participants.values()].map(({ id, name, role, connectedAt }) => ({ id, name, role, connectedAt }))
  };
}
function emitRoom(room) { io.to(room.code).emit('room:updated', safeRoom(room)); }
function canControl(room, socket) {
  if (room.controlMode === 'collaborative') return room.participants.has(socket.id);
  return room.hostId === socket.id;
}
function getRoomFor(socket, code) {
  const normalized = String(code || '').trim().toUpperCase();
  const room = rooms.get(normalized);
  if (!room || !room.participants.has(socket.id)) return null;
  return room;
}
function currentPosition(state, now = Date.now()) {
  if (!state.playing || !state.startedAt) return state.position || 0;
  return Math.max(0, (state.position || 0) + (now - state.startedAt) / 1000);
}
function publishState(room, patch, socket) {
  const now = Date.now();
  const prior = room.state;
  const action = patch.action;
  let position = currentPosition(prior, now);
  if (action === 'SEEK') position = Math.max(0, Number(patch.position) || 0);
  if (action === 'QUEUE_CHANGE') {
    room.state = { ...prior, media: patch.media ?? null, position: 0, playing: false, startedAt: null, updatedAt: now, action };
  } else {
    const playing = action === 'PLAY' ? true : action === 'PAUSE' ? false :
      action === 'BUFFERING' ? false : prior.playing;
    const startAt = action === 'PLAY' ? now + 350 : null;
    room.state = {
      ...prior, position, playing,
      startedAt: playing ? (startAt ?? now) : null,
      updatedAt: now, action, startAt,
      ...(action === 'SEEK' ? { position } : {})
    };
  }
  io.to(room.code).emit('playback:event', {
    action, state: room.state, serverNow: now, startAt: room.state.startAt,
    actor: room.participants.get(socket.id)?.name ?? 'Participant'
  });
  emitRoom(room);
}

io.on('connection', socket => {
  socket.on('clock:ping', ({ clientSentAt } = {}, ack) => {
    if (typeof ack === 'function') ack({ clientSentAt, serverNow: Date.now() });
  });

  socket.on('room:create', ({ name, controlMode } = {}, ack) => {
    const displayName = String(name || 'Guest').trim().slice(0, 32) || 'Guest';
    const code = makeCode();
    const room = {
      code, hostId: socket.id,
      controlMode: controlMode === 'collaborative' ? 'collaborative' : 'host',
      participants: new Map(),
      queue: [],
      state: { media: null, position: 0, playing: false, startedAt: null, updatedAt: Date.now(), action: 'INIT' }
    };
    room.participants.set(socket.id, { id: socket.id, name: displayName, role: 'host', connectedAt: Date.now() });
    rooms.set(code, room);
    socket.join(code);
    ack?.({ ok: true, room: safeRoom(room) });
    emitRoom(room);
  });

  socket.on('room:join', ({ code, name } = {}, ack) => {
    const normalized = String(code || '').trim().toUpperCase();
    const room = rooms.get(normalized);
    if (!room) return ack?.({ ok: false, error: 'Room code not found.' });
    if (room.participants.size >= MAX_ROOM_SIZE) return ack?.({ ok: false, error: 'Room is full.' });
    const displayName = String(name || 'Guest').trim().slice(0, 32) || 'Guest';
    room.participants.set(socket.id, { id: socket.id, name: displayName, role: 'participant', connectedAt: Date.now() });
    socket.join(normalized);
    ack?.({ ok: true, room: safeRoom(room) });
    emitRoom(room);
  });

  socket.on('room:leave', ({ code } = {}) => {
    const room = getRoomFor(socket, code);
    if (!room) return;
    socket.leave(room.code);
    room.participants.delete(socket.id);
    if (room.hostId === socket.id) {
      const next = room.participants.keys().next().value;
      if (next) {
        room.hostId = next;
        const p = room.participants.get(next); if (p) p.role = 'host';
      }
    }
    if (room.participants.size === 0) rooms.delete(room.code);
    else emitRoom(room);
  });

  socket.on('room:control-mode', ({ code, controlMode } = {}, ack) => {
    const room = getRoomFor(socket, code);
    if (!room) return ack?.({ ok: false, error: 'Join a room first.' });
    if (room.hostId !== socket.id) return ack?.({ ok: false, error: 'Only the host can change permissions.' });
    room.controlMode = controlMode === 'collaborative' ? 'collaborative' : 'host';
    emitRoom(room); ack?.({ ok: true });
  });

  socket.on('playback:command', (payload = {}, ack) => {
    const room = getRoomFor(socket, payload.code);
    if (!room) return ack?.({ ok: false, error: 'Join a room first.' });
    if (!canControl(room, socket)) return ack?.({ ok: false, error: 'Only the host can control playback in this room.' });
    const allowed = new Set(['PLAY', 'PAUSE', 'SEEK', 'QUEUE_CHANGE', 'BUFFERING']);
    if (!allowed.has(payload.action)) return ack?.({ ok: false, error: 'Unsupported playback action.' });
    if (payload.action === 'QUEUE_CHANGE') {
      const media = payload.media;
      if (media && !['youtube', 'local'].includes(media.type)) return ack?.({ ok: false, error: 'Unsupported media type.' });
      room.queue = Array.isArray(payload.queue) ? payload.queue.slice(0, 100) : room.queue;
      publishState(room, payload, socket);
    } else publishState(room, payload, socket);
    ack?.({ ok: true });
  });

  socket.on('queue:add', ({ code, item } = {}, ack) => {
    const room = getRoomFor(socket, code);
    if (!room) return ack?.({ ok: false, error: 'Join a room first.' });
    if (!canControl(room, socket)) return ack?.({ ok: false, error: 'You do not have control permission.' });
    if (!item || !['youtube', 'local'].includes(item.type) || !String(item.title || '').trim())
      return ack?.({ ok: false, error: 'Invalid queue item.' });
    room.queue.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, type: item.type, title: String(item.title).slice(0, 120), url: String(item.url || '').slice(0, 2048) });
    emitRoom(room); ack?.({ ok: true, queue: room.queue });
  });

  socket.on('chat:send', ({ code, text } = {}, ack) => {
    const room = getRoomFor(socket, code);
    const message = String(text || '').trim().slice(0, 500);
    if (!room || !message) return ack?.({ ok: false, error: 'Invalid message.' });
    io.to(room.code).emit('chat:message', { id: `${Date.now()}-${socket.id}`, name: room.participants.get(socket.id)?.name || 'Guest', text: message, at: Date.now() });
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      if (!room.participants.has(socket.id)) continue;
      room.participants.delete(socket.id);
      if (room.hostId === socket.id) {
        const next = room.participants.keys().next().value;
        room.hostId = next || null;
        if (next) room.participants.get(next).role = 'host';
      }
      if (!room.participants.size) rooms.delete(room.code);
      else emitRoom(room);
    }
  });
});

const port = Number(process.env.PORT || 4000);
httpServer.listen(port, () => console.log(`Get Together server listening on http://localhost:${port}`));
