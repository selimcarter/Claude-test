// ===================== Etat global =====================
const state = {
  roomId: null,
  myId: null,
  myName: null,
  peers: new Map(), // id -> name
  ytPlayer: null,
  ytReady: false,
  ytPendingVideoId: null,
  applyingRemoteYtChange: false,
  localStream: null,
  peerConnections: new Map(), // id -> RTCPeerConnection
  camOn: true,
  micOn: true,
  screenStream: null,
  screenPeerConnections: new Map(), // id -> RTCPeerConnection (partage d'ecran)
};

const socket = io();

// ===================== Utilitaires =====================
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), duration);
}

function extractYoutubeId(input) {
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1);
    if (url.searchParams.has('v')) return url.searchParams.get('v');
    const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];
  } catch (e) {
    // pas une URL valide
  }
  return null;
}

// ===================== Ecran d'accueil =====================
const landing = document.getElementById('landing');
const appScreen = document.getElementById('app');
const nameInput = document.getElementById('name-input');
const roomCodeInput = document.getElementById('room-code-input');

const params = new URLSearchParams(location.search);
if (params.get('room')) roomCodeInput.value = params.get('room');

document.getElementById('create-room-btn').addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) return showToast('Entrez votre prenom d\'abord.');
  enterRoom(genRoomCode(), name);
});

document.getElementById('join-room-btn').addEventListener('click', () => {
  const name = nameInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!name) return showToast('Entrez votre prenom d\'abord.');
  if (!code) return showToast('Entrez un code de salon.');
  enterRoom(code, name);
});

function enterRoom(roomId, name) {
  state.roomId = roomId;
  state.myName = name;
  history.replaceState(null, '', `?room=${roomId}`);
  socket.emit('join-room', { roomId, name });
}

// ===================== Reception des evenements de salon =====================
socket.on('room-full', () => {
  showToast('Ce salon est deja complet (2 personnes max).');
});

socket.on('joined', ({ self, peers }) => {
  state.myId = self.id;
  landing.classList.add('hidden');
  appScreen.classList.remove('hidden');
  document.getElementById('room-code-display').textContent = state.roomId;
  renderPresence([self, ...peers]);

  initMedia().then(() => {
    peers.forEach((p) => connectToPeer(p.id));
  });
});

socket.on('peer-joined', ({ id, name }) => {
  showToast(`${name} a rejoint le salon.`);
  connectToPeer(id);
  if (state.screenStream) connectScreenToPeer(id);
});

socket.on('peer-left', ({ id }) => {
  const pc = state.peerConnections.get(id);
  if (pc) { pc.close(); state.peerConnections.delete(id); }
  document.getElementById('remote-video').srcObject = null;
  document.getElementById('camera-widget').classList.add('no-remote');

  const screenPc = state.screenPeerConnections.get(id);
  if (screenPc) { screenPc.close(); state.screenPeerConnections.delete(id); }
  clearRemoteScreen();
});

socket.on('room-users', (users) => renderPresence(users));

function renderPresence(users) {
  const list = document.getElementById('presence-list');
  list.innerHTML = '';
  users.forEach((u) => {
    const chip = document.createElement('span');
    chip.className = 'user-chip';
    chip.innerHTML = `<span class="dot"></span>${u.id === state.myId ? u.name + ' (vous)' : u.name}`;
    list.appendChild(chip);
  });
}

// ===================== Onglets plateforme =====================
const tabButtons = document.querySelectorAll('.tab-btn');
function setPlatform(platform, { broadcast } = { broadcast: true }) {
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.platform === platform));
  document.querySelectorAll('.platform-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${platform}`);
  });
  if (broadcast) socket.emit('platform-select', { platform });
}
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => setPlatform(btn.dataset.platform));
});
socket.on('platform-select', ({ platform }) => setPlatform(platform, { broadcast: false }));

// ===================== Chat =====================
const chatMessages = document.getElementById('chat-messages');
document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  input.value = '';
});

socket.on('chat-message', ({ from, fromId, text, ts }) => {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (fromId === state.myId ? ' self' : '');
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `<span class="meta">${from} - ${time}</span>${escapeHtml(text)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

document.getElementById('copy-link-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(location.href).then(() => showToast('Lien copie !'));
});

// ===================== YouTube =====================
window.onYouTubeIframeAPIReady = function () {
  state.ytReady = true;
  if (state.ytPendingVideoId) {
    createYtPlayer(state.ytPendingVideoId);
    state.ytPendingVideoId = null;
  }
};

function createYtPlayer(videoId) {
  document.getElementById('yt-placeholder').classList.add('hidden');
  if (state.ytPlayer) {
    state.ytPlayer.loadVideoById(videoId);
    return;
  }
  state.ytPlayer = new YT.Player('yt-player', {
    videoId,
    playerVars: { playsinline: 1 },
    events: {
      onStateChange: onYtStateChange,
    },
  });
}

function loadYoutube(videoId, { broadcast }) {
  if (!state.ytReady) {
    state.ytPendingVideoId = videoId;
  } else {
    createYtPlayer(videoId);
  }
  if (broadcast) socket.emit('yt-load', { videoId });
}

document.getElementById('yt-load-btn').addEventListener('click', () => {
  const raw = document.getElementById('yt-url-input').value;
  const videoId = extractYoutubeId(raw);
  if (!videoId) return showToast('URL ou ID YouTube invalide.');
  loadYoutube(videoId, { broadcast: true });
});

socket.on('yt-load', ({ videoId }) => loadYoutube(videoId, { broadcast: false }));

function onYtStateChange(event) {
  if (state.applyingRemoteYtChange) return;
  if (!window.YT) return;
  if (event.data === YT.PlayerState.PLAYING) {
    socket.emit('yt-state', { state: 'play', time: state.ytPlayer.getCurrentTime() });
  } else if (event.data === YT.PlayerState.PAUSED) {
    socket.emit('yt-state', { state: 'pause', time: state.ytPlayer.getCurrentTime() });
  }
}

socket.on('yt-state', ({ state: playState, time, ts }) => {
  if (!state.ytPlayer || !state.ytPlayer.getCurrentTime) return;
  state.applyingRemoteYtChange = true;
  const latency = Math.max(0, (Date.now() - ts) / 1000);
  const targetTime = time + (playState === 'play' ? latency : 0);
  if (Math.abs(state.ytPlayer.getCurrentTime() - targetTime) > 1.5) {
    state.ytPlayer.seekTo(targetTime, true);
  }
  if (playState === 'play') state.ytPlayer.playVideo();
  else state.ytPlayer.pauseVideo();
  setTimeout(() => { state.applyingRemoteYtChange = false; }, 600);
});

// ===================== Synchro manuelle Netflix / Prime =====================
document.querySelectorAll('.countdown-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.emit('manual-countdown', { seconds: Number(btn.dataset.seconds) });
  });
});

document.querySelectorAll('.pause-ping-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.emit('manual-pause-ping');
    showToast('Signal de pause envoye.');
  });
});

socket.on('manual-countdown', ({ startAt }) => {
  const displays = [
    document.getElementById('countdown-display-netflix'),
    document.getElementById('countdown-display-prime'),
  ];
  const tick = () => {
    const remaining = Math.ceil((startAt - Date.now()) / 1000);
    const text = remaining > 0 ? String(remaining) : 'GO !';
    displays.forEach((d) => { d.textContent = text; });
    if (remaining > 0) {
      requestAnimationFrame(tick);
    } else {
      setTimeout(() => displays.forEach((d) => { d.textContent = ''; }), 1200);
    }
  };
  tick();
});

socket.on('manual-pause-ping', ({ from }) => {
  showToast(`${from} demande une pause !`, 4000);
});

// ===================== Camera / WebRTC =====================
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const cameraWidget = document.getElementById('camera-widget');
cameraWidget.classList.add('no-remote');

async function initMedia() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = state.localStream;
  } catch (err) {
    showToast('Camera/micro indisponibles ou refuses.');
  }
}

function connectToPeer(peerId) {
  if (state.peerConnections.has(peerId)) return;
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  state.peerConnections.set(peerId, pc);

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
  }

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    cameraWidget.classList.remove('no-remote');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-signal', { to: peerId, signal: { candidate: event.candidate } });
    }
  };

  if (state.myId < peerId) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc-signal', { to: peerId, signal: { sdp: pc.localDescription } });
    };
  }

  return pc;
}

socket.on('webrtc-signal', async ({ from, signal }) => {
  if (signal.kind === 'screen') {
    await handleScreenSignal(from, signal);
    return;
  }

  let pc = state.peerConnections.get(from) || connectToPeer(from);

  if (signal.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    if (signal.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-signal', { to: from, signal: { sdp: pc.localDescription } });
    }
  } else if (signal.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (e) { /* ignore */ }
  }
});

document.getElementById('toggle-cam-btn').addEventListener('click', (e) => {
  state.camOn = !state.camOn;
  if (state.localStream) state.localStream.getVideoTracks().forEach((t) => { t.enabled = state.camOn; });
  e.target.classList.toggle('off', !state.camOn);
});

document.getElementById('toggle-mic-btn').addEventListener('click', (e) => {
  state.micOn = !state.micOn;
  if (state.localStream) state.localStream.getAudioTracks().forEach((t) => { t.enabled = state.micOn; });
  e.target.classList.toggle('off', !state.micOn);
});

// ===================== Partage d'ecran (Netflix / Prime) =====================
// Une seule personne (celle qui a le compte Netflix/Prime) partage son ecran ;
// l'autre le regarde en direct, sans rien installer et sans avoir son propre
// compte. C'est un flux WebRTC separe de celui de la camera.

function setShareButtonsState(sharing) {
  document.querySelectorAll('.share-screen-btn').forEach((b) => b.classList.toggle('hidden', sharing));
  document.querySelectorAll('.stop-share-btn').forEach((b) => b.classList.toggle('hidden', !sharing));
}

async function startScreenShare() {
  if (state.screenStream) return;
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) {
    showToast("Partage d'ecran annule ou refuse.");
    return;
  }
  setShareButtonsState(true);
  state.screenStream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);

  // On partage vers tous les pairs actuellement connus dans le salon.
  state.peerConnections.forEach((_, peerId) => connectScreenToPeer(peerId));
}

function connectScreenToPeer(peerId) {
  if (!state.screenStream || state.screenPeerConnections.has(peerId)) return;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  state.screenPeerConnections.set(peerId, pc);

  state.screenStream.getTracks().forEach((track) => pc.addTrack(track, state.screenStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-signal', { to: peerId, signal: { candidate: event.candidate, kind: 'screen' } });
    }
  };

  pc.onnegotiationneeded = async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { to: peerId, signal: { sdp: pc.localDescription, kind: 'screen' } });
  };

  return pc;
}

async function handleScreenSignal(from, signal) {
  let pc = state.screenPeerConnections.get(from);
  if (!pc) {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    state.screenPeerConnections.set(from, pc);
    pc.ontrack = (event) => showRemoteScreen(event.streams[0]);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-signal', { to: from, signal: { candidate: event.candidate, kind: 'screen' } });
      }
    };
  }

  if (signal.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    if (signal.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-signal', { to: from, signal: { sdp: pc.localDescription, kind: 'screen' } });
    }
  } else if (signal.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (e) { /* ignore */ }
  }
}

function showRemoteScreen(stream) {
  ['netflix', 'prime'].forEach((platform) => {
    document.getElementById(`screen-video-${platform}`).srcObject = stream;
    document.getElementById(`screen-viewer-${platform}`).classList.remove('hidden');
  });
  showToast("L'autre personne partage son ecran.");
}

function clearRemoteScreen() {
  ['netflix', 'prime'].forEach((platform) => {
    document.getElementById(`screen-video-${platform}`).srcObject = null;
    document.getElementById(`screen-viewer-${platform}`).classList.add('hidden');
  });
}

function stopScreenShare() {
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
  }
  state.screenPeerConnections.forEach((pc) => pc.close());
  state.screenPeerConnections.clear();
  setShareButtonsState(false);
  socket.emit('screen-share-stopped');
}

socket.on('screen-share-stopped', () => {
  const pc = state.screenPeerConnections;
  pc.forEach((c) => c.close());
  pc.clear();
  clearRemoteScreen();
  showToast("Le partage d'ecran s'est arrete.");
});

document.querySelectorAll('.share-screen-btn').forEach((btn) => {
  btn.addEventListener('click', startScreenShare);
});
document.querySelectorAll('.stop-share-btn').forEach((btn) => {
  btn.addEventListener('click', stopScreenShare);
});

// ===================== Bulle camera deplacable =====================
(function makeDraggable() {
  const handle = document.getElementById('camera-drag-handle');
  const widget = cameraWidget;
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const saved = JSON.parse(localStorage.getItem('cameraWidgetPos') || 'null');
  if (saved) {
    widget.style.left = saved.left + 'px';
    widget.style.top = saved.top + 'px';
    widget.style.right = 'auto';
  }

  function clampAndApply(left, top) {
    const maxLeft = window.innerWidth - widget.offsetWidth - 4;
    const maxTop = window.innerHeight - widget.offsetHeight - 4;
    left = Math.min(Math.max(4, left), Math.max(4, maxLeft));
    top = Math.min(Math.max(4, top), Math.max(4, maxTop));
    widget.style.left = left + 'px';
    widget.style.top = top + 'px';
    widget.style.right = 'auto';
    localStorage.setItem('cameraWidgetPos', JSON.stringify({ left, top }));
  }

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    const rect = widget.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    clampAndApply(e.clientX - offsetX, e.clientY - offsetY);
  });

  handle.addEventListener('pointerup', () => { dragging = false; });
  handle.addEventListener('pointercancel', () => { dragging = false; });
})();
