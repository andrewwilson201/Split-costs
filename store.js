// Data storage. The app talks to one small document-store interface, backed by
// whichever of these is available:
//
//   claude    Published as a shared claude.ai page: the page's shared database.
//   firebase  firebase-config.js is filled in (e.g. on GitHub Pages): Cloud Firestore.
//   local     Anything else: localStorage, on this device only.
//
// Layout:
//   trips/{tripId}                      {name, currency, createdAt}
//   trips/{tripId}/people/{personId}    {name, createdAt}
//   trips/{tripId}/expenses/{expenseId} {description, amountCents, paidBy, splitAmong, date, createdAt}
//
// People and expenses are separate documents so two people adding expenses
// at the same moment never overwrite each other.
//
// In Firebase mode there are no accounts. A trip's random id is its secret,
// and the database rules refuse to list trips. So each device remembers the
// trips it has opened, and new people join through the trip's link.

import { firebaseConfig } from './firebase-config.js';

const LOCAL_KEY = 'split-costs:local-db:v1';
const KNOWN_TRIPS_KEY = 'split-costs:known-trips';

export async function openStore() {
  let claudeDb = null;
  try {
    claudeDb = (await window.claude?.use?.('db')) ?? null;
  } catch {
    claudeDb = null;
  }
  if (claudeDb) return collectionStore(claudeDb, 'claude');

  if (firebaseConfig?.projectId) {
    try {
      return linkStore(await createFirebaseDb(firebaseConfig));
    } catch (e) {
      console.error('Could not connect to Firebase, saving on this device instead.', e);
      // Say so on screen: quietly saving on one phone would split the trip's records.
      return { ...collectionStore(createLocalDb(), 'local'), connectError: e };
    }
  }
  return collectionStore(createLocalDb(), 'local');
}

/** A store where every trip can be listed (claude.ai shared db, localStorage). */
function collectionStore(db, mode) {
  return {
    db,
    mode,
    watchTrips: (next, onError) =>
      db.collection('trips').onSnapshot((snap) => next(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError),
    rememberTrip() {},
    forgetTrip() {},
    onLateWriteError() {},
  };
}

/** A store where trips are only reachable by id, so this device keeps its own list. */
function linkStore(db) {
  const readKnown = () => {
    try {
      const ids = JSON.parse(localStorage.getItem(KNOWN_TRIPS_KEY));
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  };
  const writeKnown = (ids) => {
    try {
      localStorage.setItem(KNOWN_TRIPS_KEY, JSON.stringify(ids));
    } catch {
      // Not critical: the trip link still works.
    }
  };

  const trips = new Map();
  const unsubs = new Map();
  const awaitingFirst = new Set();
  let listener = null;
  let errorListener = null;

  const emit = () => {
    if (listener && awaitingFirst.size === 0) listener([...trips.values()]);
  };

  const watch = (id) => {
    if (unsubs.has(id)) return;
    awaitingFirst.add(id);
    unsubs.set(id, db.doc(`trips/${id}`).onSnapshot((snap) => {
      if (snap.exists) {
        trips.set(id, { id, ...snap.data() });
      } else if (!snap.metadata.fromCache) {
        // Deleted, or the link was wrong.
        store.forgetTrip(id);
      }
      awaitingFirst.delete(id);
      emit();
    }, (e) => {
      awaitingFirst.delete(id);
      errorListener?.(e);
      emit();
    }));
  };

  const store = {
    db,
    mode: 'firebase',
    watchTrips(next, onError) {
      listener = next;
      errorListener = onError;
      readKnown().forEach(watch);
      emit();
      return () => { unsubs.forEach((u) => u()); listener = null; };
    },
    rememberTrip(id) {
      if (!readKnown().includes(id)) writeKnown([...readKnown(), id]);
      watch(id);
    },
    forgetTrip(id) {
      writeKnown(readKnown().filter((x) => x !== id));
      unsubs.get(id)?.();
      unsubs.delete(id);
      awaitingFirst.delete(id);
      trips.delete(id);
      emit();
    },
    onLateWriteError: db.onLateWriteError,
  };
  return store;
}

async function createFirebaseDb(config) {
  // A copy of the SDK is served with the site (see vendor/firebase/README.md).
  const [{ initializeApp }, fs] = await Promise.all([
    import('./vendor/firebase/firebase-app.js'),
    import('./vendor/firebase/firebase-firestore.js'),
  ]);
  const { emulator, ...appConfig } = config;
  const app = initializeApp(appConfig);

  let firestore;
  try {
    // Keep a copy on the device so the app works with patchy signal.
    firestore = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    firestore = fs.getFirestore(app);
  }
  if (emulator) {
    const [host, port] = emulator.split(':');
    fs.connectFirestoreEmulator(firestore, host, Number(port));
  }

  // Firestore only confirms a write once the server has it, which never
  // happens while offline. The change already shows locally, so stop waiting
  // after a moment and report any later failure separately.
  let lateErrorHandler = () => {};
  const settle = (promise) => {
    let done = false;
    const tracked = promise.finally(() => { done = true; });
    return Promise.race([tracked, new Promise((r) => setTimeout(r, 1500))]).then(() => {
      if (!done) tracked.catch((e) => lateErrorHandler(e));
    });
  };

  const wrapDocSnap = (s) => ({
    id: s.id,
    exists: s.exists(),
    data: () => s.data(),
    metadata: s.metadata,
  });
  const wrapQuerySnap = (s) => ({
    docs: s.docs.map(wrapDocSnap),
    size: s.size,
    empty: s.empty,
    metadata: s.metadata,
  });

  const docRef = (path) => {
    const ref = fs.doc(firestore, path);
    return {
      id: ref.id,
      path,
      get: async () => wrapDocSnap(await fs.getDoc(ref)),
      set: (data) => settle(fs.setDoc(ref, data)),
      update: (data) => settle(fs.updateDoc(ref, data)),
      delete: () => settle(fs.deleteDoc(ref)),
      onSnapshot: (next, error) =>
        fs.onSnapshot(ref, { includeMetadataChanges: false }, (s) => next(wrapDocSnap(s)), (e) => error?.(e)),
      collection: (sub) => collectionRef(`${path}/${sub}`),
    };
  };

  const collectionRef = (path) => {
    const ref = fs.collection(firestore, path);
    return {
      path,
      doc: (id = crypto.randomUUID()) => docRef(`${path}/${id}`),
      get: async () => wrapQuerySnap(await fs.getDocs(ref)),
      onSnapshot: (next, error) => fs.onSnapshot(ref, (s) => next(wrapQuerySnap(s)), (e) => error?.(e)),
    };
  };

  return {
    doc: docRef,
    collection: collectionRef,
    onLateWriteError: (fn) => { lateErrorHandler = fn; },
  };
}

function createLocalDb() {
  let docs = {};
  try {
    docs = JSON.parse(localStorage.getItem(LOCAL_KEY)) || {};
  } catch {
    docs = {};
  }
  const listeners = new Set();
  const metadata = { fromCache: false, hasPendingWrites: false };

  const persist = () => {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(docs));
    } catch {
      // Storage full or blocked: keep working in memory for this visit.
    }
    for (const l of listeners) l();
  };

  const snapshotOf = (colPath) => {
    const prefix = `${colPath}/`;
    const list = Object.keys(docs)
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .sort()
      .map((p) => {
        const data = docs[p];
        return { id: p.slice(prefix.length), exists: true, data: () => data, metadata };
      });
    return { docs: list, size: list.length, empty: list.length === 0, metadata };
  };

  const docRef = (path) => ({
    id: path.split('/').pop(),
    path,
    async get() {
      const data = docs[path];
      return { id: path.split('/').pop(), exists: !!data, data: () => data, metadata };
    },
    async set(data) {
      docs[path] = structuredClone(data);
      persist();
    },
    async update(data) {
      if (!docs[path]) throw { code: 'invalid_argument', message: 'Document does not exist' };
      docs[path] = { ...docs[path], ...structuredClone(data) };
      persist();
    },
    async delete() {
      delete docs[path];
      persist();
    },
    collection: (sub) => collectionRef(`${path}/${sub}`),
  });

  const collectionRef = (colPath) => ({
    path: colPath,
    doc: (id = crypto.randomUUID()) => docRef(`${colPath}/${id}`),
    async get() {
      return snapshotOf(colPath);
    },
    onSnapshot(next) {
      const fire = () => next(snapshotOf(colPath));
      listeners.add(fire);
      queueMicrotask(fire);
      return () => listeners.delete(fire);
    },
  });

  // Keep other tabs in sync, like the shared stores do across devices.
  window.addEventListener('storage', (e) => {
    if (e.key !== LOCAL_KEY) return;
    try {
      docs = JSON.parse(e.newValue) || {};
    } catch {
      return;
    }
    for (const l of listeners) l();
  });

  return { doc: docRef, collection: collectionRef };
}
