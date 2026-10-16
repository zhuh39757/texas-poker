import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPots } from '../server/pots.js';

const P = (id, contributed, folded = false) => ({ id, contributed, folded });

test('没有 all-in：只有一个主池', () => {
  assert.deepEqual(buildPots([P('A', 100), P('B', 100), P('C', 100)]), [{ amount: 300, eligible: ['A', 'B', 'C'] }]);
});

test('设计文档里的例子：A all-in 100，B、C 各 300', () => {
  assert.deepEqual(buildPots([P('A', 100), P('B', 300), P('C', 300)]), [
    { amount: 300, eligible: ['A', 'B', 'C'] },
    { amount: 400, eligible: ['B', 'C'] },
  ]);
});

test('弃牌者的钱进池，但没有资格争', () => {
  assert.deepEqual(buildPots([P('A', 50, true), P('B', 200), P('C', 200)]), [{ amount: 450, eligible: ['B', 'C'] }]);
});

test('三层边池 + 弃牌者', () => {
  const pots = buildPots([P('A', 50), P('B', 120), P('C', 300), P('D', 300), P('E', 80, true)]);
  assert.deepEqual(pots, [
    { amount: 250, eligible: ['A', 'B', 'C', 'D'] }, // 50×4 + E 的 50
    { amount: 240, eligible: ['B', 'C', 'D'] }, // 70×3 + E 剩下的 30
    { amount: 360, eligible: ['C', 'D'] },
  ]);
  assert.equal(pots.reduce((s, p) => s + p.amount, 0), 50 + 120 + 300 + 300 + 80);
});

test('没人跟的多余下注单独成池（等于退还）', () => {
  assert.deepEqual(buildPots([P('A', 500), P('B', 200)]), [
    { amount: 400, eligible: ['A', 'B'] },
    { amount: 300, eligible: ['A'] },
  ]);
});
