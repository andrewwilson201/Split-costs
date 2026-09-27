// Currencies, money formatting and exchange rates.
//
// Amounts are stored as whole minor units of their own currency (pence,
// cents, or whole yen for currencies without decimals). An expense in a
// different currency from its trip also stores the rate that converts it:
// 1 unit of the expense currency = `rate` units of the trip currency (`rateTo`).

export const DEFAULT_CURRENCY = 'GBP';

const COMMON = ['GBP', 'EUR', 'USD'];
const OTHERS = [
  'AED', 'ARS', 'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CZK', 'DKK', 'EGP',
  'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KES', 'KRW', 'LKR', 'MAD', 'MXN', 'MYR',
  'NOK', 'NZD', 'PEN', 'PHP', 'PLN', 'QAR', 'RON', 'RSD', 'SAR', 'SEK', 'SGD', 'THB', 'TRY',
  'TWD', 'UAH', 'VND', 'ZAR',
];

let displayNames = null;
try {
  displayNames = new Intl.DisplayNames(['en'], { type: 'currency' });
} catch {
  // Older browsers: fall back to the bare code.
}

export const currencyName = (code) => displayNames?.of(code) ?? code;

/** Currencies for dropdowns: [{label, codes}] groups. */
export const CURRENCY_GROUPS = [
  { label: 'Common', codes: COMMON },
  { label: 'All currencies', codes: OTHERS },
];

// Trips made before the dropdown stored a symbol the user typed.
const SYMBOLS = { '£': 'GBP', '€': 'EUR', '$': 'USD', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₺': 'TRY', 'kr': 'SEK' };

/** Turn a stored currency (a code, or an old free-text symbol) into a currency code. */
export function normalizeCurrency(value) {
  const v = String(value ?? '').trim();
  if (/^[A-Za-z]{3}$/.test(v)) return v.toUpperCase();
  return SYMBOLS[v] ?? DEFAULT_CURRENCY;
}

const digitCache = new Map();
/** How many decimal places a currency uses (2 for GBP, 0 for JPY). */
export function currencyDigits(code) {
  if (!digitCache.has(code)) {
    let d = 2;
    try {
      d = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
    } catch {
      // Unknown code: assume 2.
    }
    digitCache.set(code, d);
  }
  return digitCache.get(code);
}

/** Convert a typed amount like "12.34" to minor units of `code`. NaN if not a number. */
export function toMinor(amount, code) {
  const n = Number(amount);
  if (!Number.isFinite(n) || String(amount).trim() === '') return NaN;
  return Math.round(n * 10 ** currencyDigits(code));
}

/** Minor units back to a plain decimal string for an input box, e.g. 1234 GBP -> "12.34". */
export function minorToInput(minor, code) {
  const d = currencyDigits(code);
  return (minor / 10 ** d).toFixed(d);
}

/** Format minor units as money, e.g. 1234 GBP -> "£12.34". */
export function formatMoney(minor, code, locale = undefined) {
  const d = currencyDigits(code);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(minor / 10 ** d);
  } catch {
    return `${(minor / 10 ** d).toFixed(d)} ${code}`;
  }
}

/** Convert minor units of `from` to minor units of `to` at `rate`. */
export function convertMinor(minor, from, to, rate) {
  return Math.round((minor / 10 ** currencyDigits(from)) * rate * 10 ** currencyDigits(to));
}

/** The currency an expense was paid in. Older expenses have none: they're in the trip currency. */
export const expenseCurrency = (expense, tripCurrency) => expense.currency || tripCurrency;

/**
 * An expense's amount in minor units of the trip currency, or null when it's
 * in another currency and has no rate into the trip currency (for example
 * just after the trip's main currency changed).
 */
export function amountInTripCurrency(expense, tripCurrency) {
  const from = expenseCurrency(expense, tripCurrency);
  if (from === tripCurrency) return expense.amountCents;
  if (expense.rateTo !== tripCurrency || !(expense.rate > 0)) return null;
  return convertMinor(expense.amountCents, from, tripCurrency, expense.rate);
}

/** Format a rate for display and editing: enough significant figures to be useful. */
export function formatRate(rate) {
  if (!(rate > 0)) return '';
  return String(Number(rate.toPrecision(6)));
}

// ---------- Market rates ----------
//
// Daily mid-market rates from the free currency-api project
// (https://github.com/fawazahmed0/exchange-api), served through jsDelivr with
// a Cloudflare Pages mirror as backup. It covers every currency above, has a
// snapshot for each day, and needs no API key.

const rateCache = new Map();

function rateUrls(tag, from) {
  const f = from.toLowerCase();
  return [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/${f}.min.json`,
    `https://${tag}.currency-api.pages.dev/v1/currencies/${f}.min.json`,
  ];
}

const shiftDay = (isoDate, days) => {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Look up the market rate from `from` to `to` on `date` (YYYY-MM-DD).
 * Resolves {rate, date} where `date` is the day the rate is for. Rates are
 * published early each morning (UTC), so today and future dates use the
 * latest rate, and a missing day falls back to the day before.
 */
export async function fetchRate(from, to, date, { today, fetchFn = globalThis.fetch } = {}) {
  if (from === to) return { rate: 1, date };
  const key = `${from}>${to}@${date}`;
  if (rateCache.has(key)) return rateCache.get(key);

  const tags = !date || (today && date >= today) ? ['latest'] : [date, shiftDay(date, -1)];
  for (const tag of tags) {
    for (const url of rateUrls(tag, from)) {
      try {
        const res = await fetchFn(url);
        if (!res.ok) continue;
        const json = await res.json();
        const rate = json?.[from.toLowerCase()]?.[to.toLowerCase()];
        if (typeof rate === 'number' && rate > 0) {
          const result = { rate, date: typeof json.date === 'string' ? json.date : date };
          rateCache.set(key, result);
          return result;
        }
      } catch {
        // Try the next source.
      }
    }
  }
  throw new Error(`No exchange rate available for ${from} to ${to}`);
}
