const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

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

  // --- WebRTC signaling relay (camera) ---
  socket.on('webrtc-signal', ({ to, signal }) => {
    if (!to) return;
    io.to(to).emit('webrtc-signal', { from: socket.id, signal });
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

httpServer.listen(PORT, () => {
  console.log(`Watch Together server running on http://localhost:${PORT}`);
});
