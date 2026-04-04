import { indexedDbStore } from './indexedDbStore';
import { tauriStore } from './tauriStore';

export function isTauriRuntime() {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

/**
 * Browser: IndexedDB. Tauri desktop: local SQLite via IPC.
 */
export function getDataStore() {
  return isTauriRuntime() ? tauriStore : indexedDbStore;
}
