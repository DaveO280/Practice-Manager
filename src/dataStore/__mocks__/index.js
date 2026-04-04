const emptyLoad = { clients: [], sessions: [], cptCodes: [] };

const mockStore = {
  loadAppData: jest.fn(() => Promise.resolve(emptyLoad)),
  mergeDefaultCptCodes: jest.fn((defaults) => Promise.resolve(defaults)),
  saveClient: jest.fn(() => Promise.resolve()),
  saveSession: jest.fn(() => Promise.resolve()),
  deleteSession: jest.fn(() => Promise.resolve()),
  clearAllSessions: jest.fn(() => Promise.resolve()),
  getProviderInfo: jest.fn(() => Promise.resolve(null)),
  setProviderInfo: jest.fn(() => Promise.resolve()),
  importClientsFromParsed: jest.fn(() => Promise.resolve(0)),
  importSessionsFromParsed: jest.fn(() => Promise.resolve(0))
};

export function getDataStore() {
  return mockStore;
}

export function isTauriRuntime() {
  return false;
}
