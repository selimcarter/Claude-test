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
  micOn: false, // micro coupe par defaut a la connexion
  screenStream: null,
  screenPeerConnections: new Map(), // id -> RTCPeerConnection (partage d'ecran)
  currentPlatform: 'youtube',
  activeSharePlatform: null, // plateforme verrouillee pendant un partage d'ecran actif
};

const socket = io();

// ===================== Configuration reseau WebRTC =====================
// STUN public (Google) + TURN public de secours (OpenRelay), utilise tant que
// le serveur n'a pas de compte TURN dedie configure (voir server.js et le
// README) : ce TURN public est partage par des milliers de projets dans le
// monde, donc peu fiable en usage reel (saccades, connexions qui echouent).
let ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

// Le serveur peut fournir une config TURN dediee (identifiants prives, jamais
// exposes dans le code source) : on la recupere des le chargement de la page,
// pour que les connexions creees ensuite (des qu'on rejoint un salon) en
// beneficient. Si rien n'est configure cote serveur, il renvoie simplement le
// meme secours OpenRelay, donc rien ne change.
fetch('/api/ice-servers')
  .then((r) => r.json())
  .then((servers) => {
    if (Array.isArray(servers) && servers.length > 0) {
      ICE_SERVERS = servers;
      debugLog('Configuration ICE recuperee du serveur :', servers.length, 'entree(s)');
    }
  })
  .catch((e) => debugLog('Impossible de recuperer la config ICE, on garde le secours integre', e));

function debugLog(...args) {
  console.debug('[watch-together]', ...args);
}

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

// Notification impossible a manquer, au centre de l'ecran : utilisee pour les
// demandes de pause/avance recues par la personne qui partage son ecran.
function showRequestPopup(msg, duration = 4000) {
  const popup = document.getElementById('request-popup');
  document.getElementById('request-popup-text').textContent = msg;
  popup.classList.remove('hidden');
  clearTimeout(showRequestPopup._t);
  showRequestPopup._t = setTimeout(() => popup.classList.add('hidden'), duration);
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

// On se souvient du prenom d'une visite a l'autre (evite de le retaper a
// chaque fois qu'on rejoint un salon).
const savedName = localStorage.getItem('watchTogetherName');
if (savedName) nameInput.value = savedName;

function rememberName(name) {
  try { localStorage.setItem('watchTogetherName', name); } catch (e) { /* ignore */ }
}

document.getElementById('create-room-btn').addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) return showToast('Entrez votre prenom d\'abord.');
  rememberName(name);
  enterRoom(genRoomCode(), name);
});

document.getElementById('join-room-btn').addEventListener('click', () => {
  const name = nameInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!name) return showToast('Entrez votre prenom d\'abord.');
  if (!code) return showToast('Entrez un code de salon.');
  rememberName(name);
  enterRoom(code, name);
});

// Lien avec ?room=CODE + prenom deja memorise : on rejoint en un clic plutot
// que de faire ressaisir le prenom et re-cliquer "Rejoindre" a chaque fois.
if (params.get('room') && savedName) {
  document.getElementById('join-room-btn').textContent = `Rejoindre en tant que ${savedName}`;
}

function enterRoom(roomId, name) {
  state.roomId = roomId;
  state.myName = name;
  history.replaceState(null, '', `?room=${roomId}`);
  socket.emit('join-room', { roomId, name });
}

// ===================== Reception des evenements de salon =====================

// Le plan gratuit de Render met le serveur en veille apres inactivite : une
// page laissee ouverte longtemps peut se retrouver deconnectee du serveur
// sans que rien ne le signale a l'ecran (elle a l'air connectee mais ne l'est
// plus). Socket.IO reconnecte automatiquement le transport, mais il faut
// explicitement re-rejoindre le salon ensuite, et repartir a zero pour les
// connexions WebRTC : apres une reconnexion, tout le monde a un nouveau
// socket.id, donc les anciennes connexions pair-a-pair pointent vers des ID
// qui n'existent plus.
let hasJoinedOnce = false;

// Sur un reseau instable, la connexion peut se couper/revenir plusieurs fois
// de suite en quelques secondes ("flapping"). Reagir a CHAQUE reconnexion en
// reconstruisant tout (WebRTC, video) rend ce flapping tres visible et
// perturbateur. On attend plutot que la connexion soit stable un court
// instant avant d'agir ; un nouveau decrochage pendant l'attente annule
// l'action prevue.
let reconnectDebounceTimer = null;

socket.on('connect', () => {
  if (!hasJoinedOnce || !state.roomId) return;
  clearTimeout(reconnectDebounceTimer);
  reconnectDebounceTimer = setTimeout(() => {
    debugLog('Connexion stabilisee : on rejoint a nouveau le salon.');
    showToast('Connexion retablie, on se reconnecte au salon...', 3000);

    state.peerConnections.forEach((pc) => pc.close());
    state.peerConnections.clear();
    state.screenPeerConnections.forEach((pc) => pc.close());
    state.screenPeerConnections.clear();
    clearVideoElement(remoteVideo);
    cameraWidget.classList.add('no-remote');

    // Si on est soi-meme en train de partager son ecran, ce flux local reste
    // actif malgre la coupure reseau (il n'a pas ete arrete) : on ne l'efface
    // donc pas ici, on le rebranchera vers les pairs juste apres avoir rejoint
    // le salon (voir socket.on('joined', ...)) plutot que de laisser l'autre
    // personne avec un ecran fige sans aucun signal d'arret explicite.
    if (!state.screenStream) clearScreenViewer();

    socket.emit('join-room', { roomId: state.roomId, name: state.myName });
  }, 1500);
});

socket.on('disconnect', () => {
  if (!hasJoinedOnce) return;
  clearTimeout(reconnectDebounceTimer);
  showToast('Connexion au serveur perdue, reconnexion en cours...', 5000);
});

socket.on('room-full', () => {
  showToast('Ce salon est deja complet (2 personnes max).');
});

socket.on('joined', ({ self, peers }) => {
  hasJoinedOnce = true;
  state.myId = self.id;
  landing.classList.add('hidden');
  appScreen.classList.remove('hidden');
  document.getElementById('room-code-display').textContent = state.roomId;
  renderPresence([self, ...peers]);

  initMedia().then(() => {
    peers.forEach((p) => connectToPeer(p.id));
  });

  // Reconnexion pendant un partage d'ecran actif : le flux local est toujours
  // vivant, mais les connexions WebRTC dediees au partage ont ete fermees (et
  // les identifiants de pairs ont change) - il faut donc les rebrancher
  // explicitement, sinon l'autre personne ne recoit plus jamais l'ecran
  // partage sans qu'aucune erreur ne soit visible.
  if (state.screenStream) {
    peers.forEach((p) => connectScreenToPeer(p.id));
    socket.emit('screen-share-platform', { platform: state.activeSharePlatform });
  }
});

socket.on('peer-joined', ({ id, name }) => {
  showToast(`${name} a rejoint le salon.`);
  connectToPeer(id);
  if (state.screenStream) {
    connectScreenToPeer(id);
    socket.emit('screen-share-platform', { platform: state.activeSharePlatform });
  }
  // La personne qui rejoint n'a pas vu les clics d'onglet precedents : on lui
  // signale sur quel onglet on se trouve actuellement, sinon elle reste sur
  // l'onglet par defaut (YouTube) jusqu'au prochain changement d'onglet.
  socket.emit('platform-select', { platform: state.currentPlatform });
});

socket.on('peer-left', ({ id }) => {
  const pc = state.peerConnections.get(id);
  if (pc) { pc.close(); state.peerConnections.delete(id); }
  clearVideoElement(document.getElementById('remote-video'));
  document.getElementById('camera-widget').classList.add('no-remote');

  const screenPc = state.screenPeerConnections.get(id);
  if (screenPc) { screenPc.close(); state.screenPeerConnections.delete(id); }
  clearScreenViewer();
});

socket.on('room-users', (users) => renderPresence(users));

function renderPresence(users) {
  const list = document.getElementById('presence-list');
  list.innerHTML = '';
  users.forEach((u) => {
    const chip = document.createElement('span');
    chip.className = 'user-chip';
    const dot = document.createElement('span');
    dot.className = 'dot';
    chip.appendChild(dot);
    // Nom d'utilisateur ajoute en texte brut (jamais via innerHTML) : c'est
    // une valeur choisie librement par l'autre personne, un nom du style
    // "<img src=x onerror=...>" ne doit jamais pouvoir s'executer ici.
    chip.appendChild(document.createTextNode(u.id === state.myId ? `${u.name} (vous)` : u.name));
    list.appendChild(chip);
  });
}

// ===================== Onglets plateforme =====================
const tabButtons = document.querySelectorAll('.tab-btn');
function setPlatform(platform, { broadcast } = { broadcast: true }) {
  state.currentPlatform = platform;
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.platform === platform));
  document.querySelectorAll('.platform-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${platform}`);
  });
  if (broadcast) socket.emit('platform-select', { platform });
}
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    // Les onglets sont synchronises entre les 2 personnes : changer d'onglet
    // pendant un partage d'ecran actif cacherait la video en cours chez tout
    // le monde (le panneau video se retrouve masque). On bloque donc le
    // changement tant qu'un partage est actif sur une autre plateforme.
    if (state.activeSharePlatform && btn.dataset.platform !== state.activeSharePlatform) {
      showToast("Impossible de changer d'onglet pendant un partage d'ecran. Arretez d'abord le partage.", 4000);
      return;
    }
    setPlatform(btn.dataset.platform);
  });
});
socket.on('platform-select', ({ platform }) => setPlatform(platform, { broadcast: false }));

// Verrouille les onglets sur la plateforme partagee (empeche de naviguer
// ailleurs et de masquer la video en cours, cote partageur comme spectateur).
function lockTabsToPlatform(platform) {
  state.activeSharePlatform = platform;
  setPlatform(platform, { broadcast: false });
  tabButtons.forEach((b) => b.classList.toggle('locked', b.dataset.platform !== platform));
}

function unlockTabs() {
  state.activeSharePlatform = null;
  tabButtons.forEach((b) => b.classList.remove('locked'));
}

socket.on('screen-share-platform', ({ platform }) => lockTabsToPlatform(platform));

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

// Repli le chat pour liberer de la place pour la video (surtout utile sur
// mobile) : les messages continuent d'arriver via la popup en coin, rien
// n'est manque en le fermant.
const mainGrid = document.querySelector('.main-grid');
const chatToggleBtn = document.getElementById('chat-toggle-btn');

function setChatCollapsed(collapsed) {
  mainGrid.classList.toggle('chat-collapsed', collapsed);
  chatToggleBtn.classList.toggle('hidden', !collapsed);
}

document.getElementById('chat-close-btn').addEventListener('click', () => setChatCollapsed(true));
chatToggleBtn.addEventListener('click', () => setChatCollapsed(false));

// Replie par defaut sur petit ecran, pour maximiser la place de la video des
// l'arrivee dans le salon.
if (window.innerWidth <= 860) setChatCollapsed(true);

socket.on('chat-message', ({ from, fromId, text, ts }) => {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (fromId === state.myId ? ' self' : '');
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // "from" est un nom choisi par l'autre personne : il doit etre echappe au
  // meme titre que le texte du message (voir escapeHtml plus bas), sinon un
  // prenom contenant du HTML/JS s'executerait ici (XSS stocke).
  div.innerHTML = `<span class="meta">${escapeHtml(from)} - ${time}</span>${escapeHtml(text)}`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Notification en coin pour les messages recus : visible meme si le chat
  // est replie, ou si on regarde la video en plein ecran.
  if (fromId !== state.myId) showChatPopup(from, text);
});

function showChatPopup(from, text) {
  const popup = document.getElementById('chat-popup');
  document.getElementById('chat-popup-author').textContent = from + ' : ';
  document.getElementById('chat-popup-text').textContent = text;
  popup.classList.remove('hidden');
  clearTimeout(showChatPopup._t);
  showChatPopup._t = setTimeout(() => popup.classList.add('hidden'), 5000);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

document.getElementById('copy-link-btn').addEventListener('click', () => {
  // Sur mobile : ouvre directement le menu de partage natif (WhatsApp,
  // Messages...), plus rapide qu'un copier-coller manuel dans une autre appli.
  if (navigator.share) {
    navigator.share({
      title: 'Watch Together',
      text: 'Rejoins-moi sur Watch Together :',
      url: location.href,
    }).catch(() => {}); // l'utilisateur a simplement annule le partage
    return;
  }
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

// ===================== Demandes pause/avance (vue partage d'ecran) =====================
// Signaux envoyes depuis la vue "je regarde le partage d'ecran de l'autre"
// (boutons visibles uniquement cote spectateur, voir showScreenPreview plus bas).
document.querySelectorAll('.request-pause-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.emit('manual-pause-ping');
    showToast('Demande de pause envoyee.');
  });
});
document.querySelectorAll('.request-forward-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    socket.emit('manual-forward-ping');
    showToast("Demande d'avancer envoyee.");
  });
});

socket.on('manual-pause-ping', ({ from }) => {
  showRequestPopup(`⏸ ${from} demande une pause !`);
});

socket.on('manual-forward-ping', ({ from }) => {
  showRequestPopup(`⏩ ${from} demande d'avancer la lecture !`);
});

// ===================== Camera / WebRTC =====================
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const cameraWidget = document.getElementById('camera-widget');
cameraWidget.classList.add('no-remote');

// --- Aide : assigner un flux a un <video> et gerer le cas ou l'autoplay est
// bloque par le navigateur (frequent sur Safari/iOS) : on tente play(), et si
// la promesse est rejetee on affiche un bouton pour lancer la lecture au clic,
// plutot que de laisser une image noire sans aucune indication. ---
function clearVideoElement(videoEl) {
  videoEl.srcObject = null;
  if (videoEl._playOverlay) {
    videoEl._playOverlay.remove();
    videoEl._playOverlay = null;
  }
}

function attachStream(videoEl, stream) {
  // ontrack se declenche une fois par piste (video puis audio) avec le meme
  // MediaStream : evite un second appel a play() inutile (source d'un
  // AbortError benin mais bruyant : "interrupted by a new load request").
  if (videoEl.srcObject === stream) return;
  clearVideoElement(videoEl);
  videoEl.srcObject = stream;
  const playPromise = videoEl.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((err) => {
      debugLog('Autoplay bloque pour', videoEl.id, err);
      showPlayOverlay(videoEl);
    });
  }
}

function showPlayOverlay(videoEl) {
  if (videoEl._playOverlay) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'video-play-overlay';
  btn.textContent = '▶ Cliquer pour activer la video';
  btn.addEventListener('click', () => {
    videoEl.play().then(() => {
      btn.remove();
      videoEl._playOverlay = null;
    }).catch((e) => debugLog('play() refuse a nouveau', e));
  });
  videoEl.insertAdjacentElement('afterend', btn);
  videoEl._playOverlay = btn;
}

// --- Message d'erreur precis selon la cause reelle (permission refusee,
// aucun peripherique, deja utilise par un autre programme/onglet, etc.) ---
function mediaErrorMessage(err, what) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Acces ${what} refuse. Autorisez-le dans les parametres du navigateur (icone cadenas/camera dans la barre d'adresse) puis rechargez la page.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `Aucun peripherique ${what} detecte sur cet appareil.`;
    case 'NotReadableError':
      return `${what} deja utilise par une autre application, un autre onglet ou un autre navigateur. Fermez-le puis reessayez.`;
    default:
      return `Impossible d'acceder a ${what} (${err && err.message ? err.message : 'erreur inconnue'}).`;
  }
}

async function initMedia() {
  // Deja en possession d'une camera active (ex: reconnexion apres un reveil
  // du serveur) : pas besoin de redemander l'acces, on reutilise le flux.
  if (state.localStream && state.localStream.getTracks().some((t) => t.readyState === 'live')) {
    attachStream(localVideo, state.localStream);
    state.peerConnections.forEach((pc) => addLocalTracksToPeer(pc));
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("Camera/micro indisponibles : ce site doit etre ouvert en HTTPS (ou localhost) pour y acceder.", 6000);
    return;
  }
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.localStream.getAudioTracks().forEach((t) => { t.enabled = state.micOn; }); // micro coupe par defaut
    localVideo.muted = true; // obligatoire pour l'autoplay du flux local
    attachStream(localVideo, state.localStream);

    // Si une connexion pair-a-pair existait deja sans piste locale (ex: l'autre
    // personne a rejoint pendant que la permission camera etait en attente),
    // on ajoute les pistes maintenant : cela declenche onnegotiationneeded
    // automatiquement et relance la negociation.
    state.peerConnections.forEach((pc) => addLocalTracksToPeer(pc));
  } catch (err) {
    showToast(mediaErrorMessage(err, 'camera/micro'), 6000);
  }
}

function addLocalTracksToPeer(pc) {
  if (!state.localStream) return;
  const alreadySent = pc.getSenders().map((s) => s.track);
  state.localStream.getTracks().forEach((track) => {
    if (!alreadySent.includes(track)) pc.addTrack(track, state.localStream);
  });
}

// --- Creation d'une RTCPeerConnection avec "negociation parfaite" : les DEUX
// pairs peuvent initier une offre des qu'ils ont quelque chose a envoyer (au
// lieu de restreindre ce droit a un seul cote, ce qui bloquait silencieusement
// la connexion quand ce cote n'avait pas encore de piste locale). En cas de
// collision (offres envoyees en meme temps des deux cotes), le pair "poli"
// annule la sienne au profit de celle recue. Voir MDN "Perfect negotiation". ---
function createPeerConnection(peerId, { kind, onTrack } = {}) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const polite = state.myId > peerId;
  let makingOffer = false;
  pc._polite = polite;
  pc._ignoreOffer = false;
  pc._makingOffer = () => makingOffer;

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc-signal', { to: peerId, signal: { sdp: pc.localDescription, kind } });
    } catch (e) {
      debugLog('Erreur creation offre', kind, peerId, e);
    } finally {
      makingOffer = false;
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-signal', { to: peerId, signal: { candidate: event.candidate, kind } });
    }
  };

  pc.oniceconnectionstatechange = () => {
    debugLog(`[${kind || 'camera'}] iceConnectionState(${peerId}) =`, pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed' && typeof pc.restartIce === 'function') {
      debugLog(`[${kind || 'camera'}] tentative de restartIce apres echec`, peerId);
      pc.restartIce();
    }
  };
  pc.onconnectionstatechange = () => debugLog(`[${kind || 'camera'}] connectionState(${peerId}) =`, pc.connectionState);
  pc.onsignalingstatechange = () => debugLog(`[${kind || 'camera'}] signalingState(${peerId}) =`, pc.signalingState);

  if (onTrack) pc.ontrack = onTrack;

  return pc;
}

async function applyIncomingSignal(pc, peerId, signal) {
  if (signal.sdp) {
    const isOffer = signal.sdp.type === 'offer';
    const collision = isOffer && (pc._makingOffer() || pc.signalingState !== 'stable');
    pc._ignoreOffer = !pc._polite && collision;
    if (pc._ignoreOffer) {
      debugLog('Offre ignoree (collision, ce pair est impoli)', peerId);
      return;
    }

    // Pas besoin de rollback manuel : setRemoteDescription() applique un
    // rollback implicite automatiquement quand on recoit une offre alors
    // qu'on est en 'have-local-offer' (comportement standard des navigateurs).
    // Un rollback manuel separe ici cree une fenetre async supplementaire ou
    // un onnegotiationneeded concurrent peut interferer et casser l'etat.
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

    if (isOffer) {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-signal', { to: peerId, signal: { sdp: pc.localDescription, kind: signal.kind } });
    }
  } else if (signal.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (e) {
      if (!pc._ignoreOffer) debugLog('Erreur addIceCandidate', peerId, e);
    }
  }
}

function connectToPeer(peerId) {
  if (state.peerConnections.has(peerId)) return state.peerConnections.get(peerId);
  const pc = createPeerConnection(peerId, {
    onTrack: (event) => {
      attachStream(remoteVideo, event.streams[0]);
      cameraWidget.classList.remove('no-remote');
    },
  });
  state.peerConnections.set(peerId, pc);
  addLocalTracksToPeer(pc); // no-op si state.localStream pas encore pret (voir initMedia)
  return pc;
}

socket.on('webrtc-signal', async ({ from, signal }) => {
  const isScreen = signal.kind === 'screen';
  let pc;
  if (isScreen) {
    pc = state.screenPeerConnections.get(from);
    if (!pc) {
      pc = createPeerConnection(from, {
        kind: 'screen',
        onTrack: (event) => {
          // Compense le delai typiquement plus eleve de la capture audio
          // d'onglet/systeme cote partageur (particularite connue de
          // getDisplayMedia sur Chrome desktop, plus lente que la capture
          // video) : sans ca, le son recu peut arriver en avance sur l'image.
          // On retarde volontairement sa restitution pour les realigner,
          // plutot qu'un offset fixe code en dur pour un seul cas observe.
          if (event.track.kind === 'audio' && 'playoutDelayHint' in event.receiver) {
            event.receiver.playoutDelayHint = 0.25;
          }
          if (event.track.kind === 'video') startScreenStatsOverlay(pc, true);
          showScreenPreview(event.streams[0], { isRemote: true });
        },
      });
      state.screenPeerConnections.set(from, pc);
    }
  } else {
    pc = connectToPeer(from);
  }
  await applyIncomingSignal(pc, from, signal);
});

// Le libelle du bouton reflete l'action qu'il declenchera (et non un simple
// nom fixe) pour eviter de confondre "couper" et "activer" : un ecran noir
// apres un clic sur ce bouton n'est pas un bug de camera, juste la coupure.
const toggleCamBtn = document.getElementById('toggle-cam-btn');
const toggleMicBtn = document.getElementById('toggle-mic-btn');

// Icones fixes (voir index.html) : seule la couleur (.off = rouge) indique
// l'etat, le titre (info-bulle) precise l'action pour l'accessibilite.
toggleCamBtn.addEventListener('click', () => {
  state.camOn = !state.camOn;
  if (state.localStream) state.localStream.getVideoTracks().forEach((t) => { t.enabled = state.camOn; });
  toggleCamBtn.classList.toggle('off', !state.camOn);
  toggleCamBtn.title = state.camOn ? 'Couper la camera' : 'Activer la camera';
});

toggleMicBtn.addEventListener('click', () => {
  state.micOn = !state.micOn;
  if (state.localStream) state.localStream.getAudioTracks().forEach((t) => { t.enabled = state.micOn; });
  toggleMicBtn.classList.toggle('off', !state.micOn);
  toggleMicBtn.title = state.micOn ? 'Couper le micro' : 'Activer le micro';
});

// ===================== Partage d'ecran (Netflix / Prime) =====================
// Une seule personne (celle qui a le compte Netflix/Prime) partage son ecran ;
// l'autre le regarde en direct, sans rien installer et sans avoir son propre
// compte. C'est un flux WebRTC separe de celui de la camera.

function setShareButtonsState(sharing) {
  document.querySelectorAll('.share-screen-btn').forEach((b) => b.classList.toggle('hidden', sharing));
  document.querySelectorAll('.stop-share-btn').forEach((b) => b.classList.toggle('hidden', !sharing));
}

async function startScreenShare(platform) {
  if (state.screenStream) return;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    showToast("Partage d'ecran indisponible : ce navigateur ne le supporte pas (courant sur mobile), ou le site n'est pas en HTTPS.", 6000);
    return;
  }
  try {
    // Full HD / 30fps : la meilleure qualite source raisonnable pour du film
    // (au-dela de 30fps n'apporte rien, la plupart des films/series sont a
    // 24-30fps). Le debit reste plafonne plus bas (voir tuneScreenVideoSender),
    // donc demander cette qualite source ne cree pas de risque de saccade :
    // au pire elle est automatiquement reduite en temps reel par l'encodeur
    // (degradationPreference='balanced', voir tuneScreenVideoSender).
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
      audio: true,
    });
  } catch (e) {
    showToast(e && e.name === 'NotAllowedError'
      ? "Partage d'ecran annule."
      : `Partage d'ecran impossible (${e && e.message ? e.message : 'erreur inconnue'}).`);
    return;
  }
  // Indique a l'encodeur qu'il s'agit d'un contenu en mouvement continu (un
  // film), pas d'un partage de bureau majoritairement statique : de meilleures
  // heuristiques d'encodage ici reduisent le risque d'accumulation de frames
  // en retard (l'une des causes d'un decalage audio/video qui grandit).
  state.screenStream.getVideoTracks()[0].contentHint = 'motion';
  setShareButtonsState(true);
  state.screenStream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);

  // On affiche aussi le partage dans cet onglet, pour pouvoir suivre le film
  // sans repasser sur l'onglet Netflix/Prime d'origine.
  showScreenPreview(state.screenStream, { isRemote: false });

  // On verrouille les onglets (chez nous et chez l'autre) sur la plateforme
  // partagee, pour eviter qu'un changement d'onglet accidentel ne masque la
  // video en cours (voir lockTabsToPlatform).
  lockTabsToPlatform(platform);
  socket.emit('screen-share-platform', { platform });

  // On partage vers tous les pairs actuellement connus dans le salon.
  state.peerConnections.forEach((_, peerId) => connectScreenToPeer(peerId));
}

function connectScreenToPeer(peerId) {
  if (!state.screenStream || state.screenPeerConnections.has(peerId)) return;
  const pc = createPeerConnection(peerId, { kind: 'screen' });
  state.screenPeerConnections.set(peerId, pc);
  state.screenStream.getTracks().forEach((track) => {
    const sender = pc.addTrack(track, state.screenStream);
    if (track.kind === 'video') {
      tuneScreenVideoSender(sender);
      preferEfficientVideoCodec(pc, track);
      startScreenStatsOverlay(pc, false);
    }
  });
  return pc;
}

// Priorise VP9 (nettement plus efficace que VP8 a debit egal, ~20-30%) dans
// l'ordre des codecs propose a la negociation SDP, sans pour autant exclure
// les autres (VP8/H264 restent en repli si le pair ne supporte pas VP9) :
// a debit plafonne identique (voir tuneScreenVideoSender), un codec plus
// efficace produit une image plus nette pour le meme nombre de bits envoyes.
function preferEfficientVideoCodec(pc, track) {
  if (typeof RTCRtpSender.getCapabilities !== 'function') return;
  const transceiver = pc.getTransceivers().find((t) => t.sender && t.sender.track === track);
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
  const capabilities = RTCRtpSender.getCapabilities('video');
  if (!capabilities || !capabilities.codecs) return;
  const priority = ['video/vp9', 'video/h264', 'video/vp8', 'video/av1'];
  const sorted = [...capabilities.codecs].sort((a, b) => {
    const rank = (c) => {
      const i = priority.indexOf(c.mimeType.toLowerCase());
      return i === -1 ? priority.length : i;
    };
    return rank(a) - rank(b);
  });
  try {
    transceiver.setCodecPreferences(sorted);
  } catch (e) {
    debugLog('setCodecPreferences refuse', e);
  }
}

// Plafonne le debit encode (independamment de la resolution demandee) : sans
// aucune limite, un partage 1080p peut demander bien plus que ce qu'un relais
// TURN ou un reseau mobile encaisse, ce qui degraderait la qualite de toute
// facon (paquets perdus, saccades). 4 Mbps est une cible haute qualite
// realiste pour du 1080p/30fps sur une connexion correcte (domicile/4G+) tout
// en restant absorbable par la plupart des relais - un compte TURN dedie
// (voir README, METERED_API_KEY) rendra cette qualite bien plus atteignable
// en pratique que le TURN public partage.
//
// degradationPreference='balanced' (recommandation WebRTC par defaut) degrade
// un MELANGE de resolution et de framerate quand la bande passante reelle ne
// suit pas la cible ci-dessus, plutot que de sacrifier un seul des deux a
// l'extreme. Avant, ce reglage etait 'maintain-framerate' (sacrifie
// uniquement la resolution) pour corriger un decalage audio/video sur reseau
// mobile contraint - mais applique en permanence, meme sur un lien correct,
// ca degradait la nettete inutilement des que le debit reel etait ne serait-
// ce que legerement sous la cible. 'balanced' est un compromis plus sain par
// defaut ; si la desynchro audio/video revient sur reseau tres contraint, on
// peut reintroduire 'maintain-framerate' de facon ciblee (ex: seulement en
// dessous d'un certain debit mesure via getStats()) plutot que globalement.
function tuneScreenVideoSender(sender, maxBitrate = 4000000) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = maxBitrate;
  params.degradationPreference = 'balanced';
  sender.setParameters(params).catch((e) => debugLog('setParameters (bitrate/degradation) refuse', e));
}

// stream vient soit du pair (isRemote: true), soit de notre propre partage
// (isRemote: false, apercu local). Meme <video> reutilise dans les deux cas
// (on ne peut pas etre les deux a la fois dans un salon a 2 personnes).
function showScreenPreview(stream, { isRemote }) {
  ['netflix', 'prime'].forEach((platform) => {
    const videoEl = document.getElementById(`screen-video-${platform}`);
    attachStream(videoEl, stream);
    // Notre propre apercu doit rester muet : le son original joue deja dans
    // l'onglet Netflix/Prime partage, sinon on l'entendrait en double (echo).
    videoEl.muted = !isRemote;
    document.getElementById(`screen-viewer-${platform}`).classList.remove('hidden');
    // Les boutons "demander pause/avancer" n'ont de sens que cote spectateur
    // (celui qui partage n'a pas besoin de se demander une pause a lui-meme).
    document.getElementById(`remote-request-${platform}`).classList.toggle('hidden', !isRemote);
  });
  if (isRemote) showToast("L'autre personne partage son ecran.");
}

function clearScreenViewer() {
  stopScreenStatsOverlay();
  ['netflix', 'prime'].forEach((platform) => {
    clearVideoElement(document.getElementById(`screen-video-${platform}`));
    document.getElementById(`screen-viewer-${platform}`).classList.add('hidden');
    document.getElementById(`remote-request-${platform}`).classList.add('hidden');
  });
}

// Indicateur discret (resolution reelle / debit reel / codec / relais TURN ou
// direct) affiche pendant un partage d'ecran, cote partageur (ce qu'il envoie
// reellement, isRemote:false -> stats "outbound-rtp") comme cote spectateur
// (ce qu'il recoit reellement, isRemote:true -> stats "inbound-rtp") : permet
// de diagnostiquer une qualite mediocre avec de vrais chiffres plutot que
// d'ajuster les reglages a l'aveugle une fois de plus.
let screenStatsTimer = null;
let screenStatsPrevSample = null;

function stopScreenStatsOverlay() {
  clearInterval(screenStatsTimer);
  screenStatsTimer = null;
  screenStatsPrevSample = null;
  ['netflix', 'prime'].forEach((platform) => {
    const el = document.getElementById(`screen-stats-${platform}`);
    if (el) el.classList.add('hidden');
  });
}

function startScreenStatsOverlay(pc, isRemote) {
  stopScreenStatsOverlay();
  const rtpType = isRemote ? 'inbound-rtp' : 'outbound-rtp';

  const update = async () => {
    let report;
    try {
      report = await pc.getStats();
    } catch (e) {
      return;
    }

    let rtp = null;
    let candidatePairId = null;
    report.forEach((stat) => {
      if (stat.type === rtpType && stat.kind === 'video') rtp = stat;
      if (stat.type === 'transport' && stat.selectedCandidatePairId) candidatePairId = stat.selectedCandidatePairId;
    });
    if (!rtp) return;

    let codecName = '';
    if (rtp.codecId && report.get(rtp.codecId)) {
      codecName = (report.get(rtp.codecId).mimeType || '').split('/')[1] || '';
    }

    let relay = '';
    const pair = candidatePairId && report.get(candidatePairId);
    const localCandidate = pair && pair.localCandidateId && report.get(pair.localCandidateId);
    if (localCandidate) relay = localCandidate.candidateType === 'relay' ? 'relais TURN' : 'direct';

    const bytes = isRemote ? rtp.bytesReceived : rtp.bytesSent;
    let bitrateText = '...';
    const now = Date.now();
    if (typeof bytes === 'number' && screenStatsPrevSample) {
      const dtSeconds = (now - screenStatsPrevSample.ts) / 1000;
      if (dtSeconds > 0) {
        const kbps = Math.max(0, Math.round(((bytes - screenStatsPrevSample.bytes) * 8) / dtSeconds / 1000));
        bitrateText = `${(kbps / 1000).toFixed(1)} Mbps`;
      }
    }
    screenStatsPrevSample = { bytes, ts: now };

    const res = rtp.frameWidth && rtp.frameHeight ? `${rtp.frameWidth}x${rtp.frameHeight}` : '';
    const text = [res, bitrateText, codecName.toUpperCase(), relay].filter(Boolean).join(' · ');

    ['netflix', 'prime'].forEach((platform) => {
      const el = document.getElementById(`screen-stats-${platform}`);
      if (el) { el.textContent = text; el.classList.remove('hidden'); }
    });
  };

  update();
  screenStatsTimer = setInterval(update, 2000);
}

function stopScreenShare() {
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
  }
  state.screenPeerConnections.forEach((pc) => pc.close());
  state.screenPeerConnections.clear();
  setShareButtonsState(false);
  clearScreenViewer(); // efface aussi notre propre apercu local (on ne recoit pas notre propre "screen-share-stopped")
  unlockTabs();
  socket.emit('screen-share-stopped');
}

socket.on('screen-share-stopped', () => {
  const pc = state.screenPeerConnections;
  pc.forEach((c) => c.close());
  pc.clear();
  clearScreenViewer();
  unlockTabs();
  showToast("Le partage d'ecran s'est arrete.");
});

document.querySelectorAll('.share-screen-btn').forEach((btn) => {
  btn.addEventListener('click', () => startScreenShare(btn.dataset.platform));
});
document.querySelectorAll('.stop-share-btn').forEach((btn) => {
  btn.addEventListener('click', stopScreenShare);
});

// ===================== Plein ecran (avec la camera qui reste visible) =====================
// "Faux" plein ecran en CSS (position fixed sur tout le viewport) plutot que
// l'API Fullscreen native : Safari sur iPhone ne supporte pas requestFullscreen
// sur un <div> (seulement sur <video>, sans possibilite d'afficher la camera
// par-dessus), ce qui empechait le plein ecran de fonctionner pour celui qui
// rejoint depuis un iPhone. Cette approche fonctionne partout de la meme facon.
function refreshCameraVideos() {
  // Deplacer les <video> dans le DOM peut, sur certains navigateurs (Safari
  // notamment), interrompre brievement leur lecture : on la relance par
  // securite plutot que de laisser une image figee/noire.
  [localVideo, remoteVideo].forEach((v) => { if (v.srcObject) v.play().catch(() => {}); });
}

function exitCssFullscreen() {
  document.querySelectorAll('.screen-share-viewer.css-fullscreen').forEach((viewer) => {
    viewer.classList.remove('css-fullscreen');
    const btn = viewer.querySelector('.fullscreen-btn');
    if (btn) { btn.textContent = '⛶'; btn.title = 'Plein ecran'; }
  });
  document.body.appendChild(cameraWidget);
  // On restaure la position choisie par glisser-depose (si aucune, la CSS
  // par defaut du widget s'applique).
  if (cameraWidget.dataset.savedTop !== undefined) {
    cameraWidget.style.top = cameraWidget.dataset.savedTop;
    cameraWidget.style.left = cameraWidget.dataset.savedLeft;
    cameraWidget.style.right = cameraWidget.dataset.savedRight;
    cameraWidget.style.bottom = cameraWidget.dataset.savedBottom || '';
  }
  refreshCameraVideos();
  document.body.style.overflow = '';
  document.documentElement.style.overflow = '';
}

document.querySelectorAll('.fullscreen-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const viewer = document.getElementById(`screen-viewer-${btn.dataset.platform}`);
    const video = document.getElementById(`screen-video-${btn.dataset.platform}`);

    // iOS Safari : ni notre plein ecran CSS, ni l'API Fullscreen generique,
    // ne masquent la barre d'adresse/onglets Safari (elle reste affichee et
    // reduit l'espace visible du lecteur). Seul le plein ecran natif propre
    // a la balise <video> (webkitEnterFullscreen, specifique a Safari) la
    // masque vraiment. On l'utilise en priorite quand disponible - le seul
    // compromis est que la bulle camera ne peut pas se superposer sur ce
    // lecteur natif specifique (limite d'iOS, pas contournable en JS) ;
    // elle reste normalement disponible une fois qu'on quitte ce mode.
    if (typeof video.webkitEnterFullscreen === 'function') {
      video.webkitEnterFullscreen();
      return;
    }

    if (viewer.classList.contains('css-fullscreen')) {
      exitCssFullscreen();
      return;
    }
    exitCssFullscreen(); // au cas ou un autre onglet etait deja en plein ecran
    viewer.classList.add('css-fullscreen');

    // Une position fixee par un glisser-depose anterieur (ex: adaptee a un
    // ecran en mode portrait) peut placer la bulle hors-champ une fois le
    // viewport redimensionne en plein ecran/paysage : on l'efface le temps
    // du plein ecran (la CSS .css-fullscreen .camera-widget prend le relais),
    // et on la restaure a la sortie.
    cameraWidget.dataset.savedTop = cameraWidget.style.top;
    cameraWidget.dataset.savedLeft = cameraWidget.style.left;
    cameraWidget.dataset.savedRight = cameraWidget.style.right;
    cameraWidget.dataset.savedBottom = cameraWidget.style.bottom;
    cameraWidget.style.top = '';
    cameraWidget.style.left = '';
    cameraWidget.style.right = '';
    cameraWidget.style.bottom = '';

    viewer.appendChild(cameraWidget);
    refreshCameraVideos();
    // overflow:hidden sur <body> seul ne bloque pas toujours de facon fiable
    // le rebond/defilement tactile sur mobile (iOS et certaines versions
    // d'Android) : on le fixe aussi sur <html>, pour eviter qu'un defilement
    // residuel ne declenche l'affichage de la barre d'adresse pendant le
    // plein ecran (qui interagit mal avec 100vh, voir style.css).
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    btn.textContent = '✕';
    btn.title = 'Quitter le plein ecran';

    // Volontairement PAS d'appel a l'API Fullscreen native (requestFullscreen)
    // ici, meme si elle est disponible : sur Chrome Android, l'element mis en
    // plein ecran natif devient un nouveau "containing block" pour ses
    // descendants position:fixed (dont la bulle camera), et combine a
    // l'overflow:hidden de .screen-share-viewer, ca peut la faire disparaitre
    // (clipee/repositionnee hors champ) - constat qui avait deja motive
    // l'usage du faux plein ecran CSS plutot que l'API native sur iOS (voir
    // plus haut). Le faux plein ecran CSS suffit a remplir tout le viewport
    // sans ce probleme ; seul inconvenient : pas de rotation forcee en
    // paysage (screen.orientation.lock necessite un vrai plein ecran natif),
    // il faut tourner le telephone manuellement, comme deja le cas sur iOS.
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.screen-share-viewer.css-fullscreen')) {
    exitCssFullscreen();
  }
});

// ===================== Bulle camera deplacable =====================
(function makeDraggable() {
  const handle = document.getElementById('camera-drag-handle');
  const widget = cameraWidget;
  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const MIN_SIZE = 130;
  const MAX_SIZE = 320;
  const SIZE_STEP = 20;

  // Plafond reellement disponible sur l'ecran actuel (avec une marge de
  // 40px) : MAX_SIZE seul deborderait sur un petit telephone (ex: 320px de
  // large sur un ecran de 360px de large ne laisserait presque plus de film
  // visible).
  function currentMaxSize() {
    return Math.min(MAX_SIZE, window.innerWidth - 40, window.innerHeight - 40);
  }

  const saved = JSON.parse(localStorage.getItem('cameraWidgetPos') || 'null');
  if (saved) {
    widget.style.left = saved.left + 'px';
    widget.style.top = saved.top + 'px';
    widget.style.right = 'auto';
    // Neutralise aussi "bottom" : la regle CSS mobile positionne la bulle par
    // defaut via bottom (pas top), voir plus bas. Sans ce reset, top ET
    // bottom restent actifs en meme temps une fois deplacee, ce qui force le
    // navigateur a ETIRER la hauteur de la bulle pour combler l'ecart entre
    // les deux au lieu de garder sa taille naturelle - c'etait le vrai bug
    // (visible surtout en glissant la bulle vers le haut, ou l'ecart devient
    // enorme).
    widget.style.bottom = 'auto';
  }

  // Taille choisie par l'utilisateur (boutons -/+ plus bas), persistee pour
  // ne pas avoir a la reajuster a chaque visite. Une seule dimension (largeur)
  // suffit : la hauteur suit automatiquement via l'aspect-ratio CSS du cadre
  // video, et cette largeur inline s'applique aussi bien en plein ecran
  // (.css-fullscreen) qu'en usage normal, portrait comme paysage.
  const savedSize = Number(localStorage.getItem('cameraWidgetSize'));
  if (savedSize >= MIN_SIZE && savedSize <= currentMaxSize()) {
    widget.style.width = savedSize + 'px';
  }

  function clampAndApply(left, top) {
    const maxLeft = window.innerWidth - widget.offsetWidth - 4;
    const maxTop = window.innerHeight - widget.offsetHeight - 4;
    left = Math.min(Math.max(4, left), Math.max(4, maxLeft));
    top = Math.min(Math.max(4, top), Math.max(4, maxTop));
    widget.style.left = left + 'px';
    widget.style.top = top + 'px';
    widget.style.right = 'auto';
    // Voir le commentaire plus haut : sans ce reset, la regle CSS mobile
    // (bottom: 96px) reste active en meme temps que le "top" qu'on vient de
    // fixer, et le navigateur etire la bulle pour combler l'ecart entre les
    // deux au lieu de garder sa taille naturelle.
    widget.style.bottom = 'auto';
    localStorage.setItem('cameraWidgetPos', JSON.stringify({ left, top }));
  }

  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    const rect = widget.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
  });

  // Regroupe les mises a jour de position par frame d'animation plutot que
  // d'ecrire left/top directement a chaque evenement pointermove (qui peut se
  // declencher 60-120+ fois/seconde) : des ecritures de mise en page aussi
  // frequentes et non regroupees peuvent produire des images intermediaires
  // incoherentes (etirement/deformation visible) pendant un glissement rapide,
  // en particulier combinees a l'aspect-ratio CSS du cadre video.
  let pendingFrame = null;
  let pendingLeft = 0;
  let pendingTop = 0;

  function cancelPendingFrame() {
    if (pendingFrame !== null) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
  }

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pendingLeft = e.clientX - offsetX;
    pendingTop = e.clientY - offsetY;
    if (pendingFrame === null) {
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null;
        clampAndApply(pendingLeft, pendingTop);
      });
    }
  });

  handle.addEventListener('pointerup', () => { dragging = false; cancelPendingFrame(); });
  handle.addEventListener('pointercancel', () => { dragging = false; cancelPendingFrame(); });

  // Redimensionnement (boutons - / +) : on ne change que la largeur, la
  // hauteur suit automatiquement (aspect-ratio CSS du cadre video).
  function resizeBy(delta) {
    const current = widget.getBoundingClientRect().width;
    const next = Math.min(currentMaxSize(), Math.max(MIN_SIZE, Math.round(current + delta)));
    widget.style.width = next + 'px';
    localStorage.setItem('cameraWidgetSize', String(next));
    // On ne reclampe la position QUE si la bulle a deja ete deplacee a la
    // main (position en pixels bruts) : sinon elle est positionnee par une
    // regle CSS ancree a un coin (top/right normal, ou top/right dedie au
    // plein ecran) qui reste valide quelle que soit la largeur. La reclamper
    // ici de toute facon la convertirait en position figee (clampAndApply
    // fixe aussi right:auto) qui perdrait cet ancrage et ne suivrait plus le
    // bord lors d'une rotation ou d'un redimensionnement de fenetre ulterieur
    // - c'etait le bug : un simple clic sur +/- decrochait la bulle de son
    // coin, en plein ecran comme en usage normal.
    if (widget.style.left && widget.style.top) {
      const rect = widget.getBoundingClientRect();
      clampAndApply(rect.left, rect.top);
    }
  }

  document.getElementById('camera-shrink-btn').addEventListener('click', () => resizeBy(-SIZE_STEP));
  document.getElementById('camera-grow-btn').addEventListener('click', () => resizeBy(SIZE_STEP));

  // Une rotation d'ecran (ou un redimensionnement de fenetre) peut laisser la
  // bulle hors-champ si sa position avait ete fixee par glisser-depose dans
  // l'orientation precedente (ex: proche du bas en portrait, qui n'existe
  // plus une fois passe en paysage, viewport beaucoup moins haut). On ne
  // touche a rien si la bulle n'a jamais ete deplacee (elle suit alors les
  // regles CSS responsives normales, deja adaptees a la taille d'ecran).
  window.addEventListener('resize', () => {
    if (widget.style.left && widget.style.top) {
      clampAndApply(parseFloat(widget.style.left), parseFloat(widget.style.top));
    }
  });
})();
