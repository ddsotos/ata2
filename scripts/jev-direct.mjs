import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCpuJevInput } from '../worker/cpu.ts';

const host = '127.0.0.1';
const port = Number(process.env.JEV_PLAYGROUND_PORT ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('JEV_PLAYGROUND_PORT が不正です');
const origin = `http://${host}:${port}`;
const sessionToken = randomBytes(24).toString('hex');
const sampleTheme = '私の秘密の才能は＿＿です。';
const sampleCards = ['宇宙人', '給食', 'Wi-Fi', '校長先生', '冷蔵庫'];
const presets = {
  answer: createCpuJevInput(sampleTheme, sampleCards, 'answer'),
  dealer: createCpuJevInput(sampleTheme, sampleCards, 'dealer'),
};
const html = (await readFile(new URL('./jev-direct.html', import.meta.url), 'utf8'))
  .replace('__SESSION_TOKEN__', sessionToken)
  .replace('__PRESETS__', JSON.stringify(presets).replaceAll('<', '\\u003c'));
let runCount = 0;

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error('入力が大きすぎます（64 KBまで）');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (request, response) => {
  if (request.headers.host !== `${host}:${port}`) return sendJson(response, 403, { error: 'localhost からのみアクセスできます' });
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    });
    return response.end(html);
  }
  if (request.method !== 'POST' || request.url !== '/api/jev') return sendJson(response, 404, { error: 'Not found' });
  if (request.headers.origin !== origin || request.headers['x-session-token'] !== sessionToken || !request.headers['content-type']?.startsWith('application/json')) {
    return sendJson(response, 403, { error: 'このローカル画面から送信してください' });
  }
  if (runCount >= 30) return sendJson(response, 429, { error: 'この起動中の送信上限30回に達しました。続ける場合はサーバーを再起動してください' });

  try {
    const { input, apiKey } = await readJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input) || !('state' in input) || !input.questions || typeof input.questions !== 'object' || Array.isArray(input.questions) || !Object.keys(input.questions).length) {
      return sendJson(response, 400, { error: 'state と questions を含む Jev の入力JSONを指定してください' });
    }
    const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : process.env.TYPESAFE_API_KEY;
    if (!key) return sendJson(response, 400, { error: 'TypeSafe の API キーを画面に入力するか、TYPESAFE_API_KEY を設定してください' });

    runCount++;
    const started = performance.now();
    const upstream = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, model: 'jev-latest' }),
      signal: AbortSignal.timeout(30000),
    });
    const raw = await upstream.text();
    let result;
    try { result = JSON.parse(raw); } catch { result = raw.slice(0, 4000); }
    console.log(`TypeSafe Jev HTTP ${upstream.status} (${Math.round(performance.now() - started)} ms)`);
    return sendJson(response, 200, {
      status: upstream.status,
      elapsedMs: Math.round(performance.now() - started),
      requestId: upstream.headers.get('x-typesafe-request-id'),
      result,
      remainingThisRun: 30 - runCount,
    });
  } catch (error) {
    return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`Jev 直接実験画面: ${origin}`);
  console.log('送信時だけ TypeSafe API に直接接続します。Cloudflare は使いません。');
});
