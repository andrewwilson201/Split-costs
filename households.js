// Households: people who share money (couples, families). Everyone still
// enters their own expenses; settling up can then be done between households
// instead of between individuals. A household only counts when it has at
// least two people, and anyone not in one is a household of their own.

/** Group people into settling units: [{id, memberIds, name}], in trip order. */
export function householdsOf(people) {
  const counts = new Map();
  for (const p of people) if (p.household) counts.set(p.household, (counts.get(p.household) ?? 0) + 1);
  const units = new Map();
  for (const p of people) {
    const id = p.household && counts.get(p.household) > 1 ? `h:${p.household}` : p.id;
    if (!units.has(id)) units.set(id, { id, memberIds: [], names: [] });
    units.get(id).memberIds.push(p.id);
    units.get(id).names.push(p.name);
  }
  return [...units.values()].map(({ id, memberIds, names }) => ({ id, memberIds, name: joinNames(names) }));
}

/** "Andrew", "Andrew & Sue", "Andrew, Sue & Tom". */
export function joinNames(names) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** True when at least one household has two or more people. */
export const hasHouseholds = (people) => householdsOf(people).some((u) => u.memberIds.length > 1);

/** Add up each household's members' balances (paid, share, repayments and net). */
export function householdBalances(balances, units) {
  const result = new Map();
  for (const u of units) {
    const total = { paid: 0, share: 0, sent: 0, received: 0, net: 0 };
    for (const id of u.memberIds) {
      const b = balances.get(id);
      if (!b) continue;
      for (const k of Object.keys(total)) total[k] += b[k];
    }
    result.set(u.id, total);
  }
  return result;
}

/**
 * Shares that give each household an equal part of an expense, whatever its
 * size: the selected members of each household split one share between them.
 * Returns weights in the same order as `ids`.
 */
export function householdWeights(ids, people) {
  const unitOf = new Map();
  for (const u of householdsOf(people)) for (const m of u.memberIds) unitOf.set(m, u.id);
  const count = new Map();
  for (const id of ids) {
    const u = unitOf.get(id) ?? id;
    count.set(u, (count.get(u) ?? 0) + 1);
  }
  return ids.map((id) => 1 / count.get(unitOf.get(id) ?? id));
}

/** Whether stored shares are exactly a per-household split (so editing can show it that way). */
export function isHouseholdSplit(expense, people) {
  if (expense.splitMode !== 'shares' || !hasHouseholds(people)) return false;
  const expected = householdWeights(expense.splitAmong, people);
  return expense.splitAmong.every((id, i) => Math.abs((Number(expense.splitWeights?.[id]) || 0) - expected[i]) < 1e-9);
}
