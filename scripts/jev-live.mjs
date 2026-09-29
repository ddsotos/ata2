import { createCpuJevInput } from '../worker/cpu.ts';

const candidates = ['宇宙人', '給食', 'Wi-Fi', '校長先生', '冷蔵庫'];
const お題 = '私の秘密の才能は＿＿です。';
const input = createCpuJevInput(お題, candidates, 'answer');

let url;
let headers;
let payload;
let provider;
if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
  provider = 'Cloudflare Workers AI';
  url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run`;
  headers = { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` };
  payload = { model: 'typesafe/jev', input };
} else if (process.env.TYPESAFE_API_KEY) {
  provider = 'TypeSafe API';
  url = 'https://api.typesafe.ai/v1/systemone';
  headers = { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` };
  payload = { model: 'jev-latest', ...input };
} else {
  console.error('CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN、または TYPESAFE_API_KEY を環境変数に設定してください。');
  process.exitCode = 2;
}

if (url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  if (!response.ok || body.success === false) {
    console.error(`${provider}: HTTP ${response.status}`, JSON.stringify(body));
    process.exitCode = 1;
  } else {
    const result = body.result ?? body;
    const choice = result.answers?.choice?.choice;
    const selectedIndex = typeof choice === 'string' && /^choice_\d+$/.test(choice) ? Number(choice.slice(7)) : -1;
    if (selectedIndex < 0 || selectedIndex >= candidates.length) {
      console.error('Jev の回答が候補外です:', JSON.stringify(result));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ provider, request: input, response: result, selectedCard: candidates[selectedIndex] }, null, 2));
    }
  }
}
