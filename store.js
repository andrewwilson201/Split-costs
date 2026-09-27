// Data storage. When the app runs as a shared claude.ai page, it uses the
// page's shared realtime database, so everyone on the trip sees the same
// data. Anywhere else it falls back to a small localStorage-backed store with
// the same interface, so the app still works when opened on its own.
//
// Layout:
//   trips/{tripId}                      {name, currency, createdAt}
//   trips/{tripId}/people/{personId}    {name, createdAt}
//   trips/{tripId}/expenses/{expenseId} {description, amountCents, paidBy, splitAmong, date, createdAt}
//
// People and expenses are separate documents so two people adding expenses
// at the same moment never overwrite each other.

const LOCAL_KEY = 'split-costs:local-db:v1';

export async function openStore() {
  let db = null;
  try {
    db = (await window.claude?.use?.('db')) ?? null;
  } catch {
    db = null;
  }
  return db ? { db, shared: true } : { db: createLocalDb(), shared: false };
}

function createLocalDb() {
  let docs = {};
  try {
    docs = JSON.parse(localStorage.getItem(LOCAL_KEY)) || {};
  } catch {
    docs = {};
  }
  const listeners = new Set();

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
        return { id: p.slice(prefix.length), exists: true, data: () => data };
      });
    return { docs: list, size: list.length, empty: list.length === 0 };
  };

  const docRef = (path) => ({
    id: path.split('/').pop(),
    path,
    async get() {
      const data = docs[path];
      return { id: path.split('/').pop(), exists: !!data, data: () => data };
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
    async add(data) {
      const ref = docRef(`${colPath}/${crypto.randomUUID()}`);
      await ref.set(data);
      return ref;
    },
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

  // Keep other tabs in sync, like the shared store does across devices.
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
