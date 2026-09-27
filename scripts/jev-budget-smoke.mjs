import assert from 'node:assert/strict';

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8788';
const password = process.env.SMOKE_RESET_PASSWORD;
if (!password) throw new Error('SMOKE_RESET_PASSWORD に試験用パスワードを設定してください');

async function post(path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  return response.json();
}
const owner = await post('/api/rooms', { name: '上限管理者' });
const guest = await post(`/api/rooms/${owner.roomId}/join`, { name: '参加者' });
const path = `/api/rooms/${owner.roomId}/jev-budget`;
const auth = token => ({ Authorization: `Bearer ${token}` });

assert.equal((await fetch(`${base}${path}`)).status, 401);
assert.equal((await fetch(`${base}${path}`, { headers: auth(guest.token) })).status, 403);
const statusResponse = await fetch(`${base}${path}`, { headers: auth(owner.token) });
assert.equal(statusResponse.status, 200);
const status = await statusResponse.json();
assert.equal(status.limit, 200);
assert.equal(status.resetAvailable, true);

if (process.env.SMOKE_TEST_CLAIM === '1') {
  const claimRoom = await post('/api/rooms', { name: '利用回数検証' });
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rooms/${claimRoom.roomId}`);
  let claimState;
  const send = (type, payload = {}) => socket.send(JSON.stringify({ type, payload }));
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.type === 'authRequired') send('auth', { token: claimRoom.token });
    if (message.type === 'state') claimState = message.payload;
  });
  try {
    const wait = async (check, label) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error(`Timed out: ${label}`);
    };
    await wait(() => claimState?.youId, 'auth');
    send('addCpu');
    await wait(() => claimState?.players.length === 2, 'CPU');
    send('ready');
    await wait(() => claimState?.readyToStart, 'ready');
    send('start');
    await wait(async () => {
      const response = await fetch(`${base}${path}`, { headers: auth(owner.token) });
      return (await response.json()).used > 0;
    }, 'Jev claim');
  } finally { socket.close(); }
}

async function reset(token, value) {
  return fetch(`${base}${path}/reset`, {
    method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: value }),
  });
}
assert.equal((await reset(guest.token, password)).status, 403);
assert.equal((await reset(owner.token, 'wrong-password')).status, 403);
const usedBeforeReset = (await (await fetch(`${base}${path}`, { headers: auth(owner.token) })).json()).used;
if (process.env.SMOKE_TEST_CLAIM === '1') assert.ok(usedBeforeReset > 0);
const cleared = await reset(owner.token, password);
assert.equal(cleared.status, 200);
assert.equal((await cleared.json()).remaining, 200);
assert.equal((await (await fetch(`${base}${path}`, { headers: auth(owner.token) })).json()).used, 0);
console.log(JSON.stringify({ roomId: owner.roomId, usedBeforeReset, ownerOnly: true, wrongPasswordRejected: true, reset: true }));
