import assert from 'node:assert/strict';
import { chooseCpuCard, chooseCpuCardDetailed, typeSafeJevBinding } from '../worker/cpu.ts';

const calls = [];
const ai = { async run(model, input) {
  calls.push({ model, input });
  return { answers: { choice: { type: 'choice', choice: 'choice_2' } } };
} };
const candidates = ['大阪', '月', 'ポテトサラダ'];
assert.equal(await chooseCpuCard(ai, '私の宝物は〇〇', candidates, 'answer'), 2);
assert.equal(calls[0].model, 'typesafe/jev');
assert.equal(calls[0].input.questions.choice.type, 'choice');
assert.deepEqual(calls[0].input.state.choices, candidates);
assert.deepEqual(calls[0].input.questions.choice.criteria, { choice_0: '大阪', choice_1: '月', choice_2: 'ポテトサラダ' });
assert.equal(await chooseCpuCard(ai, '私の宝物は〇〇', candidates, 'dealer'), 2);
assert.equal(await chooseCpuCard(ai, '私の宝物は〇〇', candidates, 'answer', 'お題との意外な相性を優先'), 2);
assert.equal(calls[2].input.questions.choice.instructions, 'お題との意外な相性を優先');
assert.deepEqual(await chooseCpuCardDetailed(ai, '私の宝物は〇〇', candidates, 'answer'), { index: 2, source: 'jev' });
const originalFetch = globalThis.fetch;
let typeSafeRequest;
globalThis.fetch = async (url, options) => {
  typeSafeRequest = { url, options };
  return Response.json({ answers: { choice: { choice: 'choice_1' } } });
};
try {
  assert.equal(await chooseCpuCard(typeSafeJevBinding('test-key'), '私の宝物は〇〇', candidates, 'answer', '独自指示'), 1);
  assert.equal(typeSafeRequest.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(typeSafeRequest.options.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(typeSafeRequest.options.body).questions.choice.instructions, '独自指示');
  assert.equal(JSON.parse(typeSafeRequest.options.body).model, 'jev-latest');
} finally { globalThis.fetch = originalFetch; }
const fallback = await chooseCpuCard(undefined, '私の宝物は〇〇', candidates, 'answer');
assert.ok(fallback >= 0 && fallback < candidates.length);
const fallbackDetails = await chooseCpuCardDetailed(undefined, '私の宝物は〇〇', candidates, 'answer');
assert.equal(fallbackDetails.source, 'random');
assert.ok(fallbackDetails.index >= 0 && fallbackDetails.index < candidates.length);
console.log('CPU Jev request shape and fallback: ok');
