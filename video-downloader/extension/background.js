// Service worker : seul composant qui parle a l'hote natif (yt-dlp).
// L'etat des telechargements est garde dans chrome.storage.session pour que le
// popup puisse le lire a tout moment et qu'il survive a un redemarrage du
// service worker. Tant que le port natif est ouvert, Chrome garde le service
// worker actif, donc un telechargement en cours n'est pas interrompu.

const HOST_NAME = 'com.videodownloader.host';
const PING_TIMEOUT_MS = 10000;
const MAX_FINISHED_JOBS = 20;
const DEFAULT_PREFS = { mode: 'video', quality: 'best' };
const MODES = ['video', 'audio'];
const QUALITIES = ['best', '1080', '720', '480', '360'];
const FINISHED_STATUSES = ['done', 'error', 'cancelled'];

let nativePort = null;
const pendingPings = new Map();

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
    for (const resolve of pendingPings.values()) resolve({ ok: false, error: reason });
    pendingPings.clear();
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

function pingHost() {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingPings.delete(requestId);
      resolve({ ok: false, error: "L'hôte natif ne répond pas." });
    }, PING_TIMEOUT_MS);
    pendingPings.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    try {
      postToHost({ type: 'PING', requestId });
    } catch (error) {
      pendingPings.delete(requestId);
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    }
  });
}

function handleHostMessage(message) {
  switch (message?.type) {
    case 'PONG': {
      const resolve = pendingPings.get(message.requestId);
      pendingPings.delete(message.requestId);
      resolve?.({
        ok: true,
        ytDlpVersion: message.ytDlpVersion,
        ffmpeg: message.ffmpeg,
        downloadDir: message.downloadDir,
      });
      break;
    }
    case 'TITLE':
      updateJob(message.id, { title: String(message.title).slice(0, 300) });
      break;
    case 'PROGRESS':
      updateJob(message.id, {
        status: 'downloading',
        percent: typeof message.percent === 'number' ? message.percent : null,
        speed: String(message.speed || ''),
        eta: String(message.eta || ''),
      });
      break;
    case 'PROCESSING':
      updateJob(message.id, { status: 'processing', percent: 100 });
      break;
    case 'DONE':
      finishJob(message.id, { status: 'done', percent: 100, filepath: String(message.filepath) });
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

async function finishJob(id, changes) {
  await updateJob(id, changes);
  if (changes.status === 'cancelled') return;
  const job = (await loadJobs())[id];
  if (!job) return;
  const succeeded = changes.status === 'done';
  chrome.notifications.create(`job-${id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: succeeded ? 'Téléchargement terminé' : 'Échec du téléchargement',
    message: succeeded ? job.title || job.url : `${job.title || job.url}\n${job.error}`,
  });
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

async function startDownload(url, mode, quality) {
  if (!isDownloadableUrl(url)) throw new Error('Cette page ne contient pas de vidéo téléchargeable.');
  if (!MODES.includes(mode) || !QUALITIES.includes(quality)) throw new Error('Options invalides.');

  const id = crypto.randomUUID();
  await updateJobs((jobs) => {
    jobs[id] = { id, url, mode, quality, status: 'starting', percent: null, title: '', createdAt: Date.now() };
  });
  try {
    postToHost({ type: 'DOWNLOAD', id, url, mode, quality });
  } catch (error) {
    await updateJob(id, { status: 'error', error: error.message });
  }
  return id;
}

async function getPrefs() {
  const { prefs } = await chrome.storage.local.get('prefs');
  return { ...DEFAULT_PREFS, ...prefs };
}

// --- Messages du popup -----------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Seules les pages de l'extension (popup) peuvent piloter les telechargements.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;

  const handlers = {
    CHECK_HOST: () => pingHost(),
    START_DOWNLOAD: async () => ({ ok: true, id: await startDownload(message.url, message.mode, message.quality) }),
    CANCEL_DOWNLOAD: async () => {
      postToHost({ type: 'CANCEL', id: message.id });
      return { ok: true };
    },
    OPEN_FOLDER: async () => {
      postToHost({ type: 'OPEN_FOLDER', id: message.id });
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

  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(handler)
    .then(sendResponse)
    .catch((error) => {
      console.error(`Failed to handle ${message.type}`, error);
      sendResponse({ ok: false, error: error.message });
    });
  return true;
});

// --- Menu contextuel -------------------------------------------------------

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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'download-link' ? info.linkUrl : tab?.url || info.pageUrl;
  try {
    const { mode, quality } = await getPrefs();
    await startDownload(url, mode, quality);
  } catch (error) {
    console.error('Failed to start download from context menu', error);
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Téléchargement impossible',
      message: error.message,
    });
  }
});
