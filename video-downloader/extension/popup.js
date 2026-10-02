// Popup : affiche l'URL de l'onglet actif, lance les telechargements et
// affiche leur progression. Tout l'etat vit dans le service worker /
// chrome.storage, le popup peut donc etre ferme a tout moment.

const STATUS_LABELS = {
  starting: 'Démarrage…',
  downloading: 'Téléchargement',
  processing: 'Conversion…',
  done: 'Terminé',
  error: 'Erreur',
  cancelled: 'Annulé',
};
const ACTIVE_STATUSES = ['starting', 'downloading', 'processing'];
const TIME_PATTERN = /^\d{1,3}(:\d{1,2}){0,2}(\.\d+)?$/;

const elements = {
  hostStatus: document.getElementById('host-status'),
  openSettings: document.getElementById('open-settings'),
  pageUrl: document.getElementById('page-url'),
  mode: document.getElementById('mode'),
  quality: document.getElementById('quality'),
  playlist: document.getElementById('playlist'),
  clipFields: document.getElementById('clip-fields'),
  clipStart: document.getElementById('clip-start'),
  clipEnd: document.getElementById('clip-end'),
  moreOptions: document.getElementById('more-options'),
  download: document.getElementById('download'),
  actionError: document.getElementById('action-error'),
  clear: document.getElementById('clear'),
  jobs: document.getElementById('jobs'),
  noJobs: document.getElementById('no-jobs'),
};

let activeTabUrl = null;
let hostReady = false;

async function sendToBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Erreur inconnue');
  return response;
}

function showActionError(text) {
  elements.actionError.textContent = text;
  elements.actionError.hidden = !text;
}

function updateDownloadButton() {
  elements.download.disabled = !(hostReady && activeTabUrl);
}

// --- Extrait (debut / fin) ---------------------------------------------------

// "1:20" -> 80, "1:02:03" -> 3723, "" -> null. Retourne NaN si invalide.
function parseTime(text) {
  const value = text.trim();
  if (!value) return null;
  if (!TIME_PATTERN.test(value)) return NaN;
  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function readClip() {
  const start = parseTime(elements.clipStart.value);
  const end = parseTime(elements.clipEnd.value);
  elements.clipStart.setAttribute('aria-invalid', String(Number.isNaN(start)));
  elements.clipEnd.setAttribute('aria-invalid', String(Number.isNaN(end)));
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('Format de temps invalide (exemple : 1:20).');
  if (end !== null && end <= (start || 0)) throw new Error("La fin de l'extrait doit être après le début.");
  return start || end !== null ? { start, end } : null;
}

// --- Initialisation --------------------------------------------------------

function looksLikePlaylist(url) {
  try {
    const { hostname, pathname, searchParams } = new URL(url);
    if (!/(^|\.)youtube\.com$/.test(hostname)) return false;
    return pathname === '/playlist' || (searchParams.has('list') && !searchParams.has('v'))
      || /^\/(@[^/]+|channel\/[^/]+)\/(videos|shorts|streams)\/?$/.test(pathname);
  } catch {
    return false;
  }
}

async function loadActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (/^https?:\/\//.test(url)) {
    activeTabUrl = url;
    elements.pageUrl.textContent = url;
    elements.pageUrl.title = url;
    if (looksLikePlaylist(url)) {
      elements.playlist.checked = true;
      elements.moreOptions.open = true;
      updateClipAvailability();
    }
  } else {
    elements.pageUrl.textContent = 'Ouvrez une page contenant une vidéo.';
  }
  updateDownloadButton();
}

async function restorePrefs() {
  const prefs = await loadPrefs();
  elements.mode.value = prefs.mode;
  elements.quality.value = prefs.quality;
  updateQualityAvailability();
}

function savePrefs() {
  updateQualityAvailability();
  chrome.storage.local
    .set({ prefs: { mode: elements.mode.value, quality: elements.quality.value } })
    .catch((error) => console.error('Failed to save preferences', error));
}

function updateQualityAvailability() {
  elements.quality.disabled = elements.mode.value === 'audio';
}

function updateClipAvailability() {
  // Un extrait n'a pas de sens sur toute une playlist.
  elements.clipFields.disabled = elements.playlist.checked;
}

async function checkHost() {
  const result = await chrome.runtime.sendMessage({ type: 'CHECK_HOST' });
  const status = elements.hostStatus;
  status.className = 'status';

  if (!result?.ok) {
    status.classList.add('error');
    status.textContent = `Hôte natif introuvable : lancez le script d'installation (voir README). ${result?.error || ''}`;
    return;
  }
  if (!result.ytDlpVersion) {
    status.classList.add('error');
    status.textContent = "yt-dlp n'est pas installé (pip install -U yt-dlp).";
    return;
  }
  hostReady = true;
  const warnings = [];
  if (!result.ffmpeg) warnings.push('ffmpeg absent (qualité limitée, pas de MP3 ni d\'extrait)');
  if (!result.deno) warnings.push('Deno absent (YouTube peut échouer)');
  status.classList.add(warnings.length ? 'warn' : 'ok');
  status.textContent = [`Prêt · yt-dlp ${result.ytDlpVersion}`, ...warnings].join(' · ');
  updateDownloadButton();
}

// --- Liste des telechargements ---------------------------------------------

function createButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function describeJob(job) {
  if (job.status === 'error') return job.error || STATUS_LABELS.error;
  if (job.status === 'done' && job.playlist) {
    return `${job.fileCount} fichier(s) téléchargé(s)` + (job.failedCount ? ` · ${job.failedCount} échec(s)` : '');
  }
  if (job.status !== 'downloading') return STATUS_LABELS[job.status] || job.status;
  const parts = [];
  if (job.item && job.itemCount) parts.push(`Vidéo ${job.item}/${job.itemCount}`);
  if (typeof job.percent === 'number') parts.push(`${job.percent.toFixed(1)} %`);
  if (job.speed && !job.speed.startsWith('Unknown')) parts.push(job.speed);
  if (job.eta && !['Unknown', 'NA'].includes(job.eta)) parts.push(`reste ${job.eta}`);
  return parts.join(' · ') || STATUS_LABELS.downloading;
}

function jobPrefix(job) {
  if (job.playlist) return '☰ ';
  if (job.clip) return '✂ ';
  return job.mode === 'audio' ? '♪ ' : '';
}

function renderJob(job) {
  const item = document.createElement('li');
  item.className = 'job';

  const title = document.createElement('div');
  title.className = 'job-title';
  title.textContent = jobPrefix(job) + (job.title || job.url);
  title.title = job.url;
  item.append(title);

  const isActive = ACTIVE_STATUSES.includes(job.status);
  if (isActive) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('div');
    if (typeof job.percent === 'number' && job.status === 'downloading') {
      fill.style.width = `${job.percent}%`;
    } else {
      bar.classList.add('indeterminate');
    }
    bar.append(fill);
    item.append(bar);
  }

  const info = document.createElement('div');
  info.className = 'job-info' + (job.status === 'error' ? ' error' : '');
  const text = document.createElement('span');
  text.textContent = describeJob(job);
  info.append(text);

  const actions = document.createElement('span');
  actions.className = 'job-actions';
  if (isActive) {
    actions.append(createButton('Annuler', () => runAction({ type: 'CANCEL_DOWNLOAD', id: job.id })));
  } else if (job.status === 'done') {
    actions.append(createButton('Afficher', () => runAction({ type: 'OPEN_FOLDER', id: job.id })));
  }
  info.append(actions);
  item.append(info);
  return item;
}

function renderJobs(jobs = {}) {
  const sorted = Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt);
  elements.jobs.replaceChildren(...sorted.map(renderJob));
  elements.noJobs.hidden = sorted.length > 0;
  elements.clear.hidden = !sorted.some((job) => !ACTIVE_STATUSES.includes(job.status));
}

async function runAction(message) {
  showActionError('');
  try {
    await sendToBackground(message);
    return true;
  } catch (error) {
    showActionError(error.message);
    return false;
  }
}

async function startDownload() {
  showActionError('');
  const playlist = elements.playlist.checked;
  let clip = null;
  try {
    clip = playlist ? null : readClip();
  } catch (error) {
    showActionError(error.message);
    return;
  }
  elements.download.disabled = true;
  const started = await runAction({
    type: 'START_DOWNLOAD',
    url: activeTabUrl,
    mode: elements.mode.value,
    quality: elements.quality.value,
    playlist,
    clip,
  });
  if (started) {
    elements.clipStart.value = '';
    elements.clipEnd.value = '';
  }
  updateDownloadButton();
}

// --- Evenements ------------------------------------------------------------

elements.mode.addEventListener('change', savePrefs);
elements.quality.addEventListener('change', savePrefs);
elements.playlist.addEventListener('change', updateClipAvailability);
elements.clear.addEventListener('click', () => runAction({ type: 'CLEAR_FINISHED' }));
elements.download.addEventListener('click', startDownload);
elements.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.jobs) renderJobs(changes.jobs.newValue);
});

chrome.storage.session.get('jobs').then(({ jobs }) => renderJobs(jobs));
restorePrefs().catch((error) => console.error('Failed to load preferences', error));
loadActiveTab().catch((error) => console.error('Failed to read active tab', error));
checkHost().catch((error) => {
  elements.hostStatus.className = 'status error';
  elements.hostStatus.textContent = `Erreur : ${error.message}`;
});
