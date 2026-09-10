const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');

const app = express();
const httpServer = createServer(app);
// pingTimeout plus tolerant : sur un reseau mobile (4G/5G), de courtes
// coupures/handoffs sont normales. Avec la valeur par defaut (20s), Socket.IO
// declare la connexion morte trop vite, ce qui declenche une reconnexion
// (et donc une reinitialisation caméra/partage d'ecran cote client) pour de
// simples micro-coupures qui se seraient resorbees d'elles-memes.
const io = new Server(httpServer, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> { users: Map<socketId, name> }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { users: new Map() });
  }
  return rooms.get(roomId);
}

function roomUserList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.users.entries()).map(([id, name]) => ({ id, name }));
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || typeof roomId !== 'string') return;
    currentRoom = roomId;
    socket.join(roomId);
    const room = getRoom(roomId);

    // Cap at 2 participants (mesh WebRTC keeps this simple/reliable).
    if (room.users.size >= 2 && !room.users.has(socket.id)) {
      socket.emit('room-full');
      return;
    }

    room.users.set(socket.id, name || 'Invite');
    socket.data.name = name || 'Invite';

    const others = roomUserList(roomId).filter((u) => u.id !== socket.id);
    socket.emit('joined', { self: { id: socket.id, name: socket.data.name }, peers: others });
    socket.to(roomId).emit('peer-joined', { id: socket.id, name: socket.data.name });
    io.to(roomId).emit('room-users', roomUserList(roomId));
  });

  socket.on('chat-message', ({ text }) => {
    if (!currentRoom || !text) return;
    const payload = {
      from: socket.data.name || 'Invite',
      fromId: socket.id,
      text: String(text).slice(0, 2000),
      ts: Date.now(),
    };
    io.to(currentRoom).emit('chat-message', payload);
  });

  // --- Platform / tab selection, shared so both users see the same view ---
  socket.on('platform-select', ({ platform }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('platform-select', { platform });
  });

  // --- YouTube sync (real playback control via YouTube IFrame API) ---
  socket.on('yt-load', ({ videoId }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('yt-load', { videoId });
  });

  socket.on('yt-state', ({ state, time }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('yt-state', { state, time, ts: Date.now() });
  });

  socket.on('yt-seek', ({ time }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('yt-seek', { time, ts: Date.now() });
  });

  // --- Manual synced start / pause ping for Netflix / Prime Video ---
  socket.on('manual-countdown', ({ seconds }) => {
    if (!currentRoom) return;
    const startAt = Date.now() + seconds * 1000;
    io.to(currentRoom).emit('manual-countdown', { startAt });
  });

  socket.on('manual-pause-ping', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('manual-pause-ping', { from: socket.data.name || 'Invite' });
  });

  socket.on('manual-forward-ping', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('manual-forward-ping', { from: socket.data.name || 'Invite' });
  });

  // --- WebRTC signaling relay (camera et partage d'ecran) ---
  socket.on('webrtc-signal', ({ to, signal }) => {
    if (!to) return;
    io.to(to).emit('webrtc-signal', { from: socket.id, signal });
  });

  socket.on('screen-share-stopped', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('screen-share-stopped');
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.users.delete(socket.id);
      io.to(currentRoom).emit('peer-left', { id: socket.id });
      io.to(currentRoom).emit('room-users', roomUserList(currentRoom));
      if (room.users.size === 0) rooms.delete(currentRoom);
    }
  });
});

// =====================================================================
// Relais WebSocket "brut" pour l'extension navigateur (Netflix / Prime
// Video). L'extension s'injecte directement dans la page et pilote la
// balise <video> native : ce canal ne fait que relayer play/pause/temps,
// chat et signalisation WebRTC entre les 2 personnes d'un meme salon.
// Protocole JSON simple (independant de Socket.IO) car un content script
// / service worker d'extension n'a pas besoin du client socket.io.
// =====================================================================
const extWss = new WebSocketServer({ server: httpServer, path: '/ext-ws' });

// roomId -> Map<clientId, { ws, name }>
const extRooms = new Map();

function getExtRoom(roomId) {
  if (!extRooms.has(roomId)) extRooms.set(roomId, new Map());
  return extRooms.get(roomId);
}

function extRoomUserList(roomId) {
  const room = extRooms.get(roomId);
  if (!room) return [];
  return Array.from(room.entries()).map(([id, c]) => ({ id, name: c.name }));
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastExtRoom(roomId, obj, exceptId) {
  const room = extRooms.get(roomId);
  if (!room) return;
  room.forEach((client, id) => {
    if (id !== exceptId) sendJson(client.ws, obj);
  });
}

extWss.on('connection', (ws) => {
  const clientId = crypto.randomUUID();
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'join') {
      const roomId = String(msg.roomId || '');
      if (!roomId) return;
      currentRoom = roomId;
      const room = getExtRoom(roomId);

      // Meme limite que le site : 2 personnes par salon (WebRTC en mesh).
      if (room.size >= 2) {
        sendJson(ws, { type: 'room-full' });
        return;
      }

      const name = String(msg.name || 'Invite').slice(0, 30);
      room.set(clientId, { ws, name });

      const others = extRoomUserList(roomId).filter((u) => u.id !== clientId);
      sendJson(ws, { type: 'joined', self: { id: clientId, name }, peers: others });
      broadcastExtRoom(roomId, { type: 'peer-joined', id: clientId, name }, clientId);
      broadcastExtRoom(roomId, { type: 'room-users', users: extRoomUserList(roomId) });
    } else if (msg.type === 'chat') {
      if (!currentRoom) return;
      const room = extRooms.get(currentRoom);
      const name = room && room.get(clientId) ? room.get(clientId).name : 'Invite';
      const payload = {
        type: 'chat',
        from: name,
        fromId: clientId,
        text: String(msg.text || '').slice(0, 2000),
        ts: Date.now(),
      };
      broadcastExtRoom(currentRoom, payload); // envoye a tout le monde, y compris a soi-meme
    } else if (msg.type === 'video-state') {
      if (!currentRoom) return;
      broadcastExtRoom(currentRoom, {
        type: 'video-state',
        state: msg.state,
        time: msg.time,
        ts: Date.now(),
      }, clientId);
    } else if (msg.type === 'signal') {
      if (!msg.to || !currentRoom) return;
      const room = extRooms.get(currentRoom);
      const target = room && room.get(msg.to);
      if (target) sendJson(target.ws, { type: 'signal', from: clientId, signal: msg.signal });
    }
  });

  ws.on('close', () => {
    if (!currentRoom) return;
    const room = extRooms.get(currentRoom);
    if (room) {
      room.delete(clientId);
      broadcastExtRoom(currentRoom, { type: 'peer-left', id: clientId });
      broadcastExtRoom(currentRoom, { type: 'room-users', users: extRoomUserList(currentRoom) });
      if (room.size === 0) extRooms.delete(currentRoom);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Watch Together server running on http://localhost:${PORT}`);
});
