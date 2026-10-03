// Service worker : seul composant qui parle a l'hote natif (yt-dlp).
// L'etat des telechargements est garde dans chrome.storage.session pour que le
// popup puisse le lire a tout moment et qu'il survive a un redemarrage du
// service worker. Tant que le port natif est ouvert, Chrome garde le service
// worker actif, donc un telechargement en cours n'est pas interrompu.

importScripts('shared.js');

const HOST_NAME = 'com.videodownloader.host';
const HOST_TIMEOUTS_MS = { PING: 10000, UPDATE_YTDLP: 330000, PICK_FOLDER: 620000 };
const MAX_FINISHED_JOBS = 20;
const MODES = ['video', 'audio'];
const QUALITIES = ['best', '1080', '720', '480', '360'];
const FINISHED_STATUSES = ['done', 'error', 'cancelled'];
// Sites sur lesquels le content script affiche son bouton (voir manifest).
const PAGE_BUTTON_HOSTS = /(^|\.)(youtube\.com|tiktok\.com|instagram\.com)$/;

let nativePort = null;
const pendingRequests = new Map();

// --- Etat des telechargements (cache memoire + miroir storage.session) -----

let jobsPromise = null;
let writeChain = Promise.resolve();

function loadJobs() {
  if (!jobsPromise) {
    jobsPromise = chrome.storage.session.get('jobs').then(({ jobs = {} }) => {
      // Un nouveau service worker n'a plus de port natif : tout telechargement
      // marque "en cours" a ete interrompu avec l'ancien.
      for (const job of Object.values(jobs)) {
        if (!FINISHED_STATUSES.includes(job.status)) {
          job.status = 'error';
          job.error = 'Téléchargement interrompu.';
        }
      }
      return jobs;
    });
  }
  return jobsPromise;
}

function updateJobs(mutate) {
  writeChain = writeChain
    .then(async () => {
      const jobs = await loadJobs();
      mutate(jobs);
      pruneFinishedJobs(jobs);
      await chrome.storage.session.set({ jobs });
    })
    .catch((error) => console.error('Failed to update download jobs', error));
  return writeChain;
}

function pruneFinishedJobs(jobs) {
  const finished = Object.values(jobs)
    .filter((job) => FINISHED_STATUSES.includes(job.status))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const job of finished.slice(MAX_FINISHED_JOBS)) delete jobs[job.id];
}

function updateJob(id, changes) {
  return updateJobs((jobs) => {
    if (jobs[id]) Object.assign(jobs[id], changes);
  });
}

// --- Connexion a l'hote natif ---------------------------------------------

function getNativePort() {
  if (nativePort) return nativePort;

  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener(handleHostMessage);
  nativePort.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || 'Hôte natif déconnecté.';
    console.warn('Native host disconnected:', reason);
    nativePort = null;
    for (const resolve of pendingRequests.values()) resolve({ ok: false, error: reason });
    pendingRequests.clear();
    updateJobs((jobs) => {
      for (const job of Object.values(jobs)) {
        if (!FINISHED_STATUSES.includes(job.status)) {
          job.status = 'error';
          job.error = reason;
        }
      }
    });
  });
  return nativePort;
}

function postToHost(message) {
  getNativePort().postMessage(message);
}

// Requete/reponse avec l'hote, correlee par requestId.
function requestHost(type, payload = {}) {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({ ok: false, error: "L'hôte natif ne répond pas." });
    }, HOST_TIMEOUTS_MS[type]);
    pendingRequests.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    try {
      postToHost({ type, requestId, ...payload });
    } catch (error) {
      pendingRequests.delete(requestId);
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    }
  });
}

function resolveHostRequest(requestId, result) {
  const resolve = pendingRequests.get(requestId);
  pendingRequests.delete(requestId);
  resolve?.(result);
}

function handleHostMessage(message) {
  switch (message?.type) {
    case 'PONG':
      resolveHostRequest(message.requestId, {
        ok: true,
        ytDlpVersion: message.ytDlpVersion,
        ffmpeg: message.ffmpeg,
        deno: message.deno,
        defaultDownloadDir: message.defaultDownloadDir,
      });
      break;
    case 'UPDATE_RESULT':
      resolveHostRequest(message.requestId, {
        ok: true,
        updated: Boolean(message.ok),
        version: message.version,
        output: String(message.output || ''),
      });
      break;
    case 'FOLDER_PICKED':
      resolveHostRequest(message.requestId, message.ok
        ? { ok: true, path: message.path || null }
        : { ok: false, error: String(message.error || 'Erreur inconnue') });
      break;
    case 'TITLE':
      updateJob(message.id, { title: String(message.title).slice(0, 300) });
      break;
    case 'PROGRESS':
      updateJob(message.id, {
        status: 'downloading',
        percent: typeof message.percent === 'number' ? message.percent : null,
        speed: String(message.speed || ''),
        eta: String(message.eta || ''),
        item: Number.isInteger(message.item) ? message.item : null,
        itemCount: Number.isInteger(message.itemCount) ? message.itemCount : null,
      });
      break;
    case 'PROCESSING':
      updateJob(message.id, { status: 'processing', percent: 100 });
      break;
    case 'DONE':
      finishJob(message.id, {
        status: 'done',
        percent: 100,
        filepath: String(message.filepath),
        fileCount: Number(message.fileCount) || 1,
        failedCount: Number(message.failedCount) || 0,
      });
      break;
    case 'ERROR':
      finishJob(message.id, { status: 'error', error: String(message.message || 'Erreur inconnue') });
      break;
    case 'CANCELLED':
      finishJob(message.id, { status: 'cancelled' });
      break;
    default:
      console.warn('Unknown native host message', message);
  }
}

function notify(title, message) {
  chrome.notifications
    .create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message })
    .catch((error) => console.error('Failed to show notification', error));
}

async function finishJob(id, changes) {
  await updateJob(id, changes);
  if (changes.status === 'cancelled') return;
  const job = (await loadJobs())[id];
  if (!job) return;
  const name = job.title || job.url;
  if (changes.status === 'done') {
    const details = job.playlist
      ? `${job.fileCount} fichier(s)` + (job.failedCount ? `, ${job.failedCount} échec(s)` : '')
      : '';
    notify('Téléchargement terminé', details ? `${name}\n${details}` : name);
  } else {
    notify('Échec du téléchargement', `${name}\n${job.error}`);
  }
}

// --- Actions ---------------------------------------------------------------

function isDownloadableUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeClip(clip) {
  if (!clip) return null;
  const { start = null, end = null } = clip;
  const isValidTime = (value) => value === null || (Number.isFinite(value) && value >= 0);
  if (!isValidTime(start) || !isValidTime(end)) throw new Error('Extrait invalide.');
  if (end !== null && end <= (start || 0)) throw new Error("La fin de l'extrait doit être après le début.");
  return start || end !== null ? { start, end } : null;
}

// options : { mode, quality, playlist?, clip? } ; le reste vient des reglages.
async function startDownload(url, options) {
  if (!isDownloadableUrl(url)) throw new Error('Cette page ne contient pas de vidéo téléchargeable.');
  const { mode, quality } = options;
  if (!MODES.includes(mode) || !QUALITIES.includes(quality)) throw new Error('Options invalides.');
  const playlist = Boolean(options.playlist);
  const clip = playlist ? null : normalizeClip(options.clip);
  const settings = await loadSettings();

  const id = crypto.randomUUID();
  await updateJobs((jobs) => {
    jobs[id] = { id, url, mode, quality, playlist, clip, status: 'starting', percent: null, title: '', createdAt: Date.now() };
  });
  try {
    postToHost({
      type: 'DOWNLOAD',
      id,
      url,
      mode,
      quality,
      playlist,
      clip,
      playlistLimit: settings.playlistLimit,
      downloadDir: settings.downloadDir,
      cookiesFromBrowser: settings.cookiesFromBrowser,
      subtitles: settings.subtitles,
      subtitleLangs: settings.subtitleLangs,
      thumbnail: settings.thumbnail,
    });
  } catch (error) {
    await updateJob(id, { status: 'error', error: error.message });
  }
  return id;
}

async function startDownloadWithPrefs(url, overrides = {}) {
  const prefs = await loadPrefs();
  return startDownload(url, { ...prefs, ...overrides });
}

// --- Messages --------------------------------------------------------------

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
}

function isPageButtonContentScript(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab || !sender.url) return false;
  try {
    return PAGE_BUTTON_HOSTS.test(new URL(sender.url).hostname);
  } catch {
    return false;
  }
}

// Popup et page de reglages : acces complet.
const extensionPageHandlers = {
  CHECK_HOST: () => requestHost('PING'),
  UPDATE_YTDLP: () => requestHost('UPDATE_YTDLP'),
  PICK_FOLDER: (message) => requestHost('PICK_FOLDER', { initialDir: String(message.initialDir || '') }),
  START_DOWNLOAD: async (message) => ({
    ok: true,
    id: await startDownload(message.url, {
      mode: message.mode,
      quality: message.quality,
      playlist: message.playlist,
      clip: message.clip,
    }),
  }),
  CANCEL_DOWNLOAD: async (message) => {
    postToHost({ type: 'CANCEL', id: message.id });
    return { ok: true };
  },
  OPEN_FOLDER: async (message) => {
    const { downloadDir } = await loadSettings();
    postToHost({ type: 'OPEN_FOLDER', id: message.id, downloadDir });
    return { ok: true };
  },
  CLEAR_FINISHED: async () => {
    await updateJobs((jobs) => {
      for (const job of Object.values(jobs)) {
        if (FINISHED_STATUSES.includes(job.status)) delete jobs[job.id];
      }
    });
    return { ok: true };
  },
};

// Bouton injecte dans les pages : peut seulement lancer un telechargement
// avec les preferences enregistrees (seuls le mode et l'extrait sont choisis).
const contentScriptHandlers = {
  PAGE_DOWNLOAD: async (message) => {
    if (!MODES.includes(message.mode)) throw new Error('Options invalides.');
    const id = await startDownloadWithPrefs(message.url, { mode: message.mode, clip: message.clip ?? null });
    return { ok: true, id };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  let handlers = null;
  if (isExtensionPage(sender)) handlers = extensionPageHandlers;
  else if (isPageButtonContentScript(sender)) handlers = contentScriptHandlers;

  const handler = handlers?.[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(message))
    .then(sendResponse)
    .catch((error) => {
      console.error(`Failed to handle ${message.type}`, error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

// --- Menu contextuel et raccourci clavier -----------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'download-link',
    title: 'Télécharger la vidéo de ce lien',
    contexts: ['link'],
    targetUrlPatterns: ['http://*/*', 'https://*/*'],
  });
  chrome.contextMenus.create({
    id: 'download-page',
    title: 'Télécharger la vidéo de cette page',
    contexts: ['page', 'video'],
    documentUrlPatterns: ['http://*/*', 'https://*/*'],
  });
});

async function startDownloadFromShortcut(url) {
  try {
    await startDownloadWithPrefs(url);
    notify('Téléchargement lancé', url);
  } catch (error) {
    console.error('Failed to start download', error);
    notify('Téléchargement impossible', error.message);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'download-link' ? info.linkUrl : tab?.url || info.pageUrl;
  startDownloadFromShortcut(url);
});

chrome.commands.onCommand.addListener((command, tab) => {
  // Le raccourci accorde activeTab : l'URL de l'onglet est lisible.
  if (command === 'download-current-tab') startDownloadFromShortcut(tab?.url);
});
