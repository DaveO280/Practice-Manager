import { applyNewSessionToClient } from '../utils/timePatterns';

const DB_NAME = 'PracticeManagerDB';
const DB_VERSION = 2;

const openDB = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('clients')) {
        const clientStore = db.createObjectStore('clients', { keyPath: 'id' });
        clientStore.createIndex('name', 'name', { unique: false });
        clientStore.createIndex('active', 'active', { unique: false });
      }

      if (!db.objectStoreNames.contains('sessions')) {
        const sessionStore = db.createObjectStore('sessions', { keyPath: 'id' });
        sessionStore.createIndex('clientId', 'clientId', { unique: false });
        sessionStore.createIndex('date', 'date', { unique: false });
        sessionStore.createIndex('paid', 'paid', { unique: false });
      }

      if (!db.objectStoreNames.contains('cptCodes')) {
        db.createObjectStore('cptCodes', { keyPath: 'code' });
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
  });

const dbOperation = async (storeName, mode, operation) => {
  const db = await openDB();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = await operation(store);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return result;
};

const getAllFromStore = (store) =>
  new Promise((resolve, reject) => {
    const r = store.getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const getFromStore = (store, key) =>
  new Promise((resolve, reject) => {
    const r = store.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const putToStore = (store, value) =>
  new Promise((resolve, reject) => {
    const r = store.put(value);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });

const deleteFromStore = (store, key) =>
  new Promise((resolve, reject) => {
    const r = store.delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });

const sortSessionsDesc = (sessions) =>
  [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));

export const indexedDbStore = {
  async loadAppData() {
    const clients = await dbOperation('clients', 'readonly', (store) => getAllFromStore(store));
    const sessions = sortSessionsDesc(
      await dbOperation('sessions', 'readonly', (store) => getAllFromStore(store))
    );
    const cptCodes =
      (await dbOperation('cptCodes', 'readonly', (store) => getAllFromStore(store))) || [];
    return { clients, sessions, cptCodes };
  },

  async mergeDefaultCptCodes(defaultCodes) {
    const cptData =
      (await dbOperation('cptCodes', 'readonly', (store) => getAllFromStore(store))) || [];
    const existingCodes = new Set(cptData.map((c) => c.code));
    const merged = [...cptData];
    for (const code of defaultCodes) {
      if (!existingCodes.has(code.code)) {
        merged.push(code);
        existingCodes.add(code.code);
        await dbOperation('cptCodes', 'readwrite', (store) => putToStore(store, code));
      }
    }
    return merged.length ? merged : defaultCodes;
  },

  async saveClient(client) {
    await dbOperation('clients', 'readwrite', (store) => putToStore(store, client));
  },

  async saveSession(session) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['clients', 'sessions'], 'readwrite');
      const clientsStore = tx.objectStore('clients');
      const sessionsStore = tx.objectStore('sessions');

      const existingReq = sessionsStore.get(session.id);
      existingReq.onsuccess = () => {
        const isNewSession = !existingReq.result;

        const putSession = () => {
          const pr = sessionsStore.put(session);
          pr.onerror = () => reject(pr.error);
        };

        if (
          !isNewSession ||
          !session.clientId ||
          !session.time ||
          session.time === '—'
        ) {
          putSession();
          return;
        }

        const cr = clientsStore.get(session.clientId);
        cr.onsuccess = () => {
          const client = cr.result;
          if (client) {
            const updated = applyNewSessionToClient({ ...client }, session);
            const up = clientsStore.put(updated);
            up.onerror = () => reject(up.error);
            up.onsuccess = () => putSession();
          } else {
            putSession();
          }
        };
        cr.onerror = () => reject(cr.error);
      };
      existingReq.onerror = () => reject(existingReq.error);

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async deleteSession(sessionId) {
    await dbOperation('sessions', 'readwrite', (store) => deleteFromStore(store, sessionId));
  },

  async clearAllSessions() {
    await dbOperation('sessions', 'readwrite', (store) =>
      new Promise((resolve, reject) => {
        const r = store.clear();
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      })
    );
  },

  async getProviderInfo() {
    try {
      const row = await dbOperation('settings', 'readonly', (store) =>
        getFromStore(store, 'providerInfo')
      );
      if (row?.value) {
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      }
    } catch {
      /* settings store missing on very old DB — handled by upgrade */
    }
    const raw = localStorage.getItem('providerInfo');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        await indexedDbStore.setProviderInfo(parsed);
        return parsed;
      } catch {
        return null;
      }
    }
    return null;
  },

  async setProviderInfo(info) {
    await dbOperation('settings', 'readwrite', (store) =>
      putToStore(store, { key: 'providerInfo', value: JSON.stringify(info) })
    );
    localStorage.setItem('providerInfo', JSON.stringify(info));
  },

  async importClientsFromParsed(importData) {
    if (!importData.clients || !Array.isArray(importData.clients)) return 0;
    let n = 0;
    for (const clientData of importData.clients) {
      if (!clientData.name) continue;
      const clientToSave = {
        id: clientData.id || `client-${Date.now()}-${Math.random()}`,
        name: clientData.name,
        fullName: clientData.fullName || null,
        rate: clientData.rate || 0,
        email: clientData.email || '',
        billingType: clientData.billingType || 'direct',
        active: clientData.active !== undefined ? clientData.active : true,
        timePatterns: clientData.timePatterns || [],
        sessionCount: clientData.sessionCount || 0,
        lastSeen: clientData.lastSeen || null,
        dateOfBirth: clientData.dateOfBirth || null,
        diagnosis: clientData.diagnosis || ''
      };
      await indexedDbStore.saveClient(clientToSave);
      n += 1;
    }
    return n;
  },

  async importSessionsFromParsed(importData) {
    if (!importData.sessions || !Array.isArray(importData.sessions)) return 0;
    let n = 0;
    for (const sessionData of importData.sessions) {
      if (!sessionData.date || !sessionData.clientId) continue;
      const sessionToSave = {
        id: sessionData.id || `session-${Date.now()}-${Math.random()}`,
        clientId: sessionData.clientId,
        date: sessionData.date,
        time: sessionData.time || '',
        dayOfWeek:
          sessionData.dayOfWeek !== undefined
            ? sessionData.dayOfWeek
            : new Date(sessionData.date).getDay(),
        cptCode: sessionData.cptCode || '90834',
        duration: sessionData.duration || 45,
        amountCharged: sessionData.amountCharged || 0,
        paid: sessionData.paid || false,
        paidDate: sessionData.paidDate || null,
        notes: sessionData.notes || '',
        invoiceSent: sessionData.invoiceSent || false,
        invoiceSentDate: sessionData.invoiceSentDate || null
      };
      await indexedDbStore.saveSession(sessionToSave);
      n += 1;
    }
    return n;
  }
};
