import { toCents, formatCents, splitAmount, computeBalances, settleUp } from './settle.js';

const STORAGE_KEY = 'split-costs:v1';

// ---------- State & persistence ----------

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.trips)) return parsed;
    }
  } catch {
    // Storage unavailable or corrupt: start fresh.
  }
  return { trips: [], currentTripId: null, tab: 'people' };
}

let state = loadState();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode / full storage: the app still works for this session.
  }
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const currentTrip = () => state.trips.find((t) => t.id === state.currentTripId) || null;
const personName = (trip, id) => trip.people.find((p) => p.id === id)?.name ?? 'Unknown';
const money = (trip, cents) => formatCents(cents, trip.currency);
const today = () => new Date().toISOString().slice(0, 10);

function update(fn) {
  fn();
  save();
  render();
}

// ---------- DOM helpers ----------

const $ = (sel) => document.querySelector(sel);

/** Tiny element builder: h('li', {class: 'x'}, child, 'text'). Never uses innerHTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// ---------- Trips ----------

function createTrip() {
  const trip = { id: uid(), name: `Trip ${state.trips.length + 1}`, currency: '$', people: [], expenses: [] };
  update(() => {
    state.trips.push(trip);
    state.currentTripId = trip.id;
    state.tab = 'people';
  });
  $('#trip-name').select();
}

$('#new-trip').addEventListener('click', createTrip);
$('#new-trip-empty').addEventListener('click', createTrip);

$('#trip-select').addEventListener('change', (e) => {
  resetExpenseForm();
  update(() => { state.currentTripId = e.target.value; });
});

$('#trip-name').addEventListener('input', (e) => {
  const trip = currentTrip();
  trip.name = e.target.value;
  save();
  renderTripSelect();
});

$('#trip-currency').addEventListener('input', (e) => {
  const trip = currentTrip();
  trip.currency = e.target.value.trim();
  save();
  renderTripBody();
});

$('#delete-trip').addEventListener('click', () => {
  const trip = currentTrip();
  if (!confirm(`Delete "${trip.name || 'this trip'}" and all its expenses? This can't be undone.`)) return;
  resetExpenseForm();
  update(() => {
    state.trips = state.trips.filter((t) => t.id !== trip.id);
    state.currentTripId = state.trips[0]?.id ?? null;
  });
});

// ---------- Tabs ----------

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => update(() => { state.tab = btn.dataset.tab; }));
});

// ---------- People ----------

$('#add-person-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#person-name');
  const name = input.value.trim();
  if (!name) return;
  const trip = currentTrip();
  if (trip.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    input.setCustomValidity('That name is already on the trip');
    input.reportValidity();
    return;
  }
  update(() => trip.people.push({ id: uid(), name }));
  input.value = '';
  input.focus();
});
$('#person-name').addEventListener('input', (e) => e.target.setCustomValidity(''));

function personInUse(trip, id) {
  return trip.expenses.some((e) => e.paidBy === id || e.splitAmong.includes(id));
}

function renderPeople(trip) {
  const list = $('#people-list');
  if (trip.people.length === 0) {
    list.replaceChildren(h('li', { class: 'empty-row' }, 'No one yet — add everyone on the trip.'));
    return;
  }
  list.replaceChildren(...trip.people.map((p) => {
    const inUse = personInUse(trip, p.id);
    return h('li', {},
      h('div', { class: 'main title' }, p.name),
      h('button', {
        type: 'button', class: 'icon',
        onclick: () => {
          const name = prompt('Rename', p.name)?.trim();
          if (name) update(() => { p.name = name; });
        },
      }, 'Rename'),
      h('button', {
        type: 'button', class: 'icon danger',
        disabled: inUse,
        title: inUse ? 'Remove them from expenses first' : null,
        onclick: () => update(() => { trip.people = trip.people.filter((x) => x.id !== p.id); }),
      }, 'Remove'),
    );
  }));
}

// ---------- Expenses ----------

let editingId = null;

function selectedSplit() {
  return [...document.querySelectorAll('#split-options input:checked')].map((i) => i.value);
}

function renderExpenseForm(trip) {
  const hasPeople = trip.people.length > 0;
  $('#expenses-need-people').hidden = hasPeople;
  $('#expense-form').hidden = !hasPeople;
  if (!hasPeople) return;

  // Preserve current selections across re-renders.
  const payerSel = $('#expense-payer');
  const prevPayer = payerSel.value;
  const prevSplit = new Set(selectedSplit());
  const firstRender = $('#split-options').childElementCount === 0;

  payerSel.replaceChildren(...trip.people.map((p) => h('option', { value: p.id }, p.name)));
  if (trip.people.some((p) => p.id === prevPayer)) payerSel.value = prevPayer;

  $('#split-options').replaceChildren(...trip.people.map((p) =>
    h('label', { class: 'chip' },
      h('input', {
        type: 'checkbox', value: p.id,
        checked: firstRender || prevSplit.has(p.id) || !knownSplitIds.has(p.id),
        onchange: updateSplitPreview,
      }),
      p.name,
    ),
  ));
  knownSplitIds = new Set(trip.people.map((p) => p.id));

  if (!$('#expense-date').value) $('#expense-date').value = today();
  $('#expense-form-title').textContent = editingId ? 'Edit expense' : 'Add an expense';
  $('#expense-submit').textContent = editingId ? 'Save changes' : 'Add expense';
  $('#cancel-edit').hidden = !editingId;
  updateSplitPreview();
}
// People added after the form was drawn start out ticked.
let knownSplitIds = new Set();

function updateSplitPreview() {
  const trip = currentTrip();
  const ids = selectedSplit();
  const cents = toCents($('#expense-amount').value);
  const preview = $('#split-preview');
  if (ids.length === 0) {
    preview.textContent = 'Select at least one person.';
  } else if (cents > 0) {
    const shares = splitAmount(cents, ids.length);
    const min = Math.min(...shares);
    const max = Math.max(...shares);
    const each = min === max ? money(trip, min) : `${money(trip, min)}–${money(trip, max)}`;
    preview.textContent = `${ids.length} ${ids.length === 1 ? 'person' : 'people'} · ${each} each`;
  } else {
    preview.textContent = `${ids.length} ${ids.length === 1 ? 'person' : 'people'} selected`;
  }
}
$('#expense-amount').addEventListener('input', updateSplitPreview);

function setAllSplit(checked) {
  document.querySelectorAll('#split-options input').forEach((i) => { i.checked = checked; });
  updateSplitPreview();
}
$('#split-all').addEventListener('click', () => setAllSplit(true));
$('#split-none').addEventListener('click', () => setAllSplit(false));

function resetExpenseForm() {
  editingId = null;
  $('#expense-form').reset();
  $('#expense-error').textContent = '';
  $('#split-options').replaceChildren();
  knownSplitIds = new Set();
}

$('#cancel-edit').addEventListener('click', () => {
  resetExpenseForm();
  render();
});

$('#expense-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const trip = currentTrip();
  const description = $('#expense-desc').value.trim();
  const amountCents = toCents($('#expense-amount').value);
  const paidBy = $('#expense-payer').value;
  const splitAmong = selectedSplit();
  const date = $('#expense-date').value || today();
  const error = $('#expense-error');

  if (!description) return void (error.textContent = 'Enter a description.');
  if (!(amountCents > 0)) return void (error.textContent = 'Enter an amount greater than zero.');
  if (splitAmong.length === 0) return void (error.textContent = 'Choose at least one person to split this between.');
  error.textContent = '';

  const wasEditing = editingId;
  update(() => {
    const data = { description, amountCents, paidBy, splitAmong, date };
    if (wasEditing) {
      Object.assign(trip.expenses.find((x) => x.id === wasEditing), data);
    } else {
      trip.expenses.push({ id: uid(), ...data });
    }
    resetExpenseForm();
  });
  $('#expense-desc').focus();
});

function startEdit(trip, expense) {
  editingId = expense.id;
  $('#expense-desc').value = expense.description;
  $('#expense-amount').value = (expense.amountCents / 100).toFixed(2);
  $('#expense-payer').value = expense.paidBy;
  $('#expense-date').value = expense.date || '';
  document.querySelectorAll('#split-options input').forEach((i) => {
    i.checked = expense.splitAmong.includes(i.value);
  });
  renderExpenseForm(trip);
  $('#expense-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#expense-desc').focus();
}

function renderExpenses(trip) {
  const list = $('#expense-list');
  const total = trip.expenses.reduce((s, e) => s + e.amountCents, 0);
  $('#expense-total').textContent = trip.expenses.length ? `· ${money(trip, total)} total` : '';

  if (trip.expenses.length === 0) {
    list.replaceChildren(h('li', { class: 'empty-row' }, 'No expenses yet.'));
    return;
  }

  const sorted = [...trip.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  list.replaceChildren(...sorted.map((e) => {
    const everyone = e.splitAmong.length === trip.people.length;
    const splitText = everyone ? 'everyone' : e.splitAmong.map((id) => personName(trip, id)).join(', ');
    return h('li', {},
      h('div', { class: 'main' },
        h('div', { class: 'title' }, e.description),
        h('div', { class: 'muted small' },
          `${personName(trip, e.paidBy)} paid · split between ${splitText}${e.date ? ` · ${e.date}` : ''}`),
      ),
      h('div', { class: 'amount' }, money(trip, e.amountCents)),
      h('button', { type: 'button', class: 'icon', onclick: () => startEdit(trip, e) }, 'Edit'),
      h('button', {
        type: 'button', class: 'icon danger',
        onclick: () => {
          if (!confirm(`Delete "${e.description}"?`)) return;
          if (editingId === e.id) resetExpenseForm();
          update(() => { trip.expenses = trip.expenses.filter((x) => x.id !== e.id); });
        },
      }, 'Delete'),
    );
  }));
}

// ---------- Settle up ----------

function renderSettle(trip) {
  const balances = computeBalances(trip.people, trip.expenses);
  const payments = settleUp(balances);

  const rows = trip.people.map((p) => {
    const b = balances.get(p.id);
    const cls = b.net > 0 ? 'positive' : b.net < 0 ? 'negative' : '';
    const label = b.net > 0 ? `gets back ${money(trip, b.net)}` : b.net < 0 ? `owes ${money(trip, -b.net)}` : 'settled';
    return h('tr', {},
      h('td', {}, p.name),
      h('td', {}, money(trip, b.paid)),
      h('td', {}, money(trip, b.share)),
      h('td', { class: cls }, label),
    );
  });
  $('#balance-table tbody').replaceChildren(
    ...(rows.length ? rows : [h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'Add people to see balances.'))]),
  );

  const list = $('#payment-list');
  if (payments.length === 0) {
    list.replaceChildren(h('li', { class: 'empty-row' },
      trip.expenses.length ? 'Everyone is square — nothing to pay.' : 'Add some expenses to see who owes whom.'));
  } else {
    list.replaceChildren(...payments.map((p) =>
      h('li', { class: 'payment' },
        h('div', { class: 'main' },
          h('strong', {}, personName(trip, p.from)),
          h('span', { class: 'arrow' }, 'pays →'),
          h('strong', {}, personName(trip, p.to)),
        ),
        h('div', { class: 'amount' }, money(trip, p.amountCents)),
      ),
    ));
  }
  $('#copy-summary').hidden = payments.length === 0;
}

$('#copy-summary').addEventListener('click', async () => {
  const trip = currentTrip();
  const payments = settleUp(computeBalances(trip.people, trip.expenses));
  const total = trip.expenses.reduce((s, e) => s + e.amountCents, 0);
  const text = [
    `${trip.name || 'Trip'} — total spent ${money(trip, total)}`,
    '',
    ...payments.map((p) => `${personName(trip, p.from)} pays ${personName(trip, p.to)} ${money(trip, p.amountCents)}`),
  ].join('\n');
  const status = $('#copy-status');
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'Copied!';
  } catch {
    status.textContent = 'Could not copy — select the list above instead.';
  }
  setTimeout(() => { status.textContent = ''; }, 2500);
});

// ---------- Render ----------

function renderTripSelect() {
  const sel = $('#trip-select');
  sel.replaceChildren(...state.trips.map((t) =>
    h('option', { value: t.id, selected: t.id === state.currentTripId }, t.name || 'Untitled trip')));
  sel.hidden = state.trips.length === 0;
}

function renderTripBody() {
  const trip = currentTrip();
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === state.tab));
  });
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== state.tab; });
  renderPeople(trip);
  renderExpenseForm(trip);
  renderExpenses(trip);
  renderSettle(trip);
}

function render() {
  if (!currentTrip() && state.trips.length) state.currentTripId = state.trips[0].id;
  const trip = currentTrip();
  renderTripSelect();
  $('#no-trip').hidden = !!trip;
  $('#trip-view').hidden = !trip;
  if (!trip) return;

  if (document.activeElement !== $('#trip-name')) $('#trip-name').value = trip.name;
  if (document.activeElement !== $('#trip-currency')) $('#trip-currency').value = trip.currency;
  renderTripBody();
}

render();
