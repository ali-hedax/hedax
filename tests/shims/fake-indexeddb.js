/* Minimal in-memory IndexedDB shim — only the surface NobatStore uses:
   open / onupgradeneeded / createObjectStore / objectStoreNames.contains /
   transaction / objectStore / put / getAll / delete, plus the
   success + complete callbacks.
   The backing Map is passed in, so a test can simulate a page refresh by
   resetting NobatStore and opening the same database again. */
"use strict";

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function makeFakeIndexedDB(persist) {
  const stores = persist || new Map(); // name -> { keyPath, data: Map }
  let version = 0;

  function storeHandle(name) {
    const st = stores.get(name);
    if (!st) throw new Error("NotFoundError: object store " + name);
    return {
      put(value) {
        const key = value[st.keyPath];
        if (key === undefined) throw new Error("DataError: missing key path value");
        st.data.set(key, clone(value));
        return { result: key };
      },
      delete(key) { st.data.delete(key); return { result: undefined }; },
      getAll() { return { result: Array.from(st.data.values()).map(clone) }; },
    };
  }

  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore(name, opts) {
      stores.set(name, { keyPath: (opts && opts.keyPath) || "id", data: new Map() });
      return storeHandle(name);
    },
    transaction(name) {
      const handle = storeHandle(name);
      const tx = { objectStore: () => handle, oncomplete: null, onerror: null, onabort: null, error: null };
      setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
      return tx;
    },
    close() {},
  };

  return {
    open(_name, wantedVersion) {
      const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        if (wantedVersion > version) { version = wantedVersion; if (req.onupgradeneeded) req.onupgradeneeded(); }
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
    __stores: stores,
  };
}

module.exports = { makeFakeIndexedDB };
