import assert from 'node:assert/strict';
import { chooseCpuCard } from '../worker/cpu.ts';

const calls = [];
const ai = { async run(model, input) {
  calls.push({ model, input });
  return { answers: { card: { type: 'choice', choice: 'card_2' } } };
} };
const candidates = ['大阪', '月', 'ポテトサラダ'];
assert.equal(await chooseCpuCard(ai, '私の宝物は〇〇', candidates, 'answer'), 2);
assert.equal(calls[0].model, 'typesafe/jev');
assert.equal(calls[0].input.questions.card.type, 'choice');
assert.deepEqual(calls[0].input.questions.card.criteria, { card_0: '大阪', card_1: '月', card_2: 'ポテトサラダ' });
assert.equal(await chooseCpuCard(ai, '私の宝物は〇〇', candidates, 'dealer'), 2);
const fallback = await chooseCpuCard(undefined, '私の宝物は〇〇', candidates, 'answer');
assert.ok(fallback >= 0 && fallback < candidates.length);
console.log('CPU Jev request shape and fallback: ok');
