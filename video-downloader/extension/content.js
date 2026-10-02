// Content script (YouTube, TikTok, Instagram) : bouton flottant
// « Télécharger » isole dans un Shadow DOM. Il ne lit le DOM qu'au clic
// (pas de scan permanent) et suit la navigation SPA via la Navigation API.

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
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bar {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
        display: flex; align-items: center; gap: 1px;
        font: 600 13px/1 system-ui, sans-serif;
        border-radius: 999px; overflow: hidden;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
      }
      button {
        all: unset; cursor: pointer; padding: 10px 14px;
        background: #d93025; color: #fff;
      }
      button:hover { background: #b3261e; }
      button:focus-visible { outline: 3px solid #fff; outline-offset: -3px; }
      button:disabled { opacity: 0.7; cursor: progress; }
      .message {
        position: fixed; right: 20px; bottom: 64px; z-index: 2147483647;
        max-width: 280px; padding: 8px 12px; border-radius: 8px;
        font: 13px/1.4 system-ui, sans-serif; color: #fff; background: #1f2328;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
      }
      .message.error { background: #a40e26; }
      [hidden] { display: none !important; }
    </style>
    <div class="message" role="status" hidden></div>
    <div class="bar">
      <button type="button" data-mode="video" title="Télécharger la vidéo">⬇ Vidéo</button>
      <button type="button" data-mode="audio" title="Télécharger l'audio (MP3)">♪ MP3</button>
    </div>
  `;
  const bar = shadow.querySelector('.bar');
  const message = shadow.querySelector('.message');
  const buttons = shadow.querySelectorAll('button');

  function showMessage(text, isError = false) {
    clearTimeout(feedbackTimer);
    message.textContent = text;
    message.classList.toggle('error', isError);
    message.hidden = false;
    feedbackTimer = setTimeout(() => (message.hidden = true), FEEDBACK_DURATION_MS);
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

  function updateVisibility() {
    // YouTube : uniquement sur les pages video. TikTok / Instagram : partout
    // (fils de videos), l'URL est resolue au clic.
    const visible = enabled && (site.postLinkSelector !== null || isVideoPage(new URL(location.href)));
    bar.hidden = !visible;
    if (!visible) message.hidden = true;
  }

  // --- Actions -----------------------------------------------------------------

  async function download(mode) {
    const url = resolveVideoUrl();
    if (!url) {
      showMessage('Vidéo introuvable : ouvrez la vidéo (cliquez dessus) puis réessayez.', true);
      return;
    }
    buttons.forEach((button) => (button.disabled = true));
    try {
      const response = await chrome.runtime.sendMessage({ type: 'PAGE_DOWNLOAD', url, mode });
      if (!response?.ok) throw new Error(response?.error || 'Erreur inconnue');
      showMessage(mode === 'audio' ? 'Téléchargement MP3 lancé ✓' : 'Téléchargement lancé ✓');
    } catch (error) {
      // "Extension context invalidated" : l'extension a ete rechargee.
      showMessage(`Échec : ${error.message}. Rechargez la page si le problème persiste.`, true);
    } finally {
      buttons.forEach((button) => (button.disabled = false));
    }
  }

  for (const button of buttons) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      download(button.dataset.mode);
    });
  }

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
