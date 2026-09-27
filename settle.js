// Pure calculation logic for splitting trip costs.
// All money is handled in integer cents to avoid floating point drift.

/** Convert a user-entered amount (string or number) to integer cents. */
export function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

/** Format integer cents as a money string, e.g. 1234 -> "12.34". */
export function formatCents(cents, symbol = '') {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${symbol}${whole}.${frac}`;
}

/**
 * Split totalCents across n people as evenly as possible.
 * Leftover cents go one each to the first people in the list, so the
 * shares always add up exactly to the total.
 */
export function splitAmount(totalCents, n) {
  if (n <= 0) return [];
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Work out what each person paid, what their fair share was, and their net
 * position (positive = they are owed money, negative = they owe money).
 *
 * @param {{id: string, name: string}[]} people
 * @param {{amountCents: number, paidBy: string, splitAmong: string[]}[]} expenses
 * @returns {Map<string, {paid: number, share: number, net: number}>}
 */
export function computeBalances(people, expenses) {
  const balances = new Map(people.map((p) => [p.id, { paid: 0, share: 0, net: 0 }]));
  const ensure = (id) => {
    if (!balances.has(id)) balances.set(id, { paid: 0, share: 0, net: 0 });
    return balances.get(id);
  };

  for (const e of expenses) {
    const participants = e.splitAmong.filter(Boolean);
    if (!e.paidBy || participants.length === 0 || !(e.amountCents > 0)) continue;

    ensure(e.paidBy).paid += e.amountCents;
    const shares = splitAmount(e.amountCents, participants.length);
    participants.forEach((id, i) => {
      ensure(id).share += shares[i];
    });
  }

  for (const b of balances.values()) b.net = b.paid - b.share;
  return balances;
}

/**
 * Produce a short list of payments that settles everyone's balance.
 * Repeatedly matches the person owed the most with the person who owes the
 * most, which settles n people in at most n - 1 payments.
 *
 * @param {Map<string, {net: number}>} balances
 * @returns {{from: string, to: string, amountCents: number}[]}
 */
export function settleUp(balances) {
  const creditors = [];
  const debtors = [];
  for (const [id, b] of balances) {
    if (b.net > 0) creditors.push({ id, amount: b.net });
    else if (b.net < 0) debtors.push({ id, amount: -b.net });
  }
  const byAmountDesc = (a, b) => b.amount - a.amount || a.id.localeCompare(b.id);
  creditors.sort(byAmountDesc);
  debtors.sort(byAmountDesc);

  const payments = [];
  let c = 0;
  let d = 0;
  while (c < creditors.length && d < debtors.length) {
    const amount = Math.min(creditors[c].amount, debtors[d].amount);
    payments.push({ from: debtors[d].id, to: creditors[c].id, amountCents: amount });
    creditors[c].amount -= amount;
    debtors[d].amount -= amount;
    if (creditors[c].amount === 0) c++;
    if (debtors[d].amount === 0) d++;
  }
  return payments;
}
