import thingsJson from '../data/ata_things.json';
import descriptionsJson from '../data/ata_descriptions.json';
import { chooseCpuCard, type JevBinding } from './cpu';

type Env = { ROOMS: DurableObjectNamespace; ASSETS: Fetcher; AI?: JevBinding };
type Card = { name: string; type?: number };
type Member = { id: string; name: string; tokenHash: string; spectator: boolean; ready: boolean; cpu?: boolean };
type Player = Member & { spectator: false; score: number; hand: number[]; selection?: number };
type Answer = { cardId: number; playerId: string | null };
type Game = {
  schema: number; id: string; createdAt: number; updatedAt: number; ownerId: string;
  phase: 'lobby' | 'selecting' | 'reveal' | 'countdown' | 'roundResult' | 'finished'; paused: boolean;
  pauseReason?: string; ownerDisconnectedAt?: number; cpuNextAt?: number; round: number; dealerId: string;
  players: Player[]; spectators: Member[];
  deck: number[]; discard: number[]; descriptionDeck: number[]; descriptionDiscard: number[];
  currentDescription?: number; answers: Answer[]; revealed: number; chosenIndex?: number; revealAt?: number;
  result?: { winnerId: string | null; cardId: number; dummy: boolean };
};

const things = (thingsJson as { members: Card[] }).members;
const descriptions = (descriptionsJson as { members: Card[] }).members;
const MAX_PLAYERS = 8;
const MAX_SPECTATORS = 24;
const ROOM_TTL = 24 * 60 * 60 * 1000;
const OWNER_GRACE = 2 * 60 * 1000;
const RESULT_COUNTDOWN = 3000;
const CPU_DELAY = 900;
const CPU_RESULT_DELAY = 3000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}
function randomId(bytes = 16): string {
  const data = new Uint8Array(bytes); crypto.getRandomValues(data);
  return Array.from(data, b => b.toString(16).padStart(2, '0')).join('');
}
function shuffled<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const bytes = new Uint32Array(1); crypto.getRandomValues(bytes);
    const j = bytes[0] % (i + 1); [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
function safeName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('名前を入力してください');
  const name = value.trim();
  if (!name || [...name].length > 16) throw new Error('名前は1〜16文字で入力してください');
  return name;
}
function newDeck(size: number): number[] { return shuffled(Array.from({ length: size }, (_, i) => i)); }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      try {
        const body = await request.json() as { name?: unknown };
        const name = safeName(body.name);
        const id = randomId(6);
        const token = randomId(32);
        const room = env.ROOMS.get(env.ROOMS.idFromName(id));
        const response = await room.fetch('https://room/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name, tokenHash: await hashToken(token) }),
        });
        if (!response.ok) return response;
        const created = await response.json() as Record<string, unknown>;
        return json({ ...created, token });
      } catch (error) { return json({ error: error instanceof Error ? error.message : '部屋を作成できませんでした' }, 400); }
    }
    const roomMatch = url.pathname.match(/^\/api\/rooms\/([a-f0-9]{12})(?:\/(join))?$/);
    if (roomMatch && request.method === 'GET' && !roomMatch[2]) {
      return env.ROOMS.get(env.ROOMS.idFromName(roomMatch[1])).fetch('https://room/public');
    }
    if (roomMatch && request.method === 'POST' && roomMatch[2] === 'join') {
      try {
        const body = await request.json() as { name?: unknown };
        const name = safeName(body.name);
        const token = randomId(32);
        const response = await env.ROOMS.get(env.ROOMS.idFromName(roomMatch[1])).fetch('https://room/join', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, tokenHash: await hashToken(token) }),
        });
        if (!response.ok) return response;
        const joined = await response.json() as Record<string, unknown>;
        return json({ ...joined, token });
      } catch (error) { return json({ error: error instanceof Error ? error.message : '参加できませんでした' }, 400); }
    }
    const wsMatch = url.pathname.match(/^\/ws\/rooms\/([a-f0-9]{12})$/);
    if (wsMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      return env.ROOMS.get(env.ROOMS.idFromName(wsMatch[1])).fetch(request);
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};

export class GameRoom {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly closingSockets = new WeakSet<WebSocket>();
  private cpuBusy = false;
  private game?: Game;
  private readonly ready: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.ready = state.blockConcurrencyWhile(async () => {
      this.game = await state.storage.get<Game>('game');
    });
  }

  private async save(): Promise<void> {
    const game = this.requireGame();
    game.updatedAt = Date.now();
    await this.state.storage.put('game', game);
    const deadline = game.ownerDisconnectedAt ? game.ownerDisconnectedAt + OWNER_GRACE : Infinity;
    const ownerDeadline = deadline > Date.now() ? deadline : Infinity;
    const revealDeadline = game.phase === 'countdown' && game.revealAt ? game.revealAt : Infinity;
    if (this.hasCpuAction() && !this.cpuBusy) game.cpuNextAt ??= Date.now() + (game.phase === 'roundResult' ? CPU_RESULT_DELAY : CPU_DELAY);
    else game.cpuNextAt = undefined;
    await this.state.storage.setAlarm(Math.min(game.updatedAt + ROOM_TTL, ownerDeadline, revealDeadline, game.cpuNextAt ?? Infinity));
  }
  private requireGame(): Game {
    if (!this.game) throw new Error('部屋が見つかりません');
    return this.game;
  }
  private player(memberId: string): Player | undefined { return this.requireGame().players.find(p => p.id === memberId); }
  private socketMember(socket: WebSocket): string | undefined {
    return (socket.deserializeAttachment() as { memberId?: string } | null)?.memberId;
  }
  private onlineIds(): Set<string> {
    const ids = new Set(this.state.getWebSockets().filter(ws => ws.readyState === 1 && !this.closingSockets.has(ws)).map(ws => this.socketMember(ws)).filter((id): id is string => !!id));
    for (const player of this.game?.players ?? []) if (player.cpu) ids.add(player.id);
    return ids;
  }
  private view(memberId?: string): unknown {
    const game = this.requireGame(); const online = this.onlineIds();
    const me = memberId ? game.players.find(p => p.id === memberId) ?? game.spectators.find(p => p.id === memberId) : undefined;
    const answers = game.answers.map((answer, index) => index < game.revealed
      ? { index, card: things[answer.cardId].name }
      : { index, card: null });
    return {
      id: game.id, phase: game.phase, paused: game.paused, pauseReason: game.pauseReason,
      round: game.round, currentDescription: game.currentDescription === undefined ? null : descriptions[game.currentDescription].name,
      dealerId: game.dealerId, ownerId: game.ownerId, youId: memberId ?? null,
      youAreOwner: memberId === game.ownerId, spectator: !!me && !game.players.some(p => p.id === memberId),
      players: game.players.map(p => ({ id: p.id, name: p.name, score: p.score, ready: p.ready, online: online.has(p.id), isDealer: p.id === game.dealerId, cpu: !!p.cpu })),
      spectators: game.spectators.length, answers, revealed: game.revealed,
      chosenCard: game.phase === 'countdown' && game.chosenIndex !== undefined ? things[game.answers[game.chosenIndex].cardId].name : null,
      chosenIndex: game.phase === 'countdown' ? game.chosenIndex ?? null : null,
      countdownEndsAt: game.phase === 'countdown' ? game.revealAt ?? null : null, serverNow: Date.now(),
      result: game.result ? { ...game.result, winnerName: game.result.winnerId ? game.players.find(p => p.id === game.result!.winnerId)?.name ?? '退出したプレイヤー' : null, card: things[game.result.cardId].name } : null,
      hand: memberId ? this.player(memberId)?.hand.map(id => ({ id, name: things[id].name })) ?? [] : [],
      yourSelection: memberId ? this.player(memberId)?.selection ?? null : null,
      readyToStart: !game.paused && game.players.length >= 2 && game.players.every(p => p.ready && online.has(p.id)),
    };
  }
  private send(socket: WebSocket, type: string, payload?: unknown): void {
    try { socket.send(JSON.stringify({ type, payload })); } catch { /* closed socket */ }
  }
  private broadcast(): void {
    for (const socket of this.state.getWebSockets()) this.send(socket, 'state', this.view(this.socketMember(socket)));
  }
  private broadcastNotice(message: string): void {
    for (const socket of this.state.getWebSockets()) this.send(socket, 'notice', { message });
  }
  private drawThing(): number {
    const game = this.requireGame();
    if (!game.deck.length) { game.deck = shuffled(game.discard); game.discard = []; }
    const card = game.deck.pop();
    if (card === undefined) throw new Error('カードを引けませんでした');
    return card;
  }
  private nextDescription(): void {
    const game = this.requireGame();
    if (!game.descriptionDeck.length) { game.descriptionDeck = shuffled(game.descriptionDiscard); game.descriptionDiscard = []; }
    if (game.currentDescription !== undefined) game.descriptionDiscard.push(game.currentDescription);
    game.currentDescription = game.descriptionDeck.pop();
  }
  private beginRound(): void {
    const game = this.requireGame();
    const played = new Set(game.answers.map(answer => answer.cardId));
    game.players.forEach(player => { if (player.selection !== undefined) played.add(player.selection); });
    game.discard.push(...played);
    this.nextDescription();
    game.phase = 'selecting'; game.answers = []; game.revealed = 0; game.result = undefined; game.chosenIndex = undefined; game.revealAt = undefined;
    for (const player of game.players) player.selection = undefined;
  }
  private promoteSpectators(): void {
    const game = this.requireGame();
    const seats = Math.max(0, MAX_PLAYERS - game.players.length);
    const nextPlayers = game.spectators.splice(0, seats);
    game.players.push(...nextPlayers.map(member => ({
      ...member, spectator: false as const, score: 0, hand: [], selection: undefined,
    })));
  }
  private resetForLobby(): void {
    const game = this.requireGame();
    this.promoteSpectators();
    game.deck = newDeck(things.length); game.discard = [];
    game.descriptionDeck = newDeck(descriptions.length); game.descriptionDiscard = [];
    game.players.forEach(player => { player.score = 0; player.ready = !!player.cpu; player.hand = []; player.selection = undefined; });
    game.phase = 'lobby'; game.paused = false; game.pauseReason = undefined; game.ownerDisconnectedAt = undefined;
    game.round = 0; game.dealerId = game.ownerId; game.result = undefined;
    game.answers = []; game.currentDescription = undefined; game.revealed = 0; game.chosenIndex = undefined; game.revealAt = undefined;
  }
  private transferOwnerIfDue(now = Date.now()): void {
    const game = this.requireGame();
    if (!game.ownerDisconnectedAt || game.ownerDisconnectedAt + OWNER_GRACE > now) return;
    const online = this.onlineIds();
    const successor = game.players.find(player => !player.cpu && player.id !== game.ownerId && online.has(player.id));
    if (!successor) return;
    game.ownerId = successor.id; game.ownerDisconnectedAt = undefined;
    this.broadcastNotice(`${successor.name}さんに部屋の管理を引き継ぎました`);
  }
  private isDealer(memberId: string): boolean { return this.requireGame().dealerId === memberId; }
  private assertOwner(memberId: string): void {
    if (this.requireGame().ownerId !== memberId) throw new Error('この操作は部屋の作成者だけが行えます');
  }
  private assertNotPaused(): void { if (this.requireGame().paused) throw new Error('参加者の復帰を待っています'); }

  private hasCpuAction(): boolean {
    const game = this.requireGame();
    if (game.paused) return false;
    if (game.phase === 'selecting') return game.players.some(p => p.cpu && p.id !== game.dealerId && p.selection === undefined);
    if (game.phase === 'reveal' || game.phase === 'roundResult') return !!game.players.find(p => p.id === game.dealerId)?.cpu;
    return false;
  }

  private selectCard(player: Player, cardId: number): void {
    const game = this.requireGame();
    player.selection = cardId;
    player.hand.splice(player.hand.indexOf(cardId), 1);
    player.hand.push(this.drawThing());
    if (game.players.filter(p => p.id !== game.dealerId).every(p => p.selection !== undefined)) {
      game.answers = shuffled([
        ...game.players.filter(p => p.id !== game.dealerId).map(p => ({ cardId: p.selection!, playerId: p.id })),
        { cardId: this.drawThing(), playerId: null },
      ]);
      game.phase = 'reveal'; game.revealed = 0;
    }
  }

  private chooseAnswer(index: number): void {
    const game = this.requireGame();
    game.chosenIndex = index; game.revealAt = Date.now() + RESULT_COUNTDOWN;
    game.phase = 'countdown';
  }

  private advanceRound(): void {
    const game = this.requireGame();
    const current = game.players.findIndex(p => p.id === game.dealerId);
    game.dealerId = game.players[(current + 1) % game.players.length].id;
    game.round++; this.beginRound();
  }

  private async cpuStep(): Promise<void> {
    const game = this.requireGame();
    if (!this.hasCpuAction()) return;
    if (game.phase === 'selecting') {
      const player = game.players.find(p => p.cpu && p.id !== game.dealerId && p.selection === undefined)!;
      const round = game.round; const hand = [...player.hand];
      const theme = descriptions[game.currentDescription!].name;
      const index = await chooseCpuCard(this.env.AI, theme, hand.map(id => things[id].name), 'answer');
      if (this.game !== game || game.paused || game.phase !== 'selecting' || game.round !== round || !game.players.includes(player) || player.selection !== undefined) return;
      const cardId = hand[index];
      if (player.hand.includes(cardId)) this.selectCard(player, cardId);
      return;
    }
    if (game.phase === 'reveal') {
      if (game.revealed < game.answers.length) { game.revealed++; return; }
      const round = game.round; const answers = game.answers;
      const theme = descriptions[game.currentDescription!].name;
      const index = await chooseCpuCard(this.env.AI, theme, answers.map(answer => things[answer.cardId].name), 'dealer');
      if (this.game !== game || game.paused || game.phase !== 'reveal' || game.round !== round || game.answers !== answers || game.revealed !== answers.length) return;
      this.chooseAnswer(index); return;
    }
    if (game.phase === 'roundResult') this.advanceRound();
  }

  private finishCountdown(): void {
    const game = this.requireGame();
    if (game.phase !== 'countdown' || game.chosenIndex === undefined) return;
    const answer = game.answers[game.chosenIndex];
    game.result = { winnerId: answer.playerId, cardId: answer.cardId, dummy: answer.playerId === null };
    if (answer.playerId) { const winner = this.player(answer.playerId); if (winner) winner.score++; }
    else { const dealer = this.player(game.dealerId); if (dealer) dealer.score = Math.max(0, dealer.score - 1); }
    game.phase = game.players.some(p => p.score >= 5) ? 'finished' : 'roundResult';
    game.chosenIndex = undefined; game.revealAt = undefined;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    try {
      if (url.pathname === '/create' && request.method === 'POST') {
        if (this.game) return json({ error: '部屋はすでに作成されています' }, 409);
        const body = await request.json() as { id: string; name: string; tokenHash: string };
        const id = randomId(16);
        const owner: Player = { id, name: body.name, tokenHash: body.tokenHash, spectator: false, ready: false, score: 0, hand: [] };
        this.game = {
          schema: 1, id: body.id, createdAt: Date.now(), updatedAt: Date.now(), ownerId: id, phase: 'lobby', paused: false,
          round: 0, dealerId: id, players: [owner], spectators: [],
          deck: newDeck(things.length), discard: [], descriptionDeck: newDeck(descriptions.length), descriptionDiscard: [],
          answers: [], revealed: 0,
        };
        await this.save();
        return json({ roomId: body.id, memberId: id, owner: true });
      }
      if (url.pathname === '/join' && request.method === 'POST') {
        const game = this.requireGame(); const body = await request.json() as { name: string; tokenHash: string };
        const id = randomId(16);
        const mayPlay = game.phase === 'lobby' && game.players.length < MAX_PLAYERS;
        if (!mayPlay && game.spectators.length >= MAX_SPECTATORS) return json({ error: 'この部屋の観戦枠は満員です' }, 409);
        const member: Player | Member = mayPlay
          ? { id, name: body.name, tokenHash: body.tokenHash, spectator: false, ready: false, score: 0, hand: [] }
          : { id, name: body.name, tokenHash: body.tokenHash, spectator: true, ready: false };
        if (mayPlay) game.players.push(member as Player); else game.spectators.push(member);
        await this.save();
        return json({ roomId: game.id, memberId: id, owner: false, spectator: !mayPlay, message: mayPlay ? undefined : 'このゲームは進行中のため、観戦で参加します。' });
      }
      if (url.pathname === '/public' && request.method === 'GET') return json(this.view());
      if (url.pathname === '/alarm') return json({ ok: true });
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') { this.requireGame(); return this.openSocket(); }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : '処理に失敗しました';
      return json({ error: message }, message === '部屋が見つかりません' ? 404 : 400);
    }
  }

  private openSocket(): Response {
    const pair = new WebSocketPair(); const client = pair[0]; const server = pair[1];
    this.state.acceptWebSocket(server); server.serializeAttachment({});
    this.send(server, 'authRequired');
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    try {
      const data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as { type?: string; payload?: Record<string, unknown> };
      const attachment = socket.deserializeAttachment() as { memberId?: string } | null;
      if (!attachment?.memberId) {
        if (data.type !== 'auth' || typeof data.payload?.token !== 'string') {
          this.send(socket, 'error', { message: '認証できませんでした' });
          socket.close(4003, '認証できませんでした'); return;
        }
        const tokenHash = await hashToken(data.payload.token);
        const game = this.requireGame();
        const member = [...game.players, ...game.spectators].find(p => p.tokenHash === tokenHash);
        if (!member) {
          this.send(socket, 'error', { message: '参加情報が無効です。名前を入力して入り直してください' });
          socket.close(4003, '参加情報が無効です'); return;
        }
        for (const old of this.state.getWebSockets()) {
          if (old !== socket && this.socketMember(old) === member.id) old.close(4001, '新しい接続に切り替わりました');
        }
        socket.serializeAttachment({ memberId: member.id });
        if (member.id === game.ownerId) game.ownerDisconnectedAt = undefined;
        else this.transferOwnerIfDue();
        if (this.player(member.id) && game.paused && game.players.every(p => this.onlineIds().has(p.id) || p.id === member.id)) {
          game.paused = false; game.pauseReason = undefined;
        }
        this.send(socket, 'state', this.view(member.id)); this.broadcast(); await this.save(); return;
      }
      const memberId = attachment.memberId; const game = this.requireGame();
      if (!game.players.some(p => p.id === memberId) && !game.spectators.some(p => p.id === memberId)) throw new Error('部屋から退出しています');
      const payload = data.payload ?? {};
      switch (data.type) {
        case 'addCpu': {
          this.assertOwner(memberId);
          if (game.phase !== 'lobby' || game.players.length >= MAX_PLAYERS) throw new Error('待機中で空席があるときにCPUを追加できます');
          const used = new Set(game.players.map(player => player.name));
          let number = 1; while (used.has(`CPU ${number}`)) number++;
          game.players.push({ id: randomId(16), name: `CPU ${number}`, tokenHash: randomId(32), spectator: false, ready: true, cpu: true, score: 0, hand: [] });
          break;
        }
        case 'ready': {
          const player = this.player(memberId); if (!player || game.phase !== 'lobby') throw new Error('準備状態を変更できません');
          player.ready = !player.ready; break;
        }
        case 'start': {
          this.assertOwner(memberId);
          this.assertNotPaused();
          if (game.phase !== 'lobby' || game.players.length < 2 || !game.players.every(p => p.ready)) throw new Error('全員の準備が完了してから開始してください');
          game.players.forEach(p => { p.score = 0; p.hand = Array.from({ length: 5 }, () => this.drawThing()); });
          game.round = 1; game.dealerId = game.players[0].id; this.beginRound(); break;
        }
        case 'select': {
          this.assertNotPaused();
          const player = this.player(memberId); if (!player || game.phase !== 'selecting' || player.id === game.dealerId || player.selection !== undefined) throw new Error('今は回答を選べません');
          const cardId = Number(payload.cardId);
          if (!Number.isInteger(cardId) || !player.hand.includes(cardId)) throw new Error('手札からカードを選んでください');
          this.selectCard(player, cardId); break;
        }
        case 'reveal': {
          this.assertNotPaused();
          if (!this.isDealer(memberId) || game.phase !== 'reveal' || game.revealed >= game.answers.length) throw new Error('回答を公開できません');
          game.revealed++; break;
        }
        case 'choose': {
          this.assertNotPaused();
          const index = Number(payload.index);
          if (!this.isDealer(memberId) || game.phase !== 'reveal' || game.revealed !== game.answers.length || !Number.isInteger(index) || !game.answers[index]) throw new Error('回答を選べません');
          this.chooseAnswer(index); break;
        }
        case 'advance': {
          this.assertNotPaused();
          if (!this.isDealer(memberId) || game.phase !== 'roundResult') throw new Error('次のラウンドへ進めません');
          this.advanceRound(); break;
        }
        case 'rematch': {
          this.assertOwner(memberId);
          if (game.phase !== 'finished') throw new Error('ゲーム終了後に再戦できます');
          this.resetForLobby(); break;
        }
        case 'reset': {
          this.assertOwner(memberId);
          this.resetForLobby(); break;
        }
        case 'remove': {
          this.assertOwner(memberId);
          const targetId = String(payload.memberId ?? '');
          if (targetId === game.ownerId || !game.players.some(p => p.id === targetId)) throw new Error('そのプレイヤーは除外できません');
          const oldDealer = game.dealerId;
          const removed = game.players.find(p => p.id === targetId)!;
          if (game.phase === 'selecting' && removed.selection !== undefined) game.discard.push(removed.selection);
          game.players = game.players.filter(p => p.id !== targetId);
          for (const other of this.state.getWebSockets()) {
            if (this.socketMember(other) === targetId) {
              this.send(other, 'removed', { message: '部屋から除外されました' });
              other.close(4003, '部屋から除外されました');
            }
          }
          if (oldDealer === targetId && game.players.length) game.dealerId = game.players[0].id;
          game.ownerDisconnectedAt = undefined;
          const online = this.onlineIds();
          const stillAway = game.players.find(p => !online.has(p.id));
          game.paused = !!stillAway;
          game.pauseReason = stillAway ? `${stillAway.name}さんの再接続を待っています` : undefined;
          if (game.phase !== 'lobby' && game.phase !== 'finished' && game.players.length >= 2) { game.round++; this.beginRound(); }
          else if (game.players.length < 2 && game.phase !== 'lobby') this.resetForLobby();
          else if (game.phase === 'lobby') this.promoteSpectators();
          break;
        }
        default: throw new Error('操作を理解できませんでした');
      }
      await this.save(); this.broadcast();
    } catch (error) {
      this.send(socket, 'error', { message: error instanceof Error ? error.message : '操作に失敗しました' });
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.ready;
    const memberId = this.socketMember(socket); if (!memberId || !this.game) return;
    this.closingSockets.add(socket);
    if (this.onlineIds().has(memberId)) return;
    const player = this.player(memberId);
    if (player) {
      this.game.paused = true; this.game.pauseReason = `${player.name}さんの再接続を待っています`;
      if (this.game.ownerId === memberId) this.game.ownerDisconnectedAt = Date.now();
      await this.save(); this.broadcast();
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> { await this.webSocketClose(socket); }

  async alarm(): Promise<void> {
    await this.ready; if (!this.game) return;
    const game = this.game; const now = Date.now();
    if (game.updatedAt + ROOM_TTL <= now) {
      for (const ws of this.state.getWebSockets()) ws.close(4000, '部屋の有効期限が切れました');
      await this.state.storage.deleteAll(); this.game = undefined; return;
    }
    this.transferOwnerIfDue(now);
    if (game.phase === 'countdown' && game.revealAt && game.revealAt <= now) this.finishCountdown();
    if (!this.cpuBusy && game.cpuNextAt && game.cpuNextAt <= now && this.hasCpuAction()) {
      this.cpuBusy = true;
      game.cpuNextAt = undefined;
      try { await this.cpuStep(); }
      finally { this.cpuBusy = false; }
    }
    await this.save(); this.broadcast();
  }
}
