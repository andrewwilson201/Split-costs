// Expense categories, guessed from the description. People can override the
// guess on any expense; an override is stored as the expense's `category`.

export const CATEGORIES = [
  { id: 'food', label: 'Food' },
  { id: 'drinks', label: 'Drinks' },
  { id: 'activities', label: 'Activities' },
  { id: 'transport', label: 'Transport' },
  { id: 'accommodation', label: 'Accommodation' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'other', label: 'Other' },
];

const IDS = new Set(CATEGORIES.map((c) => c.id));
export const isCategory = (id) => IDS.has(id);
export const categoryLabel = (id) => CATEGORIES.find((c) => c.id === id)?.label ?? 'Other';

// Words are matched whole (with a plural "s"/"es"), so "bar" doesn't match
// "barbecue". Phrases with a space are matched as they appear.
const KEYWORDS = {
  drinks: [
    'beer', 'bier', 'pint', 'ale', 'lager', 'ipa', 'wine', 'prosecco', 'champagne', 'cava', 'cocktail',
    'gin', 'vodka', 'whisky', 'whiskey', 'rum', 'shot', 'spirit', 'bar', 'pub', 'drink', 'round',
    'coffee', 'tea', 'latte', 'cappuccino', 'espresso', 'cafe', 'café', 'juice', 'water', 'soda',
    'aperitif', 'apéro', 'happy hour',
  ],
  food: [
    'breakfast', 'brunch', 'lunch', 'dinner', 'supper', 'meal', 'food', 'restaurant', 'snack', 'bbq',
    'barbecue', 'grocery', 'groceries', 'supermarket', 'pizza', 'burger', 'chips', 'fries', 'frites',
    'waffle', 'crepe', 'crêpe', 'pastry', 'bakery', 'bread', 'sandwich', 'takeaway', 'kebab', 'sushi',
    'curry', 'ice cream', 'gelato', 'dessert', 'cake', 'chocolate', 'mussels', 'tapas', 'picnic',
    'deli', 'noodles', 'ramen', 'pasta', 'steak', 'fish', 'bistro', 'brasserie', 'eat', 'eats',
  ],
  activities: [
    'museum', 'gallery', 'tour', 'ticket', 'entry', 'entrance', 'admission', 'castle', 'church',
    'cathedral', 'abbey', 'palace', 'tower', 'boat', 'cruise', 'show', 'concert', 'gig', 'cinema',
    'theatre', 'theater', 'festival', 'zoo', 'aquarium', 'park', 'spa', 'golf', 'bowling', 'climb',
    'hike', 'kayak', 'bike hire', 'bike rental', 'lesson', 'class', 'game', 'match', 'escape room',
    'exhibition', 'attraction', 'excursion', 'activity',
  ],
  transport: [
    'taxi', 'uber', 'bolt', 'lyft', 'cab', 'train', 'rail', 'bus', 'coach', 'tram', 'metro', 'tube',
    'subway', 'underground', 'ferry', 'flight', 'plane', 'airport', 'fuel', 'petrol', 'diesel', 'gas',
    'parking', 'toll', 'car hire', 'car rental', 'rental car', 'transfer', 'ticket machine', 'scooter',
    'transport', 'eurostar', 'charging',
  ],
  accommodation: [
    'hotel', 'hostel', 'airbnb', 'apartment', 'flat', 'room', 'rooms', 'accommodation', 'b&b',
    'bnb', 'guesthouse', 'guest house', 'villa', 'cabin', 'lodge', 'campsite', 'camping', 'booking',
    'stay', 'resort', 'chalet',
  ],
  shopping: [
    'gift', 'gifts', 'souvenir', 'shop', 'shopping', 'market', 'clothes', 'clothing', 'shoes',
    'pharmacy', 'chemist', 'sunscreen', 'toiletries', 'present', 'postcard', 'book',
  ],
};

// When a description matches more than one category, the first in this order
// wins: "wine tour" is an activity, "hotel breakfast" is food.
const PRIORITY = ['accommodation', 'transport', 'activities', 'food', 'drinks', 'shopping'];

function words(text) {
  return text.toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}&]+/u).filter(Boolean);
}

const hasWord = (tokens, key) => tokens.some((t) => t === key || t === `${key}s` || t === `${key}es`);

/** Guess an expense's category from its description. */
export function guessCategory(description) {
  const text = String(description ?? '').toLowerCase();
  const tokens = words(text);
  const matches = (key) => (key.includes(' ') ? text.includes(key) : hasWord(tokens, key));
  // An activity word only beats food/drink when it's the main thing, not a place:
  // "Castle" is an activity, but "castle cafe" is drinks.
  const hits = PRIORITY.filter((id) => KEYWORDS[id].some(matches));
  if (hits.length === 0) return 'other';
  if (hits.includes('activities') && (hits.includes('food') || hits.includes('drinks'))) {
    const tour = ['tour', 'tasting', 'class', 'lesson', 'ticket', 'cruise'].some((k) => hasWord(tokens, k));
    if (!tour) return hits.includes('food') ? 'food' : 'drinks';
  }
  return hits[0];
}

/** The category an expense counts under: its override if set, otherwise the guess. */
export const expenseCategory = (expense) =>
  isCategory(expense.category) ? expense.category : guessCategory(expense.description);

// ---------- Spending per day ----------

const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Totals per day and category. `expenses` must already be in one currency.
 * Every day from the first to the last is included, so quiet days show as gaps.
 * Returns {days: [{date, total, byCategory: {id: minor}}], totals: {id: minor}, total}.
 */
export function spendingByDay(expenses, maxDays = 120) {
  const dated = expenses.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date ?? ''));
  const totals = {};
  let total = 0;
  if (dated.length === 0) return { days: [], totals, total };
  const dates = dated.map((e) => e.date).sort();
  const byDate = new Map();
  for (let d = dates[0], i = 0; d <= dates[dates.length - 1] && i < maxDays; d = addDays(d, 1), i++) {
    byDate.set(d, { date: d, total: 0, byCategory: {} });
  }
  for (const e of dated) {
    const day = byDate.get(e.date);
    if (!day) continue;
    const cat = expenseCategory(e);
    day.byCategory[cat] = (day.byCategory[cat] ?? 0) + e.amountCents;
    day.total += e.amountCents;
    totals[cat] = (totals[cat] ?? 0) + e.amountCents;
    total += e.amountCents;
  }
  return { days: [...byDate.values()], totals, total };
}

/** A round axis maximum at or above `max`, with its tick step (1, 2, 2.5 or 5 × 10ⁿ). */
export function niceScale(max, ticks = 5) {
  if (!(max > 0)) return { max: ticks, step: 1 };
  const rough = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough);
  return { max: step * Math.ceil(max / step), step };
}
