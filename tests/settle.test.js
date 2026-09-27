import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCents, formatCents, splitAmount, computeBalances, settleUp, allocate, expenseShares } from '../settle.js';

const people = [
  { id: 'a', name: 'Alice' },
  { id: 'b', name: 'Bob' },
  { id: 'c', name: 'Cara' },
];

test('toCents rounds to whole cents', () => {
  assert.equal(toCents('12.34'), 1234);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.ok(Number.isNaN(toCents('abc')));
});

test('formatCents', () => {
  assert.equal(formatCents(123456, '$'), '$1,234.56');
  assert.equal(formatCents(-5, '£'), '-£0.05');
});

test('splitAmount always sums to the total', () => {
  assert.deepEqual(splitAmount(1000, 3), [334, 333, 333]);
  assert.deepEqual(splitAmount(1, 2), [1, 0]);
  for (let total = 0; total < 500; total += 7) {
    for (let n = 1; n < 8; n++) {
      assert.equal(splitAmount(total, n).reduce((s, x) => s + x, 0), total);
    }
  }
});

test('expense split among everyone', () => {
  const balances = computeBalances(people, [
    { amountCents: 9000, paidBy: 'a', splitAmong: ['a', 'b', 'c'] },
  ]);
  assert.deepEqual(balances.get('a'), { paid: 9000, share: 3000, sent: 0, received: 0, net: 6000 });
  assert.equal(balances.get('b').net, -3000);
  assert.equal(balances.get('c').net, -3000);
  assert.deepEqual(settleUp(balances), [
    { from: 'b', to: 'a', amountCents: 3000 },
    { from: 'c', to: 'a', amountCents: 3000 },
  ]);
});

test('expense split among a subset excludes the others', () => {
  const balances = computeBalances(people, [
    { amountCents: 4000, paidBy: 'c', splitAmong: ['a', 'b'] },
  ]);
  assert.equal(balances.get('a').net, -2000);
  assert.equal(balances.get('b').net, -2000);
  assert.equal(balances.get('c').net, 4000);
  assert.equal(balances.get('c').share, 0);
});

test('balances always net to zero and settle completely', () => {
  const expenses = [
    { amountCents: 10001, paidBy: 'a', splitAmong: ['a', 'b', 'c'] },
    { amountCents: 3333, paidBy: 'b', splitAmong: ['b', 'c'] },
    { amountCents: 2500, paidBy: 'c', splitAmong: ['a'] },
    { amountCents: 777, paidBy: 'a', splitAmong: ['c', 'b'] },
  ];
  const balances = computeBalances(people, expenses);
  const total = [...balances.values()].reduce((s, b) => s + b.net, 0);
  assert.equal(total, 0);

  const payments = settleUp(balances);
  assert.ok(payments.length <= people.length - 1);
  const after = new Map([...balances].map(([id, b]) => [id, b.net]));
  for (const p of payments) {
    after.set(p.from, after.get(p.from) + p.amountCents);
    after.set(p.to, after.get(p.to) - p.amountCents);
  }
  for (const v of after.values()) assert.equal(v, 0);
});

test('invalid expenses are ignored', () => {
  const balances = computeBalances(people, [
    { amountCents: 1000, paidBy: 'a', splitAmong: [] },
    { amountCents: 0, paidBy: 'a', splitAmong: ['b'] },
  ]);
  for (const b of balances.values()) assert.equal(b.net, 0);
  assert.deepEqual(settleUp(balances), []);
});

test('allocate splits exactly by weight', () => {
  assert.deepEqual(allocate(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(allocate(1000, [2, 1, 1]), [500, 250, 250]);
  assert.deepEqual(allocate(1001, [2, 1, 1]), [501, 250, 250]);
  assert.deepEqual(allocate(100, [0.5, 1]), [33, 67]);
  assert.deepEqual(allocate(100, [0, 0]), [0, 0]);
  for (let t = 1; t < 300; t += 13) assert.equal(allocate(t, [3, 1, 2.5, 7]).reduce((s, x) => s + x, 0), t);
});

test('shares and exact splits', () => {
  const base = { amountCents: 6000, paidBy: 'a', splitAmong: ['a', 'b', 'c'] };
  assert.deepEqual(expenseShares(base), [2000, 2000, 2000]);
  assert.deepEqual(expenseShares({ ...base, splitMode: 'shares', splitWeights: { a: 1, b: 1, c: 0.5 } }), [2400, 2400, 1200]);
  assert.deepEqual(expenseShares({ ...base, splitMode: 'exact', splitWeights: { a: 3000, b: 2000, c: 1000 } }), [3000, 2000, 1000]);
  // Exact amounts still apply proportionally after conversion to another currency.
  assert.deepEqual(expenseShares({ ...base, amountCents: 5160, splitMode: 'exact', splitWeights: { a: 3000, b: 2000, c: 1000 } }), [2580, 1720, 860]);
  // Missing weights fall back to an equal split.
  assert.deepEqual(expenseShares({ ...base, splitMode: 'shares', splitWeights: {} }), [2000, 2000, 2000]);
  const balances = computeBalances(people, [{ ...base, splitMode: 'exact', splitWeights: { a: 3000, b: 2000, c: 1000 } }]);
  assert.equal(balances.get('b').net, -2000);
  assert.equal(balances.get('a').net, 3000);
});

test('repayments settle balances without counting as spending', () => {
  const expenses = [
    { amountCents: 9000, paidBy: 'a', splitAmong: ['a', 'b', 'c'] },
    { kind: 'payment', amountCents: 3000, paidBy: 'b', splitAmong: ['a'] },
  ];
  const balances = computeBalances(people, expenses);
  assert.deepEqual(balances.get('b'), { paid: 0, share: 3000, sent: 3000, received: 0, net: 0 });
  assert.deepEqual(balances.get('a'), { paid: 9000, share: 3000, sent: 0, received: 3000, net: 3000 });
  assert.deepEqual(settleUp(balances), [{ from: 'c', to: 'a', amountCents: 3000 }]);
});
