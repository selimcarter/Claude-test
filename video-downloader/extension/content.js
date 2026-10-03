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
      .ui { font: 13px/1.4 system-ui, sans-serif; color: #1f2328; }
      .bar {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
        display: flex; align-items: center; gap: 1px;
        font-weight: 600; line-height: 1;
        border-radius: 999px; overflow: hidden;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
      }
      .bar button { padding: 10px 14px; background: #d93025; color: #fff; }
      .bar button:hover, .bar button[aria-expanded="true"] { background: #b3261e; }
      button { all: unset; cursor: pointer; box-sizing: border-box; }
      button:focus-visible { outline: 3px solid #1a73e8; outline-offset: -3px; }
      button:disabled { opacity: 0.6; cursor: progress; }
      .panel, .message {
        position: fixed; right: 20px; bottom: 66px; z-index: 2147483647;
        border-radius: 10px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      }
      .panel { width: 260px; padding: 12px; background: #fff; }
      .panel h2 { margin: 0 0 8px; font-size: 14px; }
      .row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
      .row span { width: 38px; color: #656d76; }
      input {
        all: unset; box-sizing: border-box; flex: 1; min-width: 0;
        padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff;
      }
      input:focus { border-color: #1a73e8; }
      input[aria-invalid="true"] { border-color: #cf222e; }
      .now { padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; white-space: nowrap; }
      .now:hover { background: #f6f8fa; }
      .hint { margin: 0 0 10px; font-size: 12px; color: #656d76; }
      .actions { display: flex; gap: 6px; }
      .actions button {
        flex: 1; text-align: center; padding: 8px; border-radius: 6px;
        background: #d93025; color: #fff; font-weight: 600;
      }
      .actions button:hover { background: #b3261e; }
      .status { margin: 8px 0 0; font-size: 12px; color: #1a7f37; }
      .status.error { color: #cf222e; }
      .message { max-width: 280px; padding: 8px 12px; color: #fff; background: #1f2328; }
      .message.error { background: #a40e26; }
      [hidden] { display: none !important; }
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
        <button type="button" data-mode="video" title="Télécharger la vidéo">⬇ Vidéo</button>
        <button type="button" data-mode="audio" title="Télécharger l'audio (MP3)">♪ MP3</button>
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
