import assert from 'node:assert/strict';

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8787';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function create(path, name) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  assert.ok(response.ok);
  return response.json();
}
function connect(roomId, token) {
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rooms/${roomId}`);
  let state;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.type === 'authRequired') socket.send(JSON.stringify({ type: 'auth', payload: { token } }));
    if (message.type === 'state') state = message.payload;
  });
  return { socket, state: () => state };
}
async function until(predicate, label, timeoutMs = 130000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(`Timeout: ${label}`);
}

const owner = await create('/api/rooms', '管理者');
const second = await create(`/api/rooms/${owner.roomId}/join`, '引き継ぐ人');
const ownerPeer = connect(owner.roomId, owner.token);
const secondPeer = connect(owner.roomId, second.token);
try {
  await until(() => ownerPeer.state()?.players.length === 2 && secondPeer.state()?.players.length === 2, 'both connected', 10000);
  ownerPeer.socket.close();
  await until(() => secondPeer.state()?.paused, 'pause after owner left', 10000);
  await until(() => secondPeer.state()?.ownerId === second.memberId, 'owner transfer');
  secondPeer.socket.send(JSON.stringify({ type: 'remove', payload: { memberId: owner.memberId } }));
  await until(() => secondPeer.state()?.players.length === 1 && !secondPeer.state()?.paused, 'remove old owner', 10000);
  console.log(JSON.stringify({ roomId: owner.roomId, transfer: 'ok', oldOwnerRemoval: 'ok' }));
} finally {
  ownerPeer.socket.close(); secondPeer.socket.close();
  setTimeout(() => process.exit(), 200);
}
