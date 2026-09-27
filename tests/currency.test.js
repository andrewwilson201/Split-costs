import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCurrency, currencyDigits, toMinor, minorToInput, formatMoney, convertMinor,
  amountInTripCurrency, formatRate, fetchRate, CURRENCY_GROUPS,
} from '../currency.js';

test('normalizeCurrency handles codes and old symbols', () => {
  assert.equal(normalizeCurrency('GBP'), 'GBP');
  assert.equal(normalizeCurrency('eur'), 'EUR');
  assert.equal(normalizeCurrency('£'), 'GBP');
  assert.equal(normalizeCurrency('$'), 'USD');
  assert.equal(normalizeCurrency(''), 'GBP');
  assert.equal(normalizeCurrency(undefined), 'GBP');
});

test('every listed currency is valid and unique', () => {
  const codes = CURRENCY_GROUPS.flatMap((g) => g.codes);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.doesNotThrow(() => new Intl.NumberFormat('en', { style: 'currency', currency: c }));
});

test('minor units follow each currency', () => {
  assert.equal(currencyDigits('GBP'), 2);
  assert.equal(currencyDigits('JPY'), 0);
  assert.equal(toMinor('12.34', 'GBP'), 1234);
  assert.equal(toMinor('1500', 'JPY'), 1500);
  assert.ok(Number.isNaN(toMinor('', 'GBP')));
  assert.equal(minorToInput(1234, 'EUR'), '12.34');
  assert.equal(minorToInput(1500, 'JPY'), '1500');
});

test('formatMoney', () => {
  assert.equal(formatMoney(123456, 'GBP', 'en-GB'), '£1,234.56');
  assert.equal(formatMoney(-500, 'EUR', 'en-GB'), '-€5.00');
  assert.equal(formatMoney(1500, 'JPY', 'en-GB'), 'JP¥1,500');
});

test('convertMinor rounds to the target currency', () => {
  assert.equal(convertMinor(10000, 'EUR', 'GBP', 0.8598483), 8598);
  assert.equal(convertMinor(1500, 'JPY', 'GBP', 0.0052), 780);
  assert.equal(convertMinor(1000, 'GBP', 'JPY', 190.5), 1905);
});

test('amountInTripCurrency', () => {
  assert.equal(amountInTripCurrency({ amountCents: 500 }, 'GBP'), 500); // older expense
  assert.equal(amountInTripCurrency({ amountCents: 500, currency: 'GBP' }, 'GBP'), 500);
  assert.equal(amountInTripCurrency({ amountCents: 10000, currency: 'EUR', rate: 0.86, rateTo: 'GBP' }, 'GBP'), 8600);
  // A rate into a different main currency can't be used.
  assert.equal(amountInTripCurrency({ amountCents: 10000, currency: 'EUR', rate: 1.08, rateTo: 'USD' }, 'GBP'), null);
  assert.equal(amountInTripCurrency({ amountCents: 10000, currency: 'EUR' }, 'GBP'), null);
});

test('formatRate', () => {
  assert.equal(formatRate(0.8598483), '0.859848');
  assert.equal(formatRate(190.5), '190.5');
  assert.equal(formatRate(0), '');
});

const fakeFetch = (table) => async (url) => {
  const body = table[url];
  return body ? { ok: true, json: async () => body } : { ok: false, json: async () => ({}) };
};
const jsd = (tag, f) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/${f}.min.json`;
const pages = (tag, f) => `https://${tag}.currency-api.pages.dev/v1/currencies/${f}.min.json`;

test('fetchRate uses the rate for the expense date', async () => {
  const fetchFn = fakeFetch({ [jsd('2026-09-20', 'eur')]: { date: '2026-09-20', eur: { gbp: 0.85 } } });
  assert.deepEqual(await fetchRate('EUR', 'GBP', '2026-09-20', { today: '2026-09-27', fetchFn }), { rate: 0.85, date: '2026-09-20' });
});

test('fetchRate falls back to the mirror and then the day before', async () => {
  const mirror = fakeFetch({ [pages('2026-09-21', 'usd')]: { date: '2026-09-21', usd: { gbp: 0.75 } } });
  assert.equal((await fetchRate('USD', 'GBP', '2026-09-21', { today: '2026-09-27', fetchFn: mirror })).rate, 0.75);
  const dayBefore = fakeFetch({ [jsd('2026-09-21', 'chf')]: { date: '2026-09-21', chf: { gbp: 0.9 } } });
  assert.deepEqual(await fetchRate('CHF', 'GBP', '2026-09-22', { today: '2026-09-27', fetchFn: dayBefore }), { rate: 0.9, date: '2026-09-21' });
});

test('fetchRate uses the latest rate for today', async () => {
  const fetchFn = fakeFetch({ [jsd('latest', 'sek')]: { date: '2026-09-27', sek: { gbp: 0.07 } } });
  assert.equal((await fetchRate('SEK', 'GBP', '2026-09-27', { today: '2026-09-27', fetchFn })).rate, 0.07);
});

test('fetchRate rejects when no source has the rate', async () => {
  await assert.rejects(fetchRate('NOK', 'GBP', '2026-09-10', { today: '2026-09-27', fetchFn: fakeFetch({}) }));
  assert.deepEqual(await fetchRate('GBP', 'GBP', '2026-09-10'), { rate: 1, date: '2026-09-10' });
});
