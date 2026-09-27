import { toCents, formatCents, splitAmount, computeBalances, settleUp } from './settle.js';
import { openStore } from './store.js';

// ---------- Per-viewer preferences (which trip / tab is open) ----------

const PREFS_KEY = 'split-costs:prefs';
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}
const prefs = { tripId: null, tab: 'people', ...loadPrefs() };
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not critical.
  }
}

// ---------- Live data (mirrors the store) ----------

let store = null;
let db = null;
let trips = [];
let people = [];
let expenses = [];
let loadedTripId = null;
let unsubscribeTrip = [];

const byCreated = (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id);
const docsOf = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// The chosen trip, or the first one while it loads or if it was deleted.
const currentTrip = () => trips.find((t) => t.id === prefs.tripId) || trips[0] || null;
const personName = (id) => people.find((p) => p.id === id)?.name ?? 'Someone removed';
const money = (cents) => formatCents(cents, currentTrip()?.currency ?? '');
const uid = () => crypto.randomUUID();
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const tripDoc = (id) => db.doc(`trips/${id}`);
const peopleCol = (tripId) => db.collection(`trips/${tripId}/people`);
const expensesCol = (tripId) => db.collection(`trips/${tripId}/expenses`);

function subscribeToTrip(tripId) {
  if (tripId === loadedTripId) return;
  unsubscribeTrip.forEach((u) => u());
  unsubscribeTrip = [];
  loadedTripId = tripId;
  people = [];
  expenses = [];
  if (!tripId) return;
  unsubscribeTrip.push(
    peopleCol(tripId).onSnapshot((snap) => {
      people = docsOf(snap).sort(byCreated);
      render();
    }, onSubscribeError),
    expensesCol(tripId).onSnapshot((snap) => {
      expenses = docsOf(snap);
      render();
    }, onSubscribeError),
  );
}

function onSubscribeError() {
  showNotice('Lost connection to the shared trip data. Reload the page to reconnect.');
}

// ---------- Writes ----------

let noticeTimer = null;
function showNotice(text, sticky = false) {
  const el = $('#notice');
  el.textContent = text;
  el.hidden = !text;
  clearTimeout(noticeTimer);
  if (text && !sticky) noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

/** Run a store write and explain any failure in plain words. */
async function write(fn) {
  try {
    await fn();
    return true;
  } catch (e) {
    const code = e?.code;
    if (code === 'invalid_argument') {
      showNotice("Couldn't save. You may only have view access, so ask the trip owner to share it with you as an Editor.");
    } else if (code === 'permission-denied') {
      showNotice("Couldn't save. The trip may have been deleted, or a name or description is too long.");
    } else if (code === 'quota_exceeded' || code === 'resource-exhausted') {
      showNotice('Storage is full. Delete an old trip to make room.');
    } else {
      showNotice("Couldn't save that change. Check your connection and try again.");
    }
    return false;
  }
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
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** A button that needs a second tap within a few seconds to act. */
function confirmButton(label, confirmLabel, onConfirm, attrs = {}) {
  let armed = false;
  let timer;
  const btn = h('button', {
    type: 'button',
    ...attrs,
    onclick: () => {
      if (armed) {
        clearTimeout(timer);
        onConfirm();
        return;
      }
      armed = true;
      btn.textContent = confirmLabel;
      btn.classList.add('armed');
      timer = setTimeout(() => {
        armed = false;
        btn.textContent = label;
        btn.classList.remove('armed');
      }, 3000);
    },
  }, label);
  return btn;
}

// ---------- Trips ----------

async function createTrip() {
  const id = uid();
  const ok = await write(() => tripDoc(id).set({
    name: `Trip ${trips.length + 1}`,
    currency: '$',
    createdAt: Date.now(),
  }));
  if (!ok) return;
  store.rememberTrip(id);
  prefs.tripId = id;
  prefs.tab = 'people';
  savePrefs();
  render();
  $('#trip-name').focus();
  $('#trip-name').select();
}

$('#new-trip').addEventListener('click', createTrip);
$('#new-trip-empty').addEventListener('click', createTrip);

$('#trip-select').addEventListener('change', (e) => {
  resetExpenseForm();
  prefs.tripId = e.target.value;
  savePrefs();
  render();
});

// Trip name / currency save after a short pause in typing.
const pending = {};
function saveTripField(field, value) {
  const trip = currentTrip();
  if (!trip) return;
  clearTimeout(pending[field]);
  pending[field] = setTimeout(() => write(() => tripDoc(trip.id).update({ [field]: value })), 500);
}
$('#trip-name').addEventListener('input', (e) => saveTripField('name', e.target.value.trim()));
$('#trip-currency').addEventListener('input', (e) => saveTripField('currency', e.target.value.trim()));

async function deleteTrip(trip) {
  resetExpenseForm();
  await write(async () => {
    // Nested documents aren't removed with their parent, so clear them first.
    for (const col of [peopleCol(trip.id), expensesCol(trip.id)]) {
      const snap = await col.get();
      for (const d of snap.docs) await col.doc(d.id).delete();
    }
    await tripDoc(trip.id).delete();
  });
  store.forgetTrip(trip.id);
}

// ---------- Tabs ----------

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    prefs.tab = btn.dataset.tab;
    savePrefs();
    render();
  });
});

// ---------- People ----------

let renamingId = null;

$('#add-person-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#person-name');
  const name = input.value.trim();
  if (!name) return;
  if (people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    input.setCustomValidity('That name is already on the trip');
    input.reportValidity();
    return;
  }
  input.value = '';
  input.focus();
  await write(() => peopleCol(currentTrip().id).doc(uid()).set({ name, createdAt: Date.now() }));
});
$('#person-name').addEventListener('input', (e) => e.target.setCustomValidity(''));

const personInUse = (id) => expenses.some((e) => e.paidBy === id || e.splitAmong.includes(id));

function renderPeople() {
  const list = $('#people-list');
  // Don't wipe out a rename someone is typing when other data arrives.
  const active = document.activeElement;
  if (renamingId && active?.tagName === 'INPUT' && list.contains(active)) return;

  if (people.length === 0) {
    list.replaceChildren(h('li', { class: 'empty-row' }, 'No one yet. Add everyone on the trip.'));
    return;
  }
  list.replaceChildren(...people.map((p) => {
    if (p.id === renamingId) {
      const input = h('input', { type: 'text', value: p.name, maxlength: 40, 'aria-label': 'New name', class: 'grow' });
      const finish = async (save) => {
        const name = input.value.trim();
        renamingId = null;
        if (save && name && name !== p.name) {
          await write(() => peopleCol(currentTrip().id).doc(p.id).update({ name }));
        }
        render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      queueMicrotask(() => { input.focus(); input.select(); });
      return h('li', {},
        input,
        h('button', { type: 'button', onclick: () => finish(true) }, 'Save'),
        h('button', { type: 'button', class: 'icon', onclick: () => finish(false) }, 'Cancel'),
      );
    }
    const inUse = personInUse(p.id);
    return h('li', {},
      h('div', { class: 'main title' }, p.name),
      h('button', { type: 'button', class: 'icon', onclick: () => { renamingId = p.id; render(); } }, 'Rename'),
      inUse
        ? h('button', { type: 'button', class: 'icon', disabled: true, title: 'Remove them from expenses first' }, 'Remove')
        : confirmButton('Remove', 'Tap to confirm', () => write(() => peopleCol(currentTrip().id).doc(p.id).delete()),
          { class: 'icon danger' }),
    );
  }));
}

// ---------- Expenses ----------

let editingId = null;
let knownSplitIds = new Set(); // people added after the form was drawn start out ticked

function selectedSplit() {
  return [...document.querySelectorAll('#split-options input:checked')].map((i) => i.value);
}

function renderExpenseForm() {
  const hasPeople = people.length > 0;
  $('#expenses-need-people').hidden = hasPeople;
  $('#expense-form').hidden = !hasPeople;
  if (!hasPeople) return;

  if (editingId && !expenses.some((e) => e.id === editingId)) {
    resetExpenseForm();
    showNotice('That expense was deleted by someone else.');
  }

  // Preserve current selections across re-renders.
  const payerSel = $('#expense-payer');
  const prevPayer = payerSel.value;
  const prevSplit = new Set(selectedSplit());
  const firstRender = $('#split-options').childElementCount === 0;

  payerSel.replaceChildren(...people.map((p) => h('option', { value: p.id }, p.name)));
  if (people.some((p) => p.id === prevPayer)) payerSel.value = prevPayer;

  $('#split-options').replaceChildren(...people.map((p) =>
    h('label', { class: 'chip' },
      h('input', {
        type: 'checkbox', value: p.id,
        checked: firstRender || prevSplit.has(p.id) || !knownSplitIds.has(p.id),
        onchange: updateSplitPreview,
      }),
      p.name,
    ),
  ));
  knownSplitIds = new Set(people.map((p) => p.id));

  if (!$('#expense-date').value) $('#expense-date').value = today();
  $('#expense-form-title').textContent = editingId ? 'Edit expense' : 'Add an expense';
  $('#expense-submit').textContent = editingId ? 'Save changes' : 'Add expense';
  $('#cancel-edit').hidden = !editingId;
  updateSplitPreview();
}

function updateSplitPreview() {
  const ids = selectedSplit();
  const cents = toCents($('#expense-amount').value);
  const preview = $('#split-preview');
  const count = `${ids.length} ${ids.length === 1 ? 'person' : 'people'}`;
  if (ids.length === 0) {
    preview.textContent = 'Select at least one person.';
  } else if (cents > 0) {
    const shares = splitAmount(cents, ids.length);
    const min = Math.min(...shares);
    const max = Math.max(...shares);
    preview.textContent = `${count} · ${min === max ? money(min) : `${money(min)}–${money(max)}`} each`;
  } else {
    preview.textContent = `${count} selected`;
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
  const payer = $('#expense-payer').value;
  $('#expense-form').reset();
  $('#expense-payer').value = payer; // the same person often pays several times in a row
  $('#expense-error').textContent = '';
  $('#split-options').replaceChildren();
  knownSplitIds = new Set();
}

$('#cancel-edit').addEventListener('click', () => {
  resetExpenseForm();
  render();
});

$('#expense-form').addEventListener('submit', async (e) => {
  e.preventDefault();
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

  const data = { description, amountCents, paidBy, splitAmong, date };
  const col = expensesCol(currentTrip().id);
  const id = editingId;
  const submit = $('#expense-submit');
  submit.disabled = true;
  const ok = await write(() => (id ? col.doc(id).update(data) : col.doc(uid()).set({ ...data, createdAt: Date.now() })));
  submit.disabled = false;
  if (!ok) return;
  resetExpenseForm();
  render();
  $('#expense-desc').focus();
});

function startEdit(expense) {
  editingId = expense.id;
  $('#expense-desc').value = expense.description;
  $('#expense-amount').value = (expense.amountCents / 100).toFixed(2);
  $('#expense-payer').value = expense.paidBy;
  $('#expense-date').value = expense.date || '';
  document.querySelectorAll('#split-options input').forEach((i) => {
    i.checked = expense.splitAmong.includes(i.value);
  });
  renderExpenseForm();
  $('#expense-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#expense-desc').focus();
}

function renderExpenses() {
  const list = $('#expense-list');
  const total = expenses.reduce((s, e) => s + e.amountCents, 0);
  $('#expense-total').textContent = expenses.length ? `· ${money(total)} total` : '';

  if (expenses.length === 0) {
    list.replaceChildren(h('li', { class: 'empty-row' }, 'No expenses yet.'));
    return;
  }

  const sorted = [...expenses].sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  list.replaceChildren(...sorted.map((e) => {
    const everyone = people.length > 1 && people.every((p) => e.splitAmong.includes(p.id));
    const splitText = everyone ? 'everyone' : e.splitAmong.map(personName).join(', ');
    return h('li', { class: e.id === editingId ? 'editing' : null },
      h('div', { class: 'main' },
        h('div', { class: 'title' }, e.description),
        h('div', { class: 'muted small' },
          `${personName(e.paidBy)} paid · split between ${splitText}${e.date ? ` · ${e.date}` : ''}`),
      ),
      h('div', { class: 'amount' }, money(e.amountCents)),
      h('button', { type: 'button', class: 'icon', onclick: () => startEdit(e) }, 'Edit'),
      confirmButton('Delete', 'Tap to confirm', async () => {
        if (editingId === e.id) resetExpenseForm();
        await write(() => expensesCol(currentTrip().id).doc(e.id).delete());
      }, { class: 'icon danger' }),
    );
  }));
}

// ---------- Settle up ----------

function renderSettle() {
  const balances = computeBalances(people, expenses);
  const payments = settleUp(balances);

  const rows = people.map((p) => {
    const b = balances.get(p.id);
    const cls = b.net > 0 ? 'positive' : b.net < 0 ? 'negative' : '';
    const label = b.net > 0 ? `gets back ${money(b.net)}` : b.net < 0 ? `owes ${money(-b.net)}` : 'settled';
    return h('tr', {},
      h('td', {}, p.name),
      h('td', {}, money(b.paid)),
      h('td', {}, money(b.share)),
      h('td', { class: cls }, label),
    );
  });
  $('#balance-table tbody').replaceChildren(
    ...(rows.length ? rows : [h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'Add people to see balances.'))]),
  );

  const list = $('#payment-list');
  if (payments.length === 0) {
    list.replaceChildren(h('li', { class: 'empty-row' },
      expenses.length ? 'Everyone is square. Nothing to pay.' : 'Add some expenses to see who owes whom.'));
  } else {
    list.replaceChildren(...payments.map((p) =>
      h('li', { class: 'payment' },
        h('div', { class: 'main' },
          h('strong', {}, personName(p.from)),
          h('span', { class: 'arrow' }, 'pays →'),
          h('strong', {}, personName(p.to)),
        ),
        h('div', { class: 'amount' }, money(p.amountCents)),
      ),
    ));
  }
  $('#copy-summary').hidden = payments.length === 0;
}

$('#copy-summary').addEventListener('click', () => {
  const trip = currentTrip();
  const payments = settleUp(computeBalances(people, expenses));
  const total = expenses.reduce((s, e) => s + e.amountCents, 0);
  const text = [
    `${trip.name || 'Trip'}: total spent ${money(total)}`,
    '',
    ...payments.map((p) => `${personName(p.from)} pays ${personName(p.to)} ${money(p.amountCents)}`),
  ].join('\n');
  const status = $('#copy-status');
  navigator.clipboard.writeText(text).then(
    () => { status.textContent = 'Copied'; },
    () => { status.textContent = "Couldn't copy. Select the list above instead."; },
  );
  setTimeout(() => { status.textContent = ''; }, 2500);
});

// ---------- Render ----------

function renderTripSelect() {
  const sel = $('#trip-select');
  sel.replaceChildren(...trips.map((t) =>
    h('option', { value: t.id, selected: t.id === currentTrip()?.id }, t.name || 'Untitled trip')));
  sel.hidden = trips.length === 0;
}

function render() {
  if (!db) return;
  const trip = currentTrip();
  subscribeToTrip(trip?.id ?? null);

  $('#loading').hidden = true;
  $('#new-trip').hidden = false;
  renderTripSelect();
  $('#no-trip').hidden = !!trip;
  $('#trip-view').hidden = !trip;
  if (!trip) return;
  if (store.mode === 'firebase' && location.hash !== `#${trip.id}`) {
    history.replaceState(null, '', `#${trip.id}`); // the address bar is always the trip's link
  }

  if (document.activeElement !== $('#trip-name')) $('#trip-name').value = trip.name;
  if (document.activeElement !== $('#trip-currency')) $('#trip-currency').value = trip.currency;

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === prefs.tab));
  });
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== prefs.tab; });
  renderPeople();
  renderExpenseForm();
  renderExpenses();
  renderSettle();

  $('#delete-trip-slot').replaceChildren(
    confirmButton('Delete this trip', 'Tap again to delete the trip and all its expenses', () => deleteTrip(trip),
      { class: 'link danger' }),
  );
}

// ---------- Invite link (Firebase mode) ----------

const tripLink = (id) => `${location.origin}${location.pathname}#${id}`;

$('#copy-link').addEventListener('click', () => {
  const trip = currentTrip();
  const status = $('#link-status');
  const link = tripLink(trip.id);
  navigator.clipboard.writeText(link).then(
    () => { status.textContent = 'Link copied. Send it to everyone on the trip.'; },
    () => { status.textContent = `Copy this link: ${link}`; },
  );
  setTimeout(() => { status.textContent = ''; }, 6000);
});

/** Open a trip from a shared link like …/#<tripId>. */
let linkedTripId = null;
function openLinkedTrip() {
  const id = location.hash.slice(1);
  if (!/^[A-Za-z0-9-]{20,}$/.test(id) || id === currentTrip()?.id) return;
  linkedTripId = id;
  store.rememberTrip(id);
  prefs.tripId = id;
  savePrefs();
  resetExpenseForm();
  render();
}

// ---------- Start ----------

store = await openStore();
db = store.db;
$('#storage-note').textContent = {
  claude: 'Shared live with everyone who has this page.',
  firebase: 'Shared live with everyone who has the trip link.',
  local: 'Saved in this browser only.',
}[store.mode];
$('#invite').hidden = store.mode !== 'firebase';
store.onLateWriteError(() => {
  showNotice("A change made while offline couldn't be saved. The trip may have been deleted.");
});

if (store.mode === 'firebase') {
  window.addEventListener('hashchange', openLinkedTrip);
  openLinkedTrip();
}

store.watchTrips((list) => {
  trips = list.sort(byCreated);
  if (linkedTripId && !trips.some((t) => t.id === linkedTripId)) {
    showNotice("That trip link doesn't match any trip. It may have been deleted.");
    history.replaceState(null, '', location.pathname);
  }
  linkedTripId = null;
  render();
}, onSubscribeError);
