'use strict';

(function initStorageModule(global) {
  const DB_NAME = () => (global.CONFIG?.IDENTITY_DB_NAME || 'mychat_db');
  const DB_VERSION = () => Number(global.CONFIG?.IDENTITY_DB_VERSION || 1);

  let dbPromise = null;

  function openDatabase(forceReset = false) {
    if (!forceReset && dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME(), DB_VERSION());

      request.onupgradeneeded = event => {
        const db = event.target.result;
        const transaction = event.target.transaction;
        const identity = ensureStore(db, transaction, 'identity');
        const contacts = ensureStore(db, transaction, 'contacts');
        const messages = ensureStore(db, transaction, 'messages');
        ensureStore(db, transaction, 'vault');
        ensureStore(db, transaction, 'ratchet_sessions');
        ensureIndexes(contacts, messages);
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
    }).catch(async error => {
      console.warn('IndexedDB open failed, attempting reset', error);
      if (forceReset) throw error;
      dbPromise = null;
      await deleteDatabase();
      return openDatabase(true);
    });

    return dbPromise;
  }

  function ensureStore(db, transaction, name) {
    if (!db.objectStoreNames.contains(name)) {
      return db.createObjectStore(name, { keyPath: 'id' });
    }
    return transaction.objectStore(name);
  }

  function ensureIndexes(contacts, messages) {
    createIndexIfMissing(contacts, 'displayName', 'displayName', { unique: false });
    createIndexIfMissing(contacts, 'lastSeen', 'lastSeen', { unique: false });
    createIndexIfMissing(messages, 'conversationId', 'conversationId', { unique: false });
    createIndexIfMissing(messages, 'fromFingerprint', 'fromFingerprint', { unique: false });
    createIndexIfMissing(messages, 'ts', 'ts', { unique: false });
    createIndexIfMissing(messages, 'conversationId_ts', ['conversationId', 'ts'], { unique: false });
  }

  function createIndexIfMissing(store, name, keyPath, options) {
    if (!store.indexNames.contains(name)) {
      store.createIndex(name, keyPath, options);
    }
  }

  function deleteDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME());
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('Failed to delete IndexedDB database'));
      request.onblocked = () => reject(new Error('IndexedDB delete blocked by another tab'));
    });
  }

  async function withStore(storeName, mode, work) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let settled = false;
      let transactionCompleted = false;
      let workCompleted = false;
      let workResult;

      transaction.oncomplete = () => {
        transactionCompleted = true;
        if (!settled && workCompleted) {
          settled = true;
          resolve(workResult);
        }
      };
      transaction.onerror = () => {
        if (!settled) {
          settled = true;
          reject(transaction.error || new Error(`IndexedDB transaction failed for ${storeName}`));
        }
      };
      transaction.onabort = () => {
        if (!settled) {
          settled = true;
          reject(transaction.error || new Error(`IndexedDB transaction aborted for ${storeName}`));
        }
      };

      Promise.resolve()
        .then(() => work(store, transaction))
        .then(result => {
          workResult = result;
          workCompleted = true;
          if (!settled && transactionCompleted) {
            settled = true;
            resolve(workResult);
          }
        })
        .catch(error => {
          try {
            transaction.abort();
          } catch (abortError) {}
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
    });
  }

  function wrapRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  async function dbGet(storeName, key) {
    return withStore(storeName, 'readonly', store => wrapRequest(store.get(key)));
  }

  async function dbPut(storeName, key, value) {
    const record = {
      ...(value && typeof value === 'object' ? value : { value }),
      id: key
    };
    return withStore(storeName, 'readwrite', store => wrapRequest(store.put(record)));
  }

  async function dbDelete(storeName, key) {
    return withStore(storeName, 'readwrite', store => wrapRequest(store.delete(key)));
  }

  async function dbGetAll(storeName) {
    return withStore(storeName, 'readonly', store => wrapRequest(store.getAll()));
  }

  async function dbClear(storeName) {
    return withStore(storeName, 'readwrite', store => wrapRequest(store.clear()));
  }

  async function dbCount(storeName) {
    return withStore(storeName, 'readonly', store => wrapRequest(store.count()));
  }

  async function dbQueryByIndex(storeName, indexName, query, direction = 'next') {
    return withStore(storeName, 'readonly', store => new Promise((resolve, reject) => {
      const index = store.index(indexName);
      const request = index.openCursor(query, direction);
      const results = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(results);
          return;
        }
        results.push(cursor.value);
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error(`IndexedDB cursor failed for ${indexName}`));
    }));
  }

  async function dbTransaction(storeNames, mode, work) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeNames, mode);
      const stores = Object.fromEntries(storeNames.map(name => [name, transaction.objectStore(name)]));
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
      Promise.resolve()
        .then(() => work(stores, transaction))
        .then(value => { result = value; })
        .catch(error => {
          try {
            transaction.abort();
          } catch (abortError) {}
          reject(error);
        });
    });
  }

  global.openMyChatDatabase = openDatabase;
  global.dbGet = dbGet;
  global.dbPut = dbPut;
  global.dbDelete = dbDelete;
  global.dbGetAll = dbGetAll;
  global.dbClear = dbClear;
  global.dbCount = dbCount;
  global.dbQueryByIndex = dbQueryByIndex;
  global.dbTransaction = dbTransaction;
})(window);
