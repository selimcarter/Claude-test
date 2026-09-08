const serverUrlInput = document.getElementById('server-url');
const roomIdInput = document.getElementById('room-id');
const userNameInput = document.getElementById('user-name');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const errorEl = document.getElementById('error');

chrome.storage.sync.get(['serverUrl', 'roomId', 'name'], (saved) => {
  if (saved.serverUrl) serverUrlInput.value = saved.serverUrl;
  if (saved.roomId) roomIdInput.value = saved.roomId;
  if (saved.name) userNameInput.value = saved.name;
});

function renderStatus(status) {
  statusDot.classList.toggle('on', !!status.connected);
  if (status.connected) {
    const peerNames = (status.peers || []).map((p) => p.name).join(', ');
    statusText.textContent = `Connecte au salon ${status.roomId}` + (peerNames ? ` (avec ${peerNames})` : ' (en attente de l\'autre personne)');
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'block';
  } else {
    statusText.textContent = 'Non connecte';
    connectBtn.style.display = 'block';
    disconnectBtn.style.display = 'none';
  }
}

chrome.runtime.sendMessage({ scope: 'popup', type: 'get-status' }, (status) => {
  if (status) renderStatus(status);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.scope !== 'popup') return;
  if (msg.type === 'status') renderStatus(msg);
  if (msg.type === 'error') {
    errorEl.textContent = msg.message;
    errorEl.style.display = 'block';
  }
});

connectBtn.addEventListener('click', () => {
  const serverUrl = serverUrlInput.value.trim().replace(/\/$/, '');
  const roomId = roomIdInput.value.trim().toUpperCase();
  const name = userNameInput.value.trim();

  if (!serverUrl || !roomId || !name) {
    errorEl.textContent = 'Remplissez tous les champs.';
    errorEl.style.display = 'block';
    return;
  }
  errorEl.style.display = 'none';

  chrome.storage.sync.set({ serverUrl, roomId, name });
  chrome.runtime.sendMessage({ scope: 'popup', type: 'connect', serverUrl, roomId, name });
});

disconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ scope: 'popup', type: 'disconnect' });
});
