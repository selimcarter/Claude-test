// Injecte dans les pages Netflix / Prime Video : pilote la balise <video>
// native de la page (autorise : ce n'est pas une iframe, on lit/ecrit juste
// l'etat standard du lecteur HTML5), et affiche une bulle camera + un chat
// par-dessus la page, dans un Shadow DOM pour ne pas entrer en conflit avec
// le CSS du site.

(function () {
  const state = {
    myId: null,
    peers: [],
    videoEl: null,
    applyingRemote: false,
    localStream: null,
    peerConnections: new Map(),
    camOn: true,
    micOn: true,
  };

  // STUN public + TURN public de secours (OpenRelay/Metered), indispensable
  // des que les 2 personnes ne sont pas sur le meme reseau (NAT restrictif,
  // 4G...) : sans TURN, la connexion camera echoue silencieusement.
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];

  function debugLog(...args) {
    console.debug('[watch-together-ext]', ...args);
  }

  function mediaErrorMessage(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Acces camera/micro refuse sur ce site. Autorisez-le (icone camera dans la barre d\'adresse) puis rechargez la page.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'Aucune camera/micro detecte sur cet appareil.';
      case 'NotReadableError':
        return 'Camera/micro deja utilise par une autre application ou un autre onglet/navigateur.';
      default:
        return `Camera/micro indisponibles (${err && err.message ? err.message : 'erreur inconnue'}).`;
    }
  }

  // ===================== Detection de la balise video =====================
  function findVideo() {
    return document.querySelector('video');
  }

  function attachVideoListeners(video) {
    video.addEventListener('play', () => {
      if (state.applyingRemote) return;
      sendBg({ type: 'local-video-state', state: 'play', time: video.currentTime });
    });
    video.addEventListener('pause', () => {
      if (state.applyingRemote) return;
      sendBg({ type: 'local-video-state', state: 'pause', time: video.currentTime });
    });
    video.addEventListener('seeked', () => {
      if (state.applyingRemote) return;
      sendBg({
        type: 'local-video-state',
        state: video.paused ? 'pause' : 'play',
        time: video.currentTime,
      });
    });
  }

  setInterval(() => {
    const v = findVideo();
    if (v && v !== state.videoEl) {
      state.videoEl = v;
      attachVideoListeners(v);
    }
  }, 1000);

  function applyRemoteVideoState({ state: playState, time, ts }) {
    const video = state.videoEl;
    if (!video) return;
    state.applyingRemote = true;
    const latency = Math.max(0, (Date.now() - ts) / 1000);
    const targetTime = time + (playState === 'play' ? latency : 0);
    if (Math.abs(video.currentTime - targetTime) > 1.5) {
      video.currentTime = targetTime;
    }
    if (playState === 'play') video.play().catch(() => {});
    else video.pause();
    setTimeout(() => { state.applyingRemote = false; }, 600);
  }

  // ===================== Communication avec background.js =====================
  function sendBg(msg) {
    chrome.runtime.sendMessage({ scope: 'cs', ...msg }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.scope !== 'bg') return;
    if (msg.type === 'status') {
      state.myId = msg.myId;
      state.peers = msg.peers || [];
      ui.setConnected(msg.connected);
      if (msg.connected) {
        initMedia().then(() => state.peers.forEach((p) => connectToPeer(p.id)));
      }
    } else if (msg.type === 'peer-joined') {
      state.peers.push({ id: msg.id, name: msg.name });
      ui.toast(`${msg.name} a rejoint le salon.`);
      connectToPeer(msg.id);
    } else if (msg.type === 'peer-left') {
      const pc = state.peerConnections.get(msg.id);
      if (pc) { pc.close(); state.peerConnections.delete(msg.id); }
      ui.clearRemoteVideo();
    } else if (msg.type === 'chat') {
      ui.addChatMessage(msg.from, msg.text, msg.ts, msg.fromId === msg.myId);
    } else if (msg.type === 'video-state') {
      applyRemoteVideoState(msg);
    } else if (msg.type === 'signal') {
      handleSignal(msg.from, msg.signal);
    }
  });

  sendBg({ type: 'ready' });

  // ===================== WebRTC (camera) =====================
  async function initMedia() {
    if (state.localStream) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      ui.toast("Camera indisponible : contexte non securise (HTTPS requis).");
      return;
    }
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      ui.setLocalStream(state.localStream);
      // Si une connexion pair-a-pair existait deja sans piste locale (permission
      // camera pas encore accordee au moment ou l'autre personne s'est connectee),
      // on ajoute les pistes maintenant : ca relance la negociation toute seule.
      state.peerConnections.forEach((pc) => addLocalTracksToPeer(pc));
    } catch (e) {
      ui.toast(mediaErrorMessage(e));
    }
  }

  function addLocalTracksToPeer(pc) {
    if (!state.localStream) return;
    const alreadySent = pc.getSenders().map((s) => s.track);
    state.localStream.getTracks().forEach((track) => {
      if (!alreadySent.includes(track)) pc.addTrack(track, state.localStream);
    });
  }

  // "Negociation parfaite" (MDN) : les DEUX pairs peuvent initier une offre des
  // qu'ils ont une piste a envoyer, au lieu de reserver ce droit a un seul cote
  // (qui pouvait bloquer silencieusement toute la connexion s'il n'avait pas
  // encore sa camera prete). Un pair "poli" cede en cas de collision d'offres.
  function connectToPeer(peerId) {
    if (state.peerConnections.has(peerId)) return state.peerConnections.get(peerId);
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
        sendBg({ type: 'local-signal', to: peerId, signal: { sdp: pc.localDescription } });
      } catch (e) {
        debugLog('Erreur creation offre', peerId, e);
      } finally {
        makingOffer = false;
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) sendBg({ type: 'local-signal', to: peerId, signal: { candidate: event.candidate } });
    };

    pc.oniceconnectionstatechange = () => {
      debugLog('iceConnectionState', peerId, pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed' && typeof pc.restartIce === 'function') pc.restartIce();
    };
    pc.onconnectionstatechange = () => debugLog('connectionState', peerId, pc.connectionState);

    pc.ontrack = (event) => ui.setRemoteStream(event.streams[0]);

    state.peerConnections.set(peerId, pc);
    addLocalTracksToPeer(pc); // no-op si pas encore de camera (voir initMedia)
    return pc;
  }

  async function handleSignal(from, signal) {
    const pc = connectToPeer(from);

    if (signal.sdp) {
      const isOffer = signal.sdp.type === 'offer';
      const collision = isOffer && (pc._makingOffer() || pc.signalingState !== 'stable');
      pc._ignoreOffer = !pc._polite && collision;
      if (pc._ignoreOffer) {
        debugLog('Offre ignoree (collision)', from);
        return;
      }

      // setRemoteDescription applique un rollback implicite si besoin (pair poli).
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (isOffer) {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendBg({ type: 'local-signal', to: from, signal: { sdp: pc.localDescription } });
      }
    } else if (signal.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } catch (e) {
        if (!pc._ignoreOffer) debugLog('Erreur addIceCandidate', from, e);
      }
    }
  }

  function toggleCam() {
    state.camOn = !state.camOn;
    if (state.localStream) state.localStream.getVideoTracks().forEach((t) => { t.enabled = state.camOn; });
    return state.camOn;
  }

  function toggleMic() {
    state.micOn = !state.micOn;
    if (state.localStream) state.localStream.getAudioTracks().forEach((t) => { t.enabled = state.micOn; });
    return state.micOn;
  }

  function sendChat(text) {
    sendBg({ type: 'local-chat', text });
  }

  // ===================== Interface (Shadow DOM) =====================
  const ui = createUI({ onToggleCam: toggleCam, onToggleMic: toggleMic, onSendChat: sendChat });
})();

function createUI({ onToggleCam, onToggleMic, onSendChat }) {
  const host = document.createElement('div');
  host.id = 'watch-together-ext-root';
  host.style.all = 'initial';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
      .widget {
        position: fixed; top: 90px; right: 24px; width: 200px;
        background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px;
        overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.5); z-index: 2147483000;
        touch-action: none; user-select: none;
      }
      .drag { cursor: grab; position: relative; background: #000; aspect-ratio: 4/3; }
      .drag:active { cursor: grabbing; }
      video { width: 100%; height: 100%; object-fit: cover; display: block; }
      .remote { position: absolute; inset: 0; }
      .local { position: absolute; width: 35%; height: 35%; bottom: 6px; right: 6px; border-radius: 6px; border: 2px solid #171a21; z-index: 2; }
      .no-remote .local { position: static; width: 100%; height: 100%; border: none; border-radius: 0; }
      .no-remote .remote { display: none; }
      .btns { display: flex; gap: 4px; padding: 6px; background: #171a21; }
      .btns button { flex: 1; padding: 6px 4px; font-size: 11px; border-radius: 6px; border: 1px solid #2a2f3a; background: #1f232c; color: #e8eaed; cursor: pointer; }
      .btns button.off { background: #ff5b6a; border-color: #ff5b6a; color: #fff; }
      .chat-bubble {
        position: fixed; bottom: 24px; right: 24px; width: 46px; height: 46px; border-radius: 50%;
        background: #5b8cff; color: #fff; display: flex; align-items: center; justify-content: center;
        font-size: 20px; cursor: pointer; z-index: 2147483000; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      }
      .chat-panel {
        position: fixed; bottom: 82px; right: 24px; width: 280px; height: 360px;
        background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px; display: none;
        flex-direction: column; z-index: 2147483000; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      }
      .chat-panel.open { display: flex; }
      .messages { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
      .msg { max-width: 90%; padding: 6px 8px; border-radius: 8px; background: #1f232c; color: #e8eaed; font-size: 12px; line-height: 1.4; word-break: break-word; }
      .msg.self { align-self: flex-end; background: #5b8cff; color: #fff; }
      .msg .meta { display: block; font-size: 9px; opacity: .7; margin-bottom: 2px; }
      .chat-form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid #2a2f3a; }
      .chat-form input { flex: 1; padding: 6px 8px; background: #1f232c; border: 1px solid #2a2f3a; border-radius: 6px; color: #e8eaed; font-size: 12px; outline: none; }
      .chat-form button { padding: 6px 10px; background: #5b8cff; border: none; border-radius: 6px; color: #fff; font-size: 12px; cursor: pointer; }
      .toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: #1f232c; color: #e8eaed; border: 1px solid #2a2f3a; padding: 8px 16px;
        border-radius: 999px; font-size: 12px; z-index: 2147483000; display: none;
      }
      .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; display: inline-block; margin-right: 4px; }
      .status-dot.on { background: #3ddc84; }
      /* Cache la bulle tant qu'on n'est pas reellement connecte a un salon :
         sinon elle reste affichee en permanence sur Netflix/Prime, y compris
         quand on ne l'utilise pas, et se retrouve capturee si on partage
         cet onglet via le partage d'ecran du site. */
      .not-connected { display: none !important; }
    </style>
    <div class="widget no-remote not-connected" id="widget">
      <div class="drag" id="drag">
        <video id="remote" class="remote" autoplay playsinline></video>
        <video id="local" class="local" autoplay playsinline muted></video>
      </div>
      <div class="btns">
        <button id="camBtn"><span class="status-dot" id="dot"></span><span id="camLabel">Couper camera</span></button>
        <button id="micBtn"><span id="micLabel">Couper micro</span></button>
      </div>
    </div>
    <div class="chat-bubble not-connected" id="chatBubble">💬</div>
    <div class="chat-panel" id="chatPanel">
      <div class="messages" id="messages"></div>
      <form class="chat-form" id="chatForm">
        <input id="chatInput" type="text" placeholder="Message..." autocomplete="off">
        <button type="submit">OK</button>
      </form>
    </div>
    <div class="toast" id="toast"></div>
  `;

  const widget = root.getElementById('widget');
  const dragHandle = root.getElementById('drag');
  const localVideo = root.getElementById('local');
  const remoteVideo = root.getElementById('remote');
  const dot = root.getElementById('dot');
  let playOverlayBtn = null;

  // Sur certains navigateurs (Safari notamment), l'autoplay peut etre bloque
  // silencieusement : le flux arrive bien mais la video reste noire. On tente
  // play() et, si refuse, on affiche un bouton pour le relancer au clic.
  function tryPlay(videoEl) {
    const p = videoEl.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        console.debug('[watch-together-ext] autoplay bloque', videoEl.id, err);
        showPlayOverlay();
      });
    }
  }

  function showPlayOverlay() {
    if (playOverlayBtn) return;
    playOverlayBtn = document.createElement('button');
    playOverlayBtn.type = 'button';
    playOverlayBtn.textContent = '▶';
    playOverlayBtn.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:5;background:rgba(0,0,0,.8);color:#fff;border:1px solid #5b8cff;border-radius:999px;padding:6px 12px;font-size:16px;cursor:pointer;';
    playOverlayBtn.addEventListener('click', () => {
      localVideo.play().catch(() => {});
      remoteVideo.play().catch(() => {});
      playOverlayBtn.remove();
      playOverlayBtn = null;
    });
    dragHandle.appendChild(playOverlayBtn);
  }

  // --- Boutons camera / micro ---
  // Le libelle reflete l'action a venir (et non un nom fixe) pour eviter de
  // confondre "couper" et "activer" : un ecran noir apres un clic ici n'est
  // pas un bug, juste la coupure volontaire de la camera.
  root.getElementById('camBtn').addEventListener('click', (e) => {
    const on = onToggleCam();
    e.currentTarget.classList.toggle('off', !on);
    root.getElementById('camLabel').textContent = on ? 'Couper camera' : 'Activer camera';
  });
  root.getElementById('micBtn').addEventListener('click', (e) => {
    const on = onToggleMic();
    e.currentTarget.classList.toggle('off', !on);
    root.getElementById('micLabel').textContent = on ? 'Couper micro' : 'Activer micro';
  });

  // --- Chat ---
  const chatBubble = root.getElementById('chatBubble');
  const chatPanel = root.getElementById('chatPanel');
  chatBubble.addEventListener('click', () => chatPanel.classList.toggle('open'));
  root.getElementById('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = root.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    onSendChat(text);
    input.value = '';
  });

  // --- Bulle camera deplacable (pointer events) ---
  (function makeDraggable() {
    const handle = root.getElementById('drag');
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      const rect = widget.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const maxLeft = window.innerWidth - widget.offsetWidth - 4;
      const maxTop = window.innerHeight - widget.offsetHeight - 4;
      const left = Math.min(Math.max(4, e.clientX - offsetX), Math.max(4, maxLeft));
      const top = Math.min(Math.max(4, e.clientY - offsetY), Math.max(4, maxTop));
      widget.style.left = left + 'px';
      widget.style.top = top + 'px';
      widget.style.right = 'auto';
    });
    handle.addEventListener('pointerup', () => { dragging = false; });
    handle.addEventListener('pointercancel', () => { dragging = false; });
  })();

  function toast(msg) {
    const t = root.getElementById('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.style.display = 'none'; }, 3000);
  }

  return {
    setConnected(connected) {
      dot.classList.toggle('on', connected);
      widget.classList.toggle('not-connected', !connected);
      chatBubble.classList.toggle('not-connected', !connected);
      if (!connected) chatPanel.classList.remove('open');
      if (connected) toast('Connecte au salon Watch Together.');
    },
    setLocalStream(stream) {
      if (localVideo.srcObject === stream) return;
      localVideo.srcObject = stream;
      tryPlay(localVideo);
    },
    setRemoteStream(stream) {
      widget.classList.remove('no-remote');
      if (remoteVideo.srcObject === stream) return;
      remoteVideo.srcObject = stream;
      tryPlay(remoteVideo);
    },
    clearRemoteVideo() {
      remoteVideo.srcObject = null;
      widget.classList.add('no-remote');
      if (playOverlayBtn) { playOverlayBtn.remove(); playOverlayBtn = null; }
    },
    addChatMessage(from, text, ts, isSelf) {
      const messages = root.getElementById('messages');
      const div = document.createElement('div');
      div.className = 'msg' + (isSelf ? ' self' : '');
      const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const safeText = document.createElement('span');
      safeText.textContent = text;
      div.innerHTML = `<span class="meta">${from} - ${time}</span>`;
      div.appendChild(safeText);
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      if (!chatPanel.classList.contains('open')) toast(`${from}: ${text}`);
    },
    toast,
  };
}
