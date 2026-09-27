// Checks firestore.rules against the Firestore emulator.
// Run with: npm run test:rules   (needs Java for the emulator)
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection } from 'firebase/firestore';

const TRIP = 'b6f7a0de-1c2b-4f5e-9a8d-7c6b5a4e3d2f';
let env;
let db;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'split-costs-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  db = env.unauthenticatedContext().firestore();
});

const trip = { name: 'Lisbon', currency: '€', createdAt: 1 };
const person = { name: 'Alice', createdAt: 1 };
const expense = { description: 'Dinner', amountCents: 9000, paidBy: 'p1', splitAmong: ['p1', 'p2'], date: '2026-09-27', createdAt: 1 };

test('anyone with the trip id can create, read, update and delete it', async () => {
  const ref = doc(db, 'trips', TRIP);
  await assertSucceeds(setDoc(ref, trip));
  await assertSucceeds(getDoc(ref));
  await assertSucceeds(updateDoc(ref, { name: 'Porto' }));
  await assertSucceeds(deleteDoc(ref));
});

test('trips cannot be listed', async () => {
  await setDoc(doc(db, 'trips', TRIP), trip);
  await assertFails(getDocs(collection(db, 'trips')));
});

test('trip ids must be long and random-looking', async () => {
  await assertFails(setDoc(doc(db, 'trips', 'abc'), trip));
});

test('trip data must have the expected shape', async () => {
  const ref = doc(db, 'trips', TRIP);
  await assertFails(setDoc(ref, { ...trip, extra: true }));
  await assertFails(setDoc(ref, { ...trip, name: 'x'.repeat(61) }));
  await assertFails(setDoc(ref, { ...trip, currency: 5 }));
});

test('people and expenses need an existing trip', async () => {
  await assertFails(setDoc(doc(db, 'trips', TRIP, 'people', 'p1'), person));
  await assertFails(setDoc(doc(db, 'trips', TRIP, 'expenses', 'e1'), expense));
});

test('people and expenses can be added, listed and removed inside a trip', async () => {
  await setDoc(doc(db, 'trips', TRIP), trip);
  await assertSucceeds(setDoc(doc(db, 'trips', TRIP, 'people', 'p1'), person));
  await assertSucceeds(setDoc(doc(db, 'trips', TRIP, 'expenses', 'e1'), expense));
  await assertSucceeds(getDocs(collection(db, 'trips', TRIP, 'people')));
  await assertSucceeds(getDocs(collection(db, 'trips', TRIP, 'expenses')));
  await assertSucceeds(updateDoc(doc(db, 'trips', TRIP, 'expenses', 'e1'), { amountCents: 100 }));
  await assertSucceeds(deleteDoc(doc(db, 'trips', TRIP, 'expenses', 'e1')));
  await assertSucceeds(deleteDoc(doc(db, 'trips', TRIP, 'people', 'p1')));
});

test('bad expenses are refused', async () => {
  await setDoc(doc(db, 'trips', TRIP), trip);
  const ref = doc(db, 'trips', TRIP, 'expenses', 'e1');
  await assertFails(setDoc(ref, { ...expense, amountCents: 0 }));
  await assertFails(setDoc(ref, { ...expense, amountCents: 12.5 }));
  await assertFails(setDoc(ref, { ...expense, splitAmong: [] }));
  await assertFails(setDoc(ref, { ...expense, description: '' }));
  await assertFails(setDoc(ref, { ...expense, note: 'extra field' }));
  await assertFails(setDoc(doc(db, 'trips', TRIP, 'people', 'p1'), { name: '', createdAt: 1 }));
});

test('expenses in another currency need valid rate fields', async () => {
  await setDoc(doc(db, 'trips', TRIP), { ...trip, currency: 'GBP' });
  const ref = doc(db, 'trips', TRIP, 'expenses', 'e1');
  const foreign = { ...expense, currency: 'EUR', rate: 0.8598, rateTo: 'GBP', rateSource: 'market', rateDate: '2026-09-27' };
  await assertSucceeds(setDoc(ref, foreign));
  await assertSucceeds(updateDoc(ref, { rate: 0.86, rateSource: 'manual' }));
  await assertFails(setDoc(ref, { ...foreign, currency: 'euro' }));
  await assertFails(setDoc(ref, { ...foreign, rate: 0 }));
  await assertFails(setDoc(ref, { ...foreign, rate: '0.86' }));
  await assertFails(setDoc(ref, { ...foreign, rateSource: 'guess' }));
  await assertFails(setDoc(ref, { ...foreign, rateTo: 'gbp' }));
});

test('a trip can have one small JPEG cover photo', async () => {
  await setDoc(doc(db, 'trips', TRIP), trip);
  const cover = doc(db, 'trips', TRIP, 'photo', 'cover');
  const dataUrl = `data:image/jpeg;base64,${'A'.repeat(200000)}`;
  await assertSucceeds(setDoc(cover, { dataUrl, updatedAt: 1 }));
  await assertSucceeds(getDoc(cover));
  await assertSucceeds(deleteDoc(cover));
  await assertFails(setDoc(doc(db, 'trips', TRIP, 'photo', 'other'), { dataUrl, updatedAt: 1 }));
  await assertFails(setDoc(cover, { dataUrl: `data:image/jpeg;base64,${'A'.repeat(240000)}`, updatedAt: 1 }));
  await assertFails(setDoc(cover, { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', updatedAt: 1 }));
  await assertFails(setDoc(cover, { dataUrl: 'data:image/jpeg;base64,AAAA");background:url(x', updatedAt: 1 }));
  await assertFails(setDoc(doc(db, 'trips', 'b6f7a0de-0000-4f5e-9a8d-000000000000', 'photo', 'cover'), { dataUrl, updatedAt: 1 }));
});

test('other collections are closed', async () => {
  await assertFails(setDoc(doc(db, 'other', 'x'), { a: 1 }));
});
