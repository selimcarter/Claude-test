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
  const res = await fetch(`${URL}/api/ice-servers`);
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
  const { peers } = await join(b2, 'GRACE1', 'bob-12345');
  assert.deepStrictEqual(await reconnected, { id: 'bob-12345' });
  assert.deepStrictEqual(peers.map((p) => p.id), ['alice-1234']);

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
