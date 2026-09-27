import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessCategory, expenseCategory, CATEGORIES } from '../categories.js';

test('the Ghent trip expenses land in sensible categories', () => {
  const cases = {
    'Terrace beer': 'drinks', 'Stroom beers': 'drinks', 'Dok beers': 'drinks', Beer: 'drinks',
    Coffee: 'drinks', Bbq: 'food', Breakfast: 'food', Dinner: 'food', Waffles: 'food',
    Boat: 'activities', Castle: 'activities', 'AR church': 'activities',
  };
  for (const [description, category] of Object.entries(cases)) {
    assert.equal(guessCategory(description), category, description);
  }
});

test('other common expenses', () => {
  assert.equal(guessCategory('Taxi to airport'), 'transport');
  assert.equal(guessCategory('Eurostar tickets'), 'transport');
  assert.equal(guessCategory('Hotel'), 'accommodation');
  assert.equal(guessCategory('Airbnb 3 nights'), 'accommodation');
  assert.equal(guessCategory('Hotel breakfast'), 'accommodation');
  assert.equal(guessCategory('Souvenirs'), 'shopping');
  assert.equal(guessCategory('Groceries'), 'food');
  assert.equal(guessCategory('Beer tasting tour'), 'activities');
  assert.equal(guessCategory('Museum café'), 'drinks');
  assert.equal(guessCategory('Frites'), 'food');
  assert.equal(guessCategory('Misc'), 'other');
  assert.equal(guessCategory(''), 'other');
});

test('whole words only', () => {
  assert.equal(guessCategory('Barbecue'), 'food'); // not "bar"
  assert.equal(guessCategory('Busking donation'), 'other'); // not "bus"
});

test('an override wins over the guess, unknown overrides are ignored', () => {
  assert.equal(expenseCategory({ description: 'Beer', category: 'activities' }), 'activities');
  assert.equal(expenseCategory({ description: 'Beer', category: 'nonsense' }), 'drinks');
  assert.equal(expenseCategory({ description: 'Beer' }), 'drinks');
});

test('categories are fixed and ordered', () => {
  assert.deepEqual(CATEGORIES.map((c) => c.id), ['food', 'drinks', 'activities', 'transport', 'accommodation', 'shopping', 'other']);
});

import { spendingByDay, niceScale } from '../categories.js';

test('spendingByDay fills every day and splits by category', () => {
  const r = spendingByDay([
    { date: '2026-09-25', description: 'Terrace beer', amountCents: 1343 },
    { date: '2026-09-27', description: 'Dinner', amountCents: 21109 },
    { date: '2026-09-27', description: 'Beer', amountCents: 1999 },
    { date: '2026-09-27', description: 'Coffee', amountCents: 1034, category: 'food' },
    { date: '', description: 'Undated', amountCents: 500 },
  ]);
  assert.deepEqual(r.days.map((d) => d.date), ['2026-09-25', '2026-09-26', '2026-09-27']);
  assert.equal(r.days[1].total, 0);
  assert.deepEqual(r.days[2].byCategory, { food: 22143, drinks: 1999 });
  assert.deepEqual(r.totals, { drinks: 3342, food: 22143 });
  assert.equal(r.total, 25485);
});

test('spendingByDay crosses month ends and handles no expenses', () => {
  const r = spendingByDay([
    { date: '2026-09-30', description: 'Taxi', amountCents: 100 },
    { date: '2026-10-01', description: 'Taxi', amountCents: 100 },
  ]);
  assert.deepEqual(r.days.map((d) => d.date), ['2026-09-30', '2026-10-01']);
  assert.deepEqual(spendingByDay([]), { days: [], totals: {}, total: 0 });
});

test('niceScale', () => {
  assert.deepEqual(niceScale(40572), { max: 50000, step: 10000 });
  assert.deepEqual(niceScale(27827), { max: 30000, step: 10000 });
  assert.deepEqual(niceScale(16544), { max: 20000, step: 5000 });
  assert.deepEqual(niceScale(900), { max: 1000, step: 200 });
  assert.deepEqual(niceScale(0), { max: 5, step: 1 });
});
