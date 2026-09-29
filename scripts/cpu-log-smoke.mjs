import assert from 'node:assert/strict';

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8787';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const created = await fetch(`${base}/api/rooms`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ログ検証者' }),
});
assert.equal(created.status, 200);
const room = await created.json();
const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rooms/${room.roomId}`);
let state;
const errors = [];
function send(type, payload = {}) { socket.send(JSON.stringify({ type, payload })); }
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.type === 'authRequired') send('auth', { token: room.token });
  if (message.type === 'state') state = message.payload;
  if (message.type === 'error') errors.push(message.payload?.message);
});
async function wait(check, label, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (check(state)) return state; await sleep(50); }
  throw new Error(`Timed out: ${label}; state=${JSON.stringify(state)}; errors=${JSON.stringify(errors)}`);
}
async function readLogs() {
  const response = await fetch(`${base}/api/rooms/${room.roomId}/cpu-logs`, { headers: { Authorization: `Bearer ${room.token}` } });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  await wait(s => s?.youId, 'owner authenticated');
  send('addCpu');
  await wait(s => s?.players.length === 2, 'CPU added');
  const cpuId = state.players[1].id;
  send('ready');
  await wait(s => s?.readyToStart, 'ready');
  send('start');
  await wait(s => s?.round === 1 && s.phase === 'selecting', 'start');
  for (let attempt = 0; attempt < 2; attempt++) {
    const round = state.round;
    if (state.dealerId === state.youId) {
      await wait(s => s?.round === round && s.phase === 'reveal', `round ${round} answers`);
      for (let revealed = 1; revealed <= state.answers.length; revealed++) {
        send('reveal');
        await wait(s => s?.round === round && s.revealed === revealed, `round ${round} reveal ${revealed}`);
      }
      send('choose', { index: 0 });
    } else {
      send('select', { cardId: state.hand[0].id });
    }
    await wait(s => s?.round === round && (s.phase === 'roundResult' || s.phase === 'finished'), `round ${round} result`);
    if (attempt === 0) {
      if (state.dealerId === state.youId) send('advance');
      await wait(s => s?.round > round, `round ${round} advance`);
    }
  }
  send('finishEarly');
  await wait(s => s?.phase === 'finished', 'early finish');
  assert.equal(state.phase, 'finished', 'game should finish');
  assert.equal(state.finishedReason, 'early');
  assert.equal(state.completedRounds, 2);
  const completedRounds = state.completedRounds;
  assert.equal(state.hasCpuLogs, true);
  const log = await readLogs();
  assert.equal(log.roomId, room.roomId);
  assert.ok(log.entries.length >= 2, 'CPU answer and dealer choices should be logged');
  assert.ok(log.entries.some(entry => entry.role === 'answer'));
  assert.ok(log.entries.some(entry => entry.role === 'dealer'));
  for (const entry of log.entries) {
    assert.equal(entry.cpuId, cpuId);
    assert.equal(entry.selectedCard, entry.candidates[entry.selectedIndex]);
    assert.ok(entry.お題 && entry.instructions && entry.selectedAt);
    assert.ok(['jev', 'random'].includes(entry.source));
  }
  send('rematch');
  await wait(s => s?.phase === 'lobby', 'rematch lobby');
  assert.equal(state.hasCpuLogs, true);
  assert.deepEqual((await readLogs()).entries, log.entries, 'completed logs should survive rematch');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(JSON.stringify({ roomId: room.roomId, rounds: completedRounds, cpuChoices: log.entries.length, sources: log.entries.map(entry => entry.source), logAvailableAfterRematch: true }));
} finally { socket.close(); }
