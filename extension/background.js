// Service worker : garde la connexion WebSocket vers le serveur Watch
// Together et relaie les evenements vers l'onglet Netflix/Prime Video actif
// (content.js) et vers le popup. On centralise la connexion ici plutot que
// dans le content script car les pages Netflix/Amazon appliquent parfois une
// CSP restrictive qui bloquerait un WebSocket ouvert depuis leur propre page.

let ws = null;
let activeTabId = null;
const session = { connected: false, serverUrl: '', roomId: '', name: '', myId: null, peers: [], iceServers: null };

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage({ scope: 'popup', ...msg }).catch(() => {});
}

function sendToContentScript(msg) {
  if (activeTabId == null) return;
  chrome.tabs.sendMessage(activeTabId, { scope: 'bg', ...msg }).catch(() => {});
}

function statusPayload() {
  return {
    type: 'status',
    connected: session.connected,
    roomId: session.roomId,
    name: session.name,
    myId: session.myId,
    peers: session.peers,
  };
}

function wsUrlFromServerUrl(serverUrl) {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ext-ws';
  u.search = '';
  return u.toString();
}

// Reconnexion automatique (comme le site) si la connexion coupe sans que
// l'utilisateur ait clique "deconnecter", et heartbeat toutes les 20 s : un
// WebSocket silencieux peut etre coupe par le reseau, et sans activite Chrome
// endort le service worker de l'extension.
let reconnectTimer = null;
let heartbeatTimer = null;

async function connect({ serverUrl, roomId, name }) {
  disconnect();
  session.serverUrl = serverUrl;
  session.roomId = roomId;
  session.name = name;

  try {
    ws = new WebSocket(wsUrlFromServerUrl(serverUrl));
  } catch (e) {
    broadcastToPopup({ type: 'error', message: 'URL de serveur invalide.' });
    return;
  }

  const socket = ws;
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'join', roomId, name }));
    heartbeatTimer = setInterval(() => socket.send(JSON.stringify({ type: 'ping' })), 20000);
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }

    if (msg.type === 'joined') {
      // Config TURN fournie par le serveur a l'entree dans le salon.
      session.iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : null;
      session.connected = true;
      session.myId = msg.self.id;
      session.peers = msg.peers;
      broadcastToPopup(statusPayload());
      sendToContentScript({ type: 'status', connected: true, myId: session.myId, peers: msg.peers, iceServers: session.iceServers });
    } else if (msg.type === 'room-full') {
      session.connected = false;
      broadcastToPopup({ type: 'error', message: 'Ce salon est deja complet (2 personnes max).' });
    } else if (msg.type === 'peer-joined') {
      session.peers.push({ id: msg.id, name: msg.name });
      broadcastToPopup(statusPayload());
      sendToContentScript({ type: 'peer-joined', id: msg.id, name: msg.name });
    } else if (msg.type === 'peer-left') {
      session.peers = session.peers.filter((p) => p.id !== msg.id);
      broadcastToPopup(statusPayload());
      sendToContentScript({ type: 'peer-left', id: msg.id });
    } else if (msg.type === 'room-users') {
      session.peers = msg.users.filter((u) => u.id !== session.myId);
      broadcastToPopup(statusPayload());
    } else if (msg.type === 'chat') {
      broadcastToPopup({ type: 'chat', from: msg.from, fromId: msg.fromId, text: msg.text, ts: msg.ts, myId: session.myId });
      sendToContentScript({ type: 'chat', from: msg.from, fromId: msg.fromId, text: msg.text, ts: msg.ts, myId: session.myId });
    } else if (msg.type === 'video-state') {
      sendToContentScript({ type: 'video-state', state: msg.state, time: msg.time, ts: msg.ts });
    } else if (msg.type === 'signal') {
      sendToContentScript({ type: 'signal', from: msg.from, signal: msg.signal });
    }
  });

  socket.addEventListener('close', () => {
    clearInterval(heartbeatTimer);
    session.connected = false;
    broadcastToPopup(statusPayload());
    sendToContentScript({ type: 'status', connected: false, peers: [] });
    if (ws === socket) reconnectTimer = setTimeout(() => connect({ serverUrl, roomId, name }), 3000);
  });

  ws.addEventListener('error', () => {
    broadcastToPopup({ type: 'error', message: 'Connexion au serveur impossible.' });
  });
}

function disconnect() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  if (ws) {
    const closing = ws;
    ws = null; // avant close() : son evenement 'close' ne doit pas relancer de reconnexion
    try { closing.close(); } catch (e) { /* noop */ }
  }
  session.connected = false;
  session.myId = null;
  session.peers = [];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.scope === 'popup') {
    if (msg.type === 'connect') {
      connect({ serverUrl: msg.serverUrl, roomId: msg.roomId, name: msg.name });
    } else if (msg.type === 'disconnect') {
      disconnect();
      broadcastToPopup(statusPayload());
    } else if (msg.type === 'get-status') {
      sendResponse(statusPayload());
    }
  } else if (msg.scope === 'cs') {
    if (msg.type === 'ready' && sender.tab) {
      activeTabId = sender.tab.id;
      sendResponse(statusPayload());
    } else if (msg.type === 'local-video-state' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'video-state', state: msg.state, time: msg.time }));
    } else if (msg.type === 'local-chat' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat', text: msg.text }));
    } else if (msg.type === 'local-signal' && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'signal', to: msg.to, signal: msg.signal }));
    }
  }
  return true;
});
