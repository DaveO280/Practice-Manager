import { invoke } from '@tauri-apps/api/core';

export const tauriStore = {
  async loadAppData() {
    return invoke('load_app_data');
  },

  async mergeDefaultCptCodes(defaultCodes) {
    return invoke('merge_default_cpt_codes', { defaults: defaultCodes });
  },

  async saveClient(client) {
    return invoke('save_client_cmd', { client });
  },

  async saveSession(session) {
    return invoke('save_session_cmd', { session });
  },

  async deleteSession(sessionId) {
    return invoke('delete_session_cmd', { sessionId });
  },

  async clearAllSessions() {
    return invoke('clear_all_sessions_cmd');
  },

  async getProviderInfo() {
    const raw = await invoke('get_setting_cmd', { key: 'providerInfo' });
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  async setProviderInfo(info) {
    await invoke('set_setting_cmd', {
      key: 'providerInfo',
      value: JSON.stringify(info)
    });
  },

  async importClientsFromParsed(importData) {
    return invoke('import_clients_backup', {
      jsonStr: JSON.stringify(importData)
    });
  },

  async importSessionsFromParsed(importData) {
    return invoke('import_sessions_backup', {
      jsonStr: JSON.stringify(importData)
    });
  }
};
