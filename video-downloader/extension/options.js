// Page de reglages : chaque modification est enregistree immediatement dans
// chrome.storage.local ("settings"), lue par le service worker a chaque
// telechargement et par le content script pour le bouton sur les pages.

const SUBTITLE_LANGS_PATTERN = /^[A-Za-z0-9*.\-_]+(,[A-Za-z0-9*.\-_]+)*$/;

const elements = {
  saveStatus: document.getElementById('save-status'),
  hostError: document.getElementById('host-error'),
  autoUpdate: document.getElementById('auto-update'),
  lastUpdate: document.getElementById('last-update'),
  updateButton: document.getElementById('update-ytdlp'),
  updateStatus: document.getElementById('update-status'),
  updateOutput: document.getElementById('update-output'),
  downloadDir: document.getElementById('download-dir'),
  pickFolder: document.getElementById('pick-folder'),
  folderError: document.getElementById('folder-error'),
  thumbnail: document.getElementById('thumbnail'),
  subtitles: document.getElementById('subtitles'),
  subtitleLangs: document.getElementById('subtitle-langs'),
  playlistLimit: document.getElementById('playlist-limit'),
  cookiesBrowser: document.getElementById('cookies-browser'),
  showPageButton: document.getElementById('show-page-button'),
  shortcut: document.getElementById('shortcut'),
  editShortcut: document.getElementById('edit-shortcut'),
};

let saveStatusTimer = null;

function showSaveStatus(text, className = 'muted') {
  clearTimeout(saveStatusTimer);
  elements.saveStatus.className = `save-status ${className}`;
  elements.saveStatus.textContent = text;
  if (className === 'ok') saveStatusTimer = setTimeout(() => (elements.saveStatus.textContent = ''), 2000);
}

// --- Lecture / ecriture des reglages ---------------------------------------

function fillForm(settings) {
  elements.downloadDir.value = settings.downloadDir;
  elements.thumbnail.checked = settings.thumbnail;
  elements.subtitles.checked = settings.subtitles;
  elements.subtitleLangs.value = settings.subtitleLangs;
  elements.playlistLimit.value = settings.playlistLimit;
  elements.cookiesBrowser.value = COOKIE_BROWSERS.includes(settings.cookiesFromBrowser) ? settings.cookiesFromBrowser : '';
  elements.showPageButton.checked = settings.showPageButton;
  elements.autoUpdate.checked = settings.autoUpdate;
  elements.subtitleLangs.disabled = !settings.subtitles;
}

// Retourne les reglages du formulaire, ou null si un champ est invalide.
function readForm() {
  const langs = elements.subtitleLangs.value.replace(/\s+/g, '');
  const langsValid = !elements.subtitles.checked || SUBTITLE_LANGS_PATTERN.test(langs);
  const limit = Number(elements.playlistLimit.value);
  const limitValid = Number.isInteger(limit) && limit >= 1 && limit <= 500;

  elements.subtitleLangs.setAttribute('aria-invalid', String(!langsValid));
  elements.playlistLimit.setAttribute('aria-invalid', String(!limitValid));
  if (!langsValid || !limitValid) return null;

  return {
    downloadDir: elements.downloadDir.value.trim(),
    thumbnail: elements.thumbnail.checked,
    subtitles: elements.subtitles.checked,
    subtitleLangs: langs || DEFAULT_SETTINGS.subtitleLangs,
    playlistLimit: limit,
    cookiesFromBrowser: elements.cookiesBrowser.value,
    showPageButton: elements.showPageButton.checked,
    autoUpdate: elements.autoUpdate.checked,
  };
}

async function saveSettings() {
  elements.subtitleLangs.disabled = !elements.subtitles.checked;
  const settings = readForm();
  if (!settings) {
    showSaveStatus('Valeur invalide, non enregistrée.', 'error');
    return;
  }
  try {
    await chrome.storage.local.set({ settings });
    showSaveStatus('Enregistré ✓', 'ok');
  } catch (error) {
    console.error('Failed to save settings', error);
    showSaveStatus(`Erreur d'enregistrement : ${error.message}`, 'error');
  }
}

// --- Hote natif ------------------------------------------------------------

function setToolState(id, ok, text) {
  const item = document.getElementById(id);
  item.className = ok ? 'ok' : 'missing';
  item.querySelector('.tool-state').textContent = text;
}

async function checkHost() {
  const result = await chrome.runtime.sendMessage({ type: 'CHECK_HOST' });
  if (!result?.ok) {
    elements.hostError.textContent = `Outil de téléchargement introuvable : lancez install_windows.bat. ${result?.error || ''}`;
    elements.hostError.hidden = false;
    for (const id of ['tool-ytdlp', 'tool-ffmpeg', 'tool-deno']) setToolState(id, false, '—');
    elements.updateButton.disabled = true;
    elements.pickFolder.disabled = true;
    return;
  }
  elements.hostError.hidden = true;
  setToolState('tool-ytdlp', Boolean(result.ytDlpVersion),
    result.ytDlpVersion ? `${result.ytDlpVersion}${result.bundled ? ' (intégré)' : ''}` : 'absent');
  setToolState('tool-ffmpeg', result.ffmpeg, result.ffmpeg ? 'installé' : 'absent : HD, MP3 et extraits indisponibles');
  setToolState('tool-deno', result.deno, result.deno ? 'installé' : 'absent : YouTube peut échouer');
  elements.downloadDir.placeholder = result.defaultDownloadDir || '';
}

function formatRelativeDate(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

async function showLastUpdate() {
  const { ytdlpUpdate } = await chrome.storage.local.get('ytdlpUpdate');
  if (!ytdlpUpdate) return;
  const when = formatRelativeDate(ytdlpUpdate.at);
  const how = ytdlpUpdate.automatic ? 'automatique' : 'manuelle';
  elements.lastUpdate.textContent = ytdlpUpdate.ok
    ? `Dernière mise à jour ${how} ${when} (${ytdlpUpdate.version}).`
    : `Dernière tentative ${how} ${when} : échec.`;
}

async function updateYtDlp() {
  elements.updateButton.disabled = true;
  elements.updateStatus.className = 'muted';
  elements.updateStatus.textContent = 'Mise à jour en cours… (jusqu\'à quelques minutes)';
  elements.updateOutput.hidden = true;

  const result = await chrome.runtime.sendMessage({ type: 'UPDATE_YTDLP' });
  elements.updateButton.disabled = false;
  if (result?.busy) {
    elements.updateStatus.className = 'muted';
    elements.updateStatus.textContent = 'Téléchargements en cours : réessayez une fois terminés.';
    return;
  }
  if (!result?.ok || !result.updated) {
    elements.updateStatus.className = 'error';
    elements.updateStatus.textContent = 'Échec de la mise à jour.';
    elements.updateOutput.textContent = result?.output || result?.error || '';
    elements.updateOutput.hidden = !elements.updateOutput.textContent;
    return;
  }
  elements.updateStatus.className = 'ok-text';
  elements.updateStatus.textContent = `yt-dlp est à jour (${result.version}).`;
  await checkHost();
}

async function pickFolder() {
  elements.folderError.hidden = true;
  elements.pickFolder.disabled = true;
  elements.pickFolder.textContent = 'Fenêtre ouverte…';
  const result = await chrome.runtime.sendMessage({
    type: 'PICK_FOLDER',
    initialDir: elements.downloadDir.value || elements.downloadDir.placeholder,
  });
  elements.pickFolder.disabled = false;
  elements.pickFolder.textContent = 'Parcourir…';
  if (!result?.ok) {
    elements.folderError.textContent = `${result?.error || 'Erreur inconnue'} — saisissez le chemin à la main.`;
    elements.folderError.hidden = false;
    return;
  }
  if (result.path) {
    elements.downloadDir.value = result.path;
    await saveSettings();
  }
}

// --- Raccourci clavier -----------------------------------------------------

async function showShortcut() {
  const commands = await chrome.commands.getAll();
  const command = commands.find(({ name }) => name === 'download-current-tab');
  elements.shortcut.textContent = command?.shortcut || 'non défini';
}

// --- Evenements ------------------------------------------------------------

for (const input of [elements.thumbnail, elements.subtitles, elements.cookiesBrowser, elements.showPageButton, elements.autoUpdate]) {
  input.addEventListener('change', saveSettings);
}
for (const input of [elements.downloadDir, elements.subtitleLangs, elements.playlistLimit]) {
  input.addEventListener('change', saveSettings);
}
elements.updateButton.addEventListener('click', () => updateYtDlp().catch((error) => {
  elements.updateButton.disabled = false;
  elements.updateStatus.className = 'error';
  elements.updateStatus.textContent = error.message;
}));
elements.pickFolder.addEventListener('click', () => pickFolder().catch((error) => {
  elements.pickFolder.disabled = false;
  elements.pickFolder.textContent = 'Parcourir…';
  elements.folderError.textContent = error.message;
  elements.folderError.hidden = false;
}));
elements.editShortcut.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
// Le raccourci peut etre modifie dans un autre onglet.
window.addEventListener('focus', () => showShortcut().catch((error) => console.error('Failed to read shortcut', error)));

loadSettings()
  .then(fillForm)
  .catch((error) => showSaveStatus(`Impossible de charger les réglages : ${error.message}`, 'error'));
checkHost().catch((error) => {
  elements.hostError.textContent = `Erreur : ${error.message}`;
  elements.hostError.hidden = false;
});
showLastUpdate().catch((error) => console.error('Failed to read last update', error));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ytdlpUpdate) showLastUpdate();
});
showShortcut().catch((error) => console.error('Failed to read shortcut', error));
