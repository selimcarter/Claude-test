// Tests du serveur de salons : delai de grace, retour avec la meme identite,
// salon complet, resistance aux messages mal formes. Lancer : npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 3990;
const URL = `http://localhost:${PORT}`;
const GRACE_MS = 400;
let server;

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), GRACE_MS: String(GRACE_MS) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => server.stdout.on('data', (d) => { if (String(d).includes('running')) resolve(); }));
});

const sockets = [];
after(() => {
  sockets.forEach((s) => s.close());
  server.kill();
});

function connect() {
  const s = io(URL, { forceNew: true, reconnection: false, transports: ['websocket'] });
  sockets.push(s);
  return s;
}
const once = (s, event) => new Promise((resolve) => s.once(event, resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function join(s, roomId, clientId, extra = {}) {
  if (!s.connected) await once(s, 'connect');
  const joined = once(s, 'joined');
  s.emit('join-room', { roomId, name: clientId, clientId, ...extra });
  return joined;
}

test('un message vide ne fait pas planter le serveur', async () => {
  const s = connect();
  await once(s, 'connect');
  s.emit('chat-message');
  s.emit('join-room', null);
  s.emit('webrtc-signal');
  await sleep(200);
  const res = await fetch(URL);
  assert.ok(res.ok);
});

test('retour dans le delai de grace : pas de depart annonce', async () => {
  const a = connect();
  const b = connect();
  await join(a, 'GRACE1', 'alice-1234');
  await join(b, 'GRACE1', 'bob-12345');

  const events = [];
  a.on('peer-left', () => events.push('left'));
  const reconnecting = once(a, 'peer-reconnecting');
  b.close();
  assert.deepStrictEqual(await reconnecting, { id: 'bob-12345' });

  const b2 = connect();
  const reconnected = once(a, 'peer-reconnected');
  const { peers, reset } = await join(b2, 'GRACE1', 'bob-12345');
  assert.deepStrictEqual(await reconnected, { id: 'bob-12345' });
  assert.deepStrictEqual(peers.map((p) => p.id), ['alice-1234']);
  assert.strictEqual(reset, false, 'les connexions video doivent etre gardees');

  await sleep(GRACE_MS + 200);
  assert.deepStrictEqual(events, [], 'aucun peer-left ne doit etre envoye');
});

test("retour alors que l'ancienne connexion semble encore vivante : la place est reprise", async () => {
  const a = connect();
  const b = connect();
  await join(a, 'GHOST1', 'alice-1234');
  await join(b, 'GHOST1', 'bob-12345');

  // b revient avec une nouvelle connexion sans que l'ancienne soit fermee :
  // avant la correction, le serveur repondait "salon complet".
  const b2 = connect();
  const kicked = once(b, 'disconnect');
  const { peers } = await join(b2, 'GHOST1', 'bob-12345');
  assert.deepStrictEqual(peers.map((p) => p.id), ['alice-1234']);
  await kicked;
});

test('sans retour, le depart est annonce apres le delai de grace', async () => {
  const a = connect();
  const b = connect();
  await join(a, 'GRACE2', 'alice-1234');
  await join(b, 'GRACE2', 'bob-12345');
  const left = once(a, 'peer-left');
  const start = Date.now();
  b.close();
  assert.deepStrictEqual(await left, { id: 'bob-12345' });
  assert.ok(Date.now() - start >= GRACE_MS - 50);
});

test('salon complet : la 3e personne ne recoit pas le chat et ne coupe rien en partant', async () => {
  const a = connect();
  const b = connect();
  const c = connect();
  await join(a, 'FULL1', 'alice-1234');
  await join(b, 'FULL1', 'bob-12345');

  if (!c.connected) await once(c, 'connect');
  const full = once(c, 'room-full');
  c.emit('join-room', { roomId: 'FULL1', name: 'carol', clientId: 'carol-1234' });
  await full;

  const leaks = [];
  c.on('chat-message', () => leaks.push('chat'));
  a.on('peer-left', () => leaks.push('peer-left'));
  c.emit('chat-message', { text: 'intrus' });
  a.emit('chat-message', { text: 'prive' });
  await sleep(200);
  c.close();
  await sleep(GRACE_MS + 200);
  assert.deepStrictEqual(leaks, []);
});

test('une place en delai de grace reste reservee', async () => {
  const a = connect();
  const b = connect();
  await join(a, 'GRACE3', 'alice-1234');
  await join(b, 'GRACE3', 'bob-12345');
  b.close();
  await once(a, 'peer-reconnecting');

  const c = connect();
  if (!c.connected) await once(c, 'connect');
  const full = once(c, 'room-full');
  c.emit('join-room', { roomId: 'GRACE3', name: 'carol', clientId: 'carol-1234' });
  await full;
});

test('rechargement de page (fresh) : les deux cotes repartent de zero', async () => {
  const a = connect();
  const b = connect();
  await join(a, 'FRESH1', 'alice-1234');
  await join(b, 'FRESH1', 'bob-12345');
  const b2 = connect();
  const joinedAgain = once(a, 'peer-joined');
  const { reset } = await join(b2, 'FRESH1', 'bob-12345', { fresh: true });
  assert.strictEqual(reset, true);
  assert.strictEqual((await joinedAgain).id, 'bob-12345');
});

test("la config du relais n'est donnee qu'aux personnes qui entrent dans un salon", async () => {
  const res = await fetch(`${URL}/api/ice-servers`);
  assert.strictEqual(res.status, 404);
  const a = connect();
  const { iceServers } = await join(a, 'ICE1', 'alice-1234');
  assert.ok(Array.isArray(iceServers) && iceServers.length > 0);
});

test('YouTube : position relayee, donnees invalides ignorees', async () => {
  const a = connect();
  const b = connect();
  await join(a, 'YT1', 'alice-1234');
  await join(b, 'YT1', 'bob-12345');
  const received = [];
  b.on('yt-load', (m) => received.push(m));
  b.on('platform-select', (m) => received.push(m));
  a.emit('yt-load', { videoId: '<img src=x>' });
  a.emit('platform-select', { platform: 'evil' });
  a.emit('yt-load', { videoId: 'dQw4w9WgXcQ', time: 42.5, playing: false });
  await sleep(200);
  assert.deepStrictEqual(received, [{ videoId: 'dQw4w9WgXcQ', time: 42.5, playing: false }]);
});

test('limite du chat : le spam est ignore au-dela de 10 messages en 10 s', async () => {
  const a = connect();
  await join(a, 'SPAM1', 'alice-1234');
  let count = 0;
  a.on('chat-message', () => { count += 1; });
  for (let i = 0; i < 30; i++) a.emit('chat-message', { text: `spam ${i}` });
  await sleep(300);
  assert.strictEqual(count, 10);
});

test("une page d'un autre site ne peut pas se connecter", async () => {
  const s = io(URL, { forceNew: true, reconnection: false, transports: ['websocket'], extraHeaders: { origin: 'https://site-pirate.example' } });
  sockets.push(s);
  const err = await once(s, 'connect_error');
  assert.ok(err);
  const res = await fetch(URL);
  assert.ok(res.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.strictEqual(res.headers.get('x-powered-by'), null);
});

test('extension : entree dans le salon avec la config du relais, heartbeat accepte', async () => {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://localhost:${PORT}/ext-ws`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'ping' }));
  ws.send(JSON.stringify({ type: 'join', roomId: 'EXT1', name: 'ext' }));
  const [raw] = await once(ws, 'message').then((m) => [m]);
  const msg = JSON.parse(raw);
  assert.strictEqual(msg.type, 'joined');
  assert.ok(Array.isArray(msg.iceServers) && msg.iceServers.length > 0);
  ws.close();
});
