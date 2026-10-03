/**
 * Minimal promise wrapper around IndexedDB for local-only storage of studio
 * projects and preferences. Nothing is ever sent to a server.
 */
const DB_NAME = 'smg-studio';
const DB_VERSION = 1;
export const STORES = { projects: 'projects', prefs: 'prefs' } as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.projects)) db.createObjectStore(STORES.projects, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.prefs)) db.createObjectStore(STORES.prefs);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
  );
}

export const idb = {
  get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    return tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
  },
  put(store: string, value: unknown, key?: IDBValidKey): Promise<IDBValidKey> {
    return tx(store, 'readwrite', (s) => s.put(value, key));
  },
  delete(store: string, key: IDBValidKey): Promise<undefined> {
    return tx(store, 'readwrite', (s) => s.delete(key));
  },
  all<T>(store: string): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
};

/** Preferences with a localStorage fallback when IndexedDB is unavailable. */
export async function getPref<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = await idb.get<T>(STORES.prefs, key);
    return v === undefined ? fallback : v;
  } catch {
    try {
      const s = localStorage.getItem(`smg:${key}`);
      return s ? (JSON.parse(s) as T) : fallback;
    } catch {
      return fallback;
    }
  }
}

export async function setPref(key: string, value: unknown): Promise<void> {
  try {
    await idb.put(STORES.prefs, value, key);
  } catch {
    try {
      localStorage.setItem(`smg:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable (private mode) — ignore */
    }
  }
}
