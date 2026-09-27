import { splitAmount, computeBalances, settleUp } from './settle.js';
import {
  CURRENCY_GROUPS, DEFAULT_CURRENCY, currencyName, normalizeCurrency, currencyDigits, toMinor, minorToInput,
  formatMoney, convertMinor, expenseCurrency, amountInTripCurrency, formatRate, fetchRate,
} from './currency.js';
import { openStore } from './store.js';
import { compressPhoto, isPhotoDataUrl } from './photo.js';

// ---------- Per-viewer preferences (which trip / tab is open) ----------

const PREFS_KEY = 'split-costs:prefs';
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}
const TABS = ['expenses', 'settle', 'people', 'settings'];
const prefs = { tripId: null, tab: 'expenses', ...loadPrefs() };
if (!TABS.includes(prefs.tab)) prefs.tab = 'expenses';
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
let photo = null; // {dataUrl, updatedAt} for the open trip
let loadedTripId = null;
let unsubscribeTrip = [];

const byCreated = (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id);
const docsOf = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

// The chosen trip, or the first one while it loads or if it was deleted.
const currentTrip = () => trips.find((t) => t.id === prefs.tripId) || trips[0] || null;
const personName = (id) => people.find((p) => p.id === id)?.name ?? 'Someone removed';
const tripCurrency = () => normalizeCurrency(currentTrip()?.currency);
const money = (minor) => formatMoney(minor, tripCurrency());
const uid = () => crypto.randomUUID();
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Expenses with amounts converted to the trip currency, and how many have no usable rate. */
function expensesInTripCurrency() {
  const cur = tripCurrency();
  const usable = [];
  let missing = 0;
  for (const e of expenses) {
    const amount = amountInTripCurrency(e, cur);
    if (amount == null) missing++;
    else usable.push({ ...e, amountCents: amount });
  }
  return { usable, missing };
}

const tripDoc = (id) => db.doc(`trips/${id}`);
const peopleCol = (tripId) => db.collection(`trips/${tripId}/people`);
const expensesCol = (tripId) => db.collection(`trips/${tripId}/expenses`);
const photoDoc = (tripId) => db.doc(`trips/${tripId}/photo/cover`);

function subscribeToTrip(tripId) {
  if (tripId === loadedTripId) return;
  unsubscribeTrip.forEach((u) => u());
  unsubscribeTrip = [];
  loadedTripId = tripId;
  people = [];
  expenses = [];
  photo = null;
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
    // A trip works fine without its photo, so photo errors stay quiet.
    photoDoc(tripId).onSnapshot((snap) => {
      const data = snap.exists ? snap.data() : null;
      photo = data && isPhotoDataUrl(data.dataUrl) ? data : null;
      render();
    }, () => {}),
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

const AVATAR_COLOURS = ['#0f766e', '#6d28d9', '#b8420f', '#1d4ed8', '#be185d', '#4d7c0f', '#0e7490', '#92400e'];

/** A coloured circle with a person's initials. */
function avatar(id, small = false) {
  const name = personName(id);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const el = h('span', { class: small ? 'avatar small' : 'avatar', 'aria-hidden': 'true' }, initials);
  el.style.setProperty('--avatar', AVATAR_COLOURS[hash % AVATAR_COLOURS.length]);
  return el;
}

// ---------- Trips ----------

async function createTrip() {
  const id = uid();
  const ok = await write(() => tripDoc(id).set({
    name: `Trip ${trips.length + 1}`,
    currency: trips.length ? normalizeCurrency(trips[trips.length - 1].currency) : DEFAULT_CURRENCY,
    createdAt: Date.now(),
  }));
  if (!ok) return;
  store.rememberTrip(id);
  prefs.tripId = id;
  prefs.tab = 'settings';
  savePrefs();
  render();
  $('#trip-name').focus();
  $('#trip-name').select();
}

$('#new-trip').addEventListener('click', createTrip);
$('#new-trip-empty').addEventListener('click', createTrip);

$('#trip-select').addEventListener('change', (e) => {
  cancelCurrencyChange();
  resetExpenseForm();
  prefs.tripId = e.target.value;
  savePrefs();
  render();
});

// The trip name saves after a short pause in typing.
const pending = {};
function saveTripField(field, value) {
  const trip = currentTrip();
  if (!trip) return;
  clearTimeout(pending[field]);
  pending[field] = setTimeout(() => write(() => tripDoc(trip.id).update({ [field]: value })), 500);
}
$('#trip-name').addEventListener('input', (e) => saveTripField('name', e.target.value.trim()));

// ---------- Main currency ----------

function fillCurrencySelect(select) {
  select.replaceChildren(...CURRENCY_GROUPS.map((g) =>
    h('optgroup', { label: g.label }, g.codes.map((c) => h('option', { value: c }, `${c} · ${currencyName(c)}`)))));
}
fillCurrencySelect($('#trip-currency'));
fillCurrencySelect($('#expense-currency'));

let pendingCurrency = null;

$('#trip-currency').addEventListener('change', (e) => {
  const from = tripCurrency();
  const to = e.target.value;
  if (to === from) return cancelCurrencyChange();
  // Expenses not already in the new currency need a rate into it. Older
  // expenses without a currency are in the current one.
  const toConvert = expenses.filter((x) => expenseCurrency(x, from) !== to).length;
  if (toConvert === 0) {
    write(() => tripDoc(currentTrip().id).update({ currency: to }));
    return;
  }
  pendingCurrency = to;
  const n = toConvert === 1 ? '1 expense' : `${toConvert} expenses`;
  $('#currency-change-text').textContent =
    `Change the main currency to ${to}? ${n} not paid in ${to} will be converted at the market rate for the day they were paid. ` +
    `Rates entered by hand are kept, and converted from ${from} to ${to} at that day's market rate.`;
  $('#currency-change').hidden = false;
});

function cancelCurrencyChange() {
  pendingCurrency = null;
  $('#currency-change').hidden = true;
  if (currentTrip()) $('#trip-currency').value = tripCurrency();
}
$('#currency-change-cancel').addEventListener('click', cancelCurrencyChange);

$('#currency-change-confirm').addEventListener('click', async () => {
  const trip = currentTrip();
  const from = tripCurrency();
  const to = pendingCurrency;
  const btn = $('#currency-change-confirm');
  btn.disabled = true;
  btn.textContent = 'Getting rates…';
  try {
    const opts = { today: today() };
    const updates = await Promise.all(expenses.map(async (x) => {
      const cur = expenseCurrency(x, from);
      const day = x.date || today();
      if (cur === to) return x.currency ? null : [x.id, { currency: cur }];
      const hasOldRate = x.rateTo === from && x.rate > 0;
      // Keep a hand-entered rate by going through the old main currency.
      const viaOld = async () => {
        const step = await fetchRate(from, to, day, opts);
        return { rate: x.rate * step.rate, rateDate: step.date };
      };
      let result;
      if (hasOldRate && x.rateSource === 'manual') {
        result = { ...(await viaOld()), rateSource: 'manual' };
      } else {
        try {
          const direct = await fetchRate(cur, to, day, opts);
          result = { rate: direct.rate, rateDate: direct.date, rateSource: 'market' };
        } catch (e) {
          if (!hasOldRate) throw e;
          result = { ...(await viaOld()), rateSource: x.rateSource === 'manual' ? 'manual' : 'market' };
        }
      }
      return [x.id, { currency: cur, rateTo: to, ...result }];
    }));
    const col = expensesCol(trip.id);
    await write(async () => {
      for (const [id, data] of updates.filter(Boolean)) await col.doc(id).update(data);
      await tripDoc(trip.id).update({ currency: to });
    });
  } catch {
    showNotice("Couldn't get exchange rates, so the currency wasn't changed. Check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = 'Change currency';
    cancelCurrencyChange();
    render();
  }
});

async function deleteTrip(trip) {
  resetExpenseForm();
  await write(async () => {
    // Nested documents aren't removed with their parent, so clear them first.
    for (const col of [peopleCol(trip.id), expensesCol(trip.id)]) {
      const snap = await col.get();
      for (const d of snap.docs) await col.doc(d.id).delete();
    }
    await photoDoc(trip.id).delete();
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
        h('button', { type: 'button', class: 'quiet', onclick: () => finish(false) }, 'Cancel'),
      );
    }
    const inUse = personInUse(p.id);
    return h('li', {},
      avatar(p.id),
      h('div', { class: 'main title' }, p.name),
      h('button', { type: 'button', class: 'quiet', onclick: () => { renamingId = p.id; render(); } }, 'Rename'),
      inUse
        ? h('button', { type: 'button', class: 'quiet', disabled: true, title: 'Remove them from expenses first' }, 'Remove')
        : confirmButton('Remove', 'Tap to confirm', () => write(() => peopleCol(currentTrip().id).doc(p.id).delete()),
          { class: 'quiet danger' }),
    );
  }));
}

// ---------- Expenses ----------

let editingId = null;
let knownSplitIds = new Set(); // people added after the form was drawn start out ticked
let currencyChosen = false; // whether the form's currency has been set since it was last reset

// The exchange rate for the expense being entered, when it's in another currency.
const emptyRate = () => ({ source: 'market', rate: null, date: null, from: null, to: null, loading: false, failed: false });
let rateState = emptyRate();
let rateRequest = 0;

const formCurrency = () => $('#expense-currency').value || tripCurrency();

function defaultExpenseCurrency() {
  const last = prefs.expenseCurrency?.[currentTrip()?.id];
  return last && CURRENCY_GROUPS.some((g) => g.codes.includes(last)) ? last : tripCurrency();
}

/** Look up the market rate for the form's currency and date, unless a rate was typed in. */
async function refreshRate() {
  const from = formCurrency();
  const to = tripCurrency();
  if (from === to) {
    rateState = { ...emptyRate(), from, to };
    updateRateUI();
    return;
  }
  if (rateState.source === 'manual' && rateState.from === from && rateState.to === to) return;
  const request = ++rateRequest;
  rateState = { ...emptyRate(), from, to, loading: true };
  updateRateUI();
  try {
    const { rate, date } = await fetchRate(from, to, $('#expense-date').value || today(), { today: today() });
    if (request !== rateRequest) return;
    rateState = { ...rateState, rate, date, loading: false };
  } catch {
    if (request !== rateRequest) return;
    rateState = { ...rateState, loading: false, failed: true };
  }
  updateRateUI();
  updateSplitPreview();
}

function updateRateUI() {
  const from = formCurrency();
  const to = tripCurrency();
  $('#expense-amount').step = currencyDigits(from) ? String(10 ** -currencyDigits(from)) : '1';
  $('#expense-amount').placeholder = minorToInput(0, from);
  const foreign = from !== to;
  $('#rate-row').hidden = !foreign;
  if (!foreign) return;

  $('#rate-from').textContent = `1 ${from} =`;
  $('#rate-to').textContent = to;
  const input = $('#expense-rate');
  if (document.activeElement !== input) input.value = rateState.rate > 0 ? formatRate(rateState.rate) : '';
  let note = '';
  if (rateState.loading) note = 'Getting the market rate…';
  else if (rateState.source === 'manual') note = 'Rate entered by hand.';
  else if (rateState.failed) note = "Couldn't get the market rate. Enter the rate yourself.";
  else if (rateState.date) note = `Market rate for ${longDate(rateState.date)}. You can change it.`;
  $('#rate-note').textContent = note;
  $('#rate-reset').hidden = rateState.source !== 'manual';
}

$('#expense-currency').addEventListener('change', (e) => {
  const tripId = currentTrip()?.id;
  if (tripId) {
    prefs.expenseCurrency = { ...prefs.expenseCurrency, [tripId]: e.target.value };
    savePrefs();
  }
  rateState = emptyRate();
  refreshRate();
  updateSplitPreview();
});
$('#expense-date').addEventListener('change', () => {
  if (rateState.source === 'market') refreshRate();
});
$('#expense-rate').addEventListener('input', (e) => {
  const rate = Number(e.target.value);
  rateRequest++; // ignore any lookup still in flight
  rateState = { ...rateState, source: 'manual', rate: rate > 0 ? rate : null, loading: false, failed: false };
  updateRateUI();
  updateSplitPreview();
});
$('#rate-reset').addEventListener('click', () => {
  rateState = emptyRate();
  refreshRate();
});

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
  if (!currencyChosen) {
    $('#expense-currency').value = defaultExpenseCurrency();
    currencyChosen = true;
  }
  // Look the rate up again if the currency or the trip's main currency changed.
  if (!rateState.loading && (rateState.from !== formCurrency() || rateState.to !== tripCurrency())) {
    if (rateState.source === 'manual') rateState = emptyRate();
    refreshRate();
  } else {
    updateRateUI();
  }
  $('#expense-form-title').textContent = editingId ? 'Edit expense' : 'Add an expense';
  $('#expense-submit').textContent = editingId ? 'Save changes' : 'Add expense';
  $('#cancel-edit').hidden = !editingId;
  const deleteSlot = $('#delete-expense-slot');
  if (editingId && deleteSlot.dataset.for !== editingId) {
    const id = editingId;
    deleteSlot.replaceChildren(confirmButton('Delete', 'Tap again to delete', async () => {
      resetExpenseForm();
      render();
      await write(() => expensesCol(currentTrip().id).doc(id).delete());
    }, { class: 'danger' }));
    deleteSlot.dataset.for = id;
  } else if (!editingId && deleteSlot.dataset.for) {
    deleteSlot.replaceChildren();
    delete deleteSlot.dataset.for;
  }
  updateSplitPreview();
}

function updateSplitPreview() {
  const ids = selectedSplit();
  const cur = formCurrency();
  const minor = toMinor($('#expense-amount').value, cur);
  const preview = $('#split-preview');
  const count = `${ids.length} ${ids.length === 1 ? 'person' : 'people'}`;
  const fmt = (m) => formatMoney(m, cur);
  if (ids.length === 0) {
    preview.textContent = 'Select at least one person.';
  } else if (minor > 0) {
    const shares = splitAmount(minor, ids.length);
    const min = Math.min(...shares);
    const max = Math.max(...shares);
    let text = `${count} · ${min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`} each`;
    if (cur !== tripCurrency() && rateState.rate > 0) {
      text += ` · ${fmt(minor)} is ${money(convertMinor(minor, cur, tripCurrency(), rateState.rate))}`;
    }
    preview.textContent = text;
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
  currencyChosen = false;
  rateRequest++;
  rateState = emptyRate();
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
  const currency = formCurrency();
  const amountCents = toMinor($('#expense-amount').value, currency);
  const paidBy = $('#expense-payer').value;
  const splitAmong = selectedSplit();
  const date = $('#expense-date').value || today();
  const error = $('#expense-error');

  if (!description) return void (error.textContent = 'Enter a description.');
  if (!(amountCents > 0)) return void (error.textContent = 'Enter an amount greater than zero.');
  if (splitAmong.length === 0) return void (error.textContent = 'Choose at least one person to split this between.');
  // Expenses in the main currency don't store one, like expenses from before
  // currencies were added.
  const data = { description, amountCents, paidBy, splitAmong, date };
  if (currency !== tripCurrency()) {
    data.currency = currency;
    if (rateState.loading) return void (error.textContent = 'Still getting the exchange rate. Try again in a moment.');
    if (!(rateState.rate > 0)) return void (error.textContent = `Enter the exchange rate from ${currency} to ${tripCurrency()}.`);
    Object.assign(data, {
      rate: rateState.rate,
      rateTo: tripCurrency(),
      rateSource: rateState.source,
      rateDate: rateState.source === 'market' && rateState.date ? rateState.date : date,
    });
  }
  error.textContent = '';

  const col = expensesCol(currentTrip().id);
  const id = editingId;
  const submit = $('#expense-submit');
  submit.disabled = true;
  // Save the whole expense so fields from its old currency don't linger.
  const createdAt = (id && expenses.find((x) => x.id === id)?.createdAt) || Date.now();
  const ok = await write(() => col.doc(id || uid()).set({ ...data, createdAt }));
  submit.disabled = false;
  if (!ok) return;
  resetExpenseForm();
  render();
  $('#expense-desc').focus();
});

function startEdit(expense) {
  editingId = expense.id;
  const trip = tripCurrency();
  const cur = expenseCurrency(expense, trip);
  $('#expense-currency').value = cur;
  currencyChosen = true;
  rateRequest++;
  rateState = cur !== trip && expense.rateTo === trip && expense.rate > 0
    ? { ...emptyRate(), source: expense.rateSource === 'manual' ? 'manual' : 'market', rate: expense.rate, date: expense.rateDate, from: cur, to: trip }
    : emptyRate();
  $('#expense-desc').value = expense.description;
  $('#expense-amount').value = minorToInput(expense.amountCents, cur);
  $('#expense-payer').value = expense.paidBy;
  $('#expense-date').value = expense.date || '';
  document.querySelectorAll('#split-options input').forEach((i) => {
    i.checked = expense.splitAmong.includes(i.value);
  });
  renderExpenseForm();
  $('#expense-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#expense-desc').focus();
}

const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function renderExpenses() {
  const list = $('#expense-list');
  const trip = tripCurrency();
  const { usable } = expensesInTripCurrency();
  const total = usable.reduce((s, e) => s + e.amountCents, 0);
  $('#expense-total').textContent = expenses.length ? money(total) : '';

  if (expenses.length === 0) {
    list.replaceChildren(h('li', { class: 'empty-row' }, 'No expenses yet.'));
    return;
  }

  const sorted = [...expenses].sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));

  // Group by day, newest first, with each day's total in the main currency.
  const rows = [];
  let day = null;
  for (const e of sorted) {
    if ((e.date || '') !== day) {
      day = e.date || '';
      const dayTotal = usable.filter((x) => (x.date || '') === day).reduce((s, x) => s + x.amountCents, 0);
      rows.push(h('li', { class: 'day' }, h('span', {}, day ? dayLabel(day) : 'No date'), h('span', {}, money(dayTotal))));
    }
    const everyone = people.length > 1 && people.every((p) => e.splitAmong.includes(p.id));
    const splitText = everyone ? 'everyone' : e.splitAmong.map(personName).join(', ');
    const cur = expenseCurrency(e, trip);
    const inTrip = amountInTripCurrency(e, trip);
    const original = formatMoney(e.amountCents, cur);
    const paid = cur === trip ? 'paid' : inTrip == null ? `paid ${original}` : `paid ${original} at ${formatRate(e.rate)}`;
    rows.push(h('li', { class: e.id === editingId ? 'expense editing' : 'expense' },
      h('button', { type: 'button', class: 'expense-button', 'aria-label': `Edit ${e.description}`, onclick: () => startEdit(e) },
        avatar(e.paidBy),
        h('div', { class: 'main' },
          h('div', { class: 'title' }, e.description),
          h('div', { class: 'sub' }, `${personName(e.paidBy)} ${paid} · split between ${splitText}`),
          inTrip == null ? h('div', { class: 'sub needs-rate' }, `No exchange rate into ${trip}. Tap to add one.`) : null,
        ),
        h('div', { class: inTrip == null ? 'amount needs-rate' : 'amount' }, inTrip == null ? original : money(inTrip)),
      ),
    ));
  }
  list.replaceChildren(...rows);
}

// ---------- Settle up ----------

function renderSettle() {
  const { usable, missing } = expensesInTripCurrency();
  const balances = computeBalances(people, usable);
  $('#settle-warning').textContent = missing
    ? `${missing === 1 ? '1 expense is' : `${missing} expenses are`} left out because ${missing === 1 ? 'it has' : 'they have'} no exchange rate into ${tripCurrency()}. Edit ${missing === 1 ? 'it' : 'them'} on the Expenses tab to add one.`
    : '';
  const payments = settleUp(balances);

  $('#balance-list').replaceChildren(...(people.length ? people.map((p) => {
    const b = balances.get(p.id);
    const pill = b.net > 0
      ? h('span', { class: 'pill positive' }, `gets back ${money(b.net)}`)
      : b.net < 0
        ? h('span', { class: 'pill negative' }, `owes ${money(-b.net)}`)
        : h('span', { class: 'pill neutral' }, 'settled');
    return h('li', {},
      avatar(p.id),
      h('div', { class: 'main' },
        h('div', { class: 'title' }, p.name),
        h('div', { class: 'sub' }, `Paid ${money(b.paid)} · share ${money(b.share)}`),
      ),
      pill,
    );
  }) : [h('li', { class: 'empty-row' }, 'Add people to see balances.')]));

  const list = $('#payment-list');
  if (payments.length === 0) {
    list.replaceChildren(h('li', { class: 'empty-row' },
      expenses.length ? 'Everyone is square. Nothing to pay.' : 'Add some expenses to see who owes whom.'));
  } else {
    list.replaceChildren(...payments.map((p) =>
      h('li', {},
        h('div', { class: 'main who' },
          avatar(p.from, true), h('span', {}, personName(p.from)),
          h('span', { class: 'arrow' }, 'pays'),
          avatar(p.to, true), h('span', {}, personName(p.to)),
        ),
        h('div', { class: 'amount' }, money(p.amountCents)),
      ),
    ));
  }
  $('#copy-summary').parentElement.hidden = payments.length === 0;
}

$('#copy-summary').addEventListener('click', () => {
  const trip = currentTrip();
  const { usable } = expensesInTripCurrency();
  const payments = settleUp(computeBalances(people, usable));
  const total = usable.reduce((s, e) => s + e.amountCents, 0);
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
  renderBackdrop();
  if (!trip) return;
  renderHero(trip);
  if (store.mode === 'firebase' && location.hash !== `#${trip.id}`) {
    history.replaceState(null, '', `#${trip.id}`); // the address bar is always the trip's link
  }

  if (document.activeElement !== $('#trip-name')) $('#trip-name').value = trip.name;
  if (!pendingCurrency) $('#trip-currency').value = tripCurrency();

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.tab === prefs.tab));
  });
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== prefs.tab; });
  renderPeople();
  renderExpenseForm();
  renderExpenses();
  renderSettle();

  const deleteSlot = $('#delete-trip-slot');
  if (deleteSlot.dataset.for !== trip.id) {
    deleteSlot.replaceChildren(
      confirmButton('Delete this trip', 'Tap again to delete it for everyone', () => deleteTrip(trip), { class: 'danger' }),
    );
    deleteSlot.dataset.for = trip.id;
  }
}

function renderHero(trip) {
  $('#hero-title').textContent = trip.name || 'Untitled trip';
  const { usable } = expensesInTripCurrency();
  const total = usable.reduce((s, e) => s + e.amountCents, 0);
  const dates = expenses.map((e) => e.date).filter(Boolean).sort();
  const parts = [];
  const summary = $('#hero-summary');
  summary.replaceChildren();
  if (expenses.length) summary.append(h('strong', {}, money(total)), ' spent');
  parts.push(`${people.length} ${people.length === 1 ? 'person' : 'people'}`);
  if (dates.length) {
    const fmt = (iso, withYear) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined,
      withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
    const first = dates[0];
    const last = dates[dates.length - 1];
    parts.push(first === last ? fmt(first, true) : `${fmt(first, first.slice(0, 4) !== last.slice(0, 4))} – ${fmt(last, true)}`);
  }
  summary.append(`${expenses.length ? ' · ' : ''}${parts.join(' · ')}`);
  $('#photo-button-label').textContent = photo ? 'Change photo' : 'Add cover photo';
}

let shownPhotoKey = null;
function renderBackdrop() {
  const trip = currentTrip();
  const key = trip && photo ? `${trip.id}:${photo.updatedAt}:${photo.dataUrl.length}` : null;
  if (key === shownPhotoKey) return;
  shownPhotoKey = key;
  const backdrop = $('#trip-backdrop');
  const preview = $('#photo-preview');
  // isPhotoDataUrl guarantees a plain base64 JPEG, so it's safe inside url("").
  const image = key ? `url("${photo.dataUrl}")` : '';
  backdrop.style.backgroundImage = image;
  backdrop.classList.toggle('has-photo', !!key);
  preview.style.backgroundImage = image;
  preview.hidden = !key;
  const removeSlot = $('#photo-remove-slot');
  removeSlot.replaceChildren(key
    ? confirmButton('Remove photo', 'Tap again to remove', () => write(() => photoDoc(currentTrip().id).delete()), { class: 'danger' })
    : '');
  $('#photo-change').textContent = key ? 'Change photo' : 'Choose photo';
}

$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  const trip = currentTrip();
  if (!file || !trip) return;
  const status = $('#photo-status');
  status.textContent = 'Preparing photo…';
  try {
    const dataUrl = await compressPhoto(file);
    status.textContent = 'Saving photo…';
    const ok = await write(() => photoDoc(trip.id).set({ dataUrl, updatedAt: Date.now() }));
    status.textContent = ok ? 'Photo saved. Everyone on the trip will see it.' : "The photo couldn't be saved.";
  } catch (err) {
    status.textContent = err.message || "That photo couldn't be used.";
    showNotice(status.textContent);
  }
});

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
if (store.connectError) {
  showNotice(`Couldn't connect to the shared trip database, so changes are only being saved on this device. Reload the page to try again. (${store.connectError.message || store.connectError})`, true);
}
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
