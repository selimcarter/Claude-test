// Page de reglages : chaque modification est enregistree immediatement dans
// chrome.storage.local ("settings"), lue par le service worker a chaque
// telechargement et par le content script pour le bouton sur les pages.

const SUBTITLE_LANGS_PATTERN = /^[A-Za-z0-9*.\-_]+(,[A-Za-z0-9*.\-_]+)*$/;

const elements = {
  saveStatus: document.getElementById('save-status'),
  hostStatus: document.getElementById('host-status'),
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
  elements.saveStatus.className = className;
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

async function checkHost() {
  const result = await chrome.runtime.sendMessage({ type: 'CHECK_HOST' });
  const status = elements.hostStatus;
  if (!result?.ok) {
    status.className = 'error';
    status.textContent = `Hôte natif introuvable : lancez le script d'installation. ${result?.error || ''}`;
    elements.updateButton.disabled = true;
    elements.pickFolder.disabled = true;
    return;
  }
  const parts = [
    result.ytDlpVersion ? `yt-dlp ${result.ytDlpVersion} ✓` : 'yt-dlp absent ✗',
    result.ffmpeg ? 'ffmpeg ✓' : 'ffmpeg absent ✗',
    result.deno ? 'Deno ✓' : 'Deno absent ✗ (nécessaire pour YouTube)',
  ];
  status.className = result.ytDlpVersion && result.ffmpeg && result.deno ? 'ok' : 'warn';
  status.textContent = parts.join(' · ');
  elements.downloadDir.placeholder = result.defaultDownloadDir || '';
}

async function updateYtDlp() {
  elements.updateButton.disabled = true;
  elements.updateStatus.className = 'muted';
  elements.updateStatus.textContent = 'Mise à jour en cours… (jusqu\'à quelques minutes)';
  elements.updateOutput.hidden = true;

  const result = await chrome.runtime.sendMessage({ type: 'UPDATE_YTDLP' });
  elements.updateButton.disabled = false;
  if (!result?.ok || !result.updated) {
    elements.updateStatus.className = 'error';
    elements.updateStatus.textContent = 'Échec de la mise à jour.';
    elements.updateOutput.textContent = result?.output || result?.error || '';
    elements.updateOutput.hidden = !elements.updateOutput.textContent;
    return;
  }
  elements.updateStatus.className = 'ok';
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

for (const input of [elements.thumbnail, elements.subtitles, elements.cookiesBrowser, elements.showPageButton]) {
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
  elements.hostStatus.className = 'error';
  elements.hostStatus.textContent = `Erreur : ${error.message}`;
});
showShortcut().catch((error) => console.error('Failed to read shortcut', error));
