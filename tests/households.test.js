import { test } from 'node:test';
import assert from 'node:assert/strict';
import { householdsOf, householdBalances, householdWeights, isHouseholdSplit, joinNames, hasHouseholds } from '../households.js';
import { computeBalances, settleUp, expenseShares } from '../settle.js';

const people = [
  { id: 'a', name: 'Andrew', household: 'h1' },
  { id: 's', name: 'Sue', household: 'h1' },
  { id: 'j', name: 'Jim', household: 'h2' },
  { id: 'k', name: 'Kate', household: 'h2' },
  { id: 'm', name: 'Mike', household: 'h3' },
  { id: 'o', name: 'Jo', household: 'h3' },
];

test('households group couples and leave singles on their own', () => {
  const units = householdsOf([...people, { id: 'x', name: 'Solo' }, { id: 'y', name: 'Lonely', household: 'h9' }]);
  assert.deepEqual(units.map((u) => u.name), ['Andrew & Sue', 'Jim & Kate', 'Mike & Jo', 'Solo', 'Lonely']);
  assert.deepEqual(units[3].memberIds, ['x']);
  assert.equal(joinNames(['A', 'B', 'C']), 'A, B & C');
  assert.equal(hasHouseholds(people), true);
  assert.equal(hasHouseholds([{ id: 'x', name: 'Solo', household: 'h1' }]), false);
});

test('couples settle with each other, not person to person', () => {
  const everyone = people.map((p) => p.id);
  const expenses = [
    { paidBy: 'a', amountCents: 12000, splitAmong: everyone }, // Andrew pays 120
    { paidBy: 's', amountCents: 6000, splitAmong: everyone }, // Sue pays 60
    { paidBy: 'k', amountCents: 6000, splitAmong: everyone }, // Kate pays 60
  ];
  const balances = computeBalances(people, expenses);
  const units = householdsOf(people);
  const byHousehold = householdBalances(balances, units);
  assert.equal(byHousehold.get('h:h1').net, 18000 - 8000); // paid 180, share 2 × 40
  assert.equal(byHousehold.get('h:h2').net, 6000 - 8000);
  assert.equal(byHousehold.get('h:h3').net, -8000);
  const payments = settleUp(byHousehold);
  assert.deepEqual(payments, [
    { from: 'h:h3', to: 'h:h1', amountCents: 8000 },
    { from: 'h:h2', to: 'h:h1', amountCents: 2000 },
  ]);
  // Household nets add up to the same as the individual nets.
  const sum = (m) => [...m.values()].reduce((s, b) => s + b.net, 0);
  assert.equal(sum(byHousehold), sum(balances));
});

test('split per household gives each household an equal part', () => {
  const ids = ['a', 's', 'j', 'k', 'm']; // Jo not included
  const weights = householdWeights(ids, people);
  assert.deepEqual(weights, [0.5, 0.5, 0.5, 0.5, 1]);
  const shares = expenseShares({ amountCents: 30000, splitAmong: ids, splitMode: 'shares', splitWeights: Object.fromEntries(ids.map((id, i) => [id, weights[i]])) });
  assert.deepEqual(shares, [5000, 5000, 5000, 5000, 10000]);
});

test('a stored per-household split is recognised', () => {
  const ids = ['a', 's', 'm'];
  const expense = { splitAmong: ids, splitMode: 'shares', splitWeights: { a: 0.5, s: 0.5, m: 1 } };
  assert.equal(isHouseholdSplit(expense, people), true);
  assert.equal(isHouseholdSplit({ ...expense, splitWeights: { a: 1, s: 1, m: 1 } }, people), false);
  assert.equal(isHouseholdSplit({ ...expense, splitMode: undefined }, people), false);
});
