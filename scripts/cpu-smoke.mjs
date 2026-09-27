import assert from 'node:assert/strict';

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8787';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '人間' }) });
assert.equal(response.status, 200);
const room = await response.json();
const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rooms/${room.roomId}`);
let state;
const errors = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.type === 'authRequired') send('auth', { token: room.token });
  if (message.type === 'state') state = message.payload;
  if (message.type === 'error') errors.push(message.payload?.message);
});
function send(type, payload = {}) { socket.send(JSON.stringify({ type, payload })); }
async function wait(check, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (check(state)) return state; await sleep(50); }
  throw new Error(`Timed out: ${label}; state=${JSON.stringify(state)}; errors=${JSON.stringify(errors)}`);
}
try {
  await wait(s => s?.youId, 'auth');
  send('addCpu');
  await wait(s => s?.players.length === 2, 'CPU added');
  assert.equal(state.players[1].cpu, true);
  assert.equal(state.players[1].ready, true);
  assert.equal(state.players[1].online, true);
  assert.ok(state.cpuDefaults.answer.includes('themeとの噛み合い'));
  assert.equal(state.cpuPrompts[state.players[1].id].answer, state.cpuDefaults.answer);
  const publicView = await (await fetch(`${base}/api/rooms/${room.roomId}`)).json();
  assert.equal(publicView.cpuPrompts, undefined, 'CPU instructions should only be sent to the owner');
  send('updateCpuPrompts', { memberId: state.players[1].id, prompts: { answer: '独自の回答用指示文', dealer: '独自の親用指示文' } });
  await wait(s => s?.cpuPrompts?.[s.players[1].id]?.answer === '独自の回答用指示文', 'CPU prompts updated');
  assert.equal(state.cpuPrompts[state.players[1].id].dealer, '独自の親用指示文');
  send('ready');
  await wait(s => s?.readyToStart, 'ready to start');
  send('start');
  await wait(s => s?.phase === 'selecting' && s.hand.length === 5, 'first round');
  await wait(s => s?.phase === 'reveal', 'CPU submitted card');
  const earlyLog = await fetch(`${base}/api/rooms/${room.roomId}/cpu-logs`, { headers: { Authorization: `Bearer ${room.token}` } });
  assert.equal(earlyLog.status, 409, 'CPU choices should stay hidden until the game ends');
  const unauthenticatedLog = await fetch(`${base}/api/rooms/${room.roomId}/cpu-logs`);
  assert.equal(unauthenticatedLog.status, 401);
  for (let i = 1; i <= 2; i++) {
    send('reveal'); await wait(s => s?.revealed === i, `reveal ${i}`);
  }
  send('choose', { index: state.answers[0].index });
  await wait(s => s?.phase === 'countdown', 'countdown');
  await wait(s => s?.phase === 'roundResult', 'first result');
  send('advance');
  await wait(s => s?.round === 2 && s.phase === 'selecting' && s.dealerId !== s.youId, 'CPU dealer');
  send('select', { cardId: state.hand[0].id });
  await wait(s => s?.phase === 'reveal', 'second reveal');
  await wait(s => s?.phase === 'countdown', 'CPU revealed and chose', 20000);
  assert.equal(state.revealed, state.answers.length);
  await wait(s => s?.phase === 'roundResult', 'second result');
  send('finishEarly');
  await wait(s => s?.phase === 'finished', 'early finish');
  assert.equal(state.finishedReason, 'early');
  assert.equal(state.completedRounds, 2);
  send('rematch');
  await wait(s => s?.phase === 'lobby', 'rematch lobby');
  assert.equal(state.players[1].ready, true, 'CPU should remain ready after rematch');
  send('ready');
  await wait(s => s?.readyToStart, 'ready after reset');
  send('remove', { memberId: state.players[1].id });
  await wait(s => s?.players.length === 1, 'remove CPU');
  assert.equal(state.readyToStart, false);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(JSON.stringify({ roomId: room.roomId, answered: true, dealerChose: true, earlyFinish: true, removal: true }));
} finally { socket.close(); }
