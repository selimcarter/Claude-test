// Content script (YouTube, TikTok, Instagram) : bouton flottant
// « Télécharger » isole dans un Shadow DOM, avec un panneau « Extrait » pour
// choisir debut / fin a partir de la position de lecture. Il ne lit le DOM
// qu'a la demande (pas de scan permanent) et suit la navigation SPA via la
// Navigation API.

(() => {
  const ROOT_ID = 'video-downloader-ext-root';
  if (document.getElementById(ROOT_ID)) return; // protection double injection

  const FEEDBACK_DURATION_MS = 3000;
  const MAX_ANCESTOR_DEPTH = 15;

  // Pages dont l'URL designe directement une video.
  const SITES = [
    {
      host: /(^|\.)youtube\.com$/,
      videoPath: /^\/(watch|shorts\/[\w-]+|live\/[\w-]+)/,
      postLinkSelector: null, // YouTube : bouton uniquement sur les pages video
    },
    {
      host: /(^|\.)tiktok\.com$/,
      videoPath: /^\/@[^/]+\/video\/\d+/,
      postLinkSelector: 'a[href*="/video/"]',
    },
    {
      host: /(^|\.)instagram\.com$/,
      videoPath: /^\/(p|reels?|tv)\/[\w-]+/,
      postLinkSelector: 'a[href*="/p/"], a[href*="/reel/"]',
    },
  ];

  const site = SITES.find(({ host }) => host.test(location.hostname));
  if (!site) return;

  let enabled = DEFAULT_SETTINGS.showPageButton;
  let feedbackTimer = null;

  // --- Interface -------------------------------------------------------------

  const root = document.createElement('div');
  root.id = ROOT_ID;
  const shadow = root.attachShadow({ mode: 'closed' });
  // Contenu statique uniquement (aucune donnee de la page n'est inseree ici).
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .ui { font: 13px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: #f4f4f8; }
      button { all: unset; cursor: pointer; box-sizing: border-box; }
      button:focus-visible { outline: 2px solid #ff2e93; outline-offset: 2px; }
      button:disabled { opacity: 0.6; cursor: progress; }
      [hidden] { display: none !important; }

      /* Barre flottante : verre sombre + logo degrade */
      .bar {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
        display: flex; align-items: center; gap: 2px; padding: 4px;
        border-radius: 999px; font-weight: 600; line-height: 1;
        background: rgba(18, 18, 26, 0.78); border: 1px solid rgba(255, 255, 255, 0.12);
        backdrop-filter: blur(14px) saturate(1.4); -webkit-backdrop-filter: blur(14px) saturate(1.4);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
        transition: transform 0.2s;
      }
      .bar:hover { transform: translateY(-1px); }
      .logo {
        display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%;
        background: linear-gradient(120deg, #ff5a5f, #ff2e93 55%, #7b5cff); color: #fff; font-size: 15px;
        box-shadow: 0 4px 12px rgba(255, 46, 147, 0.45);
      }
      .bar button { padding: 9px 12px; border-radius: 999px; color: #f4f4f8; transition: background 0.15s; }
      .bar button:hover { background: rgba(255, 255, 255, 0.1); }
      .bar button[aria-expanded="true"] { background: linear-gradient(120deg, #ff5a5f, #ff2e93 55%, #7b5cff); }

      /* Panneau extrait et messages */
      .panel, .message {
        position: fixed; right: 20px; bottom: 72px; z-index: 2147483647; border-radius: 16px;
        background: rgba(18, 18, 26, 0.9); border: 1px solid rgba(255, 255, 255, 0.12);
        backdrop-filter: blur(16px) saturate(1.4); -webkit-backdrop-filter: blur(16px) saturate(1.4);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
      }
      .panel { width: 280px; padding: 14px; animation: rise 0.2s ease-out; }
      @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
      .panel h2 { margin: 0 0 10px; font-size: 14px; font-weight: 700; }
      .row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .row span { width: 38px; color: #9a9ab2; }
      input {
        all: unset; box-sizing: border-box; flex: 1; min-width: 0; padding: 7px 9px;
        font: 600 13px ui-monospace, "Cascadia Mono", monospace; color: #f4f4f8;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 9px;
      }
      input::placeholder { color: #6f6f86; }
      input:focus { border-color: #ff2e93; }
      input[aria-invalid="true"] { border-color: #ff5470; }
      .now {
        padding: 7px 9px; border-radius: 9px; white-space: nowrap; font-size: 12px;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.12);
      }
      .now:hover { border-color: #ff2e93; }
      .hint { margin: 2px 0 12px; font-size: 12px; color: #9a9ab2; }
      .actions { display: flex; gap: 6px; }
      .actions button {
        flex: 1; text-align: center; padding: 9px; border-radius: 10px; font-weight: 700; color: #fff;
        background: linear-gradient(120deg, #ff5a5f, #ff2e93 55%, #7b5cff);
        box-shadow: 0 6px 16px rgba(255, 46, 147, 0.35);
      }
      .actions button:hover { filter: brightness(1.08); }
      .status { margin: 10px 0 0; font-size: 12px; color: #3ddc97; }
      .status.error { color: #ff5470; }
      .message { max-width: 300px; padding: 10px 14px; }
      .message.error { border-color: rgba(255, 84, 112, 0.6); color: #ffd0d8; }
      @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
    </style>
    <div class="ui">
      <div class="message" role="status" hidden></div>
      <div class="panel" role="dialog" aria-label="Télécharger un extrait" hidden>
        <h2>✂ Télécharger un extrait</h2>
        <div class="row">
          <span>Début</span>
          <input data-field="start" placeholder="0:00" autocomplete="off" aria-label="Début de l'extrait">
          <button type="button" class="now" data-now="start" title="Prendre la position actuelle de la vidéo">⏱ maintenant</button>
        </div>
        <div class="row">
          <span>Fin</span>
          <input data-field="end" placeholder="fin" autocomplete="off" aria-label="Fin de l'extrait">
          <button type="button" class="now" data-now="end" title="Prendre la position actuelle de la vidéo">⏱ maintenant</button>
        </div>
        <p class="hint">Lancez la vidéo, cliquez « maintenant » au début puis à la fin du passage voulu. Format : 1:20 ou 1:02:03.</p>
        <div class="actions">
          <button type="button" data-clip-mode="video">⬇ Vidéo</button>
          <button type="button" data-clip-mode="audio">♪ MP3</button>
        </div>
        <p class="status" role="status" hidden></p>
      </div>
      <div class="bar">
        <span class="logo" aria-hidden="true">⬇</span>
        <button type="button" data-mode="video" title="Télécharger la vidéo">Vidéo</button>
        <button type="button" data-mode="audio" title="Télécharger l'audio (MP3)">MP3</button>
        <button type="button" class="clip-toggle" aria-expanded="false" title="Télécharger seulement un passage">✂ Extrait</button>
      </div>
    </div>
  `;
  const ui = shadow.querySelector('.ui');
  const bar = shadow.querySelector('.bar');
  const message = shadow.querySelector('.message');
  const panel = shadow.querySelector('.panel');
  const panelStatus = shadow.querySelector('.status');
  const clipToggle = shadow.querySelector('.clip-toggle');
  const startInput = shadow.querySelector('[data-field="start"]');
  const endInput = shadow.querySelector('[data-field="end"]');
  const actionButtons = shadow.querySelectorAll('[data-mode], [data-clip-mode]');

  // Les touches tapees dans le panneau ne doivent pas declencher les raccourcis
  // du site (sur YouTube, les chiffres deplacent la lecture).
  for (const type of ['keydown', 'keyup', 'keypress']) {
    ui.addEventListener(type, (event) => event.stopPropagation());
  }

  function showMessage(text, isError = false) {
    clearTimeout(feedbackTimer);
    // Panneau ouvert : le retour s'affiche dedans pour ne pas le recouvrir.
    const target = panel.hidden ? message : panelStatus;
    target.textContent = text;
    target.classList.toggle('error', isError);
    target.hidden = false;
    feedbackTimer = setTimeout(() => (target.hidden = true), FEEDBACK_DURATION_MS);
  }

  function setPanelOpen(open) {
    panel.hidden = !open;
    clipToggle.setAttribute('aria-expanded', String(open));
    panelStatus.hidden = true;
    if (open) {
      message.hidden = true;
      startInput.focus();
    }
  }

  // --- Detection de la video ------------------------------------------------

  function isVideoPage(url) {
    return site.videoPath.test(url.pathname);
  }

  function mostVisibleVideo() {
    let best = null;
    let bestArea = 0;
    for (const video of document.querySelectorAll('video')) {
      const rect = video.getBoundingClientRect();
      const width = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
      const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
      const area = Math.max(0, width) * Math.max(0, height);
      if (area > bestArea) {
        best = video;
        bestArea = area;
      }
    }
    return best;
  }

  // Dans un fil (TikTok / Instagram), l'URL de la page n'est pas celle de la
  // video : on cherche le lien du post le plus proche de la video visible.
  function findPostLinkNear(video) {
    let node = video;
    for (let depth = 0; node && depth < MAX_ANCESTOR_DEPTH; depth += 1, node = node.parentElement) {
      const link = node.querySelector(site.postLinkSelector);
      if (link?.href) return link.href;
    }
    return null;
  }

  function resolveVideoUrl() {
    const url = new URL(location.href);
    if (isVideoPage(url)) return url.href;
    if (!site.postLinkSelector) return null;
    const video = mostVisibleVideo();
    return video ? findPostLinkNear(video) : null;
  }

  function getVideoTime() {
    const video = mostVisibleVideo();
    if (!video || !Number.isFinite(video.currentTime)) return null;
    return { currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null };
  }

  function updateVisibility() {
    // YouTube : uniquement sur les pages video. TikTok / Instagram : partout
    // (fils de videos), l'URL est resolue au clic.
    const visible = enabled && (site.postLinkSelector !== null || isVideoPage(new URL(location.href)));
    bar.hidden = !visible;
    if (!visible) {
      message.hidden = true;
      setPanelOpen(false);
    }
  }

  // --- Actions -----------------------------------------------------------------

  async function download(mode, clip = null) {
    const url = resolveVideoUrl();
    if (!url) {
      showMessage('Vidéo introuvable : ouvrez la vidéo (cliquez dessus) puis réessayez.', true);
      return false;
    }
    actionButtons.forEach((button) => (button.disabled = true));
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PAGE_DOWNLOAD', url, mode, clip });
      if (!response?.ok) throw new Error(response?.error || 'Erreur inconnue');
      const what = clip ? 'Extrait' : 'Téléchargement';
      showMessage(mode === 'audio' ? `${what} MP3 lancé ✓` : `${what} lancé ✓`);
      return true;
    } catch (error) {
      // "Extension context invalidated" : l'extension a ete rechargee.
      showMessage(`Échec : ${error.message}. Rechargez la page si le problème persiste.`, true);
      return false;
    } finally {
      actionButtons.forEach((button) => (button.disabled = false));
    }
  }

  function readClipFromPanel() {
    for (const input of [startInput, endInput]) {
      input.setAttribute('aria-invalid', String(Number.isNaN(parseTime(input.value))));
    }
    const clip = buildClip(startInput.value, endInput.value);
    if (!clip) throw new Error('Indiquez au moins un début ou une fin.');
    return clip;
  }

  async function downloadClip(mode) {
    let clip;
    try {
      clip = readClipFromPanel();
    } catch (error) {
      showMessage(error.message, true);
      return;
    }
    if (await download(mode, clip)) {
      startInput.value = '';
      endInput.value = '';
    }
  }

  function fillWithCurrentTime(input) {
    const time = getVideoTime();
    if (!time) {
      showMessage('Aucune vidéo en lecture trouvée sur la page.', true);
      return;
    }
    input.value = formatTime(time.currentTime);
    input.setAttribute('aria-invalid', 'false');
  }

  for (const button of shadow.querySelectorAll('[data-mode]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      download(button.dataset.mode);
    });
  }
  for (const button of shadow.querySelectorAll('[data-clip-mode]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      downloadClip(button.dataset.clipMode);
    });
  }
  for (const button of shadow.querySelectorAll('[data-now]')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      fillWithCurrentTime(button.dataset.now === 'start' ? startInput : endInput);
    });
  }
  clipToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    setPanelOpen(panel.hidden);
  });
  ui.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setPanelOpen(false);
  });

  // --- Messages du popup ----------------------------------------------------------

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || request?.type !== 'GET_VIDEO_TIME') return false;
    sendResponse(getVideoTime());
    return false;
  });

  // --- Cycle de vie --------------------------------------------------------------

  // Navigation SPA (pushState / replaceState / retour arriere).
  if (window.navigation) {
    window.navigation.addEventListener('currententrychange', updateVisibility);
  } else {
    window.addEventListener('popstate', updateVisibility);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      enabled = { ...DEFAULT_SETTINGS, ...changes.settings.newValue }.showPageButton;
      updateVisibility();
    }
  });

  loadSettings()
    .then((settings) => {
      enabled = settings.showPageButton;
    })
    .catch((error) => console.error('[video-downloader] Failed to load settings', error))
    .finally(() => {
      updateVisibility();
      (document.body || document.documentElement).append(root);
    });
})();
