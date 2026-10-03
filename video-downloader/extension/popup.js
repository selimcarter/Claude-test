// Popup : affiche la page active, lance les telechargements et affiche leur
// progression. Tout l'etat vit dans le service worker / chrome.storage, le
// popup peut donc etre ferme a tout moment.

const ACTIVE_STATUSES = ['starting', 'downloading', 'processing'];
const SITE_NAMES = [
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, 'YouTube'],
  [/(^|\.)tiktok\.com$/, 'TikTok'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(x|twitter)\.com$/, 'X'],
  [/(^|\.)facebook\.com$/, 'Facebook'],
  [/(^|\.)vimeo\.com$/, 'Vimeo'],
  [/(^|\.)twitch\.tv$/, 'Twitch'],
  [/(^|\.)reddit\.com$/, 'Reddit'],
  [/(^|\.)dailymotion\.com$/, 'Dailymotion'],
];
const ICONS = {
  cancel: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>',
};

const $ = (id) => document.getElementById(id);
const elements = {
  hostStatus: $('host-status'),
  hostText: $('host-text'),
  openSettings: $('open-settings'),
  favicon: $('favicon'),
  faviconFallback: $('favicon-fallback'),
  pageTitle: $('page-title'),
  pageSite: $('page-site'),
  modeVideo: $('mode-video'),
  modeAudio: $('mode-audio'),
  qualityChips: $('quality-chips'),
  clipToggle: $('clip-toggle'),
  clipPanel: $('clip-panel'),
  timeline: $('timeline'),
  rangeStart: $('range-start'),
  rangeEnd: $('range-end'),
  rangeFill: $('range-fill'),
  clipStart: $('clip-start'),
  clipEnd: $('clip-end'),
  nowButtons: document.querySelectorAll('[data-now-for]'),
  playlist: $('playlist'),
  download: $('download'),
  downloadLabel: $('download-label'),
  actionError: $('action-error'),
  clear: $('clear'),
  jobs: $('jobs'),
  noJobs: $('no-jobs'),
};

let activeTabUrl = null;
let activeTabId = null;
let hostReady = false;
let videoDuration = null;

async function sendToBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'Erreur inconnue');
  return response;
}

function showActionError(text) {
  elements.actionError.textContent = text;
  elements.actionError.hidden = !text;
}

function selectedMode() {
  return elements.modeAudio.checked ? 'audio' : 'video';
}

function selectedQuality() {
  return elements.qualityChips.querySelector('input:checked')?.value || 'best';
}

// --- Bouton principal --------------------------------------------------------

function describeClipForLabel() {
  try {
    const clip = buildClip(elements.clipStart.value, elements.clipEnd.value);
    if (!clip) return null;
    return `${formatTime(clip.start || 0)} → ${clip.end !== null ? formatTime(clip.end) : 'fin'}`;
  } catch {
    return null;
  }
}

function updateDownloadButton() {
  const isAudio = selectedMode() === 'audio';
  let label = isAudio ? 'Télécharger le MP3' : 'Télécharger la vidéo';
  if (elements.playlist.checked) {
    label = isAudio ? 'Télécharger la playlist en MP3' : 'Télécharger la playlist';
  } else if (elements.clipToggle.checked) {
    const range = describeClipForLabel();
    label = range ? `Télécharger l'extrait ${range}` : "Choisissez l'extrait";
  }
  elements.downloadLabel.textContent = label;
  elements.download.disabled = !(hostReady && activeTabUrl);
}

// --- Page active -----------------------------------------------------------------

function siteName(hostname) {
  return SITE_NAMES.find(([pattern]) => pattern.test(hostname))?.[1] || hostname.replace(/^www\./, '');
}

function looksLikePlaylist(url) {
  const { hostname, pathname, searchParams } = url;
  if (!/(^|\.)youtube\.com$/.test(hostname)) return false;
  return pathname === '/playlist' || (searchParams.has('list') && !searchParams.has('v'))
    || /^\/(@[^/]+|channel\/[^/]+)\/(videos|shorts|streams)\/?$/.test(pathname);
}

function showFavicon(favIconUrl) {
  // activeTab donne acces a l'icone de l'onglet ; uniquement https/data:image.
  if (!favIconUrl || !/^(https:|data:image\/)/.test(favIconUrl)) return;
  elements.favicon.addEventListener('load', () => {
    elements.favicon.hidden = false;
    elements.faviconFallback.hidden = true;
  }, { once: true });
  elements.favicon.src = favIconUrl;
}

async function loadActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  const url = tab?.url || '';
  if (/^https?:\/\//.test(url)) {
    const parsed = new URL(url);
    activeTabUrl = url;
    elements.pageTitle.textContent = tab.title || url;
    elements.pageSite.textContent = siteName(parsed.hostname);
    elements.pageTitle.title = url;
    showFavicon(tab.favIconUrl);
    if (looksLikePlaylist(parsed)) {
      elements.playlist.checked = true;
      syncOptionAvailability();
    }
  } else {
    elements.pageSite.textContent = 'Aucune vidéo sur cette page';
  }
  updateDownloadButton();
}

// --- Preferences -------------------------------------------------------------------

async function restorePrefs() {
  const prefs = await loadPrefs();
  (prefs.mode === 'audio' ? elements.modeAudio : elements.modeVideo).checked = true;
  const quality = elements.qualityChips.querySelector(`input[value="${CSS.escape(prefs.quality)}"]`);
  if (quality) quality.checked = true;
  syncOptionAvailability();
}

function savePrefs() {
  syncOptionAvailability();
  chrome.storage.local
    .set({ prefs: { mode: selectedMode(), quality: selectedQuality() } })
    .catch((error) => console.error('Failed to save preferences', error));
}

function setSwitchDisabled(input, disabled) {
  input.disabled = disabled;
  input.closest('.switch-row').classList.toggle('disabled', disabled);
}

// Extrait et playlist s'excluent ; la qualite n'a pas de sens en MP3.
function syncOptionAvailability() {
  elements.qualityChips.disabled = selectedMode() === 'audio';
  setSwitchDisabled(elements.clipToggle, elements.playlist.checked);
  setSwitchDisabled(elements.playlist, elements.clipToggle.checked);
  elements.clipPanel.hidden = !elements.clipToggle.checked;
  updateDownloadButton();
}

// --- Extrait ------------------------------------------------------------------------

// Le content script (YouTube / TikTok / Instagram) donne position et duree.
async function requestVideoTime() {
  if (activeTabId === null) return null;
  try {
    const response = await chrome.tabs.sendMessage(activeTabId, { type: 'GET_VIDEO_TIME' });
    return Number.isFinite(response?.currentTime) ? response : null;
  } catch {
    return null; // pas de content script sur ce site
  }
}

function updateRangeFill() {
  const max = Number(elements.rangeStart.max) || 1;
  const start = (Number(elements.rangeStart.value) / max) * 100;
  const end = (Number(elements.rangeEnd.value) / max) * 100;
  elements.rangeFill.style.left = `${start}%`;
  elements.rangeFill.style.width = `${Math.max(0, end - start)}%`;
}

// Frise -> champs texte
function onRangeInput(event) {
  const start = Number(elements.rangeStart.value);
  const end = Number(elements.rangeEnd.value);
  if (start >= end) {
    // Les poignees ne se croisent pas.
    if (event.target === elements.rangeStart) elements.rangeStart.value = Math.max(0, end - 1);
    else elements.rangeEnd.value = Math.min(videoDuration, start + 1);
  }
  elements.clipStart.value = Number(elements.rangeStart.value) > 0 ? formatTime(Number(elements.rangeStart.value)) : '';
  elements.clipEnd.value = Number(elements.rangeEnd.value) < videoDuration ? formatTime(Number(elements.rangeEnd.value)) : '';
  for (const input of [elements.clipStart, elements.clipEnd]) input.setAttribute('aria-invalid', 'false');
  updateRangeFill();
  updateDownloadButton();
}

// Champs texte -> frise
function onTimeFieldInput() {
  for (const input of [elements.clipStart, elements.clipEnd]) {
    input.setAttribute('aria-invalid', String(Number.isNaN(parseTime(input.value))));
  }
  if (videoDuration) {
    const start = parseTime(elements.clipStart.value);
    const end = parseTime(elements.clipEnd.value);
    if (Number.isFinite(start)) elements.rangeStart.value = Math.min(start, videoDuration);
    else if (start === null) elements.rangeStart.value = 0;
    if (Number.isFinite(end)) elements.rangeEnd.value = Math.min(end, videoDuration);
    else if (end === null) elements.rangeEnd.value = videoDuration;
    updateRangeFill();
  }
  updateDownloadButton();
}

async function setupClipTools() {
  const video = await requestVideoTime();
  for (const button of elements.nowButtons) button.hidden = !video;
  if (video?.duration > 1) {
    videoDuration = Math.floor(video.duration);
    for (const range of [elements.rangeStart, elements.rangeEnd]) range.max = videoDuration;
    elements.rangeStart.value = 0;
    elements.rangeEnd.value = videoDuration;
    elements.timeline.hidden = false;
    updateRangeFill();
  }
}

async function setClipFieldToCurrentTime(input) {
  const video = await requestVideoTime();
  if (!video) {
    showActionError('Position de lecture introuvable : lancez la vidéo puis réessayez.');
    return;
  }
  showActionError('');
  input.value = formatTime(video.currentTime);
  onTimeFieldInput();
}

function readClip() {
  for (const input of [elements.clipStart, elements.clipEnd]) {
    input.setAttribute('aria-invalid', String(Number.isNaN(parseTime(input.value))));
  }
  const clip = buildClip(elements.clipStart.value, elements.clipEnd.value);
  if (!clip) throw new Error('Choisissez un début et/ou une fin pour l\'extrait.');
  return clip;
}

// --- Etat de l'hote -----------------------------------------------------------------

function setHostStatus(state, text, title = '') {
  elements.hostStatus.className = `pill ${state}`;
  elements.hostText.textContent = text;
  elements.hostStatus.title = title;
}

async function checkHost() {
  const result = await chrome.runtime.sendMessage({ type: 'CHECK_HOST' });
  if (!result?.ok) {
    setHostStatus('error', 'Outil non installé', `Lancez install_windows.bat. ${result?.error || ''}`);
    return;
  }
  if (!result.ytDlpVersion) {
    setHostStatus('error', 'yt-dlp manquant', 'Relancez install_windows.bat.');
    return;
  }
  hostReady = true;
  const missing = [!result.ffmpeg && 'ffmpeg', !result.deno && 'Deno'].filter(Boolean);
  if (missing.length) {
    setHostStatus('warn', `Prêt · ${missing.join(' et ')} manquant`, 'Relancez install_windows.bat pour les installer.');
  } else {
    setHostStatus('ok', `Prêt · yt-dlp ${result.ytDlpVersion}`);
  }
  updateDownloadButton();
}

// --- Liste des telechargements -----------------------------------------------------

function iconButton(icon, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = ICONS[icon]; // icone statique (constante ci-dessus)
  button.addEventListener('click', onClick);
  return button;
}

function jobMeta(job) {
  if (job.status === 'error') return job.error || 'Erreur';
  if (job.status === 'cancelled') return 'Annulé';
  if (job.status === 'done') {
    if (job.playlist) return `${job.fileCount} fichier(s)` + (job.failedCount ? ` · ${job.failedCount} échec(s)` : '');
    return job.mode === 'audio' ? 'MP3 prêt' : 'Vidéo prête';
  }
  if (job.status === 'starting') return 'Préparation…';
  if (job.status === 'processing') return 'Finalisation…';
  const parts = [];
  if (job.item && job.itemCount) parts.push(`Vidéo ${job.item}/${job.itemCount}`);
  if (job.speed && !job.speed.startsWith('Unknown')) parts.push(job.speed);
  if (job.eta && !['Unknown', 'NA'].includes(job.eta)) parts.push(`reste ${job.eta}`);
  return parts.join(' · ') || 'Téléchargement…';
}

function jobKind(job) {
  if (job.playlist) return 'Playlist';
  if (job.clip) return `Extrait ${formatTime(job.clip.start || 0)} → ${job.clip.end !== null ? formatTime(job.clip.end) : 'fin'}`;
  return job.mode === 'audio' ? 'MP3' : '';
}

function renderRing(job) {
  const ring = document.createElement('div');
  ring.className = 'ring';
  const label = document.createElement('span');
  if (job.status === 'downloading' && typeof job.percent === 'number') {
    ring.style.setProperty('--p', job.percent.toFixed(1));
    label.textContent = `${Math.floor(job.percent)}%`;
  } else if (ACTIVE_STATUSES.includes(job.status)) {
    ring.classList.add('indeterminate');
  } else {
    ring.classList.add(job.status);
    label.textContent = { done: '✓', error: '!', cancelled: '–' }[job.status] || '';
  }
  ring.append(label);
  return ring;
}

function renderJob(job) {
  const item = document.createElement('li');
  item.className = 'job';

  const body = document.createElement('div');
  body.className = 'job-body';
  const title = document.createElement('p');
  title.className = 'job-title';
  title.textContent = job.title || job.url;
  title.title = job.url;
  const meta = document.createElement('p');
  meta.className = 'job-meta' + (job.status === 'error' ? ' error' : '');
  meta.textContent = [jobKind(job), jobMeta(job)].filter(Boolean).join(' · ');
  body.append(title, meta);

  if (job.status === 'error') {
    if (job.errorHint) {
      const hint = document.createElement('p');
      hint.className = 'job-hint';
      hint.textContent = job.errorHint;
      body.append(hint);
    }
    if (job.errorDetails && job.errorDetails !== job.error) {
      const details = document.createElement('details');
      details.className = 'job-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Détail technique';
      const code = document.createElement('code');
      code.textContent = job.errorDetails;
      details.append(summary, code);
      body.append(details);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'job-actions';
  if (ACTIVE_STATUSES.includes(job.status)) {
    actions.append(iconButton('cancel', 'Annuler', () => runAction({ type: 'CANCEL_DOWNLOAD', id: job.id })));
  } else if (job.status === 'done') {
    actions.append(iconButton('folder', 'Afficher dans le dossier', () => runAction({ type: 'OPEN_FOLDER', id: job.id })));
  }

  item.append(renderRing(job), body, actions);
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
  if (!playlist && elements.clipToggle.checked) {
    try {
      clip = readClip();
    } catch (error) {
      showActionError(error.message);
      return;
    }
  }
  elements.download.disabled = true;
  await runAction({
    type: 'START_DOWNLOAD',
    url: activeTabUrl,
    mode: selectedMode(),
    quality: selectedQuality(),
    playlist,
    clip,
  });
  updateDownloadButton();
}

// --- Evenements ------------------------------------------------------------------

for (const input of document.querySelectorAll('input[name="mode"], input[name="quality"]')) {
  input.addEventListener('change', savePrefs);
}
elements.clipToggle.addEventListener('change', syncOptionAvailability);
elements.playlist.addEventListener('change', syncOptionAvailability);
elements.rangeStart.addEventListener('input', onRangeInput);
elements.rangeEnd.addEventListener('input', onRangeInput);
elements.clipStart.addEventListener('input', onTimeFieldInput);
elements.clipEnd.addEventListener('input', onTimeFieldInput);
for (const button of elements.nowButtons) {
  const input = $(button.dataset.nowFor);
  button.addEventListener('click', () => setClipFieldToCurrentTime(input));
}
elements.clear.addEventListener('click', () => runAction({ type: 'CLEAR_FINISHED' }));
elements.download.addEventListener('click', startDownload);
elements.openSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.jobs) renderJobs(changes.jobs.newValue);
});

chrome.storage.session.get('jobs').then(({ jobs }) => renderJobs(jobs));
restorePrefs().catch((error) => console.error('Failed to load preferences', error));
loadActiveTab()
  .then(setupClipTools)
  .catch((error) => console.error('Failed to read active tab', error));
checkHost().catch((error) => setHostStatus('error', 'Erreur', error.message));
