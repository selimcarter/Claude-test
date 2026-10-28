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
// declare la connexion morte trop vite pour de simples micro-coupures qui se
// seraient resorbees d'elles-memes.
// Pas de connectionStateRecovery : le delai de grace ci-dessous le remplace,
// et sa relecture d'evenements manques rejouait d'anciens signaux WebRTC.
const io = new Server(httpServer, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3000;

// Temps laisse a un participant dont la connexion a coupe pour revenir dans
// le meme salon, avec la meme identite, sans que l'autre le voie partir.
const GRACE_MS = Number(process.env.GRACE_MS) || 45000;

app.use(express.static(path.join(__dirname, 'public')));

// STUN/TURN de secours utilise tant que METERED_API_KEY/METERED_DOMAIN ne
// sont pas configures (voir README) : le TURN public OpenRelay est partage
// par des milliers de projets dans le monde, donc peu fiable en usage reel.
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

// Le client demande sa config ICE ici plutot que de l'avoir codee en dur :
// permet de brancher un compte TURN dedie (identifiants prives, jamais
// exposes dans le code source) juste via des variables d'environnement sur
// Render, sans toucher au code.
app.get('/api/ice-servers', async (req, res) => {
  const apiKey = process.env.METERED_API_KEY;
  const domain = process.env.METERED_DOMAIN;
  if (!apiKey || !domain) {
    return res.json(FALLBACK_ICE_SERVERS);
  }
  try {
    const response = await fetch(`https://${domain}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`);
    if (!response.ok) throw new Error(`Metered a repondu ${response.status}`);
    const iceServers = await response.json();
    res.json(iceServers);
  } catch (err) {
    console.error('Impossible de recuperer les identifiants TURN Metered, utilisation du secours:', err.message);
    res.json(FALLBACK_ICE_SERVERS);
  }
});

// ===================== Journal des coupures =====================
// Garde en memoire les derniers evenements de connexion (cote serveur et
// remontes par les navigateurs) pour connaitre la cause exacte d'une coupure.
// shortcut: en memoire seulement (efface a chaque redemarrage/mise en veille
// Render), aussi ecrit dans les Logs Render ; passer a un stockage durable si
// on doit garder l'historique plus longtemps.
const diagLog = [];
const DIAG_MAX = 1000;

function logDiag(entry) {
  const e = { at: new Date().toISOString(), ...entry };
  diagLog.push(e);
  if (diagLog.length > DIAG_MAX) diagLog.shift();
  console.log('[diag]', JSON.stringify(e));
}

function formatDiagLine(e) {
  const when = new Date(e.at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
  const fields = [when, e.source, e.room || '-', e.name || '-', e.event, e.reason || e.details || '', e.ua || ''];
  return fields.join(' | ');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest();
}

// Page protegee par mot de passe (variable ADMIN_TOKEN sur Render) : le
// navigateur affiche sa fenetre de connexion, n'importe quel identifiant.
app.get('/admin/logs', (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(404).send('Journal desactive : definissez la variable ADMIN_TOKEN sur Render.');
  const encoded = (req.headers.authorization || '').split(' ')[1] || '';
  const password = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
  if (!crypto.timingSafeEqual(sha256(password), sha256(token))) {
    res.set('WWW-Authenticate', 'Basic realm="journal"');
    return res.status(401).send('Mot de passe requis.');
  }
  const lines = diagLog.slice().reverse().map(formatDiagLine);
  res.type('text/plain; charset=utf-8').send(lines.join('\n') || 'Aucun evenement enregistre depuis le dernier demarrage du serveur.');
});

// ===================== Salons =====================
// roomId -> { users: Map<clientId, { socketId, name, graceTimer }> }
// clientId est l'identite stable du participant (elle survit aux
// reconnexions), contrairement au socket.id qui change a chaque fois.
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
  return Array.from(room.users.entries()).map(([id, user]) => ({ id, name: user.name }));
}

function removeUser(roomId, clientId) {
  const room = rooms.get(roomId);
  if (!room || !room.users.has(clientId)) return;
  clearTimeout(room.users.get(clientId).graceTimer);
  room.users.delete(clientId);
  io.to(roomId).emit('peer-left', { id: clientId });
  io.to(roomId).emit('room-users', roomUserList(roomId));
  if (room.users.size === 0) rooms.delete(roomId);
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let clientId = null;
  const ua = String(socket.handshake.headers['user-agent'] || '').slice(0, 200);
  const diag = (event, extra = {}) => logDiag({ source: 'serveur', room: currentRoom, name: socket.data.name, ua, event, ...extra });

  // Un handler qui plante (ex: un client qui envoie un message vide/null) ne
  // doit jamais faire tomber tout le serveur, donc tous les salons.
  const on = (event, handler) => socket.on(event, (payload) => {
    try {
      handler(payload || {});
    } catch (err) {
      console.error(`Erreur sur l'evenement "${event}":`, err);
    }
  });

  function leaveCurrentRoom() {
    if (!currentRoom) return;
    socket.leave(currentRoom);
    removeUser(currentRoom, clientId);
    currentRoom = null;
  }

  on('join-room', ({ roomId, name, clientId: requestedId, fresh }) => {
    if (!roomId || typeof roomId !== 'string') return;
    roomId = roomId.trim().toUpperCase().slice(0, 20);
    const id = typeof requestedId === 'string' && /^[\w-]{8,64}$/.test(requestedId) ? requestedId : socket.id;

    // Changement de salon (ou d'identite) sans deconnexion : on libere
    // proprement l'ancienne place plutot que de laisser une entree fantome.
    if (currentRoom && (currentRoom !== roomId || clientId !== id)) leaveCurrentRoom();

    const room = getRoom(roomId);
    const existing = room.users.get(id);

    // Cap a 2 participants (mesh WebRTC). Une place en delai de grace reste
    // reservee a son proprietaire. Refuse AVANT socket.join : sinon la
    // personne refusee recevrait quand meme le chat et les evenements du salon.
    if (!existing && room.users.size >= 2) {
      socket.emit('room-full');
      diag('salon-complet');
      return;
    }

    const safeName = String(name || 'Invite').slice(0, 30);
    if (existing) {
      clearTimeout(existing.graceTimer);
      existing.graceTimer = null;
      const oldSocketId = existing.socketId;
      existing.socketId = socket.id; // avant de couper l'ancien, pour que son 'disconnect' soit ignore
      existing.name = safeName;
      if (oldSocketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) oldSocket.disconnect(true);
      }
    } else {
      room.users.set(id, { socketId: socket.id, name: safeName, graceTimer: null });
    }

    currentRoom = roomId;
    clientId = id;
    socket.data.name = safeName;
    socket.join(roomId);

    const others = roomUserList(roomId).filter((u) => u.id !== id);
    // Retour dans le delai de grace : chacun garde sa connexion video en
    // place. Sinon (rechargement de page "fresh", ou serveur redemarre qui a
    // oublie le salon), les DEUX cotes repartent de zero (reset).
    const reset = !existing || Boolean(fresh);
    socket.emit('joined', { self: { id, name: safeName }, peers: others, reset });
    if (!reset) {
      socket.to(roomId).emit('peer-reconnected', { id });
    } else {
      socket.to(roomId).emit('peer-joined', { id, name: safeName });
    }
    io.to(roomId).emit('room-users', roomUserList(roomId));
    diag(existing ? 'retour-dans-le-salon' : 'entree-dans-le-salon', { details: fresh ? 'nouvelle page' : '' });
  });

  // Fermeture volontaire de la page : depart immediat, pas de delai de grace.
  on('leave-room', () => {
    diag('depart-volontaire');
    leaveCurrentRoom();
  });

  on('diag-log', ({ entries }) => {
    if (!Array.isArray(entries)) return;
    entries.slice(0, 50).forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      logDiag({
        source: 'navigateur',
        room: currentRoom,
        name: socket.data.name,
        ua,
        event: String(entry.event || '?').slice(0, 40),
        details: JSON.stringify(entry).slice(0, 500),
      });
    });
  });

  on('chat-message', ({ text }) => {
    if (!currentRoom || !text) return;
    const payload = {
      from: socket.data.name || 'Invite',
      fromId: clientId,
      text: String(text).slice(0, 2000),
      ts: Date.now(),
    };
    io.to(currentRoom).emit('chat-message', payload);
  });

  // --- Platform / tab selection, shared so both users see the same view ---
  on('platform-select', ({ platform }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('platform-select', { platform });
  });

  // --- YouTube sync (real playback control via YouTube IFrame API) ---
  on('yt-load', ({ videoId }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('yt-load', { videoId });
  });

  on('yt-state', ({ state, time }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('yt-state', { state, time, ts: Date.now() });
  });

  on('yt-seek', ({ time }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('yt-seek', { time, ts: Date.now() });
  });

  // --- Demandes pause/avance (depuis la vue partage d'ecran) ---
  on('manual-pause-ping', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('manual-pause-ping', { from: socket.data.name || 'Invite' });
  });

  on('manual-forward-ping', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('manual-forward-ping', { from: socket.data.name || 'Invite' });
  });

  // --- WebRTC signaling relay (camera et partage d'ecran) ---
  on('webrtc-signal', ({ to, signal }) => {
    // Le destinataire doit etre un membre actuel du MEME salon que
    // l'expediteur : sans cette verification, n'importe quel client connecte
    // pourrait injecter des offres/candidats SDP vers n'importe quel autre
    // socket du serveur, y compris dans un salon different du sien.
    if (!to || !currentRoom) return;
    const room = rooms.get(currentRoom);
    const target = room && room.users.get(to);
    if (!target) return;
    io.to(target.socketId).emit('webrtc-signal', { from: clientId, signal });
  });

  on('screen-share-stopped', () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('screen-share-stopped');
  });

  on('screen-share-platform', ({ platform }) => {
    if (!currentRoom || !platform) return;
    socket.to(currentRoom).emit('screen-share-platform', { platform });
  });

  socket.on('disconnect', (reason) => {
    if (!currentRoom) return;
    diag('coupure', { reason });
    const roomId = currentRoom;
    const id = clientId;
    const room = rooms.get(roomId);
    const user = room && room.users.get(id);
    // Deja remplace par une reconnexion plus recente du meme participant.
    if (!user || user.socketId !== socket.id) return;

    socket.to(roomId).emit('peer-reconnecting', { id });
    user.graceTimer = setTimeout(() => {
      logDiag({ source: 'serveur', room: roomId, name: user.name, ua, event: 'delai-de-grace-expire' });
      removeUser(roomId, id);
    }, GRACE_MS);
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
// noServer + aiguillage manuel : avec { server, path }, la librairie ws
// rejetait (erreur 400) toute connexion WebSocket hors de /ext-ws, y compris
// celles de Socket.IO - le site restait donc bloque en "long-polling" HTTP,
// bien plus fragile (surtout sur mobile) qu'une vraie connexion WebSocket.
const extWss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ext-ws') return; // laisse Socket.IO gerer
  extWss.handleUpgrade(req, socket, head, (ws) => extWss.emit('connection', ws, req));
});

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

  // Sans ecouteur 'error', une erreur de socket ferait planter tout le serveur.
  ws.on('error', (err) => console.error('Erreur WebSocket extension:', err.message));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      const roomId = String(msg.roomId || '').trim().toUpperCase();
      if (!roomId) return;

      // Meme nettoyage que cote Socket.IO : eviter qu'un changement de salon
      // sans deconnexion ne laisse une entree fantome dans l'ancien.
      if (currentRoom && currentRoom !== roomId) {
        const previousRoom = extRooms.get(currentRoom);
        if (previousRoom) {
          previousRoom.delete(clientId);
          broadcastExtRoom(currentRoom, { type: 'peer-left', id: clientId });
          broadcastExtRoom(currentRoom, { type: 'room-users', users: extRoomUserList(currentRoom) });
          if (previousRoom.size === 0) extRooms.delete(currentRoom);
        }
        currentRoom = null;
      }

      const room = getExtRoom(roomId);

      // Meme limite que le site : 2 personnes par salon (WebRTC en mesh).
      // Verifie avant d'entrer, pour qu'une personne refusee ne puisse pas
      // envoyer de messages au salon.
      if (room.size >= 2 && !room.has(clientId)) {
        sendJson(ws, { type: 'room-full' });
        return;
      }

      currentRoom = roomId;
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
