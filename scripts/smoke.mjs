import assert from 'node:assert/strict';

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8787';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(path, body) {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
  return data;
}

class Peer {
  constructor(token, roomId) {
    this.token = token;
    this.roomId = roomId;
    this.state = null;
    this.errors = [];
    this.closeCode = null;
    this.socket = null;
  }
  async connect() {
    const wsUrl = `${base.replace(/^http/, 'ws')}/ws/rooms/${this.roomId}`;
    this.socket = new WebSocket(wsUrl);
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'authRequired') this.send('auth', { token: this.token });
      if (message.type === 'state') this.state = message.payload;
      if (message.type === 'error') this.errors.push(message.payload?.message);
    });
    this.socket.addEventListener('close', event => { this.closeCode = event.code; });
    await this.wait(state => state?.youId !== null && state?.youId !== undefined);
  }
  send(type, payload = {}) {
    assert.equal(this.socket?.readyState, WebSocket.OPEN, `${type}: socket is not open`);
    this.socket.send(JSON.stringify({ type, payload }));
  }
  async wait(predicate, label = 'state', timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (predicate(this.state)) return this.state;
      await delay(20);
    }
    throw new Error(`Timeout waiting for ${label}. Last state: ${JSON.stringify(this.state)}`);
  }
  close() { this.socket?.close(); }
}

const created = await request('/api/rooms', { name: '親' });
const joined = await request(`/api/rooms/${created.roomId}/join`, { name: '友達' });
const owner = new Peer(created.token, created.roomId);
const friend = new Peer(joined.token, created.roomId);
const peers = [owner, friend];
try {
  await owner.connect(); await friend.connect();
  assert.equal(owner.state.players.length, 2);
  assert.equal(owner.state.phase, 'lobby');
  owner.send('ready'); friend.send('ready');
  await owner.wait(s => s?.readyToStart, 'both players ready');
  owner.send('start');
  await owner.wait(s => s?.phase === 'selecting' && s.hand.length === 5, 'game start');
  await friend.wait(s => s?.phase === 'selecting' && s.hand.length === 5, 'second hand');
  assert.equal((await request(`/api/rooms/${created.roomId}`)).hand.length, 0, 'public view exposed a hand');
  friend.send('reveal');
  await friend.wait(() => friend.errors.length > 0, 'unauthorized reveal error');
  assert.match(friend.errors.pop(), /公開できません/);
  friend.send('select', { cardId: -1 });
  await friend.wait(() => friend.errors.length > 0, 'invalid card error');
  assert.match(friend.errors.pop(), /手札からカード/);

  // Disconnect pauses the table; the same token resumes the same seat.
  friend.close();
  await owner.wait(s => s?.paused, 'pause after disconnect');
  assert.equal(owner.state.players.find(player => player.id === joined.memberId).online, false);
  const returningFriend = new Peer(joined.token, created.roomId);
  await returningFriend.connect(); peers[1] = returningFriend;
  await owner.wait(s => s && !s.paused, 'resume after reconnect');
  assert.equal(returningFriend.state.hand.length, 5);

  // A mid-game visitor watches, then takes an open seat on rematch.
  const spectatorCredentials = await request(`/api/rooms/${created.roomId}/join`, { name: '観戦者' });
  assert.equal(spectatorCredentials.spectator, true);
  const spectator = new Peer(spectatorCredentials.token, created.roomId);
  await spectator.connect(); peers.push(spectator);
  assert.equal(spectator.state.spectator, true);
  assert.equal(spectator.state.hand.length, 0);

  let rounds = 0;
  while (owner.state.phase !== 'finished' && rounds < 10) {
    rounds++;
    const dealer = peers.find(peer => peer.state.youId === owner.state.dealerId);
    const answerer = peers.find(peer => peer !== spectator && peer !== dealer);
    assert.ok(dealer && answerer);
    assert.equal(answerer.state.phase, 'selecting');
    const playedCard = answerer.state.hand[0];
    answerer.send('select', { cardId: playedCard.id });
    await dealer.wait(s => s?.phase === 'reveal', 'reveal phase');
    const answerCount = dealer.state.answers.length;
    for (let i = 1; i <= answerCount; i++) {
      dealer.send('reveal');
      await dealer.wait(s => s?.revealed === i, `reveal ${i}`);
    }
    const chosenAnswer = dealer.state.answers.find(answer => answer.card === playedCard.name);
    assert.ok(chosenAnswer, 'selected card was not revealed');
    const scoreBefore = dealer.state.players.map(player => ({ id: player.id, score: player.score }));
    const chosenAt = Date.now();
    dealer.send('choose', { index: chosenAnswer.index });
    await dealer.wait(s => s?.phase === 'countdown', 'result countdown');
    assert.equal(dealer.state.chosenCard, chosenAnswer.card, 'chosen card should be visible during countdown');
    assert.equal(dealer.state.chosenIndex, chosenAnswer.index, 'chosen answer should stay highlighted');
    assert.ok(dealer.state.answers.every(answer => answer.card), 'all answers should remain visible during countdown');
    assert.equal(dealer.state.result, null, 'winner must stay hidden during countdown');
    assert.deepEqual(dealer.state.players.map(player => ({ id: player.id, score: player.score })), scoreBefore, 'score must stay hidden during countdown');
    await dealer.wait(s => s?.phase === 'roundResult' || s?.phase === 'finished', 'round result');
    assert.ok(Date.now() - chosenAt >= 2500, 'result was revealed before the countdown');
    if (dealer.state.phase === 'roundResult') {
      dealer.send('advance');
      await dealer.wait(s => s?.phase === 'selecting', 'next round');
      await answerer.wait(s => s?.phase === 'selecting', 'next round for other player');
    }
  }
  assert.equal(owner.state.phase, 'finished', 'game did not finish after ten rounds');
  assert.equal(rounds, 10);
  assert.equal(owner.state.completedRounds, 10);
  assert.equal(owner.state.finishedReason, 'roundLimit');
  assert.equal(owner.state.players.reduce((sum, player) => sum + player.score, 0), 10);
  const highestScore = Math.max(...owner.state.players.map(player => player.score));
  const winners = owner.state.players.filter(player => player.score === highestScore).map(player => player.name);
  owner.send('rematch');
  await spectator.wait(s => s?.phase === 'lobby' && !s.spectator, 'spectator promoted');
  assert.equal(owner.state.players.length, 3);
  owner.send('ready'); returningFriend.send('ready'); spectator.send('ready');
  await owner.wait(s => s?.readyToStart, 'rematch ready');
  owner.send('start');
  await owner.wait(s => s?.phase === 'selecting' && s.players.length === 3, 'three-player game');
  owner.send('finishEarly');
  await owner.wait(s => s?.phase === 'finished' && s.finishedReason === 'early', 'early finish');
  assert.equal(owner.state.completedRounds, 0);
  owner.send('rematch');
  await owner.wait(s => s?.phase === 'lobby' && s.players.every(player => player.score === 0), 'rematch after early finish');
  owner.send('remove', { memberId: spectatorCredentials.memberId });
  await owner.wait(s => s?.players.length === 2, 'player removal');
  await spectator.wait(() => spectator.closeCode === 4003, 'removed player socket closed');
  const duplicate = new Peer(created.token, created.roomId);
  await duplicate.connect(); peers.push(duplicate);
  await owner.wait(() => owner.closeCode === 4001, 'older tab replaced');
  await duplicate.wait(s => !s?.paused && s?.players.find(player => player.id === created.memberId)?.online, 'new tab remains active');

  const invalidSocket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rooms/${created.roomId}`);
  const invalidClose = await new Promise((resolve, reject) => {
    invalidSocket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'authRequired') invalidSocket.send(JSON.stringify({ type: 'auth', payload: { token: 'invalid' } }));
    });
    invalidSocket.addEventListener('close', event => resolve(event.code), { once: true });
    invalidSocket.addEventListener('error', reject, { once: true });
  });
  assert.equal(invalidClose, 4003);
  console.log(JSON.stringify({ roomId: created.roomId, rounds, reconnect: 'ok', spectatorPromotion: 'ok', earlyFinish: 'ok', removal: 'ok', tabTakeover: 'ok', invalidAuth: 'ok', winners }));
} finally {
  for (const peer of peers) peer.close();
  setTimeout(() => process.exit(), 200);
}
