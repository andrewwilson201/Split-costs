import { splitAmount, allocate, isPayment, computeBalances, settleUp } from './settle.js';
import {
  CURRENCY_GROUPS, DEFAULT_CURRENCY, currencyName, normalizeCurrency, currencyDigits, toMinor, minorToInput,
  formatMoney, convertMinor, expenseCurrency, amountInTripCurrency, formatRate, fetchRate,
} from './currency.js';
import { openStore } from './store.js';
import { compressPhoto, isPhotoDataUrl } from './photo.js';
import { householdsOf, householdBalances, householdWeights, isHouseholdSplit, hasHouseholds, joinNames } from './households.js';
import { CATEGORIES, categoryLabel, guessCategory, expenseCategory, isCategory, spendingByDay, niceScale } from './categories.js';

// ---------- Per-viewer preferences (which trip / tab is open) ----------

const PREFS_KEY = 'split-costs:prefs';
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
}
const TABS = ['expenses', 'spending', 'settle', 'settings'];
const prefs = { tripId: null, tab: 'expenses', ...loadPrefs() };
if (prefs.tab === 'people') prefs.tab = 'settings'; // People moved into the Trip tab
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
  closeExpenseSheet();
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

// "Auto" follows the description as it's typed; picking a category overrides it.
$('#expense-category').replaceChildren(
  h('option', { value: '' }, 'Auto'),
  ...CATEGORIES.map((c) => h('option', { value: c.id }, c.label)),
);
function updateAutoCategory() {
  const guess = guessCategory($('#expense-desc').value);
  $('#expense-category').options[0].textContent = $('#expense-desc').value.trim() ? `Auto: ${categoryLabel(guess)}` : 'Auto';
}
$('#expense-desc').addEventListener('input', updateAutoCategory);

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

// ---------- Undo ----------

let toastTimer = null;
let toastUndo = null;

/** A short message at the bottom of the screen, with an Undo button when `undo` is given. */
function showToast(text, undo = null) {
  $('#toast-text').textContent = text;
  $('#toast-undo').hidden = !undo;
  toastUndo = undo;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 7000);
}
function hideToast() {
  $('#toast').hidden = true;
  toastUndo = null;
}
$('#toast-undo').addEventListener('click', async () => {
  const undo = toastUndo;
  hideToast();
  if (undo) await undo();
});

/** Put back a document exactly as it was, under its old id. */
function restoreDoc(col, item) {
  const { id, ...data } = item;
  return write(() => col.doc(id).set(data));
}

async function deleteWithUndo(col, item, message) {
  const ok = await write(() => col.doc(item.id).delete());
  if (ok) showToast(message, () => restoreDoc(col, item));
}

// ---------- Who's who on this phone ----------

/** The person this phone belongs to on the open trip, if they've said. */
function meId() {
  const id = prefs.me?.[currentTrip()?.id];
  return people.some((p) => p.id === id) ? id : null;
}

function setMe(id) {
  const tripId = currentTrip().id;
  prefs.me = { ...prefs.me, [tripId]: id };
  prefs.notOnTrip = { ...prefs.notOnTrip, [tripId]: false };
  savePrefs();
  if (id) $('#expense-payer').value = id;
  render();
}

$('#whoami-skip').addEventListener('click', () => {
  prefs.notOnTrip = { ...prefs.notOnTrip, [currentTrip().id]: true };
  savePrefs();
  render();
});

function renderWhoAmI(trip) {
  const me = meId();
  const ask = people.length > 0 && !me && !prefs.notOnTrip?.[trip.id];
  $('#whoami').hidden = !ask;
  if (ask) {
    $('#whoami-options').replaceChildren(...people.map((p) =>
      h('button', { type: 'button', class: 'person-chip', onclick: () => setMe(p.id) }, avatar(p.id, true), p.name)));
  }
  const line = $('#me-line');
  if (me) {
    line.replaceChildren('On this phone you’re ', h('strong', {}, personName(me)), '. ',
      h('button', { type: 'button', class: 'link', onclick: () => setMe(null) }, 'Change'));
  } else if (people.length) {
    line.replaceChildren('This phone isn’t set to anyone on the trip. ',
      h('button', { type: 'button', class: 'link', onclick: () => setMe(null) }, 'Choose who you are'));
  } else {
    line.replaceChildren();
  }
}

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

/** A small dropdown: on their own, or in a household with someone else on the trip. */
function householdPicker(person) {
  const units = householdsOf(people);
  const own = units.find((u) => u.memberIds.includes(person.id));
  const options = [h('option', { value: '' }, 'Household: on their own')];
  if (own.memberIds.length > 1) {
    const others = own.memberIds.filter((id) => id !== person.id).map(personName);
    options.push(h('option', { value: 'stay', selected: true }, `Household: with ${joinNames(others)}`));
  }
  for (const u of units) {
    if (u === own) continue;
    options.push(h('option', { value: u.memberIds[0] }, `Household: with ${u.name}`));
  }
  const select = h('select', { class: 'household-select', 'aria-label': `${person.name}'s household` }, options);
  select.addEventListener('change', () => {
    if (select.value !== 'stay') setHousehold(person, select.value || null);
  });
  return select;
}

/** Put `person` on their own (targetId null) or in the same household as `targetId`. */
async function setHousehold(person, targetId) {
  const units = householdsOf(people);
  const own = units.find((u) => u.memberIds.includes(person.id));
  const changes = new Map();
  // Someone left alone in a household of two goes back to being on their own.
  if (own.memberIds.length === 2) changes.set(own.memberIds.find((id) => id !== person.id), null);
  if (targetId) {
    const target = people.find((p) => p.id === targetId);
    const householdId = target.household || uid();
    if (target.household !== householdId) changes.set(targetId, householdId);
    changes.set(person.id, householdId);
  } else {
    changes.set(person.id, null);
  }
  const col = peopleCol(currentTrip().id);
  await write(async () => {
    for (const [id, household] of changes) {
      const { id: _id, ...data } = people.find((p) => p.id === id);
      if (household) data.household = household;
      else delete data.household;
      await col.doc(id).set(data);
    }
  });
}

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
      h('div', { class: 'main' },
        h('div', { class: 'title' }, p.name, p.id === meId() ? h('span', { class: 'you' }, 'you') : null),
        people.length > 1 ? householdPicker(p) : null),
      h('button', { type: 'button', class: 'quiet', onclick: () => { renamingId = p.id; render(); } }, 'Rename'),
      inUse
        ? h('button', { type: 'button', class: 'quiet', disabled: true, title: 'Remove them from expenses first' }, 'Remove')
        : confirmButton('Remove', 'Tap to confirm', () => deleteWithUndo(peopleCol(currentTrip().id), p, `Removed ${p.name}`),
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

// ---------- Split editor ----------
//
// Equally (default), by shares (e.g. 1, 1, 0.5) or by exact amounts. Shares
// and amounts are stored as `splitWeights`; see expenseShares() in settle.js.

let splitMode = 'equal';
let splitValues = {}; // personId -> what's typed in their shares/amount box
let splitKey = ''; // what the editor was last drawn for; '' after a reset

function selectedSplit() {
  return [...document.querySelectorAll('#split-options input[type="checkbox"]:checked')].map((i) => i.value);
}

const amountStep = (cur) => (currencyDigits(cur) ? String(10 ** -currencyDigits(cur)) : '1');

/** Draw the split editor. Kept as-is unless the mode or people change, so typing isn't interrupted. */
function renderSplitEditor(force = false, selected = null) {
  const key = `${splitMode}|${people.map((p) => `${p.id}:${p.name}:${p.household ?? ''}`).join(',')}`;
  if (!force && key === splitKey) return;
  const fresh = splitKey === '';
  const previous = new Set(selectedSplit());
  splitKey = key;
  document.querySelectorAll('.segmented button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === splitMode)));

  const box = $('#split-options');
  box.className = splitMode === 'equal' ? 'chips' : 'split-rows';
  const cur = formCurrency();
  box.replaceChildren(...people.map((p) => {
    const checked = selected ? selected.has(p.id) : fresh || previous.has(p.id) || !knownSplitIds.has(p.id);
    const box = h('input', { type: 'checkbox', value: p.id, checked });
    if (splitMode === 'equal') {
      box.addEventListener('change', onSplitChange);
      return h('label', { class: 'chip' }, box, p.name);
    }
    if (splitMode === 'households') {
      box.addEventListener('change', onSplitChange);
      return h('div', { class: 'split-row' },
        h('label', { class: 'chip' }, box, p.name),
        h('span', { class: 'small muted' }, householdsOf(people).find((u) => u.memberIds.includes(p.id)).name),
        h('span', { class: 'split-share', 'data-share-for': p.id }));
    }
    const input = h('input', {
      type: 'number',
      inputmode: 'decimal',
      min: '0',
      step: splitMode === 'shares' ? 'any' : amountStep(cur),
      class: 'split-value',
      'aria-label': `${p.name}'s ${splitMode === 'shares' ? 'shares' : 'amount'}`,
      placeholder: splitMode === 'shares' ? '1' : minorToInput(0, cur),
      value: splitValues[p.id] ?? (splitMode === 'shares' ? '1' : ''),
      disabled: !checked,
    });
    input.addEventListener('input', () => { splitValues[p.id] = input.value; onSplitChange(); });
    box.addEventListener('change', () => { input.disabled = !box.checked; onSplitChange(); });
    return h('div', { class: 'split-row' },
      h('label', { class: 'chip' }, box, p.name),
      input,
      h('span', { class: 'split-share', 'data-share-for': p.id }));
  }));
  knownSplitIds = new Set(people.map((p) => p.id));
}

function onSplitChange() {
  updateSplitPreview();
  updateQuickSummary();
}

document.querySelectorAll('.segmented button').forEach((b) => {
  b.addEventListener('click', () => {
    if (splitMode === b.dataset.mode) return;
    splitMode = b.dataset.mode;
    splitValues = {};
    renderSplitEditor(true);
    onSplitChange();
  });
});

/**
 * Who shares the expense and how much each owes, in minor units of the
 * form's currency. `error` explains anything that stops it being saved.
 */
function splitPlan() {
  const ids = selectedSplit();
  const cur = formCurrency();
  const total = toMinor($('#expense-amount').value, cur);
  if (ids.length === 0) return { ids, error: 'Choose at least one person to split this between.' };
  if (splitMode === 'equal') return { ids, shares: total > 0 ? splitAmount(total, ids.length) : null };
  if (splitMode === 'households') {
    const weights = householdWeights(ids, people);
    return { ids, weights, shares: total > 0 ? allocate(total, weights) : null };
  }
  if (splitMode === 'shares') {
    const weights = ids.map((id) => Number(splitValues[id] ?? 1));
    if (weights.some((w) => !(w >= 0))) return { ids, error: 'Shares must be numbers, like 1 or 0.5.' };
    if (!weights.some((w) => w > 0)) return { ids, error: 'Give at least one person a share.' };
    return { ids, weights, shares: total > 0 ? allocate(total, weights) : null };
  }
  const amounts = ids.map((id) => {
    const text = String(splitValues[id] ?? '').trim();
    return text === '' ? 0 : toMinor(text, cur);
  });
  if (amounts.some((a) => !(a >= 0))) return { ids, error: 'Amounts must be numbers.' };
  const left = (total > 0 ? total : 0) - amounts.reduce((s, a) => s + a, 0);
  const error = left > 0
    ? `${formatMoney(left, cur)} still to assign.`
    : left < 0 ? `The amounts add up to ${formatMoney(-left, cur)} more than the total.` : null;
  return { ids, weights: amounts, shares: amounts, left, error: total > 0 ? error : null };
}

function updateSplitPreview() {
  const cur = formCurrency();
  const fmt = (m) => formatMoney(m, cur);
  const total = toMinor($('#expense-amount').value, cur);
  const plan = splitPlan();
  const preview = $('#split-preview');
  document.querySelectorAll('[data-share-for]').forEach((el) => {
    const i = plan.ids.indexOf(el.dataset.shareFor);
    el.textContent = (splitMode === 'shares' || splitMode === 'households') && i >= 0 && plan.shares ? fmt(plan.shares[i]) : '';
  });
  let text;
  if (plan.error && (splitMode !== 'exact' || total > 0)) text = plan.error;
  else if (!(total > 0)) text = `${plan.ids.length} ${plan.ids.length === 1 ? 'person' : 'people'} selected`;
  else if (splitMode === 'equal') {
    const min = Math.min(...plan.shares);
    const max = Math.max(...plan.shares);
    text = `${plan.ids.length} ${plan.ids.length === 1 ? 'person' : 'people'} · ${min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`} each`;
  } else if (splitMode === 'households') {
    const n = Math.round(plan.weights.reduce((s, w) => s + w, 0));
    text = `${n} ${n === 1 ? 'household' : 'households'} · ${fmt(Math.round(total / n))} each`;
  } else if (splitMode === 'shares') {
    const n = plan.weights.reduce((s, w) => s + w, 0);
    text = `${formatShareCount(n)} ${n === 1 ? 'share' : 'shares'} in total`;
  } else {
    text = 'Adds up to the total.';
  }
  if (total > 0 && cur !== tripCurrency() && rateState.rate > 0) {
    text += ` · ${fmt(total)} is ${money(convertMinor(total, cur, tripCurrency(), rateState.rate))}`;
  }
  preview.textContent = text;
  preview.classList.toggle('error-text', !!plan.error && total > 0);
}
const formatShareCount = (n) => String(Math.round(n * 100) / 100);

$('#expense-amount').addEventListener('input', updateSplitPreview);

function setAllSplit(checked) {
  document.querySelectorAll('#split-options input[type="checkbox"]').forEach((i) => {
    i.checked = checked;
    i.dispatchEvent(new Event('change'));
  });
  onSplitChange();
}
$('#split-all').addEventListener('click', () => setAllSplit(true));
$('#split-none').addEventListener('click', () => setAllSplit(false));

// ---------- Quick-add sheet ----------

const sheet = $('#expense-sheet');

/** One line saying what will be saved, so the extra options can stay folded away. */
function updateQuickSummary() {
  if (!people.length) return;
  const ids = selectedSplit();
  const everyone = ids.length === people.length && people.length > 1;
  const who = everyone ? 'everyone' : ids.map(personName).join(', ') || 'nobody';
  const how = {
    equal: 'split equally between', shares: 'split by shares between', exact: 'split by amount between',
    households: 'split per household between',
  }[splitMode];
  const date = $('#expense-date').value;
  const when = !date || date === today() ? 'today' : longDate(date);
  const parts = [`${personName($('#expense-payer').value)} paid`, `${how} ${who}`, when];
  const cat = $('#expense-category').value;
  parts.push(isCategory(cat) ? categoryLabel(cat) : `${categoryLabel(guessCategory($('#expense-desc').value))} (auto)`);
  $('#quick-summary').textContent = parts.join(' · ');
}
['#expense-payer', '#expense-date', '#expense-category'].forEach((sel) => $(sel).addEventListener('change', updateQuickSummary));
$('#expense-desc').addEventListener('input', updateQuickSummary);

function setMoreOptions(open) {
  $('#more-options').hidden = !open;
  $('#more-toggle').setAttribute('aria-expanded', String(open));
  $('#more-toggle').textContent = open ? 'Fewer options' : 'Change who paid, split, date…';
}
$('#more-toggle').addEventListener('click', () => setMoreOptions($('#more-options').hidden));

function openExpenseSheet(expense = null) {
  if (!people.length) {
    prefs.tab = 'settings';
    savePrefs();
    render();
    showNotice('Add the people on the trip first.');
    return;
  }
  resetExpenseForm();
  if (expense) startEdit(expense);
  else renderExpenseForm();
  if (!sheet.open) sheet.showModal();
  if (!expense) $('#expense-amount').focus();
}

function closeExpenseSheet() {
  if (sheet.open) sheet.close();
}
sheet.addEventListener('close', () => {
  resetExpenseForm();
  render();
});
// Tapping the dimmed area outside the sheet closes it.
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeExpenseSheet(); });
$('#cancel-edit').addEventListener('click', closeExpenseSheet);
$('#add-expense-fab').addEventListener('click', () => openExpenseSheet());

function renderExpenseForm() {
  const hasPeople = people.length > 0;
  $('#expenses-need-people').hidden = hasPeople;
  if (!hasPeople) return;

  if (editingId && !expenses.some((e) => e.id === editingId)) {
    closeExpenseSheet();
    showNotice('That expense was deleted by someone else.');
    return;
  }

  // Preserve the chosen payer across re-renders; default to this phone's person.
  const payerSel = $('#expense-payer');
  const prevPayer = payerSel.value;
  payerSel.replaceChildren(...people.map((p) => h('option', { value: p.id }, p.name)));
  const fallback = meId() || prefs.lastPayer?.[currentTrip().id];
  if (people.some((p) => p.id === prevPayer)) payerSel.value = prevPayer;
  else if (people.some((p) => p.id === fallback)) payerSel.value = fallback;

  const households = hasHouseholds(people);
  $('.segmented [data-mode="households"]').hidden = !households;
  if (splitMode === 'households' && !households) splitMode = 'equal';
  renderSplitEditor();

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

  const deleteSlot = $('#delete-expense-slot');
  if (editingId && deleteSlot.dataset.for !== editingId) {
    const id = editingId;
    deleteSlot.replaceChildren(confirmButton('Delete', 'Tap again to delete', () => {
      const original = expenses.find((x) => x.id === id);
      closeExpenseSheet();
      deleteWithUndo(expensesCol(currentTrip().id), original, `Deleted “${original.description}”`);
    }, { class: 'danger' }));
    deleteSlot.dataset.for = id;
  } else if (!editingId && deleteSlot.dataset.for) {
    deleteSlot.replaceChildren();
    delete deleteSlot.dataset.for;
  }

  const original = editingId && expenses.find((x) => x.id === editingId);
  const meta = [];
  if (original?.createdBy) meta.push(`Added by ${personName(original.createdBy)}`);
  if (original?.updatedBy) meta.push(`last changed by ${personName(original.updatedBy)}`);
  $('#sheet-meta').textContent = meta.join(', ');

  updateSplitPreview();
  updateQuickSummary();
}

function resetExpenseForm() {
  editingId = null;
  const payer = $('#expense-payer').value;
  $('#expense-form').reset();
  $('#expense-payer').value = payer; // the same person often pays several times in a row
  currencyChosen = false;
  rateRequest++;
  rateState = emptyRate();
  splitMode = 'equal';
  splitValues = {};
  splitKey = '';
  knownSplitIds = new Set();
  $('#split-options').replaceChildren();
  updateAutoCategory();
  setMoreOptions(false);
  $('#expense-error').textContent = '';
  $('#sheet-meta').textContent = '';
}

$('#expense-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const description = $('#expense-desc').value.trim();
  const currency = formCurrency();
  const amountCents = toMinor($('#expense-amount').value, currency);
  const paidBy = $('#expense-payer').value;
  const date = $('#expense-date').value || today();
  const error = $('#expense-error');
  const plan = splitPlan();
  const showOptions = () => setMoreOptions(true);

  if (!(amountCents > 0)) return void (error.textContent = 'Enter an amount greater than zero.');
  if (!description) return void (error.textContent = 'Say what it was, like “Dinner”.');
  if (plan.error) {
    showOptions();
    return void (error.textContent = plan.error);
  }
  // Expenses in the main currency don't store one, like expenses from before
  // currencies were added.
  const data = { description, amountCents, paidBy, splitAmong: plan.ids, date };
  const category = $('#expense-category').value;
  if (isCategory(category)) data.category = category;
  if (splitMode !== 'equal') {
    // A per-household split is stored as shares (e.g. 0.5 each for a couple).
    data.splitMode = splitMode === 'households' ? 'shares' : splitMode;
    data.splitWeights = Object.fromEntries(plan.ids.map((id, i) => [id, plan.weights[i]]));
  }
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
  const original = id && expenses.find((x) => x.id === id);
  const me = meId();
  if (original?.createdBy) data.createdBy = original.createdBy;
  else if (!id && me) data.createdBy = me;
  if (id && me) data.updatedBy = me;
  const newId = id || uid();
  const submit = $('#expense-submit');
  submit.disabled = true;
  // Save the whole expense so fields from its old currency or split don't linger.
  const ok = await write(() => col.doc(newId).set({ ...data, createdAt: original?.createdAt || Date.now() }));
  submit.disabled = false;
  if (!ok) return;
  prefs.lastPayer = { ...prefs.lastPayer, [currentTrip().id]: paidBy };
  savePrefs();
  closeExpenseSheet();
  if (original) {
    showToast('Changes saved', () => restoreDoc(col, original));
  } else {
    showToast(`Added “${description}”`, () => write(() => col.doc(newId).delete()));
  }
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
  $('#expense-category').value = isCategory(expense.category) ? expense.category : '';
  updateAutoCategory();
  $('#expense-amount').value = minorToInput(expense.amountCents, cur);
  $('#expense-payer').replaceChildren(...people.map((p) => h('option', { value: p.id }, p.name)));
  $('#expense-payer').value = expense.paidBy;
  $('#expense-date').value = expense.date || '';
  splitMode = isHouseholdSplit(expense, people) ? 'households'
    : expense.splitMode === 'shares' || expense.splitMode === 'exact' ? expense.splitMode : 'equal';
  splitValues = {};
  if (splitMode === 'shares' || splitMode === 'exact') {
    for (const [pid, w] of Object.entries(expense.splitWeights ?? {})) {
      splitValues[pid] = splitMode === 'exact' ? minorToInput(w, cur) : String(w);
    }
  }
  splitKey = '';
  renderSplitEditor(true, new Set(expense.splitAmong));
  renderExpenseForm();
}

const dayLabel = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function renderExpenses() {
  const list = $('#expense-list');
  const trip = tripCurrency();
  const bought = expenses.filter((e) => !isPayment(e));
  const usable = expensesInTripCurrency().usable.filter((e) => !isPayment(e));
  const total = usable.reduce((s, e) => s + e.amountCents, 0);
  $('#expense-total').textContent = bought.length ? money(total) : '';
  $('#add-expense-fab').hidden = people.length === 0;
  $('#expenses-need-people').hidden = people.length > 0;

  if (bought.length === 0) {
    list.replaceChildren(h('li', { class: 'empty-row' }, people.length ? 'No expenses yet. Tap “Add expense” to add the first one.' : 'No expenses yet.'));
    return;
  }

  const sorted = [...bought].sort((a, b) =>
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
    const how = isHouseholdSplit(e, people) ? 'split per household between'
      : e.splitMode === 'shares' || e.splitMode === 'exact' ? 'split unevenly between' : 'split between';
    const cur = expenseCurrency(e, trip);
    const inTrip = amountInTripCurrency(e, trip);
    const original = formatMoney(e.amountCents, cur);
    const paid = cur === trip ? 'paid' : inTrip == null ? `paid ${original}` : `paid ${original} at ${formatRate(e.rate)}`;
    rows.push(h('li', { class: 'expense' },
      h('button', { type: 'button', class: 'expense-button', 'aria-label': `Edit ${e.description}`, onclick: () => openExpenseSheet(e) },
        avatar(e.paidBy),
        h('div', { class: 'main' },
          h('div', { class: 'title' }, e.description),
          h('div', { class: 'sub' },
            h('span', { class: `cat-tag cat-${expenseCategory(e)}` }, categoryLabel(expenseCategory(e))),
            ` ${personName(e.paidBy)} ${paid} · ${how} ${splitText}`),
          inTrip == null ? h('div', { class: 'sub needs-rate' }, `No exchange rate into ${trip}. Tap to add one.`) : null,
        ),
        h('div', { class: inTrip == null ? 'amount needs-rate' : 'amount' }, inTrip == null ? original : money(inTrip)),
      ),
    ));
  }
  list.replaceChildren(...rows);
}

// ---------- Spending ----------

const shortDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });

/** Round axis labels, e.g. £100 rather than £100.00. */
const axisMoney = (minor) => {
  const text = money(minor);
  return /[.,]00$/.test(text) ? text.slice(0, -3) : text;
};

let hideSpendingTooltip = () => {};
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest?.('#spend-chart')) hideSpendingTooltip();
});

function renderSpending() {
  const { usable: all, missing } = expensesInTripCurrency();
  const usable = all.filter((e) => !isPayment(e));
  const { days, totals, total } = spendingByDay(usable);
  const empty = days.length === 0;
  $('#spend-empty').hidden = !empty;
  $('#spend-body').hidden = empty;
  $('#spend-total').textContent = empty ? '' : money(total);
  if (empty) return;

  const present = CATEGORIES.filter((c) => totals[c.id] > 0);
  $('#spend-legend').replaceChildren(...present.map((c) =>
    h('li', {},
      h('span', { class: `swatch cat-${c.id}`, 'aria-hidden': 'true' }),
      h('span', { class: 'legend-label' }, c.label),
      h('span', { class: 'legend-value' }, `${money(totals[c.id])} · ${Math.round((totals[c.id] / total) * 100)}%`),
    )));

  const { max, step } = niceScale(Math.max(...days.map((d) => d.total)));
  const showTotals = days.length <= 10;
  const chart = $('#spend-chart');
  chart.style.setProperty('--days', days.length);
  chart.setAttribute('aria-label', `Spending per day by category, ${days.length} days`);

  const grid = h('div', { class: 'chart-grid', 'aria-hidden': 'true' });
  for (let v = 0; v <= max; v += step) {
    const line = h('div', { class: v === 0 ? 'gridline baseline' : 'gridline' }, h('span', {}, axisMoney(v)));
    line.style.bottom = `${(v / max) * 100}%`;
    grid.append(line);
  }

  const columns = days.map((d, i) => {
    const segments = CATEGORIES.filter((c) => d.byCategory[c.id] > 0).map((c) => {
      const seg = h('span', { class: `segment cat-${c.id}` });
      seg.style.flexGrow = d.byCategory[c.id];
      return seg;
    });
    const stack = h('span', { class: 'bar-stack' }, segments);
    stack.style.height = `${(d.total / max) * 100}%`;
    const breakdown = CATEGORIES.filter((c) => d.byCategory[c.id] > 0)
      .map((c) => `${c.label} ${money(d.byCategory[c.id])}`).join(', ');
    return h('button', {
      type: 'button',
      class: 'day-column',
      'data-index': i,
      'aria-label': `${dayLabel(d.date)}: ${d.total ? `${money(d.total)} (${breakdown})` : 'nothing spent'}`,
    },
    h('span', { class: 'plot' },
      showTotals && d.total ? h('span', { class: 'bar-total', style: `bottom: ${(d.total / max) * 100}%` }, axisMoney(d.total)) : null,
      stack),
    h('span', { class: 'day-label' }, shortDay(d.date)));
  });

  const tooltip = h('div', { class: 'chart-tooltip', role: 'status', hidden: true });
  const showDay = (i) => {
    const d = days[i];
    columns.forEach((c, j) => c.classList.toggle('active', j === i));
    tooltip.replaceChildren(
      h('div', { class: 'tooltip-head' }, h('span', {}, dayLabel(d.date)), h('strong', {}, money(d.total))),
      ...(d.total
        ? CATEGORIES.filter((c) => d.byCategory[c.id] > 0).slice().reverse().map((c) =>
          h('div', { class: 'tooltip-row' },
            h('span', { class: `swatch cat-${c.id}`, 'aria-hidden': 'true' }),
            h('span', {}, c.label),
            h('span', { class: 'tooltip-value' }, money(d.byCategory[c.id]))))
        : [h('div', { class: 'tooltip-row muted' }, 'Nothing spent')]),
    );
    tooltip.hidden = false;
    // Keep the tooltip inside the chart, next to the day.
    const col = columns[i];
    const left = col.offsetLeft + col.offsetWidth / 2;
    tooltip.style.left = `${Math.min(Math.max(left, 90), chart.scrollWidth - 90)}px`;
  };
  const hide = () => {
    tooltip.hidden = true;
    columns.forEach((c) => c.classList.remove('active'));
  };
  // Mouse: hover shows a day. Touch: tap a day to show it, tap outside the chart to close.
  columns.forEach((c, i) => {
    c.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showDay(i); });
    c.addEventListener('focus', () => showDay(i));
    c.addEventListener('click', () => showDay(i));
  });
  chart.onpointerleave = (e) => { if (e.pointerType === 'mouse') hide(); };
  hideSpendingTooltip = hide;

  chart.replaceChildren(grid, h('div', { class: 'columns' }, columns), tooltip);

  $('#spend-warning').textContent = missing
    ? `${missing === 1 ? '1 expense has' : `${missing} expenses have`} no exchange rate into ${tripCurrency()} and ${missing === 1 ? "isn't" : "aren't"} included.`
    : '';

  // The same numbers as a table.
  $('#spend-table').replaceChildren(
    h('thead', {}, h('tr', {}, h('th', {}, 'Day'), ...present.map((c) => h('th', {}, c.label)), h('th', {}, 'Total'))),
    h('tbody', {}, ...days.map((d) => h('tr', {},
      h('th', {}, dayLabel(d.date)),
      ...present.map((c) => h('td', {}, d.byCategory[c.id] ? money(d.byCategory[c.id]) : '–')),
      h('td', {}, money(d.total))))),
    h('tfoot', {}, h('tr', {}, h('th', {}, 'Total'), ...present.map((c) => h('td', {}, money(totals[c.id]))), h('td', {}, money(total)))),
  );
}

// ---------- Settle up ----------

const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

// ---------- Who settles with whom: people, or households ----------

const settleByHousehold = () => hasHouseholds(people) && (prefs.settleBy?.[currentTrip()?.id] ?? 'household') === 'household';

/** The parties that settle up: households (couples as one) or each person. */
function settleParties() {
  return settleByHousehold()
    ? householdsOf(people)
    : people.map((p) => ({ id: p.id, memberIds: [p.id], name: p.name }));
}

function partyAvatar(party, small = false) {
  if (party.memberIds.length === 1) return avatar(party.memberIds[0], small);
  return h('span', { class: 'avatar-stack' }, party.memberIds.slice(0, 3).map((id) => avatar(id, small)));
}

/** Balances and suggested payments for the current way of settling. */
function settlement() {
  const { usable, missing } = expensesInTripCurrency();
  const parties = settleParties();
  const balances = householdBalances(computeBalances(people, usable), parties);
  return { parties, balances, payments: settleUp(balances), missing };
}

document.querySelectorAll('#settle-by button').forEach((b) => {
  b.addEventListener('click', () => {
    prefs.settleBy = { ...prefs.settleBy, [currentTrip().id]: b.dataset.by };
    savePrefs();
    render();
  });
});

/** Record that one person has paid another back. */
async function recordRepayment(from, to, amountCents, label) {
  const col = expensesCol(currentTrip().id);
  const id = uid();
  const me = meId();
  const data = {
    kind: 'payment', description: 'Repayment', amountCents, paidBy: from, splitAmong: [to],
    date: today(), createdAt: Date.now(), ...(me ? { createdBy: me } : {}),
  };
  const ok = await write(() => col.doc(id).set(data));
  if (ok) showToast(`Recorded ${label ?? `${personName(from)} paying ${personName(to)}`} ${money(amountCents)}`, () => write(() => col.doc(id).delete()));
}

function renderSettle() {
  const { parties, balances, payments, missing } = settlement();
  const byHousehold = settleByHousehold();
  const partyOf = (id) => parties.find((q) => q.id === id);
  const me = meId();
  const mine = (party) => !!me && party.memberIds.includes(me);

  $('#settle-by').hidden = !hasHouseholds(people);
  document.querySelectorAll('#settle-by button').forEach((b) => {
    b.setAttribute('aria-checked', String((b.dataset.by === 'household') === byHousehold));
  });
  $('#settle-warning').textContent = missing
    ? `${missing === 1 ? '1 expense is' : `${missing} expenses are`} left out because ${missing === 1 ? 'it has' : 'they have'} no exchange rate into ${tripCurrency()}. Edit ${missing === 1 ? 'it' : 'them'} on the Expenses tab to add one.`
    : '';

  $('#balance-list').replaceChildren(...(people.length ? parties.map((party) => {
    const b = balances.get(party.id);
    const pill = b.net > 0
      ? h('span', { class: 'pill positive' }, `${party.memberIds.length > 1 ? 'get' : 'gets'} back ${money(b.net)}`)
      : b.net < 0
        ? h('span', { class: 'pill negative' }, `${party.memberIds.length > 1 ? 'owe' : 'owes'} ${money(-b.net)}`)
        : h('span', { class: 'pill neutral' }, 'settled');
    const sub = [`Paid ${money(b.paid)}`, `share ${money(b.share)}`];
    if (b.sent) sub.push(`paid back ${money(b.sent)}`);
    if (b.received) sub.push(`got back ${money(b.received)}`);
    return h('li', {},
      partyAvatar(party),
      h('div', { class: 'main' },
        h('div', { class: 'title' }, party.name, mine(party) ? h('span', { class: 'you' }, 'you') : null),
        h('div', { class: 'sub' }, sub.join(' · ')),
      ),
      pill,
    );
  }) : [h('li', { class: 'empty-row' }, 'Add people to see balances.')]));

  const bought = expenses.some((e) => !isPayment(e));
  const list = $('#payment-list');
  if (payments.length === 0) {
    list.replaceChildren(h('li', { class: 'empty-row' },
      bought ? 'Everyone is square. Nothing to pay.' : 'Add some expenses to see who owes whom.'));
  } else {
    list.replaceChildren(...payments.map((pay) => {
      const from = partyOf(pay.from);
      const to = partyOf(pay.to);
      // The repayment is recorded between one member of each; which one doesn't matter.
      const fromPerson = mine(from) ? me : from.memberIds[0];
      const toPerson = mine(to) ? me : to.memberIds[0];
      const verb = from.memberIds.length > 1 ? 'pay' : 'pays';
      return h('li', { class: mine(from) || mine(to) ? 'mine' : null },
        h('div', { class: 'main' },
          h('div', { class: 'who' },
            partyAvatar(from, true), h('span', {}, from.name),
            h('span', { class: 'arrow' }, verb),
            partyAvatar(to, true), h('span', {}, to.name)),
          confirmButton('Mark as paid', `Confirm ${from.name} paid`,
            () => recordRepayment(fromPerson, toPerson, pay.amountCents, `${from.name} paying ${to.name}`),
            { class: 'link mark-paid' }),
        ),
        h('div', { class: 'amount' }, money(pay.amountCents)),
      );
    }));
  }
  $('#copy-summary').parentElement.hidden = payments.length === 0;

  const nameOf = (personId) => (byHousehold ? parties.find((q) => q.memberIds.includes(personId))?.name : null) ?? personName(personId);
  const repayments = expenses.filter(isPayment)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  $('#repayments-card').hidden = repayments.length === 0;
  $('#repayment-list').replaceChildren(...repayments.map((r) => {
    const inTrip = amountInTripCurrency(r, tripCurrency());
    return h('li', {},
      h('div', { class: 'main' },
        h('div', { class: 'title' }, `${nameOf(r.paidBy)} paid ${nameOf(r.splitAmong[0])}`),
        h('div', { class: 'sub' }, r.date ? shortDate(r.date) : ''),
      ),
      h('div', { class: 'amount' }, inTrip == null ? formatMoney(r.amountCents, expenseCurrency(r, tripCurrency())) : money(inTrip)),
      confirmButton('Remove', 'Tap to confirm', () => deleteWithUndo(expensesCol(currentTrip().id), r, 'Repayment removed'),
        { class: 'quiet danger' }),
    );
  }));
}

$('#copy-summary').addEventListener('click', () => {
  const trip = currentTrip();
  const { usable } = expensesInTripCurrency();
  const { parties, payments } = settlement();
  const nameOf = (id) => parties.find((q) => q.id === id)?.name ?? '';
  const total = usable.filter((e) => !isPayment(e)).reduce((s, e) => s + e.amountCents, 0);
  const text = [
    `${trip.name || 'Trip'}: total spent ${money(total)}`,
    '',
    ...payments.map((p) => `${nameOf(p.from)} ${parties.find((q) => q.id === p.from)?.memberIds.length > 1 ? 'pay' : 'pays'} ${nameOf(p.to)} ${money(p.amountCents)}`),
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
  renderWhoAmI(trip);
  renderPeople();
  if (sheet.open) renderExpenseForm();
  renderExpenses();
  if (prefs.tab === 'spending') renderSpending();
  renderSettle();
  renderDeleteTrip(trip);
  renderInstall();
}

// ---------- Deleting a trip: type its name to confirm ----------

const deleteWord = (trip) => (trip?.name || '').trim() || 'delete';

function renderDeleteTrip(trip) {
  $('#delete-trip-prompt').textContent = `Type “${deleteWord(trip)}” to confirm`;
  const typed = $('#delete-trip-confirm').value.trim().toLowerCase();
  $('#delete-trip-button').disabled = typed !== deleteWord(trip).toLowerCase();
}
$('#delete-trip-confirm').addEventListener('input', () => renderDeleteTrip(currentTrip()));
$('#delete-trip-button').addEventListener('click', async () => {
  const trip = currentTrip();
  if ($('#delete-trip-confirm').value.trim().toLowerCase() !== deleteWord(trip).toLowerCase()) return;
  $('#delete-trip-confirm').value = '';
  $('#delete-trip-button').disabled = true;
  await deleteTrip(trip);
  showToast(`Deleted “${trip.name || 'Untitled trip'}”`);
});

// ---------- Install as an app ----------

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  renderInstall();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  renderInstall();
});

function renderInstall() {
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $('#install-card').hidden = installed || !(installPrompt || ios);
  $('#install-button').hidden = !installPrompt;
  if (ios && !installPrompt) {
    $('#install-text').textContent = 'In Safari, tap the Share button, then “Add to Home Screen”. It then opens full screen, like an app, and works without signal.';
  }
}
$('#install-button').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  renderInstall();
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // Not available here (for example inside another app's frame): the app still works online.
  });
}

function renderHero(trip) {
  $('#hero-title').textContent = trip.name || 'Untitled trip';
  const { usable } = expensesInTripCurrency();
  const bought = expenses.filter((e) => !isPayment(e));
  const total = usable.filter((e) => !isPayment(e)).reduce((s, e) => s + e.amountCents, 0);
  const dates = bought.map((e) => e.date).filter(Boolean).sort();
  const parts = [];
  const summary = $('#hero-summary');
  summary.replaceChildren();
  if (bought.length) summary.append(h('strong', {}, money(total)), ' spent');
  parts.push(`${people.length} ${people.length === 1 ? 'person' : 'people'}`);
  if (dates.length) {
    const fmt = (iso, withYear) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined,
      withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
    const first = dates[0];
    const last = dates[dates.length - 1];
    parts.push(first === last ? fmt(first, true) : `${fmt(first, first.slice(0, 4) !== last.slice(0, 4))} – ${fmt(last, true)}`);
  }
  summary.append(`${bought.length ? ' · ' : ''}${parts.join(' · ')}`);

  // Where this phone's person stands.
  const me = meId();
  const heroMe = $('#hero-me');
  heroMe.hidden = !me || !bought.length;
  if (me && bought.length) {
    const { parties, balances } = settlement();
    const party = parties.find((q) => q.memberIds.includes(me));
    const net = balances.get(party.id)?.net ?? 0;
    const who = party.memberIds.length > 1 ? 'Your household' : 'You';
    const is = party.memberIds.length > 1 ? 'is' : 'are';
    heroMe.className = `hero-me ${net > 0 ? 'positive' : net < 0 ? 'negative' : ''}`;
    heroMe.textContent = net > 0 ? `${who} ${is} owed ${money(net)}`
      : net < 0 ? `${who} ${party.memberIds.length > 1 ? 'owes' : 'owe'} ${money(-net)}`
        : `${who} ${is} all square`;
  }
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
  document.body.classList.toggle('with-photo', !!key);
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
