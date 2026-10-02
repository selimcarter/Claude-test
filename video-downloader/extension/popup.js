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

const elements = {
  hostStatus: document.getElementById('host-status'),
  pageUrl: document.getElementById('page-url'),
  mode: document.getElementById('mode'),
  quality: document.getElementById('quality'),
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

// --- Initialisation --------------------------------------------------------

async function loadActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (/^https?:\/\//.test(url)) {
    activeTabUrl = url;
    elements.pageUrl.textContent = url;
    elements.pageUrl.title = url;
  } else {
    elements.pageUrl.textContent = 'Ouvrez une page contenant une vidéo.';
  }
  updateDownloadButton();
}

async function loadPrefs() {
  const { prefs } = await chrome.storage.local.get('prefs');
  if (prefs?.mode) elements.mode.value = prefs.mode;
  if (prefs?.quality) elements.quality.value = prefs.quality;
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
  status.classList.add('ok');
  status.textContent = `Prêt · yt-dlp ${result.ytDlpVersion}` + (result.ffmpeg ? '' : ' · ffmpeg absent (qualité limitée, pas de MP3)');
  status.title = `Dossier : ${result.downloadDir}`;
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
  if (job.status !== 'downloading') return STATUS_LABELS[job.status] || job.status;
  const parts = [];
  if (typeof job.percent === 'number') parts.push(`${job.percent.toFixed(1)} %`);
  if (job.speed && !job.speed.startsWith('Unknown')) parts.push(job.speed);
  if (job.eta && !['Unknown', 'NA'].includes(job.eta)) parts.push(`reste ${job.eta}`);
  return parts.join(' · ') || STATUS_LABELS.downloading;
}

function renderJob(job) {
  const item = document.createElement('li');
  item.className = 'job';

  const title = document.createElement('div');
  title.className = 'job-title';
  title.textContent = (job.mode === 'audio' ? '♪ ' : '') + (job.title || job.url);
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
  } catch (error) {
    showActionError(error.message);
  }
}

// --- Evenements ------------------------------------------------------------

elements.mode.addEventListener('change', savePrefs);
elements.quality.addEventListener('change', savePrefs);
elements.clear.addEventListener('click', () => runAction({ type: 'CLEAR_FINISHED' }));
elements.download.addEventListener('click', async () => {
  elements.download.disabled = true;
  await runAction({
    type: 'START_DOWNLOAD',
    url: activeTabUrl,
    mode: elements.mode.value,
    quality: elements.quality.value,
  });
  updateDownloadButton();
});

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.jobs) renderJobs(changes.jobs.newValue);
});

chrome.storage.session.get('jobs').then(({ jobs }) => renderJobs(jobs));
loadPrefs().catch((error) => console.error('Failed to load preferences', error));
loadActiveTab().catch((error) => console.error('Failed to read active tab', error));
checkHost().catch((error) => {
  elements.hostStatus.className = 'status error';
  elements.hostStatus.textContent = `Erreur : ${error.message}`;
});
