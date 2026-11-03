// On-device storage (IndexedDB). Nothing here leaves the phone.
// Stores:
//   txns  - one record per transaction in the ledger
//   kv    - small settings blobs: labels, merchant -> label memory
const DB_NAME = "finance";
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("txns")) {
        const s = db.createObjectStore("txns", { keyPath: "id" });
        s.createIndex("date", "date");
        s.createIndex("merchant", "merchant");
      }
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  allTxns: () => run("txns", "readonly", (s) => reqP(s.getAll())),
  putTxn: (t) => run("txns", "readwrite", (s) => { s.put(t); }),
  putTxns: (list) => run("txns", "readwrite", (s) => { list.forEach((t) => s.put(t)); }),
  deleteTxn: (id) => run("txns", "readwrite", (s) => { s.delete(id); }),
  clearTxns: () => run("txns", "readwrite", (s) => { s.clear(); }),
  get: (key) => run("kv", "readonly", (s) => reqP(s.get(key))),
  set: (key, value) => run("kv", "readwrite", (s) => { s.put(value, key); }),
  clearKv: () => run("kv", "readwrite", (s) => { s.clear(); })
};
