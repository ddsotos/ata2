import QRCode from 'qrcode';
import { parseRoomId } from './room-code';
import './style.css';

type Player = { id: string; name: string; score: number; ready: boolean; online: boolean; isDealer: boolean; cpu: boolean };
type CpuPrompts = { answer: string; dealer: string };
type CpuLogEntry = {
  gameNumber: number; round: number; cpuId: string; cpuName: string; role: 'answer' | 'dealer';
  お題: string; candidates: string[]; selectedIndex: number; selectedCard: string;
  instructions: string; source: 'jev' | 'random'; reason?: string; selectedAt: string;
};
type CpuLogsResponse = { roomId: string; entries: CpuLogEntry[] };
type JevBudgetStatus = { limit: number; used: number; remaining: number; resetsAt: string; resetAvailable: boolean };
type Snapshot = {
  id: string; phase: 'lobby' | 'selecting' | 'reveal' | 'countdown' | 'roundResult' | 'finished'; paused: boolean; pauseReason?: string;
  round: number; winningScore: number; completedRounds: number; finishedReason: 'scoreLimit' | 'roundLimit' | 'early' | null;
  currentDescription: string | null; dealerId: string; ownerId: string; youId: string | null;
  youAreOwner: boolean; spectator: boolean; players: Player[]; spectators: number;
  answers: { index: number; card: string | null }[]; revealed: number;
  chosenCard: string | null; chosenIndex: number | null; countdownEndsAt: number | null; serverNow: number;
  result: { winnerId: string | null; winnerName: string | null; card: string; dummy: boolean } | null;
  hand: { id: number; name: string }[]; yourSelection: number | null; readyToStart: boolean;
  cpuDefaults?: CpuPrompts; cpuPrompts?: Record<string, CpuPrompts>; cpuProvider?: 'typesafe' | 'cloudflare';
  hasCpuLogs: boolean;
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
let cpuEditor: { memberId: string | null; prompts: CpuPrompts } | null = null;
let cpuLogsOpen = false;
let cpuLogs: CpuLogsResponse | null = null;
let cpuLogsLoading = false;
let cpuLogsError = '';
let selectedCpuId: string | null = null;
let jevBudgetOpen = false;
let jevBudgetStatus: JevBudgetStatus | null = null;
let jevBudgetLoading = false;
let jevBudgetError = '';
let jevBudgetNotice = '';
let jevResetDraft = '';

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
          <label>部屋コードまたは招待リンク<input name="room" inputmode="text" required placeholder="12桁のコード、または招待リンク" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
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
    const id = parseRoomId(String(form.get('room') ?? ''));
    try {
      if (!id) throw new Error('12桁の部屋コード、または招待リンクを入力してください');
      const result = await api(`/api/rooms/${encodeURIComponent(id)}/join`, { name: form.get('name') });
      enter(result as RoomCredential);
    } catch (e) { app.querySelector('.error')!.textContent = (e as Error).message; }
  });
}

function enter(next: RoomCredential): void {
  socket?.close();
  notice = ''; qrOpen = false; qrDataUrl = '';
  selectionDraft = null; selectionSending = false; countdownTarget = null; scoreEffect = null;
  cpuEditor = null;
  cpuLogsOpen = false; cpuLogs = null; cpuLogsLoading = false; cpuLogsError = ''; selectedCpuId = null;
  jevBudgetOpen = false; jevBudgetStatus = null; jevBudgetLoading = false; jevBudgetError = ''; jevBudgetNotice = ''; jevResetDraft = '';
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
      const refreshCpuLogs = next.phase === 'finished' && previous?.phase !== 'finished' && cpuLogsOpen;
      if (next.phase === 'finished' && previous?.phase !== 'finished') { cpuLogs = null; selectedCpuId = null; }
      snapshot = next; renderRoom();
      if (refreshCpuLogs) void loadCpuLogs();
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
      <span class="player-copy"><b>${esc(player.name)}${player.id === game.youId ? '<small>あなた</small>' : ''}</b><small>${player.isDealer ? player.cpu ? '親 · CPU' : '親' : player.cpu ? game.phase === 'lobby' ? '準備OK' : 'CPU' : player.ready && game.phase === 'lobby' ? '準備OK' : game.phase === 'lobby' ? '準備中' : player.online ? '参加中' : '切断中'}</small></span>
      <span class="score">${player.score}<small>点</small>${scoreEffect?.playerId === player.id ? `<em>${scoreEffect.delta > 0 ? '+1' : '−1'}</em>` : ''}</span>
      ${game.youAreOwner && game.phase === 'lobby' && player.cpu ? `<button class="button cpu-settings-button" data-edit-cpu="${esc(player.id)}">指示文</button>` : ''}
      ${game.youAreOwner && player.id !== game.ownerId ? `<button class="icon-button remove" data-remove="${esc(player.id)}" aria-label="${esc(player.name)}を除外">×</button>` : ''}
    </li>`).join('');
}

function cpuLogPanel(game: Snapshot): string {
  if (!game.hasCpuLogs) return '';
  if (!cpuLogsOpen) return '<div class="cpu-log-toggle"><button class="button secondary" id="open-cpu-logs">終了したゲームのCPU選択ログを見る</button></div>';
  let body = '';
  if (cpuLogsLoading) body = '<p class="muted">ログを読み込んでいます…</p>';
  else if (cpuLogsError) body = `<p class="error" role="alert">${esc(cpuLogsError)}</p>`;
  else if (!cpuLogs?.entries.length) body = '<p class="muted">終了したゲームのCPU選択は記録されていません。</p>';
  else {
    const cpus = [...new Map(cpuLogs.entries.map(entry => [entry.cpuId, entry.cpuName])).entries()];
    const cpuId = selectedCpuId && cpus.some(([id]) => id === selectedCpuId) ? selectedCpuId : cpus[0][0];
    const entries = cpuLogs.entries.filter(entry => entry.cpuId === cpuId);
    body = `<div class="cpu-log-tabs">${cpus.map(([id, name]) => `<button type="button" class="button ${id === cpuId ? 'primary' : 'secondary'}" data-cpu-log="${esc(id)}" aria-pressed="${id === cpuId}">${esc(name)}</button>`).join('')}</div>
      <div class="cpu-log-actions"><span>${entries.length}件の選択</span><button class="button secondary" id="download-cpu-log" data-cpu-id="${esc(cpuId)}">このCPUのログをJSONで保存</button></div>
      <ol class="cpu-log-list">${entries.map(entry => `<li class="cpu-log-entry"><div class="cpu-log-meta"><b>ゲーム ${entry.gameNumber}・ROUND ${entry.round}・${entry.role === 'answer' ? '回答側' : '親'}</b><time>${esc(new Date(entry.selectedAt).toLocaleString('ja-JP'))}</time></div><p><strong>お題</strong> ${esc(entry.お題)}</p><p><strong>選択</strong> ${esc(entry.selectedCard)} <span class="cpu-log-source">${entry.source === 'jev' ? 'Jev' : 'ランダム代替'}</span></p><details><summary>候補と指示文を見る</summary><ol class="cpu-log-candidates">${entry.candidates.map((card, index) => `<li ${index === entry.selectedIndex ? 'class="selected"' : ''}>${esc(card)}${index === entry.selectedIndex ? ' ✓' : ''}</li>`).join('')}</ol><p><strong>指示文</strong> ${esc(entry.instructions)}</p>${entry.reason ? `<p><strong>代替理由</strong> ${esc(entry.reason)}</p>` : ''}</details></li>`).join('')}</ol>`;
  }
  return `<section class="stage cpu-log-panel"><div class="cpu-log-heading"><div><p class="eyebrow">CPU LOG</p><h2>CPUの選択履歴</h2></div><button class="button secondary" id="close-cpu-logs">閉じる</button></div><p class="muted">終了したゲームの記録だけを表示します。部屋の有効期限内にJSONを保存してください。</p>${body}</section>`;
}

function jevBudgetPanel(game: Snapshot): string {
  if (!game.youAreOwner || game.cpuProvider !== 'typesafe' || !jevBudgetOpen) return '';
  const status = jevBudgetStatus;
  return `<section class="stage jev-budget-panel"><div class="cpu-log-heading"><div><p class="eyebrow">JEV USAGE</p><h2>Jev呼び出し上限</h2></div><button class="button secondary" id="close-jev-budget">閉じる</button></div>
    ${jevBudgetLoading ? '<p class="muted">使用回数を確認しています…</p>' : status ? `<p>本日の使用回数: <strong>${status.used} / ${status.limit}</strong>（残り ${status.remaining} 回）</p><p class="muted">次の自動リセット: ${esc(new Date(status.resetsAt).toLocaleString('ja-JP'))}</p>` : ''}
    ${jevBudgetError ? `<p class="error" role="alert">${esc(jevBudgetError)}</p>` : ''}${jevBudgetNotice ? `<p class="notice" role="status">${esc(jevBudgetNotice)}</p>` : ''}
    <button type="button" class="button secondary" id="refresh-jev-budget" ${jevBudgetLoading ? 'disabled' : ''}>使用回数を更新</button>
    ${status && !status.resetAvailable ? '<p class="muted">リセットするには、Cloudflare WorkerのSecretに JEV_RESET_PASSWORD を設定してください。</p>' : status?.resetAvailable ? `<form id="jev-budget-reset" class="jev-budget-form"><label for="jev-reset-password">Cloudflareに設定したリセット用パスワード</label><input id="jev-reset-password" type="password" name="password" value="${esc(jevResetDraft)}" autocomplete="off" maxlength="256" required><p class="muted">クリアするとTypeSafeへの呼び出しが再開し、利用料金が発生する可能性があります。</p><button class="button primary" type="submit" ${jevBudgetLoading ? 'disabled' : ''}>本日の上限をクリア</button></form>` : ''}</section>`;
}

async function loadJevBudget(): Promise<void> {
  if (!credential || jevBudgetLoading) return;
  const roomId = credential.roomId;
  jevBudgetLoading = true; jevBudgetError = ''; jevBudgetNotice = ''; renderRoom();
  try {
    const response = await fetch(`/api/rooms/${roomId}/jev-budget`, { headers: { Authorization: `Bearer ${credential.token}` }, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '使用回数を確認できませんでした');
    if (credential?.roomId === roomId) jevBudgetStatus = data as JevBudgetStatus;
  } catch (error) {
    if (credential?.roomId === roomId) jevBudgetError = error instanceof Error ? error.message : '使用回数を確認できませんでした';
  } finally {
    if (credential?.roomId === roomId) { jevBudgetLoading = false; renderRoom(); }
  }
}

async function resetJevBudget(password: string): Promise<void> {
  if (!credential || jevBudgetLoading) return;
  const roomId = credential.roomId;
  jevBudgetLoading = true; jevBudgetError = ''; jevBudgetNotice = ''; renderRoom();
  try {
    const response = await fetch(`/api/rooms/${roomId}/jev-budget/reset`, {
      method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? '上限をクリアできませんでした');
    if (credential?.roomId === roomId) {
      jevBudgetStatus = { ...data, resetAvailable: true } as JevBudgetStatus;
      jevResetDraft = ''; jevBudgetNotice = '本日のJev呼び出し回数を0に戻しました';
    }
  } catch (error) {
    if (credential?.roomId === roomId) jevBudgetError = error instanceof Error ? error.message : '上限をクリアできませんでした';
  } finally {
    if (credential?.roomId === roomId) { jevBudgetLoading = false; renderRoom(); }
  }
}

async function loadCpuLogs(): Promise<void> {
  if (!credential || cpuLogsLoading) return;
  const roomId = credential.roomId;
  cpuLogsLoading = true; cpuLogsError = ''; renderRoom();
  try {
    const response = await fetch(`/api/rooms/${roomId}/cpu-logs`, { headers: { Authorization: `Bearer ${credential.token}` }, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'ログを読み込めませんでした');
    if (credential?.roomId === roomId) cpuLogs = data as CpuLogsResponse;
  } catch (error) {
    if (credential?.roomId === roomId) cpuLogsError = error instanceof Error ? error.message : 'ログを読み込めませんでした';
  } finally {
    if (credential?.roomId === roomId) { cpuLogsLoading = false; renderRoom(); }
  }
}

function downloadCpuLog(cpuId: string, roomId: string): void {
  const entries = cpuLogs?.entries.filter(entry => entry.cpuId === cpuId) ?? [];
  if (!entries.length) return;
  const file = new Blob([JSON.stringify({ roomId, cpuId, cpuName: entries[0].cpuName, entries }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url; link.download = `ata-cpu-${roomId}-${cpuId.slice(0, 8)}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    stage = `<section class="stage lobby-stage"><p class="eyebrow">GAME ROOM</p><h2>みんなが集まるのを待っています</h2><p class="muted">${game.players.length}/8 人 · 2人以上 · ${game.winningScore}点先取で遊べます</p>
      <div class="invite-row"><code>${esc(inviteUrl)}</code><button class="button compact" id="copy-invite">リンクをコピー</button><button class="button compact" id="show-qr">QRコード</button></div>
      <div id="qr-panel" class="qr-panel" ${qrOpen ? '' : 'hidden'}><img id="qr-image" src="${qrDataUrl}" alt="部屋への招待QRコード"><p>スマートフォンで読み取って参加</p></div>
      <div class="stage-actions">${activePlayer ? `<button class="button ${game.players.find(p => p.id === game.youId)?.ready ? 'secondary' : 'primary'}" id="ready">${game.players.find(p => p.id === game.youId)?.ready ? '準備OK ✓' : '準備完了'}</button>` : '<span class="pill">観戦で参加中 · 次のゲームから参加できます</span>'}
      ${game.youAreOwner && game.players.length < 8 ? '<button class="button secondary" id="add-cpu">CPUを追加</button>' : ''}
      ${game.youAreOwner ? `<button class="button primary" id="start" ${game.readyToStart ? '' : 'disabled'}>ゲームを始める <span>→</span></button>` : ''}</div>
      ${game.youAreOwner ? `<p class="cpu-provider">Jev接続: ${game.cpuProvider === 'typesafe' ? 'TypeSafe API（Worker Secret）' : 'Cloudflare AI binding'}</p>` : ''}
      ${game.youAreOwner && cpuEditor ? `<form id="cpu-editor" class="cpu-editor"><h3>${cpuEditor.memberId ? `${esc(game.players.find(p => p.id === cpuEditor!.memberId)?.name)}の指示文` : '新しいCPUの指示文'}</h3><p>回答側と親側をそれぞれ設定できます。ゲーム開始後は変更できません。</p><label for="cpu-answer-prompt">回答側</label><textarea id="cpu-answer-prompt" name="answer" maxlength="2000" required>${esc(cpuEditor.prompts.answer)}</textarea><label for="cpu-dealer-prompt">親側</label><textarea id="cpu-dealer-prompt" name="dealer" maxlength="2000" required>${esc(cpuEditor.prompts.dealer)}</textarea><div class="cpu-editor-actions"><button type="button" class="button secondary" id="cpu-default-prompts">初期文に戻す</button><button type="button" class="button secondary" id="cpu-editor-cancel">キャンセル</button><button type="submit" class="button primary">${cpuEditor.memberId ? '指示文を保存' : 'この設定でCPUを追加'}</button></div></form>` : ''}</section>`;
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
  } else if (game.phase === 'roundResult') {
    const result = game.result;
    stage = `<section class="stage result-stage"><p class="eyebrow">ROUND ${game.round} RESULT</p><h2>選ばれた回答</h2>
      <article class="winning-card"><span class="prompt-label">${result?.dummy ? 'ダミー回答' : `回答者 · ${esc(result?.winnerName)}`}</span><p>${esc(result?.card)}</p></article>
      ${scoreEffect ? `<div class="score-celebration ${scoreEffect.delta > 0 ? 'positive' : 'negative'}" role="status"><strong>${scoreEffect.delta > 0 ? '+1' : '−1'}</strong><span>${esc(scoreEffect.name)} さん</span></div>` : ''}
      <div class="result-message">${result?.dummy ? '親は1点減点（0点が下限）' : `🎉 ${esc(result?.winnerName)} さんに1点！`}</div>
      ${game.youId === game.dealerId ? '<button class="button primary wide" id="advance">次のラウンドへ →</button>' : '<p class="muted center">親が次のラウンドを始めます。</p>'}</section>`;
  } else if (game.phase === 'finished') {
    const ranking = [...game.players].sort((a, b) => b.score - a.score);
    const leaders = ranking.filter(player => player.score === ranking[0]?.score);
    const winner = leaders.length === 1 ? `${leaders[0].name} さんが1位` : `${leaders.map(player => player.name).join('・')} さんが同点1位`;
    const result = game.result;
    stage = `<section class="stage result-stage"><p class="eyebrow">GAME FINISHED</p><h2>${game.finishedReason === 'early' ? '途中終了の結果' : game.finishedReason === 'roundLimit' ? '10ラウンド終了の結果' : `${game.winningScore}点先取の結果`}</h2><p class="muted center">得点に反映したラウンド: ${game.completedRounds}</p>
      <div class="winner-banner">${esc(winner)}</div>
      <ol class="final-ranking">${ranking.map(player => `<li><span>${ranking.findIndex(other => other.score === player.score) + 1}位　${esc(player.name)}</span><strong>${player.score}点</strong></li>`).join('')}</ol>
      ${result ? `<div class="last-result"><span class="prompt-label">最後に選ばれた回答</span><p>${esc(result.card)} <small>（${result.dummy ? 'ダミー回答' : esc(result.winnerName)}）</small></p></div>` : '<p class="muted center">進行中だったラウンドの得点は集計していません。</p>'}
      ${scoreEffect ? `<div class="score-celebration ${scoreEffect.delta > 0 ? 'positive' : 'negative'}" role="status"><strong>${scoreEffect.delta > 0 ? '+1' : '−1'}</strong><span>${esc(scoreEffect.name)} さん</span></div>` : ''}
      ${game.youAreOwner ? '<button class="button primary wide" id="rematch">同じメンバーで再戦</button>' : '<p class="muted center">部屋の作成者が再戦を始めます。</p>'}</section>`;
  }
  const ownerOffline = !game.players.find(p => p.id === game.ownerId)?.online;
  app.innerHTML = `<main class="game-shell">
    <header class="topbar"><a class="wordmark" href="/">視 <span>私の世界の見方</span></a><div class="topbar-right"><span class="room-chip">部屋 ${esc(game.id.toUpperCase())}</span><button class="button text-button" id="copy-top">招待を共有 ↗</button></div></header>
    <div class="game-layout"><aside class="sidebar"><div class="sidebar-title"><span class="eyebrow">PLAYERS</span><span class="pill">${game.players.length} / 8</span></div><ul class="player-list">${playerList(game)}</ul><div class="sidebar-bottom"><span class="presence-dot"></span>${game.spectators}人が観戦中</div>${game.youAreOwner && game.cpuProvider === 'typesafe' ? '<button class="button reset-button" id="open-jev-budget">Jev使用回数・上限</button>' : ''}${game.youAreOwner && game.phase !== 'lobby' && game.phase !== 'finished' ? '<button class="button reset-button" id="finish-early">途中終了して結果を見る</button>' : ''}</aside>
      <div class="game-main">${game.paused ? `<div class="pause-banner"><b>ゲームを一時停止中</b><span>${esc(game.pauseReason ?? '参加者の復帰を待っています')}</span>${game.youAreOwner && ownerOffline ? '<small>管理者の引き継ぎを待っています</small>' : ''}</div>` : ''}${notice ? `<div class="notice" role="status">${esc(notice)}<button id="dismiss-notice" aria-label="閉じる">×</button></div>` : ''}${stage}${jevBudgetPanel(game)}${cpuLogPanel(game)}</div></div>
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
  document.querySelector('#open-jev-budget')?.addEventListener('click', () => { jevBudgetOpen = true; void loadJevBudget(); });
  document.querySelector('#close-jev-budget')?.addEventListener('click', () => { jevBudgetOpen = false; jevResetDraft = ''; renderRoom(); });
  document.querySelector('#refresh-jev-budget')?.addEventListener('click', () => void loadJevBudget());
  document.querySelector<HTMLInputElement>('#jev-reset-password')?.addEventListener('input', event => { jevResetDraft = (event.currentTarget as HTMLInputElement).value; });
  document.querySelector<HTMLFormElement>('#jev-budget-reset')?.addEventListener('submit', event => {
    event.preventDefault();
    const password = (event.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>('#jev-reset-password')?.value ?? '';
    void resetJevBudget(password);
  });
  document.querySelector('#open-cpu-logs')?.addEventListener('click', () => { cpuLogsOpen = true; if (cpuLogs) renderRoom(); else void loadCpuLogs(); });
  document.querySelector('#close-cpu-logs')?.addEventListener('click', () => { cpuLogsOpen = false; renderRoom(); });
  document.querySelectorAll<HTMLElement>('[data-cpu-log]').forEach(button => button.addEventListener('click', () => { selectedCpuId = button.dataset.cpuLog ?? null; renderRoom(); }));
  document.querySelector<HTMLElement>('#download-cpu-log')?.addEventListener('click', event => {
    const cpuId = (event.currentTarget as HTMLElement).dataset.cpuId;
    if (cpuId) downloadCpuLog(cpuId, game.id);
  });
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
  document.querySelector('#add-cpu')?.addEventListener('click', () => {
    cpuEditor = { memberId: null, prompts: { ...(game.cpuDefaults ?? { answer: '', dealer: '' }) } }; renderRoom();
  });
  document.querySelectorAll<HTMLElement>('[data-edit-cpu]').forEach(button => button.addEventListener('click', () => {
    const memberId = button.dataset.editCpu!;
    cpuEditor = { memberId, prompts: { ...(game.cpuPrompts?.[memberId] ?? game.cpuDefaults ?? { answer: '', dealer: '' }) } }; renderRoom();
  }));
  document.querySelector<HTMLTextAreaElement>('#cpu-answer-prompt')?.addEventListener('input', event => {
    if (cpuEditor) cpuEditor.prompts.answer = (event.currentTarget as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLTextAreaElement>('#cpu-dealer-prompt')?.addEventListener('input', event => {
    if (cpuEditor) cpuEditor.prompts.dealer = (event.currentTarget as HTMLTextAreaElement).value;
  });
  document.querySelector<HTMLFormElement>('#cpu-editor')?.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const prompts = { answer: (form.elements.namedItem('answer') as HTMLTextAreaElement).value, dealer: (form.elements.namedItem('dealer') as HTMLTextAreaElement).value };
    if (cpuEditor?.memberId) send('updateCpuPrompts', { memberId: cpuEditor.memberId, prompts });
    else send('addCpu', { prompts });
    cpuEditor = null; renderRoom();
  });
  document.querySelector('#cpu-default-prompts')?.addEventListener('click', () => {
    if (!cpuEditor || !game.cpuDefaults) return;
    cpuEditor.prompts = { ...game.cpuDefaults }; renderRoom();
  });
  document.querySelector('#cpu-editor-cancel')?.addEventListener('click', () => { cpuEditor = null; renderRoom(); });
  document.querySelector('#start')?.addEventListener('click', () => send('start'));
  document.querySelector('#reveal')?.addEventListener('click', () => send('reveal'));
  document.querySelector('#advance')?.addEventListener('click', () => send('advance'));
  document.querySelector('#rematch')?.addEventListener('click', () => send('rematch'));
  document.querySelector('#finish-early')?.addEventListener('click', () => {
    const scoring = game.phase === 'countdown' ? '選ばれた回答の得点を反映して' : game.phase === 'roundResult' ? '現在の得点で' : '進行中のラウンドは得点に含めず、現在の得点で';
    if (confirm(`${scoring}ゲームを終了しますか？ CPUの選択ログも閲覧できるようになります。`)) send('finishEarly');
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
  app.innerHTML = `<main class="landing join-landing"><a class="back-link" href="/">← ホームへ</a><div class="brand-mark small-mark">視</div><p class="eyebrow">INVITATION</p><h1>部屋に参加する</h1><p class="lead">部屋コード <strong>${esc(roomId.toUpperCase())}</strong></p><form id="room-join" class="panel"><label>あなたの名前<input name="name" maxlength="16" required placeholder="例：あおい" autocomplete="nickname"></label><button class="button primary" type="submit">参加する <span>→</span></button></form><p class="error" role="alert">${esc(notice)}</p></main>`;
  document.querySelector<HTMLFormElement>('#room-join')!.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement);
    try { const result = await api(`/api/rooms/${roomId}/join`, { name: form.get('name') }); enter(result as RoomCredential); }
    catch (e) { document.querySelector('.error')!.textContent = (e as Error).message; }
  });
}

window.addEventListener('popstate', () => { credential = null; snapshot = null; socket?.close(); socket = null; void boot(); });
void boot();
