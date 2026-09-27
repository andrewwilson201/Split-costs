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
 * Split `total` in proportion to `weights`, in whole units, so the parts
 * always add up exactly to the total. Leftover units go to the largest
 * fractional parts (ties to whoever is listed first).
 */
export function allocate(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!(sum > 0)) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    parts[i] += 1;
    left -= 1;
  }
  return parts;
}

/** True for a repayment between two people rather than something bought. */
export const isPayment = (e) => e.kind === 'payment';

/**
 * Each participant's share of an expense, in the same units as `amountCents`.
 * Split modes: equal (default), 'shares' (weights like 2:1:1) or 'exact'
 * (amounts per person, stored as weights that add up to the total, so they
 * still apply after the expense is converted into another currency).
 */
export function expenseShares(e) {
  const ids = e.splitAmong.filter(Boolean);
  if (e.splitMode === 'shares' || e.splitMode === 'exact') {
    const weights = ids.map((id) => Math.max(0, Number(e.splitWeights?.[id]) || 0));
    if (weights.some((w) => w > 0)) return allocate(e.amountCents, weights);
  }
  return splitAmount(e.amountCents, ids.length);
}

/**
 * Work out what each person paid, what their fair share was, any repayments
 * they've made or received, and their net position (positive = they are owed
 * money, negative = they owe money).
 *
 * @returns {Map<string, {paid: number, share: number, sent: number, received: number, net: number}>}
 */
export function computeBalances(people, expenses) {
  const blank = () => ({ paid: 0, share: 0, sent: 0, received: 0, net: 0 });
  const balances = new Map(people.map((p) => [p.id, blank()]));
  const ensure = (id) => {
    if (!balances.has(id)) balances.set(id, blank());
    return balances.get(id);
  };

  for (const e of expenses) {
    const participants = e.splitAmong.filter(Boolean);
    if (!e.paidBy || participants.length === 0 || !(e.amountCents > 0)) continue;

    if (isPayment(e)) {
      ensure(e.paidBy).sent += e.amountCents;
      ensure(participants[0]).received += e.amountCents;
      continue;
    }
    ensure(e.paidBy).paid += e.amountCents;
    const shares = expenseShares(e);
    participants.forEach((id, i) => {
      ensure(id).share += shares[i];
    });
  }

  for (const b of balances.values()) b.net = b.paid - b.share + b.sent - b.received;
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
