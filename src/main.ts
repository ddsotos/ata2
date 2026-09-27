import QRCode from 'qrcode';
import './style.css';

type Player = { id: string; name: string; score: number; ready: boolean; online: boolean; isDealer: boolean };
type Snapshot = {
  id: string; phase: 'lobby' | 'selecting' | 'reveal' | 'countdown' | 'roundResult' | 'finished'; paused: boolean; pauseReason?: string;
  round: number; currentDescription: string | null; dealerId: string; ownerId: string; youId: string | null;
  youAreOwner: boolean; spectator: boolean; players: Player[]; spectators: number;
  answers: { index: number; card: string | null }[]; revealed: number;
  chosenCard: string | null; chosenIndex: number | null; countdownEndsAt: number | null; serverNow: number;
  result: { winnerId: string | null; winnerName: string | null; card: string; dummy: boolean } | null;
  hand: { id: number; name: string }[]; yourSelection: number | null; readyToStart: boolean;
};
type RoomCredential = { roomId: string; memberId: string; token: string; owner: boolean; spectator?: boolean; message?: string };
const app = document.querySelector<HTMLDivElement>('#app')!;
let snapshot: Snapshot | null = null;
let credential: RoomCredential | null = null;
let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let notice = '';
let qrOpen = false;
let qrDataUrl = '';
let selectionDraft: { kind: 'hand' | 'answer'; id: number; roomId: string; round: number } | null = null;
let selectionSending = false;
let countdownTarget: { endsAt: number; localTime: number } | null = null;
let countdownTimer: number | undefined;
let scoreEffect: { playerId: string; name: string; delta: number } | null = null;
let scoreEffectTimer: number | undefined;

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
function storedKey(roomId: string): string { return `sekai-room-${roomId}`; }
function currentRoomId(): string | null { return location.pathname.match(/^\/r\/([a-f0-9]{12})\/?$/)?.[1] ?? null; }
function send(type: string, payload: Record<string, unknown> = {}): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, payload }));
}
function api(path: string, body?: unknown): Promise<any> {
  return fetch(path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async response => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '通信に失敗しました');
    return data;
  });
}

function landing(error = ''): void {
  app.innerHTML = `
    <main class="landing">
      <div class="brand-mark" aria-hidden="true">視</div>
      <p class="eyebrow">FRIENDS · CARDS · LAUGHTER</p>
      <h1>私の世界の見方</h1>
      <p class="lead">みんなの「これだ！」を持ち寄ろう。</p>
      <div class="landing-grid">
        <form id="create-form" class="panel">
          <span class="step">01</span><h2>部屋をつくる</h2>
          <label>あなたの名前<input name="name" maxlength="16" required placeholder="例：あおい" autocomplete="nickname"></label>
          <button class="button primary" type="submit">新しい部屋をつくる <span>→</span></button>
        </form>
        <form id="join-form" class="panel">
          <span class="step">02</span><h2>招待から参加</h2>
          <label>部屋コード<input name="room" inputmode="text" maxlength="12" required placeholder="招待リンクのコード"></label>
          <label>あなたの名前<input name="name" maxlength="16" required placeholder="例：はる" autocomplete="nickname"></label>
          <button class="button secondary" type="submit">部屋に入る <span>→</span></button>
        </form>
      </div>
      <p class="error" role="alert">${esc(error)}</p>
      <p class="footnote">2〜8人 · 招待制 · スマートフォンでも遊べます</p>
    </main>`;
  document.querySelector<HTMLFormElement>('#create-form')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement);
    try { const result = await api('/api/rooms', { name: form.get('name') }); enter(result as RoomCredential); }
    catch (e) { landing((e as Error).message); }
  });
  document.querySelector<HTMLFormElement>('#join-form')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement);
    const id = String(form.get('room')).trim().toLowerCase();
    try {
      const result = await api(`/api/rooms/${encodeURIComponent(id)}/join`, { name: form.get('name') });
      enter(result as RoomCredential);
    } catch (e) { landing((e as Error).message); }
  });
}

function enter(next: RoomCredential): void {
  socket?.close();
  notice = ''; qrOpen = false; qrDataUrl = '';
  selectionDraft = null; selectionSending = false; countdownTarget = null; scoreEffect = null;
  credential = next; localStorage.setItem(storedKey(next.roomId), JSON.stringify(next));
  history.pushState({}, '', `/r/${next.roomId}`); snapshot = null; connect();
}

function connect(): void {
  if (!credential) return;
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const connection = new WebSocket(`${scheme}//${location.host}/ws/rooms/${credential.roomId}`);
  socket = connection;
  renderRoom();
  connection.addEventListener('open', () => { if (socket === connection) reconnectAttempt = 0; });
  connection.addEventListener('message', event => {
    if (socket !== connection) return;
    let message: { type: string; payload?: any };
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'authRequired') connection.send(JSON.stringify({ type: 'auth', payload: { token: credential?.token } }));
    else if (message.type === 'state') {
      if (notice === '接続が切れました。再接続しています…') notice = '';
      const previous = snapshot;
      const next = message.payload as Snapshot;
      if (!previous || previous.id !== next.id || previous.round !== next.round || previous.phase !== next.phase || next.yourSelection !== null) {
        selectionDraft = null; selectionSending = false;
      }
      if (next.phase === 'countdown' && next.countdownEndsAt && countdownTarget?.endsAt !== next.countdownEndsAt) {
        countdownTarget = { endsAt: next.countdownEndsAt, localTime: performance.now() + Math.max(0, next.countdownEndsAt - next.serverNow) };
      } else if (next.phase !== 'countdown') countdownTarget = null;
      if (previous?.phase === 'countdown' && (next.phase === 'roundResult' || next.phase === 'finished')) {
        const changed = next.players.find(player => player.score !== previous.players.find(old => old.id === player.id)?.score);
        if (changed) {
          scoreEffect = { playerId: changed.id, name: changed.name, delta: changed.score - (previous.players.find(old => old.id === changed.id)?.score ?? changed.score) };
          if (scoreEffectTimer) window.clearTimeout(scoreEffectTimer);
          scoreEffectTimer = window.setTimeout(() => { scoreEffect = null; renderRoom(); }, 2300);
        }
      } else if (next.phase !== 'roundResult' && next.phase !== 'finished') {
        scoreEffect = null;
        if (scoreEffectTimer) { window.clearTimeout(scoreEffectTimer); scoreEffectTimer = undefined; }
      }
      snapshot = next; renderRoom();
    }
    else if (message.type === 'notice') { notice = message.payload?.message ?? ''; renderRoom(); }
    else if (message.type === 'removed') { notice = message.payload?.message ?? '部屋から除外されました'; renderRoom(); }
    else if (message.type === 'error') { selectionSending = false; notice = message.payload?.message ?? '操作に失敗しました'; renderRoom(); }
  });
  connection.addEventListener('close', event => {
    if (socket !== connection) return;
    socket = null;
    if (!credential) return;
    if (event.code === 4001) {
      notice = '同じ参加情報が別のタブで開かれました。このタブで続ける場合は再読み込みしてください。';
      renderRoom(); return;
    }
    if (event.code === 4003) {
      localStorage.removeItem(storedKey(credential.roomId));
      credential = null; snapshot = null;
      void boot(); return;
    }
    notice = '接続が切れました。再接続しています…'; renderRoom();
    const delay = Math.min(1000 * 2 ** reconnectAttempt++, 15000);
    reconnectTimer = window.setTimeout(connect, delay);
  });
  connection.addEventListener('error', () => connection.close());
}

function playerList(game: Snapshot): string {
  return game.players.map(player => `
    <li class="player ${player.isDealer ? 'dealer' : ''} ${player.id === game.youId ? 'you' : ''} ${scoreEffect?.playerId === player.id ? scoreEffect.delta > 0 ? 'score-up' : 'score-down' : ''}">
      <span class="avatar">${esc([...player.name][0] ?? '？')}</span>
      <span class="player-copy"><b>${esc(player.name)}${player.id === game.youId ? '<small>あなた</small>' : ''}</b><small>${player.isDealer ? '親' : player.ready && game.phase === 'lobby' ? '準備OK' : game.phase === 'lobby' ? '準備中' : player.online ? '参加中' : '切断中'}</small></span>
      <span class="score">${player.score}<small>点</small>${scoreEffect?.playerId === player.id ? `<em>${scoreEffect.delta > 0 ? '+1' : '−1'}</em>` : ''}</span>
      ${game.youAreOwner && player.id !== game.ownerId ? `<button class="icon-button remove" data-remove="${esc(player.id)}" aria-label="${esc(player.name)}を除外">×</button>` : ''}
    </li>`).join('');
}

function renderRoom(): void {
  if (countdownTimer) { window.clearInterval(countdownTimer); countdownTimer = undefined; }
  if (!credential) { landing(); return; }
  if (!snapshot) {
    app.innerHTML = `<main class="loading"><div class="spinner"></div><p>部屋につないでいます…</p><p class="muted">${esc(notice)}</p></main>`; return;
  }
  const game = snapshot;
  const inviteUrl = `${location.origin}/r/${game.id}`;
  const activePlayer = game.players.some(p => p.id === game.youId);
  let stage = '';
  if (game.phase === 'lobby') {
    stage = `<section class="stage lobby-stage"><p class="eyebrow">GAME ROOM</p><h2>みんなが集まるのを待っています</h2><p class="muted">${game.players.length}/8 人 · 2人以上で遊べます</p>
      <div class="invite-row"><code>${esc(inviteUrl)}</code><button class="button compact" id="copy-invite">リンクをコピー</button><button class="button compact" id="show-qr">QRコード</button></div>
      <div id="qr-panel" class="qr-panel" ${qrOpen ? '' : 'hidden'}><img id="qr-image" src="${qrDataUrl}" alt="部屋への招待QRコード"><p>スマートフォンで読み取って参加</p></div>
      <div class="stage-actions">${activePlayer ? `<button class="button ${game.players.find(p => p.id === game.youId)?.ready ? 'secondary' : 'primary'}" id="ready">${game.players.find(p => p.id === game.youId)?.ready ? '準備OK ✓' : '準備完了'}</button>` : '<span class="pill">観戦で参加中 · 次のゲームから参加できます</span>'}
      ${game.youAreOwner ? `<button class="button primary" id="start" ${game.readyToStart ? '' : 'disabled'}>ゲームを始める <span>→</span></button>` : ''}</div></section>`;
  } else if (game.phase === 'selecting') {
    const dealer = game.youId === game.dealerId;
    const selected = game.yourSelection !== null;
    const canPick = activePlayer && !dealer && !selected;
    const draftId = selectionDraft?.kind === 'hand' && selectionDraft.roomId === game.id && selectionDraft.round === game.round ? selectionDraft.id : null;
    stage = `<section class="stage"><div class="stage-heading"><div><p class="eyebrow">ROUND ${game.round}</p><h2>${dealer ? 'みんなの答えを待ちましょう' : selected ? 'カードを出しました' : 'お題に合うカードを選ぼう'}</h2></div><span class="pill">${dealer ? 'あなたは親' : 'カードを1枚選択'}</span></div>
      <article class="prompt-card"><span class="prompt-label">お題</span><p>${esc(game.currentDescription)}</p></article>
      ${dealer || selected || !activePlayer ? `<div class="waiting-note">${dealer ? 'みんながカードを選んでいます。親はこのラウンドで手札を選べません。' : selected ? '全員が選び終わると、親が回答を公開します。' : 'みんながカードを選んでいます。'}</div>` : ''}
      ${activePlayer ? `<div class="hand-heading"><h3>あなたの手札</h3><p>${dealer ? '親は見るだけ・選択できません' : selected ? '提出済み・次のラウンドまで選択できません' : '1枚選んでから確定してください'}</p></div><div class="hand-grid">${game.hand.map(card => `<button type="button" class="answer-card hand-card ${draftId === card.id ? 'is-selected' : ''}" ${canPick ? `data-select="${card.id}" aria-pressed="${draftId === card.id}"` : 'disabled'}>${esc(card.name)}<span>${canPick ? draftId === card.id ? '選択中' : 'タップして選択' : '選択できません'}</span></button>`).join('')}</div>${canPick ? `<button class="button primary wide confirm-button" id="confirm-hand" ${draftId === null || selectionSending ? 'disabled' : ''}>${selectionSending ? '送信中…' : 'このカードを確定する'}</button>` : ''}` : ''}</section>`;
  } else if (game.phase === 'reveal') {
    const dealer = game.youId === game.dealerId;
    const canChoose = dealer && game.revealed === game.answers.length;
    const draftIndex = selectionDraft?.kind === 'answer' && selectionDraft.roomId === game.id && selectionDraft.round === game.round ? selectionDraft.id : null;
    stage = `<section class="stage"><div class="stage-heading"><div><p class="eyebrow">ROUND ${game.round}</p><h2>${dealer ? '回答をめくって選ぼう' : '親が回答を選んでいます'}</h2></div><span class="pill">${game.revealed}/${game.answers.length} 枚公開</span></div>
      <article class="prompt-card small"><span class="prompt-label">お題</span><p>${esc(game.currentDescription)}</p></article>
      <div class="revealed-grid">${game.answers.map(answer => canChoose && answer.card ? `<button type="button" class="answer-card reveal-card is-revealed ${draftIndex === answer.index ? 'is-selected' : ''}" data-choose="${answer.index}" aria-pressed="${draftIndex === answer.index}">${esc(answer.card)}<span>${draftIndex === answer.index ? '選択中' : 'タップして選択'}</span></button>` : `<div class="answer-card reveal-card ${answer.card ? 'is-revealed' : ''}">${answer.card ? esc(answer.card) : '<span class="card-back">？</span>'}</div>`).join('')}</div>
      ${dealer && game.revealed < game.answers.length ? '<button class="button primary wide" id="reveal">次の回答をめくる</button>' : ''}
      ${canChoose ? `<button class="button primary wide confirm-button" id="confirm-answer" ${draftIndex === null || selectionSending ? 'disabled' : ''}>${selectionSending ? '送信中…' : 'この回答を確定する'}</button>` : ''}</section>`;
  } else if (game.phase === 'countdown') {
    stage = `<section class="stage countdown-stage"><p class="eyebrow">ROUND ${game.round}</p><h2>選ばれた回答は…</h2><article class="prompt-card small"><span class="prompt-label">お題</span><p>${esc(game.currentDescription)}</p></article><div class="revealed-grid">${game.answers.map(answer => `<div class="answer-card reveal-card is-revealed ${answer.index === game.chosenIndex ? 'is-chosen' : ''}">${esc(answer.card)}${answer.index === game.chosenIndex ? '<span>選ばれた回答</span>' : ''}</div>`).join('')}</div><div class="countdown-number" id="countdown-number" aria-hidden="true">3</div><p class="muted center" id="countdown-message" role="status">誰が出したかは、カウントダウン後に公開します</p></section>`;
  } else if (game.phase === 'roundResult' || game.phase === 'finished') {
    const result = game.result;
    stage = `<section class="stage result-stage"><p class="eyebrow">${game.phase === 'finished' ? 'GAME FINISHED' : `ROUND ${game.round} RESULT`}</p><h2>${game.phase === 'finished' ? 'ゲーム終了！' : '選ばれた回答'}</h2>
      <article class="winning-card"><span class="prompt-label">${result?.dummy ? 'ダミー回答' : `回答者 · ${esc(result?.winnerName)}`}</span><p>${esc(result?.card)}</p></article>
      ${scoreEffect ? `<div class="score-celebration ${scoreEffect.delta > 0 ? 'positive' : 'negative'}" role="status"><strong>${scoreEffect.delta > 0 ? '+1' : '−1'}</strong><span>${esc(scoreEffect.name)} さん</span></div>` : ''}
      <div class="result-message">${result?.dummy ? '親は1点減点（0点が下限）' : `🎉 ${esc(result?.winnerName)} さんに1点！`}</div>
      ${game.phase === 'finished' ? `<div class="winner-banner">${esc([...game.players].sort((a,b) => b.score - a.score)[0]?.name)} さんが5点に到達しました</div>${game.youAreOwner ? '<button class="button primary wide" id="rematch">同じメンバーで再戦</button>' : '<p class="muted center">部屋の作成者が再戦を始めます。</p>'}` : game.youId === game.dealerId ? '<button class="button primary wide" id="advance">次のラウンドへ →</button>' : '<p class="muted center">親が次のラウンドを始めます。</p>'}</section>`;
  }
  const ownerOffline = !game.players.find(p => p.id === game.ownerId)?.online;
  app.innerHTML = `<main class="game-shell">
    <header class="topbar"><a class="wordmark" href="/">視 <span>私の世界の見方</span></a><div class="topbar-right"><span class="room-chip">部屋 ${esc(game.id.slice(0, 6).toUpperCase())}</span><button class="button text-button" id="copy-top">招待を共有 ↗</button></div></header>
    <div class="game-layout"><aside class="sidebar"><div class="sidebar-title"><span class="eyebrow">PLAYERS</span><span class="pill">${game.players.length} / 8</span></div><ul class="player-list">${playerList(game)}</ul><div class="sidebar-bottom"><span class="presence-dot"></span>${game.spectators}人が観戦中</div>${game.youAreOwner && game.phase !== 'lobby' ? '<button class="button reset-button" id="reset">ゲームをリセット</button>' : ''}</aside>
      <div class="game-main">${game.paused ? `<div class="pause-banner"><b>ゲームを一時停止中</b><span>${esc(game.pauseReason ?? '参加者の復帰を待っています')}</span>${game.youAreOwner && ownerOffline ? '<small>管理者の引き継ぎを待っています</small>' : ''}</div>` : ''}${notice ? `<div class="notice" role="status">${esc(notice)}<button id="dismiss-notice" aria-label="閉じる">×</button></div>` : ''}${stage}</div></div>
    <footer class="game-footer">友達との会話は、いつもの通話アプリでどうぞ。 <span>WATASHI NO SEKAI NO MIKATA</span></footer>
  </main>`;
  bindRoomEvents(game, inviteUrl);
  if (game.phase === 'countdown') {
    const tick = () => {
      const remaining = Math.max(0, (countdownTarget?.localTime ?? performance.now()) - performance.now());
      const number = document.querySelector('#countdown-number');
      if (number) number.textContent = remaining > 0 ? String(Math.ceil(remaining / 1000)) : '…';
      const message = document.querySelector('#countdown-message');
      if (message && remaining === 0) message.textContent = '結果を公開しています';
    };
    tick(); countdownTimer = window.setInterval(tick, 100);
  }
}

function bindRoomEvents(game: Snapshot, inviteUrl: string): void {
  document.querySelector('#dismiss-notice')?.addEventListener('click', () => { notice = ''; renderRoom(); });
  document.querySelector('#copy-invite')?.addEventListener('click', () => copyInvite(inviteUrl));
  document.querySelector('#copy-top')?.addEventListener('click', () => copyInvite(inviteUrl));
  document.querySelector('#show-qr')?.addEventListener('click', async () => {
    qrOpen = !qrOpen; renderRoom();
    if (qrOpen && !qrDataUrl) {
      qrDataUrl = await QRCode.toDataURL(inviteUrl, { width: 220, margin: 2, color: { dark: '#282622', light: '#ffffff' } });
      document.querySelector<HTMLImageElement>('#qr-image')?.setAttribute('src', qrDataUrl);
    }
  });
  document.querySelector('#ready')?.addEventListener('click', () => send('ready'));
  document.querySelector('#start')?.addEventListener('click', () => send('start'));
  document.querySelector('#reveal')?.addEventListener('click', () => send('reveal'));
  document.querySelector('#advance')?.addEventListener('click', () => send('advance'));
  document.querySelector('#rematch')?.addEventListener('click', () => send('rematch'));
  document.querySelector('#reset')?.addEventListener('click', () => {
    if (confirm('得点・手札を初期化して、この部屋で最初から始めますか？')) send('reset');
  });
  document.querySelectorAll<HTMLElement>('[data-select]').forEach(button => button.addEventListener('click', () => {
    selectionDraft = { kind: 'hand', id: Number(button.dataset.select), roomId: game.id, round: game.round }; renderRoom();
  }));
  document.querySelector('#confirm-hand')?.addEventListener('click', () => {
    if (selectionDraft?.kind !== 'hand' || selectionSending || socket?.readyState !== WebSocket.OPEN) return;
    selectionSending = true; send('select', { cardId: selectionDraft.id }); renderRoom();
  });
  document.querySelectorAll<HTMLElement>('[data-choose]').forEach(card => card.addEventListener('click', () => {
    selectionDraft = { kind: 'answer', id: Number(card.dataset.choose), roomId: game.id, round: game.round }; renderRoom();
  }));
  document.querySelector('#confirm-answer')?.addEventListener('click', () => {
    if (selectionDraft?.kind !== 'answer' || selectionSending || socket?.readyState !== WebSocket.OPEN) return;
    selectionSending = true; send('choose', { index: selectionDraft.id }); renderRoom();
  });
  document.querySelectorAll<HTMLElement>('[data-remove]').forEach(button => button.addEventListener('click', () => {
    const player = game.players.find(p => p.id === button.dataset.remove);
    if (player && confirm(`${player.name}さんを部屋から除外しますか？`)) send('remove', { memberId: player.id });
  }));
}

async function copyInvite(url: string): Promise<void> {
  try { await navigator.clipboard.writeText(url); notice = '招待リンクをコピーしました'; renderRoom(); }
  catch { notice = `招待リンク: ${url}`; renderRoom(); }
}

async function boot(): Promise<void> {
  const roomId = currentRoomId();
  if (!roomId) { landing(); return; }
  const saved = localStorage.getItem(storedKey(roomId));
  if (saved) {
    try { credential = JSON.parse(saved) as RoomCredential; connect(); return; }
    catch { localStorage.removeItem(storedKey(roomId)); }
  }
  app.innerHTML = `<main class="landing join-landing"><a class="back-link" href="/">← ホームへ</a><div class="brand-mark small-mark">視</div><p class="eyebrow">INVITATION</p><h1>部屋に参加する</h1><p class="lead">部屋コード <strong>${esc(roomId.slice(0, 6).toUpperCase())}</strong></p><form id="room-join" class="panel"><label>あなたの名前<input name="name" maxlength="16" required placeholder="例：あおい" autocomplete="nickname"></label><button class="button primary" type="submit">参加する <span>→</span></button></form><p class="error" role="alert">${esc(notice)}</p></main>`;
  document.querySelector<HTMLFormElement>('#room-join')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement);
    try { const result = await api(`/api/rooms/${roomId}/join`, { name: form.get('name') }); enter(result as RoomCredential); }
    catch (e) { document.querySelector('.error')!.textContent = (e as Error).message; }
  });
}

window.addEventListener('popstate', () => { credential = null; snapshot = null; socket?.close(); socket = null; void boot(); });
void boot();
