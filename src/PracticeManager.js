import React, { useState, useEffect, useRef } from 'react';

import { Camera, Users, Calendar, Download, Plus, X, Check, Sparkles, Clock, DollarSign, Edit2, Trash2, FileText, Mail } from 'lucide-react';

// Import HEIC converter
import heic2any from 'heic2any';
import { getVeniceFinalScheduleText } from './utils/veniceOutput';
import { saveJsonToDevice, saveCsvToDevice, saveBlobToDevice, supportsSaveFilePicker } from './utils/saveToDevice';
import { getDataStore } from './dataStore';

// Utility: Fuzzy string matching
const fuzzyMatch = (str1, str2) => {
  if (!str1 || !str2) return 0;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  // Exact match
  if (s1 === s2) return 1.0;
  
  // Contains match
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;
  
  // Levenshtein distance
  const matrix = Array(s2.length + 1).fill(null).map(() => 
    Array(s1.length + 1).fill(null)
  );
  
  for (let i = 0; i <= s1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= s2.length; j++) matrix[j][0] = j;
  
  for (let j = 1; j <= s2.length; j++) {
    for (let i = 1; i <= s1.length; i++) {
      if (s2[j - 1] === s1[i - 1]) {
        matrix[j][i] = matrix[j - 1][i - 1];
      } else {
        matrix[j][i] = Math.min(
          matrix[j - 1][i - 1] + 1,
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1
        );
      }
    }
  }
  
  const distance = matrix[s2.length][s1.length];
  const maxLen = Math.max(s1.length, s2.length);
  return 1 - (distance / maxLen);
};

// Utility: Time helper
const isWithinHour = (time1, time2) => {
  const parseTime = (t) => {
    const [time, period] = t.split(' ');
    let [hours, minutes] = time.split(':').map(Number);
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  };
  
  const diff = Math.abs(parseTime(time1) - parseTime(time2));
  return diff <= 60; // Within 1 hour
};

// Parse YYYY-MM-DD as local date (new Date('YYYY-MM-DD') is UTC midnight → wrong day in local TZ)
const parseLocalDate = (dateStr) => {
  if (!dateStr) return null;
  const s = typeof dateStr === 'string' ? dateStr : dateStr.toISOString().split('T')[0];
  const parts = s.split('-').map(Number);
  if (parts.length !== 3) return new Date(dateStr);
  const [y, m, d] = parts;
  return new Date(y, m - 1, d);
};

const isWithinWeeks = (dateStr, weeks) => {
  const date = parseLocalDate(dateStr) || new Date(dateStr);
  const now = new Date();
  const diffTime = Math.abs(now - date);
  const diffWeeks = diffTime / (1000 * 60 * 60 * 24 * 7);
  return diffWeeks <= weeks;
};

/** RFC-style CSV field: quote if needed, escape internal quotes */
const formatCsvBulkField = (val) => {
  const s = val == null ? '' : String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

/** Split one CSV line into cells (handles "quoted, commas" correctly) */
const parseCsvBulkLine = (line) => {
  const result = [];
  let i = 0;
  let cur = '';
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      result.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  result.push(cur.trim());
  return result;
};

const PROVIDER_INFO_DEFAULTS = {
  providerName: '',
  company: '',
  email: '',
  phone: '',
  fax: '',
  address: '',
  npi: '',
  taxId: '',
  signatureImage: ''
};

// CPT Codes
const DEFAULT_CPT_CODES = [
  { code: '90791', description: 'Initial Evaluation', defaultDuration: 60 },
  { code: '90971', description: 'Brief Emotional/Behavioral Assessment', defaultDuration: 15 },
  { code: '90832', description: 'Psychotherapy 30 min', defaultDuration: 30 },
  { code: '90834', description: 'Psychotherapy 45 min', defaultDuration: 45 },
  { code: '90834-POS10', description: 'Individual Therapy 45 min - POS 10', defaultDuration: 45 },
  { code: '90837', description: 'Psychotherapy 60 min', defaultDuration: 60 },
  { code: '90846', description: 'Family Psychotherapy (without patient)', defaultDuration: 50 },
  { code: '90847', description: 'Family Psychotherapy (with patient)', defaultDuration: 50 },
  { code: '99446', description: 'Interprofessional Consultation', defaultDuration: 60 },
  { code: '99484', description: 'Behavioral Health Integration', defaultDuration: 30 }
];

const PracticeManager = () => {
  const store = getDataStore();
  const [currentView, setCurrentView] = useState('sessions'); // sessions, import, clients, export, invoicing
  const [clients, setClients] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [cptCodes, setCptCodes] = useState(DEFAULT_CPT_CODES);
  const [loading, setLoading] = useState(true);
  const [autoImportEnabled, setAutoImportEnabled] = useState(() => {
    return localStorage.getItem('autoImportEnabled') === 'true';
  });
  const [showMonthlyExportReminder, setShowMonthlyExportReminder] = useState(false);
  const [providerInfo, setProviderInfo] = useState(PROVIDER_INFO_DEFAULTS);
  const [appDataHydrated, setAppDataHydrated] = useState(false);

  // eslint-disable-next-line no-unused-vars -- reserved for future UI toggle
  const toggleAutoImport = () => {
    const newValue = !autoImportEnabled;
    setAutoImportEnabled(newValue);
    localStorage.setItem('autoImportEnabled', newValue.toString());
    if (newValue) {
      alert('Auto-import enabled. The app will prompt you to select backup files on next startup if the database is empty.');
    } else {
      alert('Auto-import disabled.');
    }
  };

  // Auto-import function
  const autoImportBackups = async () => {
    if (!autoImportEnabled) return;
    
    try {
      // Check if we have stored file handles
      const storedClientsFile = localStorage.getItem('clientsBackupFile');
      const storedSessionsFile = localStorage.getItem('sessionsBackupFile');
      
      if (!storedClientsFile && !storedSessionsFile) {
        // No files stored, prompt user to select
        const enableAutoImport = window.confirm(
          'Auto-import is enabled but no backup files are configured.\n\n' +
          'Would you like to select backup files now?'
        );
        
        if (enableAutoImport) {
          // Create file input for clients
          const clientsInput = document.createElement('input');
          clientsInput.type = 'file';
          clientsInput.accept = '.json';
          clientsInput.style.display = 'none';
          clientsInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (file) {
              await importClientsFromFile(file);
              localStorage.setItem('clientsBackupFile', file.name);
            }
          };
          document.body.appendChild(clientsInput);
          clientsInput.click();
          
          // Create file input for sessions
          setTimeout(() => {
            const sessionsInput = document.createElement('input');
            sessionsInput.type = 'file';
            sessionsInput.accept = '.json';
            sessionsInput.style.display = 'none';
            sessionsInput.onchange = async (e) => {
              const file = e.target.files[0];
              if (file) {
                await importSessionsFromFile(file);
                localStorage.setItem('sessionsBackupFile', file.name);
              }
            };
            document.body.appendChild(sessionsInput);
            sessionsInput.click();
          }, 500);
        }
        return;
      }
      
      // If files are stored, we can't auto-read them without user interaction
      // So we'll just show a notification
      console.log('Auto-import enabled. Use Import buttons to load backup files.');
    } catch (error) {
      console.error('Error in auto-import:', error);
    }
  };
  
  // Import clients from file (helper function)
  const importClientsFromFile = async (file) => {
    try {
      const text = await file.text();
      const importData = JSON.parse(text);
      
      if (!importData.clients || !Array.isArray(importData.clients)) {
        console.warn('Invalid clients file format');
        return;
      }
      
      const importedCount = await store.importClientsFromParsed(importData);
      const data = await store.loadAppData();
      setClients(Array.isArray(data?.clients) ? data.clients : []);
      console.log(`Auto-imported ${importedCount} clients`);
    } catch (error) {
      console.error('Error importing clients:', error);
    }
  };
  
  // Import sessions from file (helper function)
  const importSessionsFromFile = async (file) => {
    try {
      const text = await file.text();
      const importData = JSON.parse(text);
      
      if (!importData.sessions || !Array.isArray(importData.sessions)) {
        console.warn('Invalid sessions file format');
        return;
      }
      
      const importedCount = await store.importSessionsFromParsed(importData);
      const data = await store.loadAppData();
      const clientList = Array.isArray(data?.clients) ? data.clients : [];
      const sessionList = Array.isArray(data?.sessions) ? data.sessions : [];
      setClients(clientList);
      setSessions(
        [...sessionList].sort((a, b) => new Date(b.date) - new Date(a.date))
      );
      console.log(`Auto-imported ${importedCount} sessions`);
    } catch (error) {
      console.error('Error importing sessions:', error);
    }
  };
  
  useEffect(() => {
    const loadData = async () => {
      try {
        const data = await store.loadAppData();
        const clientList = Array.isArray(data?.clients) ? data.clients : [];
        const sessionList = Array.isArray(data?.sessions) ? data.sessions : [];
        setClients(clientList);
        setSessions(
          [...sessionList].sort((a, b) => new Date(b.date) - new Date(a.date))
        );
        const merged = await store.mergeDefaultCptCodes(DEFAULT_CPT_CODES);
        const cptList = Array.isArray(merged) ? merged : DEFAULT_CPT_CODES;
        setCptCodes(cptList.length ? cptList : DEFAULT_CPT_CODES);

        const pi = await store.getProviderInfo();
        setProviderInfo(
          pi ? { ...PROVIDER_INFO_DEFAULTS, ...pi } : PROVIDER_INFO_DEFAULTS
        );

        setLoading(false);
        setAppDataHydrated(true);

        const lastBackup = localStorage.getItem('lastBackupExportDate');
        const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
        if (!lastBackup || Date.now() - new Date(lastBackup).getTime() > thirtyDaysMs) {
          setShowMonthlyExportReminder(true);
        }

        if (clientList.length === 0 || sessionList.length === 0) {
          setTimeout(() => autoImportBackups(), 1000);
        }
      } catch (error) {
        console.error('Error loading data:', error);
        setLoading(false);
        setAppDataHydrated(true);
      }
    };

    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!appDataHydrated) return;
    void Promise.resolve(store.setProviderInfo(providerInfo)).catch((e) =>
      console.error(e)
    );
    localStorage.setItem('providerInfo', JSON.stringify(providerInfo));
  }, [providerInfo, appDataHydrated, store]);

  const exportFullBackup = async () => {
    const dateStr = new Date().toISOString().split('T')[0];
    const sessionsPayload = { version: '1.0', exportDate: new Date().toISOString(), sessions };
    const clientsPayload = { version: '1.0', exportDate: new Date().toISOString(), clients };

    const r1 = await saveJsonToDevice(sessionsPayload, `sessions_backup_${dateStr}.json`);
    if (r1.aborted) return;

    if (!supportsSaveFilePicker()) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    const r2 = await saveJsonToDevice(clientsPayload, `clients_backup_${dateStr}.json`);
    if (r2.aborted) return;

    localStorage.setItem('lastBackupExportDate', new Date().toISOString());
    setShowMonthlyExportReminder(false);
    const picked =
      r1.mode === 'picker' && r2.mode === 'picker'
        ? ' Both files were saved where you chose.'
        : ' If you did not see a save dialog, check your Downloads folder.';
    alert(`Backup exported (sessions + clients JSON).${picked}`);
  };

  const saveClient = async (client) => {
    try {
      await store.saveClient(client);
      const data = await store.loadAppData();
      setClients(Array.isArray(data?.clients) ? data.clients : []);
    } catch (error) {
      console.error('Error in saveClient:', error);
      throw error;
    }
  };

  const saveSession = async (session) => {
    try {
      await store.saveSession(session);
      const data = await store.loadAppData();
      const clientList = Array.isArray(data?.clients) ? data.clients : [];
      const sessionList = Array.isArray(data?.sessions) ? data.sessions : [];
      setClients(clientList);
      setSessions(
        [...sessionList].sort((a, b) => new Date(b.date) - new Date(a.date))
      );
    } catch (error) {
      console.error('Error in saveSession:', error);
      throw error;
    }
  };

  const deleteSession = async (sessionId) => {
    try {
      await store.deleteSession(sessionId);
      const data = await store.loadAppData();
      const sessionList = Array.isArray(data?.sessions) ? data.sessions : [];
      setSessions(
        [...sessionList].sort((a, b) => new Date(b.date) - new Date(a.date))
      );
    } catch (error) {
      console.error('Error in deleteSession:', error);
      throw error;
    }
  };

  const clearAllSessions = async () => {
    if (sessions.length === 0) {
      alert('No sessions to delete.');
      return;
    }

    const sessionCount = sessions.length;
    const confirmMessage = `Are you sure you want to delete ALL ${sessionCount} session(s)?\n\nThis action cannot be undone.\n\nType "DELETE ALL" to confirm:`;
    const userInput = prompt(confirmMessage);

    if (userInput !== 'DELETE ALL') {
      return;
    }

    try {
      await store.clearAllSessions();
      setSessions([]);
      alert(`All ${sessionCount} session(s) have been deleted.`);
    } catch (error) {
      console.error('Error clearing all sessions:', error);
      alert('Error deleting sessions. Please try again.');
    }
  };
  
  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        fontFamily: '"Crimson Pro", Georgia, serif'
      }}>
        <div style={{ textAlign: 'center', color: 'white' }}>
          <Clock size={48} style={{ marginBottom: '1rem', animation: 'spin 2s linear infinite' }} />
          <p style={{ fontSize: '1.5rem', fontWeight: 600 }}>Loading Practice Manager...</p>
        </div>
      </div>
    );
  }
  
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      fontFamily: '"Crimson Pro", Georgia, serif',
      color: '#1a1a2e'
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600;700&family=Space+Mono:wght@400;700&display=swap');
        
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        @keyframes slideIn {
          from { transform: translateX(-20px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        
        .card {
          animation: fadeIn 0.4s ease-out;
        }
        
        .session-item {
          animation: slideIn 0.3s ease-out;
        }
        
        button {
          transition: all 0.2s ease;
        }
        
        button:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 16px rgba(0,0,0,0.2);
        }
        
        button:active {
          transform: translateY(0);
        }
        
        input, select, textarea {
          transition: all 0.2s ease;
        }
        
        input:focus, select:focus, textarea:focus {
          outline: none;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.3);
        }
        
        input[type="number"]::-webkit-inner-spin-button,
        input[type="number"]::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        input[type="number"] {
          -moz-appearance: textfield;
        }
      `}</style>
      
      {/* Header */}
      <div style={{
        background: 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'blur(10px)',
        borderBottom: '3px solid #667eea',
        padding: '1.5rem 2rem',
        boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
      }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{
            fontSize: '2.5rem',
            fontWeight: 700,
            margin: 0,
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            letterSpacing: '-0.02em'
          }}>
            Practice Manager
          </h1>
          <div style={{ fontFamily: '"Space Mono", monospace', color: '#666', fontSize: '0.9rem' }}>
            {sessions.length} sessions · {clients.filter(c => c.active).length} active clients
          </div>
        </div>
      </div>
      
      {/* Monthly backup reminder */}
      {showMonthlyExportReminder && !loading && (
        <div style={{
          background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)',
          borderBottom: '2px solid #f59e0b',
          padding: '0.75rem 2rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem'
        }}>
          <span style={{ color: '#92400e', fontWeight: 600, fontFamily: '"Crimson Pro", Georgia, serif' }}>
            📦 It’s been over 30 days since your last backup. Export now to keep your data safe. (Chrome/Edge: you can pick the folder; Safari/Firefox: files go to Downloads.)
          </span>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              onClick={exportFullBackup}
              style={{
                padding: '0.5rem 1rem',
                background: '#f59e0b',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            >
              Export backup now
            </button>
            <button
              onClick={() => {
                localStorage.setItem('lastBackupExportDate', new Date().toISOString());
                setShowMonthlyExportReminder(false);
              }}
              style={{
                padding: '0.5rem 1rem',
                background: 'transparent',
                color: '#92400e',
                border: '2px solid #f59e0b',
                borderRadius: '8px',
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      
      {/* Navigation */}
      <div style={{ background: 'rgba(255, 255, 255, 0.9)', borderBottom: '1px solid rgba(102, 126, 234, 0.2)' }}>
        <div style={{ maxWidth: '1400px', margin: '0 auto', display: 'flex', gap: '0.5rem', padding: '1rem 2rem' }}>
          {[
            { id: 'sessions', icon: Calendar, label: 'Sessions' },
            { id: 'import', icon: Camera, label: 'Import Schedule' },
            { id: 'clients', icon: Users, label: 'Clients' },
            { id: 'export', icon: Download, label: 'Export' },
            { id: 'invoicing', icon: FileText, label: 'Invoicing' }
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              onClick={() => setCurrentView(id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.75rem 1.5rem',
                border: 'none',
                background: currentView === id 
                  ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                  : 'transparent',
                color: currentView === id ? 'white' : '#666',
                borderRadius: '12px',
                cursor: 'pointer',
                fontSize: '1rem',
                fontWeight: currentView === id ? 600 : 400,
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            >
              <Icon size={20} />
              {label}
            </button>
          ))}
        </div>
      </div>
      
      {/* Main Content */}
      <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '2rem' }}>
        {currentView === 'sessions' && <SessionsView sessions={sessions} clients={clients} saveSession={saveSession} deleteSession={deleteSession} setSessions={setSessions} cptCodes={cptCodes} clearAllSessions={clearAllSessions} />}
        {currentView === 'import' && <ImportView clients={clients} sessions={sessions} cptCodes={cptCodes} saveSession={saveSession} saveClient={saveClient} />}
        {currentView === 'clients' && <ClientsView clients={clients} saveClient={saveClient} />}
        {currentView === 'export' && <ExportView sessions={sessions} clients={clients} />}
        {currentView === 'invoicing' && (
          <InvoicingView
            sessions={sessions}
            clients={clients}
            saveSession={saveSession}
            providerInfo={providerInfo}
            setProviderInfo={setProviderInfo}
          />
        )}
      </div>
    </div>
  );
};

// Sessions View Component
const SessionsView = ({ sessions, clients, saveSession, deleteSession, setSessions, cptCodes, clearAllSessions }) => {
  const [filter, setFilter] = useState('lastWeek');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [filterClientId, setFilterClientId] = useState('');
  const [filteredSessions, setFilteredSessions] = useState([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState(null);
  const [editingSessionData, setEditingSessionData] = useState(null);
  const [newSessionData, setNewSessionData] = useState({
    clientId: '',
    date: new Date().toISOString().split('T')[0],
    time: '',
    cptCode: '90834',
    duration: 45,
    amountCharged: 0,
    notes: ''
  });
  
  useEffect(() => {
    const now = new Date();
    let filtered = [...sessions];
    
    switch (filter) {
      case 'today':
        filtered = sessions.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          return sessionDate && sessionDate.toDateString() === now.toDateString();
        });
        break;
      case 'thisWeek':
        // Current calendar week (Sunday to Saturday)
        const startOfThisWeek = new Date(now);
        startOfThisWeek.setDate(now.getDate() - now.getDay()); // Start from Sunday
        startOfThisWeek.setHours(0, 0, 0, 0);
        
        const endOfThisWeek = new Date(startOfThisWeek);
        endOfThisWeek.setDate(startOfThisWeek.getDate() + 6); // End on Saturday
        endOfThisWeek.setHours(23, 59, 59, 999);
        
        filtered = sessions.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          return sessionDate && sessionDate >= startOfThisWeek && sessionDate <= endOfThisWeek;
        });
        break;
      case 'lastWeek':
        // Previous calendar week (Sunday to Saturday)
        const startOfLastWeek = new Date(now);
        startOfLastWeek.setDate(now.getDate() - now.getDay() - 7); // Previous Sunday
        startOfLastWeek.setHours(0, 0, 0, 0);
        
        const endOfLastWeek = new Date(startOfLastWeek);
        endOfLastWeek.setDate(startOfLastWeek.getDate() + 6); // Previous Saturday
        endOfLastWeek.setHours(23, 59, 59, 999);
        
        filtered = sessions.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          return sessionDate && sessionDate >= startOfLastWeek && sessionDate <= endOfLastWeek;
        });
        break;
      case 'thisMonth':
        filtered = sessions.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          return sessionDate && sessionDate.getMonth() === now.getMonth() && 
                 sessionDate.getFullYear() === now.getFullYear();
        });
        break;
      case 'lastMonth': {
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        startOfLastMonth.setHours(0, 0, 0, 0);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
        endOfLastMonth.setHours(23, 59, 59, 999);
        filtered = sessions.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          return sessionDate && sessionDate >= startOfLastMonth && sessionDate <= endOfLastMonth;
        });
        break;
      }
      case 'unpaid':
        filtered = sessions.filter(s => !s.paid);
        break;
      case 'custom':
        if (filterStartDate && filterEndDate) {
          const start = parseLocalDate(filterStartDate);
          const end = parseLocalDate(filterEndDate);
          if (start && end) {
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
            filtered = sessions.filter(s => {
              const sessionDate = parseLocalDate(s.date);
              return sessionDate && sessionDate >= start && sessionDate <= end;
            });
          }
        }
        break;
      default:
        break;
    }
    
    // Apply client filter
    if (filterClientId) {
      filtered = filtered.filter(s => s.clientId === filterClientId);
    }
    
    setFilteredSessions(filtered);
  }, [filter, sessions, filterStartDate, filterEndDate, filterClientId]);
  
  const togglePaid = async (sessionId) => {
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      session.paid = !session.paid;
      session.paidDate = session.paid ? new Date().toISOString() : null;
      await saveSession(session);
    }
  };
  
  const groupByDate = (sessions) => {
    const groups = {};
    sessions.forEach(session => {
      if (!groups[session.date]) {
        groups[session.date] = [];
      }
      groups[session.date].push(session);
    });
    return groups;
  };
  
  const grouped = groupByDate(filteredSessions);
  const dates = Object.keys(grouped).sort((a, b) => new Date(b) - new Date(a));
  
  const exportSessions = async () => {
    const exportData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      sessions: sessions
    };
    const filename = `sessions_backup_${new Date().toISOString().split('T')[0]}.json`;
    const r = await saveJsonToDevice(exportData, filename);
    if (r.aborted) return;
    localStorage.setItem('lastBackupExportDate', new Date().toISOString());
    const where = r.mode === 'picker' ? 'to the folder you chose' : 'check your Downloads folder';
    alert(`Saved ${sessions.length} session(s) as ${filename} (${where}).`);
  };

  const handleImportSessions = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.name.endsWith('.json')) {
      alert('Please select a JSON file');
      return;
    }
    
    try {
      const text = await file.text();
      const importData = JSON.parse(text);
      
      // Validate the import data structure
      if (!importData.sessions || !Array.isArray(importData.sessions)) {
        alert('Invalid file format. Expected a JSON file with a "sessions" array.');
        return;
      }
      
      const importedSessions = importData.sessions;
      const confirmMessage = `This will import ${importedSessions.length} session(s).\n\n` +
        `Existing sessions with the same ID will be updated.\n` +
        `New sessions will be added.\n\n` +
        `Do you want to continue?`;
      
      if (!window.confirm(confirmMessage)) {
        return;
      }
      
      // Import each session
      let importedCount = 0;
      let updatedCount = 0;
      
      for (const sessionData of importedSessions) {
        // Validate required fields
        if (!sessionData.date || !sessionData.clientId) {
          console.warn('Skipping session without required fields:', sessionData);
          continue;
        }
        
        // Ensure session has all required fields
        const sessionToSave = {
          id: sessionData.id || `session-${Date.now()}-${Math.random()}`,
          clientId: sessionData.clientId,
          date: sessionData.date,
          time: sessionData.time || '',
          dayOfWeek: sessionData.dayOfWeek !== undefined ? sessionData.dayOfWeek : new Date(sessionData.date).getDay(),
          cptCode: sessionData.cptCode || '90834',
          duration: sessionData.duration || 45,
          amountCharged: sessionData.amountCharged || 0,
          paid: sessionData.paid || false,
          paidDate: sessionData.paidDate || null,
          notes: sessionData.notes || ''
        };
        
        // Check if session already exists
        const exists = sessions.find(s => s.id === sessionToSave.id);
        if (exists) {
          updatedCount++;
        } else {
          importedCount++;
        }
        
        await saveSession(sessionToSave);
      }
      
      alert(`Import complete!\n\n` +
        `✓ ${importedCount} new session(s) added\n` +
        `✓ ${updatedCount} existing session(s) updated`);
      
      // Reset file input
      event.target.value = '';
    } catch (error) {
      console.error('Error importing sessions:', error);
      alert('Error importing sessions. Please check the file format and try again.');
      event.target.value = '';
    }
  };
  
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '2rem', fontWeight: 700, margin: 0, color: 'white' }}>Sessions</h2>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 1rem',
              border: '2px solid white',
              background: showAddForm ? 'white' : 'transparent',
              color: showAddForm ? '#667eea' : 'white',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '0.9rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
            title="Add new session"
          >
            <Plus size={16} />
            {showAddForm ? 'Cancel' : 'Add Session'}
          </button>
          <button
            onClick={exportSessions}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 1rem',
              border: '2px solid white',
              background: 'transparent',
              color: 'white',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '0.9rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
            title="Save sessions backup to your computer (pick folder in Chrome/Edge)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Export
          </button>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 1rem',
              border: '2px solid white',
              background: 'transparent',
              color: 'white',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '0.9rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
            title="Import sessions from backup"
          >
            <input
              type="file"
              accept=".json"
              onChange={handleImportSessions}
              style={{ display: 'none' }}
            />
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="17 8 12 3 7 8"></polyline>
              <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
            Import
          </label>
          <button
            onClick={clearAllSessions}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.5rem 1rem',
              border: '2px solid #ef4444',
              background: 'transparent',
              color: '#ef4444',
              borderRadius: '8px',
              cursor: 'pointer',
              fontSize: '0.9rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
            title="Delete all sessions"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
            Clear All
          </button>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {[
            { id: 'today', label: 'Today' },
            { id: 'thisWeek', label: 'This Week' },
            { id: 'lastWeek', label: 'Last Week' },
            { id: 'thisMonth', label: 'This Month' },
            { id: 'lastMonth', label: 'Last Month' },
            { id: 'custom', label: 'Date range' },
            { id: 'unpaid', label: 'Unpaid' }
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              style={{
                padding: '0.5rem 1rem',
                border: 'none',
                background: filter === id ? 'white' : 'rgba(255, 255, 255, 0.2)',
                color: filter === id ? '#667eea' : 'white',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '0.9rem',
                fontWeight: filter === id ? 600 : 400,
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            >
              {label}
            </button>
          ))}
          {filter === 'custom' && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.5rem' }}>
              <input
                type="date"
                value={filterStartDate}
                onChange={(e) => setFilterStartDate(e.target.value)}
                style={{
                  padding: '0.4rem 0.5rem',
                  border: '2px solid rgba(255,255,255,0.5)',
                  borderRadius: '6px',
                  background: 'rgba(255,255,255,0.15)',
                  color: 'white',
                  fontSize: '0.9rem',
                  fontFamily: '"Space Mono", monospace'
                }}
                title="Start date"
              />
              <span style={{ color: 'white' }}>–</span>
              <input
                type="date"
                value={filterEndDate}
                onChange={(e) => setFilterEndDate(e.target.value)}
                style={{
                  padding: '0.4rem 0.5rem',
                  border: '2px solid rgba(255,255,255,0.5)',
                  borderRadius: '6px',
                  background: 'rgba(255,255,255,0.15)',
                  color: 'white',
                  fontSize: '0.9rem',
                  fontFamily: '"Space Mono", monospace'
                }}
                title="End date"
              />
            </span>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.75rem', color: 'white', fontSize: '0.9rem' }}>
            Client:
            <select
              value={filterClientId}
              onChange={(e) => setFilterClientId(e.target.value)}
              style={{
                padding: '0.4rem 0.5rem',
                border: '2px solid rgba(255,255,255,0.5)',
                borderRadius: '6px',
                background: 'rgba(255,255,255,0.15)',
                color: 'white',
                fontSize: '0.9rem',
                fontFamily: '"Crimson Pro", Georgia, serif',
                minWidth: '140px'
              }}
              title="Filter by client"
            >
              <option value="">All clients</option>
              {clients.filter(c => c.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map(client => (
                <option key={client.id} value={client.id} style={{ color: '#333' }}>{client.name}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      
      {showAddForm && (
        <div className="card" style={{
          background: 'white',
          borderRadius: '16px',
          padding: '2rem',
          marginBottom: '2rem',
          boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
        }}>
          <h3 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '1.5rem' }}>
            Add New Session
          </h3>
          <form onSubmit={async (e) => {
            e.preventDefault();
            if (!newSessionData.clientId || !newSessionData.date) {
              alert('Please select a client and date');
              return;
            }
            
            const client = clients.find(c => c.id === newSessionData.clientId);
            const session = {
              id: `session-${Date.now()}-${Math.random()}`,
              clientId: newSessionData.clientId,
              date: newSessionData.date,
              time: newSessionData.time,
              dayOfWeek: new Date(newSessionData.date).getDay(),
              cptCode: newSessionData.cptCode,
              duration: parseInt(newSessionData.duration) || 45,
              amountCharged: parseFloat(newSessionData.amountCharged) || (client?.rate || 0),
              paid: false,
              paidDate: null,
              notes: newSessionData.notes || ''
            };
            
            try {
              await saveSession(session);
              setNewSessionData({
                clientId: '',
                date: new Date().toISOString().split('T')[0],
                time: '',
                cptCode: '90834',
                duration: 45,
                amountCharged: 0,
                notes: ''
              });
              setShowAddForm(false);
              alert('Session added successfully!');
            } catch (error) {
              console.error('Error adding session:', error);
              alert('Error adding session. Please try again.');
            }
          }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Client *
                </label>
                <select
                  value={newSessionData.clientId}
                  onChange={(e) => {
                    const clientId = e.target.value;
                    const client = clients.find(c => c.id === clientId);
                    setNewSessionData({
                      ...newSessionData,
                      clientId,
                      amountCharged: client?.rate || 0
                    });
                  }}
                  required
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif',
                    background: 'white'
                  }}
                >
                  <option value="">Select client...</option>
                  {clients.filter(c => c.active).sort((a, b) => a.name.localeCompare(b.name)).map(client => (
                    <option key={client.id} value={client.id}>{client.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Date *
                </label>
                <input
                  type="date"
                  value={newSessionData.date}
                  onChange={(e) => setNewSessionData({ ...newSessionData, date: e.target.value })}
                  required
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Time
                </label>
                <input
                  type="time"
                  value={newSessionData.time}
                  onChange={(e) => setNewSessionData({ ...newSessionData, time: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  CPT Code
                </label>
                <select
                  value={newSessionData.cptCode}
                  onChange={(e) => setNewSessionData({ ...newSessionData, cptCode: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif',
                    background: 'white'
                  }}
                >
                  {cptCodes.map(code => (
                    <option key={code.code} value={code.code}>
                      {code.code} - {code.description}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Duration (minutes)
                </label>
                <input
                  type="number"
                  value={newSessionData.duration}
                  onChange={(e) => setNewSessionData({ ...newSessionData, duration: e.target.value })}
                  min="15"
                  step="15"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Amount Charged ($)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={newSessionData.amountCharged}
                  onChange={(e) => setNewSessionData({ ...newSessionData, amountCharged: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Notes
                </label>
                <textarea
                  value={newSessionData.notes}
                  onChange={(e) => setNewSessionData({ ...newSessionData, notes: e.target.value })}
                  rows="3"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif',
                    resize: 'vertical'
                  }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                type="submit"
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  border: 'none',
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  color: 'white',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '1rem',
                  fontWeight: 600,
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              >
                Add Session
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddForm(false);
                  setNewSessionData({
                    clientId: '',
                    date: new Date().toISOString().split('T')[0],
                    time: '',
                    cptCode: '90834',
                    duration: 45,
                    amountCharged: 0,
                    notes: ''
                  });
                }}
                style={{
                  padding: '0.75rem 1.5rem',
                  border: '2px solid #e5e7eb',
                  background: 'white',
                  color: '#666',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '1rem',
                  fontWeight: 600,
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      
      {filteredSessions.length === 0 ? (
        <div className="card" style={{
          background: 'white',
          borderRadius: '16px',
          padding: '4rem 2rem',
          textAlign: 'center',
          boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
        }}>
          <Calendar size={64} style={{ color: '#ccc', marginBottom: '1rem' }} />
          <p style={{ fontSize: '1.25rem', color: '#666' }}>No sessions found for this filter</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          {dates.map(date => (
            <div key={date} className="card" style={{
              background: 'white',
              borderRadius: '16px',
              padding: '1.5rem',
              boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
            }}>
              <h3 style={{
                fontSize: '1.25rem',
                fontWeight: 600,
                marginBottom: '1rem',
                color: '#667eea',
                borderBottom: '2px solid #f0f0f0',
                paddingBottom: '0.5rem'
              }}>
                {(() => {
                  // Parse date manually to avoid timezone issues
                  const [year, month, day] = date.split('-').map(Number);
                  const dateObj = new Date(year, month - 1, day);
                  return dateObj.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                })()}
              </h3>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {grouped[date].map((session, idx) => {
                  const client = clients.find(c => c.id === session.clientId);
                  const isEditing = editingSessionId === session.id;
                  const editData = isEditing ? editingSessionData : null;
                  return (
                    <div
                      key={session.id}
                      className="session-item"
                      style={{
                        padding: '1rem',
                        background: session.paid ? '#f0fdf4' : '#fef2f2',
                        borderRadius: '12px',
                        border: `2px solid ${isEditing ? '#667eea' : session.paid ? '#86efac' : '#fecaca'}`,
                        animationDelay: `${idx * 0.05}s`
                      }}
                    >
                      {isEditing && editData ? (
                        <form onSubmit={async (e) => {
                          e.preventDefault();
                          if (!editData.clientId || !editData.date) {
                            alert('Client and date are required.');
                            return;
                          }
                          const updated = {
                            ...session,
                            clientId: editData.clientId,
                            date: editData.date,
                            time: editData.time || '—',
                            dayOfWeek: parseLocalDate(editData.date)?.getDay() ?? session.dayOfWeek,
                            cptCode: editData.cptCode,
                            duration: parseInt(editData.duration, 10) || 45,
                            amountCharged: parseFloat(editData.amountCharged) || 0,
                            notes: editData.notes || ''
                          };
                          try {
                            await saveSession(updated);
                            setEditingSessionId(null);
                            setEditingSessionData(null);
                          } catch (err) {
                            console.error(err);
                            alert('Failed to save. Please try again.');
                          }
                        }} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: '#555' }}>Client</label>
                            <select
                              value={editData.clientId}
                              onChange={(e) => {
                                const c = clients.find(x => x.id === e.target.value);
                                setEditingSessionData({ ...editData, clientId: e.target.value, amountCharged: c?.rate ?? editData.amountCharged });
                              }}
                              required
                              style={{ width: '100%', padding: '0.5rem', border: '2px solid #e5e7eb', borderRadius: '6px', fontSize: '0.9rem' }}
                            >
                              {clients.filter(c => c.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map(c => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: '#555' }}>Date</label>
                            <input type="date" value={editData.date} onChange={(e) => setEditingSessionData({ ...editData, date: e.target.value })} required style={{ width: '100%', padding: '0.5rem', border: '2px solid #e5e7eb', borderRadius: '6px', fontSize: '0.9rem' }} />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: '#555' }}>Time</label>
                            <input type="text" value={editData.time} onChange={(e) => setEditingSessionData({ ...editData, time: e.target.value })} placeholder="e.g. 10:30 AM or —" style={{ width: '100%', padding: '0.5rem', border: '2px solid #e5e7eb', borderRadius: '6px', fontSize: '0.9rem' }} />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: '#555' }}>CPT Code</label>
                            <select value={editData.cptCode} onChange={(e) => setEditingSessionData({ ...editData, cptCode: e.target.value })} style={{ width: '100%', padding: '0.5rem', border: '2px solid #e5e7eb', borderRadius: '6px', fontSize: '0.9rem' }}>
                              {cptCodes.map(code => (
                                <option key={code.code} value={code.code}>{code.code} - {code.description}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: '#555' }}>Duration (min)</label>
                            <input type="number" min={15} step={15} value={editData.duration} onChange={(e) => setEditingSessionData({ ...editData, duration: e.target.value })} style={{ width: '100%', padding: '0.5rem', border: '2px solid #e5e7eb', borderRadius: '6px', fontSize: '0.9rem' }} />
                          </div>
                          <div>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: '#555' }}>Amount ($)</label>
                            <input type="number" step={0.01} value={editData.amountCharged} onChange={(e) => setEditingSessionData({ ...editData, amountCharged: e.target.value })} style={{ width: '100%', padding: '0.5rem', border: '2px solid #e5e7eb', borderRadius: '6px', fontSize: '0.9rem' }} />
                          </div>
                          <div style={{ gridColumn: '1 / -1' }}>
                            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: '#555' }}>Notes</label>
                            <textarea value={editData.notes} onChange={(e) => setEditingSessionData({ ...editData, notes: e.target.value })} rows={2} style={{ width: '100%', padding: '0.5rem', border: '2px solid #e5e7eb', borderRadius: '6px', fontSize: '0.9rem', resize: 'vertical' }} />
                          </div>
                          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                            <button type="button" onClick={() => { setEditingSessionId(null); setEditingSessionData(null); }} style={{ padding: '0.5rem 1rem', border: '1px solid #d1d5db', background: '#f9fafb', borderRadius: '8px', cursor: 'pointer', fontSize: '0.9rem' }}>Cancel</button>
                            <button type="submit" style={{ padding: '0.5rem 1rem', border: 'none', background: '#667eea', color: 'white', borderRadius: '8px', cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600 }}>Save changes</button>
                          </div>
                        </form>
                      ) : (
                        <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: 1 }}>
                        <div style={{
                          fontFamily: '"Space Mono", monospace',
                          fontSize: '0.9rem',
                          fontWeight: 700,
                          color: '#666',
                          minWidth: '80px'
                        }}>
                          {session.time}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontSize: '1.1rem' }}>
                            {client?.name || 'Unknown Client'}
                          </div>
                          <div style={{ fontSize: '0.9rem', color: '#666', fontFamily: '"Space Mono", monospace' }}>
                            {session.cptCode} · {session.duration} min
                            {session.invoiceSent && (
                              <span style={{ marginLeft: '0.5rem', color: '#166534', fontWeight: 500 }}>
                                · <Mail size={12} style={{ verticalAlign: 'middle', marginRight: '0.15rem' }} /> Invoice sent
                              </span>
                            )}
                          </div>
                        </div>
                        <div style={{
                          fontWeight: 700,
                          fontSize: '1.25rem',
                          color: '#667eea',
                          fontFamily: '"Space Mono", monospace'
                        }}>
                          ${session.amountCharged}
                        </div>
                      </div>
                      
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingSessionId(session.id);
                            setEditingSessionData({
                              clientId: session.clientId,
                              date: session.date,
                              time: session.time || '',
                              cptCode: session.cptCode || '90834',
                              duration: session.duration ?? 45,
                              amountCharged: session.amountCharged ?? 0,
                              notes: session.notes || ''
                            });
                          }}
                          style={{
                            padding: '0.5rem',
                            border: '1px solid #667eea',
                            background: 'white',
                            color: '#667eea',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                          title="Edit session"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button
                          onClick={() => togglePaid(session.id)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem',
                            padding: '0.5rem 1rem',
                            border: 'none',
                            background: session.paid ? '#22c55e' : '#ef4444',
                            color: 'white',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            fontSize: '0.9rem',
                            fontWeight: 600,
                            fontFamily: '"Crimson Pro", Georgia, serif'
                          }}
                        >
                          {session.paid ? (
                            <>
                              <Check size={16} />
                              Paid
                            </>
                          ) : (
                            <>
                              <DollarSign size={16} />
                              Unpaid
                            </>
                          )}
                        </button>
                        <button
                          onClick={async () => {
                            if (window.confirm(`Are you sure you want to delete this session for ${client?.name || 'Unknown Client'}?`)) {
                              try {
                                await deleteSession(session.id);
                                alert('Session deleted successfully');
                              } catch (error) {
                                console.error('Error deleting session:', error);
                                alert('Error deleting session. Please try again.');
                              }
                            }
                          }}
                          style={{
                            padding: '0.5rem',
                            border: 'none',
                            background: '#fee',
                            color: '#ef4444',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                          title="Delete session"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                      </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Import View Component
const VENICE_SCHEDULE_PROMPT = `Can you pull the names and times from this handwritten schedule?

Output only schedule lines:
- Day header like: Monday, March 2
- Appointment line like: 10:30 — Jen
No explanation.`;

const ImportView = ({ clients, sessions, cptCodes, saveSession, saveClient }) => {
  const [photoFile, setPhotoFile] = useState(null);
  const [extractedAppointments, setExtractedAppointments] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [lastVeniceOutput, setLastVeniceOutput] = useState('');
  const [lastVeniceError, setLastVeniceError] = useState('');
  const fileInputRef = useRef(null);

  const fileToDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const callVeniceOCR = async (imageFile) => {
    const apiKey = process.env.REACT_APP_VENICE_API_KEY || '';
    const model = (process.env.REACT_APP_VENICE_MODEL || 'qwen-2.5-vl').trim() || 'qwen-2.5-vl';
    if (!apiKey.trim()) {
      throw new Error('Venice API key not set. Add REACT_APP_VENICE_API_KEY to .env');
    }
    console.log('[Venice] Sending request, model:', model, 'image size:', imageFile.size);
    const dataUrl = await fileToDataUrl(imageFile);
    console.log('[Venice] Prepared image data URL length:', dataUrl ? dataUrl.length : 0);
    const stripThinking = String(process.env.REACT_APP_VENICE_STRIP_THINKING || 'true').toLowerCase() !== 'false';
    console.log('[Venice] Options:', { stripThinking });
    let res;
    try {
      res = await fetch('https://api.venice.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: VENICE_SCHEDULE_PROMPT },
                { type: 'image_url', image_url: { url: dataUrl } }
              ]
            }
          ],
          ...(stripThinking ? {
            venice_parameters: {
              strip_thinking_response: true
            }
          } : {})
        })
      });
      console.log('[Venice] Response received:', res.status, res.statusText);
    } catch (fetchErr) {
      console.error('[Venice] Fetch error (network/CORS?):', fetchErr);
      throw new Error(`Venice request failed: ${fetchErr.message}`);
    }
    const errText = await res.text();
    console.log('[Venice] Raw response length:', errText.length, 'preview:', errText.slice(0, 800));
    if (!res.ok) {
      console.error('[Venice] API error', res.status, res.statusText, errText);
      throw new Error(`Venice API ${res.status}: ${errText.slice(0, 300)}`);
    }
    let data;
    try {
      data = JSON.parse(errText);
    } catch (e) {
      console.error('[Venice] Invalid JSON response:', errText.slice(0, 500));
      throw new Error('Venice returned non-JSON response');
    }
    // --- Robust text extraction: try every known Venice response shape ---
    const extractText = (val) => {
      if (typeof val === 'string') return val.trim();
      if (Array.isArray(val)) {
        return val
          .map(p => {
            if (!p) return '';
            if (typeof p === 'string') return p;
            return p.text ?? p.content ?? '';
          })
          .join('')
          .trim();
      }
      return '';
    };

    let text = '';
    const choice = data?.choices?.[0];
    const finishReason = choice?.finish_reason;
    const msg = choice?.message ?? choice?.delta;

    // Priority 1: message.content (standard OpenAI-compatible path)
    if (!text) text = extractText(msg?.content);
    // Priority 2: message.reasoning_content (reasoning models with strip_thinking off)
    if (!text) text = extractText(msg?.reasoning_content);
    // Priority 3: message.text (some providers)
    if (!text) text = extractText(msg?.text);
    // Priority 4: choice-level text
    if (!text) text = extractText(choice?.text);
    // Priority 5: top-level fields
    if (!text) text = extractText(data?.output);
    if (!text) text = extractText(data?.response);
    if (!text) text = extractText(data?.text);
    if (!text) text = extractText(data?.content);

    // Priority 6: scan ALL choices (some APIs return multiple)
    if (!text && Array.isArray(data?.choices)) {
      for (const c of data.choices) {
        const m = c?.message ?? c?.delta;
        text = extractText(m?.content) || extractText(m?.reasoning_content) || extractText(m?.text) || extractText(c?.text);
        if (text) break;
      }
    }

    if (!text) {
      if (finishReason === 'length') {
        console.error('[Venice] Model hit its token limit (finish_reason: "length") with no content produced.');
      }
      const fullDump = JSON.stringify(data).slice(0, 2000);
      console.error('[Venice] Could not extract text from response. Full dump:', fullDump);
      throw new Error('Unexpected Venice response format');
    }
    console.log('[Venice] Success, output length:', text.length, 'finish_reason:', finishReason, 'preview:', text.slice(0, 200));
    return text.trim();
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) {
      console.log('File selected:', file.name, file.type, file.size);
      setPhotoFile(file);
      processImage(file);
    }
  };
  
  const processImage = async (file) => {
    setIsProcessing(true);
    
    try {
      console.log('Starting image processing...');
      console.log('File details:', { name: file.name, type: file.type, size: file.size });

      const apiKey = (process.env.REACT_APP_VENICE_API_KEY || '').trim();
      if (!apiKey) {
        alert('Venice API key not configured. Add REACT_APP_VENICE_API_KEY to your .env file.');
        setIsProcessing(false);
        return;
      }

      const isHeic = file.name && /\.(heic|heif)$/i.test(file.name);
      let fileForVenice = file;
      if (isHeic) {
        const convertedBlob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.8 });
        fileForVenice = Array.isArray(convertedBlob) ? convertedBlob[0] : convertedBlob;
      }

      const extractedText = await callVeniceOCR(fileForVenice);
      const finalText = getVeniceFinalScheduleText(extractedText);
      console.log('[Venice] Full output:', extractedText);
      console.log('[Venice] Final-only output preview:', finalText.slice(0, 400));
      setLastVeniceOutput(finalText);
      setLastVeniceError('');
      setOcrText(finalText);
      parseOCRText(finalText, clients, sessions);
      setIsProcessing(false);
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.error('[Venice] Failed:', errMsg, err);
      setLastVeniceError(errMsg);
      setLastVeniceOutput('');
      setIsProcessing(false);
      alert(`Venice AI failed: ${errMsg}\n\nCheck the "Venice output / error" section below for details.`);
    }
  };
  
  const parseOCRText = (extractedText, clients, sessions) => {
    try {
      setIsProcessing(true);
      
      const lines = extractedText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
      
      console.log('=== PARSING SCHEDULE TEXT ===');
      console.log('Total lines:', lines.length);
      console.log('Lines:', lines);
      
      // Venice date format: "Monday, March 2" on its own line
      const veniceDateLineRegex = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s*\.?\s*$/i;
      const fullMonthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      const year = new Date().getFullYear();
      
      // Detect all dates
      const detectedDates = [];
      for (const line of lines) {
        const m = line.match(veniceDateLineRegex);
        if (m) {
          const day = parseInt(m[3], 10);
          const monthIdx = fullMonthNames.indexOf(m[2].toLowerCase());
          if (day >= 1 && day <= 31 && monthIdx >= 0) {
            const dateStr = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            if (!detectedDates.includes(dateStr)) {
              detectedDates.push(dateStr);
              console.log('Found date:', m[0], '→', dateStr);
            }
          }
        }
      }
      
      if (detectedDates.length === 0) {
        const fallback = new Date().toISOString().split('T')[0];
        console.log('No dates found, using today:', fallback);
        detectedDates.push(fallback);
      }
      
      const sortedDates = [...detectedDates].sort();
      
      // Skip reasoning/narrative lines from AI output
      const isReasoningLine = (s) => {
        const t = (s || '').trim();
        if (t.length > 120) return true;
        if (/^(the user|let me|looking at|actually|wait[,:]|i can see|i need to|so we|but the|i think|i'll|columns?|row |slot |label|extracted|create client)/i.test(t)) return true;
        return false;
      };
      const isReasoningName = (name) => {
        if (!name || typeof name !== 'string') return true;
        const t = name.trim();
        if (t.length > 35) return true;
        if (/^(the user|let me|looking at|actually|wait|but the|so we|i can|i need|columns?|row |am slot|pm slot|create client|extracted|empty|unclear)/i.test(t)) return true;
        if ((t.split(/\s+/).length > 6) && /[a-z]{4,}/.test(t)) return true;
        return false;
      };
      
      // Parse appointments line by line, tracking current date from day headers
      const appointments = [];
      let currentDate = sortedDates[0];
      let currentDateIndex = 0;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (isReasoningLine(line)) continue;
        
        // Check for date header — switch current date
        const veniceDateMatch = line.match(veniceDateLineRegex);
        if (veniceDateMatch) {
          const day = parseInt(veniceDateMatch[3], 10);
          const monthIdx = fullMonthNames.indexOf(veniceDateMatch[2].toLowerCase());
          if (day >= 1 && day <= 31 && monthIdx >= 0) {
            currentDate = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            currentDateIndex = sortedDates.indexOf(currentDate);
            if (currentDateIndex < 0) {
              sortedDates.push(currentDate);
              sortedDates.sort();
              currentDateIndex = sortedDates.indexOf(currentDate);
            }
            console.log(`✓ Date: ${currentDate} at line ${i + 1}`);
          }
          continue;
        }
        
        // Pattern A: "10:30 — Jen" or "10:30 AM — Jen" or "4:50 — Annie"
        const timeNameMatch = line.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?\s*(?:[—\-–]\s*)?(.+?)(?:\s+(pd|upd|\d+\/\d+))?\s*$/i);
        if (timeNameMatch) {
          let hour = parseInt(timeNameMatch[1]);
          const minutes = parseInt(timeNameMatch[2]);
          const ampm = timeNameMatch[3] ? timeNameMatch[3].toUpperCase() : null;
          let clientName = timeNameMatch[4] ? timeNameMatch[4].trim() : null;
          
          if (clientName) {
            clientName = clientName.replace(/^[—\-–]\s*/, '').trim();
            clientName = clientName.replace(/\s+(pd|upd|\d+\/\d+)$/i, '').trim();
            const nameMatch = clientName.match(/^([A-Za-z][A-Za-z\s&+'.]+)/);
            if (nameMatch) clientName = nameMatch[1].trim();
          }
          
          let hour24;
          if (ampm === 'PM' && hour !== 12) hour24 = hour + 12;
          else if (ampm === 'AM' && hour === 12) hour24 = 0;
          else if (ampm) hour24 = hour;
          else hour24 = hour >= 1 && hour <= 7 ? hour + 12 : hour;
          
          if (clientName && clientName.length > 1 && !isReasoningName(clientName) && hour24 >= 0 && hour24 <= 23) {
            const displayHour = hour24 > 12 ? hour24 - 12 : (hour24 === 0 ? 12 : hour24);
            const period = hour24 >= 12 ? 'PM' : 'AM';
            const startTime = `${displayHour}:${minutes.toString().padStart(2, '0')} ${period}`;
            
            const endMinTotal = hour24 * 60 + minutes + 45;
            const endH24 = Math.floor(endMinTotal / 60);
            const endM = endMinTotal % 60;
            const endDisplay = endH24 > 12 ? endH24 - 12 : (endH24 === 0 ? 12 : endH24);
            const endTime = `${endDisplay}:${endM.toString().padStart(2, '0')} ${endH24 >= 12 ? 'PM' : 'AM'}`;
            
            appointments.push({
              id: Date.now() + Math.random() + appointments.length,
              date: currentDate,
              dayColumn: currentDateIndex,
              startTime, endTime, duration: 45,
              rawText: clientName,
              suggestedClient: null,
              suggestedCPT: '90834',
              confidence: 0.9
            });
            console.log(`✓ ${startTime} - ${clientName} on ${currentDate}`);
            continue;
          }
        }
        
        // Pattern B: "12 Ashton" or "1 — Tess" (hour without minutes)
        const hourNameMatch = line.match(/^(\d{1,2})\s*(AM|PM)?\s*(?:[—\-–]\s*)?([A-Za-z].+?)(?:\s+(pd|upd|\d+\/\d+))?\s*$/i);
        if (hourNameMatch) {
          let hour = parseInt(hourNameMatch[1]);
          const ampmH = hourNameMatch[2] ? hourNameMatch[2].toUpperCase() : null;
          let clientName = hourNameMatch[3] ? hourNameMatch[3].trim() : null;
          
          if (clientName) {
            clientName = clientName.replace(/^[—\-–]\s*/, '').trim();
            clientName = clientName.replace(/\s+(pd|upd|\d+\/\d+)$/i, '').trim();
            const nameMatch = clientName.match(/^([A-Za-z][A-Za-z\s&+'.]+)/);
            if (nameMatch) clientName = nameMatch[1].trim();
          }
          
          let hour24;
          if (ampmH === 'PM' && hour !== 12) hour24 = hour + 12;
          else if (ampmH === 'AM' && hour === 12) hour24 = 0;
          else if (ampmH) hour24 = hour;
          else hour24 = hour >= 1 && hour <= 7 ? hour + 12 : hour;
          
          if (clientName && clientName.length > 1 && !isReasoningName(clientName) && hour24 >= 0 && hour24 <= 23) {
            const displayHour = hour24 > 12 ? hour24 - 12 : (hour24 === 0 ? 12 : hour24);
            const period = hour24 >= 12 ? 'PM' : 'AM';
            const startTime = `${displayHour}:00 ${period}`;
            
            const endMinTotal = hour24 * 60 + 45;
            const endH24 = Math.floor(endMinTotal / 60);
            const endM = endMinTotal % 60;
            const endDisplay = endH24 > 12 ? endH24 - 12 : (endH24 === 0 ? 12 : endH24);
            const endTime = `${endDisplay}:${endM.toString().padStart(2, '0')} ${endH24 >= 12 ? 'PM' : 'AM'}`;
            
            appointments.push({
              id: Date.now() + Math.random() + appointments.length,
              date: currentDate,
              dayColumn: currentDateIndex,
              startTime, endTime, duration: 45,
              rawText: clientName,
              suggestedClient: null,
              suggestedCPT: '90834',
              confidence: 0.8
            });
            console.log(`✓ ${startTime} - ${clientName} on ${currentDate}`);
            continue;
          }
        }
      }
      
      console.log(`\n=== PARSING SUMMARY ===`);
      console.log(`Detected ${detectedDates.length} date(s):`, detectedDates);
      console.log(`Sorted dates:`, sortedDates);
      console.log(`Extracted ${appointments.length} appointment(s)`);
      
      // Group appointments by date for debugging
      const appointmentsByDate = {};
      appointments.forEach(apt => {
        if (!appointmentsByDate[apt.date]) {
          appointmentsByDate[apt.date] = [];
        }
        appointmentsByDate[apt.date].push(apt);
      });
      console.log('\nAppointments by date:');
      Object.keys(appointmentsByDate).sort().forEach(date => {
        console.log(`  ${date}: ${appointmentsByDate[date].length} appointment(s)`);
        appointmentsByDate[date].forEach(apt => {
          console.log(`    - ${apt.startTime} - ${apt.rawText}`);
        });
      });
      
      if (appointments.length === 0) {
        console.warn('⚠️  NO APPOINTMENTS FOUND!');
        console.log('This might mean:');
        console.log('1. The date format isn\'t being recognized');
        console.log('2. The time/name patterns aren\'t matching');
        console.log('3. The text format is different than expected');
        console.log('\nPlease check the console logs above to see what lines were processed.');
      }
      
      // Apply smart matching based on time/day patterns
      console.log('\nApplying smart matching...');
      const matched = appointments.map(apt => {
        const suggestion = suggestClient(apt, clients, sessions);
        // If no match found but we have rawText, we'll show it in the dropdown
        // Don't create a temp client - just keep rawText for the dropdown
        return {
          ...apt,
          suggestedClient: suggestion.suggestedClient,
          confidence: suggestion.suggestedClient ? suggestion.confidence : 0.5,
          reason: suggestion.suggestedClient ? suggestion.reason : 'Extracted from schedule'
        };
      });
      
      console.log('✓ Matching complete. Final appointments:', matched.length);
      console.log('Setting extracted appointments to state...', matched);
      
      setExtractedAppointments(matched);
      setIsProcessing(false);
      
      console.log('State updated. Check UI for appointments.');
    } catch (error) {
      console.error('Parse error:', error);
      setIsProcessing(false);
    }
  };
  
  const handlePasteOCRText = () => {
    if (!ocrText.trim()) {
      alert('Please paste the schedule text first');
      return;
    }
    parseOCRText(ocrText, clients, sessions);
  };
  
  const suggestClient = (appointment, clientList, sessionHistory) => {
    const { rawText, date, startTime } = appointment;
    const dayOfWeek = new Date(date).getDay();
    
    const scores = clientList.map(client => {
      // Text match (40%)
      const textScore = fuzzyMatch(rawText, client.name) * 0.4;
      
      // Time pattern match (30%)
      const pattern = client.timePatterns?.find(p => 
        p.dayOfWeek === dayOfWeek && isWithinHour(p.time, startTime)
      );
      const patternScore = pattern ? Math.min(pattern.frequency / 10, 1) * 0.3 : 0;
      
      // Recent frequency (20%)
      const recentSessions = sessionHistory.filter(s => 
        s.clientId === client.id && isWithinWeeks(s.date, 4)
      );
      const frequencyScore = Math.min(recentSessions.length / 4, 1) * 0.2;
      
      // Day of week pattern (10%)
      const dayMatches = sessionHistory.filter(s => 
        s.clientId === client.id && parseLocalDate(s.date).getDay() === dayOfWeek
      ).length;
      const dayScore = Math.min(dayMatches / 4, 1) * 0.1;
      
      const totalScore = textScore + patternScore + frequencyScore + dayScore;
      
      return {
        client,
        score: totalScore,
        breakdown: { textScore, patternScore, frequencyScore, dayScore }
      };
    });
    
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0];
    
    if (best && best.score >= 0.70) {
      let reason = '';
      const { breakdown } = best;
      if (breakdown.patternScore > 0.2) reason = 'Same time slot';
      else if (breakdown.textScore > 0.3) reason = 'Handwriting match';
      else if (breakdown.frequencyScore > 0.15) reason = 'Recent client';
      
      return {
        suggestedClient: best.client,
        confidence: best.score,
        reason
      };
    }
    
    return { suggestedClient: null, confidence: 0 };
  };
  
  const updateAppointment = (id, updates) => {
    setExtractedAppointments(prev => 
      prev.map(apt => apt.id === id ? { ...apt, ...updates } : apt)
    );
  };
  
  const removeAppointment = (id) => {
    setExtractedAppointments(prev => prev.filter(apt => apt.id !== id));
  };
  
  const saveAllSessions = async () => {
    console.log('Starting to save all sessions');
    console.log('Extracted appointments:', extractedAppointments);
    
    let savedCount = 0;
    
    for (const apt of extractedAppointments) {
      if (!apt.selectedClientId) {
        console.log('Skipping appointment - no client selected:', apt);
        continue;
      }
      
      const client = clients.find(c => c.id === apt.selectedClientId);
      console.log('Found client for appointment:', client);
      
      const session = {
        id: `session-${Date.now()}-${Math.random()}`,
        clientId: apt.selectedClientId,
        date: apt.date,
        time: apt.startTime,
        dayOfWeek: new Date(apt.date).getDay(),
        cptCode: apt.selectedCPT || apt.suggestedCPT,
        duration: apt.duration,
        amountCharged: client?.rate || 0,
        paid: false,
        paidDate: null,
        notes: ''
      };
      
      console.log('Saving session:', session);
      
      try {
        await saveSession(session);
        savedCount++;
        console.log('Session saved successfully, count:', savedCount);
      } catch (error) {
        console.error('Error saving session:', error);
      }
    }
    
    console.log(`Finished saving ${savedCount} sessions`);
    
    setExtractedAppointments([]);
    setPhotoFile(null);
    alert(`${savedCount} session(s) saved successfully!`);
  };
  
  return (
    <div>
      <h2 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '2rem', color: 'white' }}>
        Import Schedule
      </h2>
      
      
      
      
      
      {(lastVeniceOutput || lastVeniceError) ? (
        <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(255,255,255,0.15)', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.3)' }}>
          <div style={{ color: 'white', fontWeight: 600, marginBottom: '0.5rem' }}>Venice output / error</div>
          {lastVeniceError ? (
            <pre style={{ margin: 0, padding: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', color: '#fecaca', fontSize: '0.85rem', overflow: 'auto', maxHeight: '200px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {lastVeniceError}
            </pre>
          ) : null}
          {lastVeniceOutput ? (
            <pre style={{ margin: lastVeniceError ? '0.75rem 0 0' : 0, padding: '0.75rem', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', color: '#bbf7d0', fontSize: '0.85rem', overflow: 'auto', maxHeight: '240px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {lastVeniceOutput}
            </pre>
          ) : null}
        </div>
      ) : null}
      
      {!photoFile && !showTextInput ? (
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
          <button
            onClick={() => fileInputRef.current?.click()}
            style={{
              flex: 1,
              padding: '1rem 2rem',
              border: 'none',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
              borderRadius: '12px',
              cursor: 'pointer',
              fontSize: '1.1rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem'
            }}
          >
            <Camera size={20} />
            Upload Image & Parse Schedule
          </button>
          <button
            onClick={() => setShowTextInput(true)}
            style={{
              flex: 1,
              padding: '1rem 2rem',
              border: '2px solid white',
              background: 'transparent',
              color: 'white',
              borderRadius: '12px',
              cursor: 'pointer',
              fontSize: '1.1rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem'
            }}
          >
            Paste OCR Text
          </button>
        </div>
      ) : null}
      
      {showTextInput && !photoFile ? (
        <div className="card" style={{
          background: 'white',
          borderRadius: '16px',
          padding: '2rem',
          marginBottom: '2rem',
          boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
        }}>
          <h3 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '1rem' }}>
            Paste Schedule Text
          </h3>
          <p style={{ color: '#666', marginBottom: '1rem', fontSize: '0.9rem' }}>
            Paste Venice AI schedule output or any schedule text here. Dates, times, and client names will be extracted automatically.
          </p>
          <textarea
            value={ocrText}
            onChange={(e) => setOcrText(e.target.value)}
            placeholder="Paste schedule text here..."
            style={{
              width: '100%',
              height: '300px',
              padding: '1rem',
              border: '2px solid #e5e7eb',
              borderRadius: '8px',
              fontSize: '1rem',
              fontFamily: '"Space Mono", monospace',
              resize: 'vertical',
              marginBottom: '1rem'
            }}
          />
          <div style={{ display: 'flex', gap: '1rem' }}>
            <button
              onClick={handlePasteOCRText}
              disabled={isProcessing}
              style={{
                flex: 1,
                padding: '0.75rem 1.5rem',
                border: 'none',
                background: isProcessing ? '#ccc' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                borderRadius: '8px',
                cursor: isProcessing ? 'not-allowed' : 'pointer',
                fontSize: '1rem',
                fontWeight: 600,
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            >
              {isProcessing ? 'Processing...' : 'Parse Text & Create Appointments'}
            </button>
            <button
              onClick={() => {
                setShowTextInput(false);
                setOcrText('');
              }}
              style={{
                padding: '0.75rem 1.5rem',
                border: '2px solid #e5e7eb',
                background: 'white',
                color: '#666',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '1rem',
                fontWeight: 600,
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      
      {!photoFile && !showTextInput ? (
        <div className="card" style={{
          background: 'white',
          borderRadius: '16px',
          padding: '4rem 2rem',
          textAlign: 'center',
          boxShadow: '0 10px 30px rgba(0,0,0,0.1)',
          cursor: 'pointer'
        }}
        onClick={() => fileInputRef.current?.click()}
        >
          <Camera size={64} style={{ color: '#667eea', marginBottom: '1rem' }} />
          <h3 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Upload Schedule Photo
          </h3>
          <p style={{ color: '#666', marginBottom: '2rem' }}>
            Take a photo of your handwritten schedule or upload an existing image
          </p>
          <button style={{
            padding: '1rem 2rem',
            border: 'none',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            borderRadius: '12px',
            cursor: 'pointer',
            fontSize: '1.1rem',
            fontWeight: 600,
            fontFamily: '"Crimson Pro", Georgia, serif'
          }}>
            Choose File
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
          />
        </div>
      ) : isProcessing ? (
        <div className="card" style={{
          background: 'white',
          borderRadius: '16px',
          padding: '4rem 2rem',
          textAlign: 'center',
          boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
        }}>
          <Clock size={64} style={{ color: '#667eea', marginBottom: '1rem', animation: 'spin 2s linear infinite' }} />
          <h3 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            Processing Schedule...
          </h3>
          <p style={{ color: '#666' }}>
            Extracting appointments and matching clients
          </p>
        </div>
      ) : (
        <div>
          <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              onClick={() => {
                setPhotoFile(null);
                setExtractedAppointments([]);
              }}
              style={{
                padding: '0.5rem 1rem',
                border: 'none',
                background: 'rgba(255, 255, 255, 0.2)',
                color: 'white',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '0.9rem',
                fontWeight: 600,
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            >
              ← Start Over
            </button>
            
            {extractedAppointments.length > 0 && (
              <button
                onClick={saveAllSessions}
                style={{
                  padding: '0.75rem 1.5rem',
                  border: 'none',
                  background: '#22c55e',
                  color: 'white',
                  borderRadius: '12px',
                  cursor: 'pointer',
                  fontSize: '1rem',
                  fontWeight: 600,
                  fontFamily: '"Crimson Pro", Georgia, serif',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}
              >
                <Check size={20} />
                Save All Sessions ({extractedAppointments.length})
              </button>
            )}
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {extractedAppointments.length === 0 ? (
              <div style={{ 
                padding: '2rem', 
                textAlign: 'center', 
                color: '#666',
                background: 'white',
                borderRadius: '12px'
              }}>
                No appointments found. Try pasting your schedule text again.
              </div>
            ) : (() => {
              // Sort appointments by date, then by time
              const sortedAppointments = [...extractedAppointments].sort((a, b) => {
                // First sort by date
                const dateComparison = a.date.localeCompare(b.date);
                if (dateComparison !== 0) return dateComparison;
                
                // If same date, sort by start time
                // Convert "10:30 AM" to comparable format
                const parseTime = (timeStr) => {
                  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
                  if (!match) return 0;
                  let hour = parseInt(match[1]);
                  const minute = parseInt(match[2]);
                  const period = match[3].toUpperCase();
                  if (period === 'PM' && hour !== 12) hour += 12;
                  if (period === 'AM' && hour === 12) hour = 0;
                  return hour * 60 + minute; // Convert to minutes for easy comparison
                };
                
                return parseTime(a.startTime) - parseTime(b.startTime);
              });
              
              // Group by date for display
              const appointmentsByDate = {};
              sortedAppointments.forEach(apt => {
                if (!appointmentsByDate[apt.date]) {
                  appointmentsByDate[apt.date] = [];
                }
                appointmentsByDate[apt.date].push(apt);
              });
              
              const sortedDates = Object.keys(appointmentsByDate).sort();
              
              return sortedDates.map((date, dateIdx) => (
                <div key={date} style={{ marginBottom: '1.5rem' }}>
                  <h3 style={{
                    fontSize: '1.25rem',
                    fontWeight: 600,
                    color: '#1f2937',
                    marginBottom: '0.75rem',
                    paddingBottom: '0.5rem',
                    borderBottom: '2px solid #e5e7eb',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}>
                    {(() => {
                      // Parse date string and format it nicely
                      const [year, month, day] = date.split('-').map(Number);
                      const dateObj = new Date(year, month - 1, day);
                      return dateObj.toLocaleDateString('en-US', { 
                        weekday: 'long', 
                        month: 'long', 
                        day: 'numeric' 
                      });
                    })()}
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    {appointmentsByDate[date].map((apt, idx) => (
                      <AppointmentCard
                        key={apt.id}
                        appointment={apt}
                        clients={clients}
                        cptCodes={cptCodes}
                        saveClient={saveClient}
                        onUpdate={(updates) => updateAppointment(apt.id, updates)}
                        onRemove={() => removeAppointment(apt.id)}
                        style={{ animationDelay: `${(dateIdx * 10 + idx) * 0.05}s` }}
                      />
                    ))}
                  </div>
                </div>
              ));
            })()}
          </div>
        </div>
      )}
    </div>
  );
};

// Appointment Card Component
const AppointmentCard = ({ appointment, clients, cptCodes, saveClient, onUpdate, onRemove, style }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [isCreatingClient, setIsCreatingClient] = useState(false);
  const [showClientForm, setShowClientForm] = useState(false);
  const [newClientData, setNewClientData] = useState({
    name: '',
    rate: '',
    email: '',
    billingType: 'direct',
    dateOfBirth: '',
    diagnosis: ''
  });
  
  const activeClients = clients.filter(c => c.active).sort((a, b) => a.name.localeCompare(b.name));
  
  const selectedClient = appointment.selectedClientId 
    ? clients.find(c => c.id === appointment.selectedClientId)
    : appointment.suggestedClient;
  
  // Check if extracted name matches an existing client
  const matchingClient = appointment.rawText 
    ? activeClients.find(c => 
        c.name.toLowerCase().trim() === appointment.rawText.toLowerCase().trim() ||
        c.name.toLowerCase().includes(appointment.rawText.toLowerCase().trim()) ||
        appointment.rawText.toLowerCase().trim().includes(c.name.toLowerCase())
      )
    : null;
  
  const handleConfirmExtractedName = async () => {
    if (matchingClient) {
      // If we found a match, select that client
      onUpdate({ selectedClientId: matchingClient.id });
    } else if (appointment.rawText) {
      // If no match, show form to create a new client
      setNewClientData({
        name: appointment.rawText.trim(),
        rate: '',
        email: '',
        billingType: 'direct',
        dateOfBirth: '',
        diagnosis: ''
      });
      setShowClientForm(true);
    }
  };
  
  const handleSaveNewClient = async () => {
    if (!newClientData.name.trim()) {
      alert('Please enter a client name');
      return;
    }
    
    setIsCreatingClient(true);
    try {
      const newClient = {
        id: `client-${Date.now()}-${Math.random()}`,
        name: newClientData.name.trim(),
        // Only include rate if it was entered, otherwise default to 0
        rate: newClientData.rate && newClientData.rate.trim() ? parseFloat(newClientData.rate) : 0,
        // Only include email if it was entered
        email: newClientData.email.trim() || '',
        billingType: newClientData.billingType || 'direct',
        dateOfBirth: newClientData.dateOfBirth || null,
        diagnosis: newClientData.diagnosis || '',
        active: true,
        timePatterns: [],
        sessionCount: 0,
        lastSeen: null
      };
      await saveClient(newClient);
      // Select the newly created client
      onUpdate({ selectedClientId: newClient.id });
      setIsCreatingClient(false);
      setShowClientForm(false);
      setNewClientData({ name: '', rate: '', email: '', billingType: 'direct', dateOfBirth: '', diagnosis: '' });
    } catch (error) {
      console.error('Error creating client:', error);
      alert('Error creating client. Please try again.');
      setIsCreatingClient(false);
    }
  };
  
  const handleCancelClientForm = () => {
    setShowClientForm(false);
    setNewClientData({ name: '', rate: '', email: '', billingType: 'direct' });
  };
    
  const confidenceColor = appointment.confidence >= 0.8 ? '#22c55e' : 
                          appointment.confidence >= 0.7 ? '#f59e0b' : '#ef4444';
  
  return (
    <div className="card" style={{
      background: 'white',
      borderRadius: '16px',
      padding: '1.5rem',
      boxShadow: '0 10px 30px rgba(0,0,0,0.1)',
      ...style
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
            {isEditing ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <input
                  type="time"
                  value={(() => {
                    // Convert "10:30 AM" to "10:30" format for time input
                    const timeStr = appointment.startTime;
                    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
                    if (match) {
                      let hour = parseInt(match[1]);
                      const minute = match[2];
                      const period = match[3].toUpperCase();
                      if (period === 'PM' && hour !== 12) hour += 12;
                      if (period === 'AM' && hour === 12) hour = 0;
                      return `${hour.toString().padStart(2, '0')}:${minute}`;
                    }
                    return '';
                  })()}
                  onChange={(e) => {
                    const [hour24, minute] = e.target.value.split(':').map(Number);
                    const hour12 = hour24 === 0 ? 12 : (hour24 > 12 ? hour24 - 12 : hour24);
                    const period = hour24 >= 12 ? 'PM' : 'AM';
                    const newStartTime = `${hour12}:${minute.toString().padStart(2, '0')} ${period}`;
                    
                    // Calculate new end time based on duration
                    const endMinutes = minute + appointment.duration;
                    const endHour24 = hour24 + Math.floor(endMinutes / 60);
                    const endMinutesFinal = endMinutes % 60;
                    const endHour12 = endHour24 === 0 ? 12 : (endHour24 > 12 ? endHour24 - 12 : endHour24);
                    const endPeriod = endHour24 >= 12 ? 'PM' : 'AM';
                    const newEndTime = `${endHour12}:${endMinutesFinal.toString().padStart(2, '0')} ${endPeriod}`;
                    
                    onUpdate({ startTime: newStartTime, endTime: newEndTime });
                  }}
                  style={{
                    padding: '0.5rem',
                    border: '2px solid #3b82f6',
                    borderRadius: '6px',
                    fontSize: '1rem',
                    fontFamily: '"Space Mono", monospace',
                    width: '120px'
                  }}
                />
                <span style={{ fontSize: '1.25rem', fontWeight: 600 }}>→</span>
                <span style={{ fontSize: '1.25rem', fontWeight: 600 }}>
                  {appointment.endTime}
                </span>
                <span style={{ fontSize: '1rem', color: '#666' }}>
                  ({appointment.duration} min)
                </span>
                <button
                  onClick={() => setIsEditing(false)}
                  style={{
                    padding: '0.5rem 1rem',
                    border: 'none',
                    background: '#22c55e',
                    color: 'white',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                    fontWeight: 600
                  }}
                >
                  <Check size={16} style={{ display: 'inline', marginRight: '0.25rem' }} />
                  Done
                </button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>
                  {appointment.startTime === '—' 
                    ? 'Time TBD' + (appointment.duration ? ` (${appointment.duration} min)` : '')
                    : `${appointment.startTime} → ${appointment.endTime} (${appointment.duration} min)`}
                </div>
                <button
                  onClick={() => setIsEditing(true)}
                  style={{
                    padding: '0.25rem 0.5rem',
                    border: 'none',
                    background: '#f0f9ff',
                    color: '#3b82f6',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem'
                  }}
                  title="Edit time"
                >
                  <Edit2 size={14} />
                </button>
              </>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <label style={{ fontSize: '0.85rem', color: '#666' }}>Date:</label>
            <input
              type="date"
              value={appointment.date}
              onChange={(e) => onUpdate({ date: e.target.value })}
              style={{
                padding: '0.35rem 0.5rem',
                border: '2px solid #e5e7eb',
                borderRadius: '6px',
                fontSize: '0.9rem',
                fontFamily: '"Space Mono", monospace',
                color: '#374151'
              }}
            />
            <span style={{ fontSize: '0.85rem', color: '#9ca3af' }}>
              {(() => {
                const [year, month, day] = appointment.date.split('-').map(Number);
                const dateObj = new Date(year, month - 1, day);
                return dateObj.toLocaleDateString('en-US', { weekday: 'short' });
              })()}
            </span>
          </div>
        </div>
        
        <button
          onClick={onRemove}
          style={{
            padding: '0.5rem',
            border: 'none',
            background: '#fee',
            color: '#ef4444',
            borderRadius: '8px',
            cursor: 'pointer'
          }}
        >
          <Trash2 size={16} />
        </button>
      </div>
      
      {/* Show extracted name with confirm button if not yet selected */}
      {appointment.rawText && !appointment.selectedClientId && !showClientForm && (
        <div style={{
          marginBottom: '1rem',
          padding: '1rem',
          background: matchingClient ? '#f0fdf4' : '#f0f9ff',
          border: `2px solid ${matchingClient ? '#22c55e' : '#3b82f6'}`,
          borderRadius: '8px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem'
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ 
              fontSize: '0.85rem', 
              color: '#666', 
              marginBottom: '0.25rem',
              fontWeight: 600
            }}>
              Extracted Name:
            </div>
            <div style={{ 
              fontSize: '1.1rem', 
              fontWeight: 600,
              color: matchingClient ? '#16a34a' : '#1e40af',
              fontFamily: '"Space Mono", monospace'
            }}>
              {appointment.rawText}
            </div>
            {matchingClient && (
              <div style={{ 
                fontSize: '0.8rem', 
                color: '#16a34a', 
                marginTop: '0.25rem' 
              }}>
                ✓ Matches existing client: {matchingClient.name}
              </div>
            )}
          </div>
          <button
            onClick={handleConfirmExtractedName}
            disabled={isCreatingClient}
            style={{
              padding: '0.75rem 1.5rem',
              border: 'none',
              background: matchingClient ? '#22c55e' : '#3b82f6',
              color: 'white',
              borderRadius: '8px',
              cursor: isCreatingClient ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              opacity: isCreatingClient ? 0.6 : 1
            }}
          >
            <Check size={18} />
            {isCreatingClient ? 'Creating...' : (matchingClient ? 'Confirm' : 'Create Client')}
          </button>
        </div>
      )}
      
      {/* Show client creation form */}
      {showClientForm && (
        <div style={{
          marginBottom: '1rem',
          padding: '1.5rem',
          background: '#f0f9ff',
          border: '2px solid #3b82f6',
          borderRadius: '8px'
        }}>
          <div style={{ 
            fontSize: '1rem', 
            fontWeight: 600, 
            marginBottom: '1rem',
            color: '#1e40af'
          }}>
            Create New Client
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '0.85rem', 
                fontWeight: 600, 
                marginBottom: '0.5rem', 
                color: '#666' 
              }}>
                Client Name *
              </label>
              <input
                type="text"
                value={newClientData.name}
                onChange={(e) => setNewClientData({ ...newClientData, name: e.target.value })}
                placeholder="Enter client name"
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '2px solid #e5e7eb',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              />
            </div>
            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '0.85rem', 
                fontWeight: 600, 
                marginBottom: '0.5rem', 
                color: '#666' 
              }}>
                Rate ($) <span style={{ fontWeight: 400, color: '#999', fontSize: '0.8rem' }}>(optional)</span>
              </label>
              <input
                type="number"
                step="0.01"
                value={newClientData.rate}
                onChange={(e) => setNewClientData({ ...newClientData, rate: e.target.value })}
                placeholder="Can add later"
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '2px solid #e5e7eb',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              />
            </div>
            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '0.85rem', 
                fontWeight: 600, 
                marginBottom: '0.5rem', 
                color: '#666' 
              }}>
                Email <span style={{ fontWeight: 400, color: '#999', fontSize: '0.8rem' }}>(optional)</span>
              </label>
              <input
                type="email"
                value={newClientData.email}
                onChange={(e) => setNewClientData({ ...newClientData, email: e.target.value })}
                placeholder="Can add later"
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '2px solid #e5e7eb',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              />
            </div>
            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '0.85rem', 
                fontWeight: 600, 
                marginBottom: '0.5rem', 
                color: '#666' 
              }}>
                Billing Type <span style={{ fontWeight: 400, color: '#999', fontSize: '0.8rem' }}>(optional)</span>
              </label>
              <select
                value={newClientData.billingType}
                onChange={(e) => setNewClientData({ ...newClientData, billingType: e.target.value })}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '2px solid #e5e7eb',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  fontFamily: '"Crimson Pro", Georgia, serif',
                  background: 'white'
                }}
              >
                <option value="direct">Direct Pay</option>
                <option value="insurance">Insurance</option>
                <option value="sliding">Sliding Scale</option>
              </select>
            </div>
            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '0.85rem', 
                fontWeight: 600, 
                marginBottom: '0.5rem', 
                color: '#666' 
              }}>
                Date of Birth <span style={{ fontWeight: 400, color: '#999', fontSize: '0.8rem' }}>(optional)</span>
              </label>
              <input
                type="date"
                value={newClientData.dateOfBirth}
                onChange={(e) => setNewClientData({ ...newClientData, dateOfBirth: e.target.value })}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '2px solid #e5e7eb',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              />
            </div>
            <div>
              <label style={{ 
                display: 'block', 
                fontSize: '0.85rem', 
                fontWeight: 600, 
                marginBottom: '0.5rem', 
                color: '#666' 
              }}>
                Diagnosis <span style={{ fontWeight: 400, color: '#999', fontSize: '0.8rem' }}>(optional)</span>
              </label>
              <input
                type="text"
                value={newClientData.diagnosis}
                onChange={(e) => setNewClientData({ ...newClientData, diagnosis: e.target.value })}
                placeholder="Can add later"
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '2px solid #e5e7eb',
                  borderRadius: '6px',
                  fontSize: '1rem',
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button
              onClick={handleCancelClientForm}
              disabled={isCreatingClient}
              style={{
                padding: '0.75rem 1.5rem',
                border: '2px solid #e5e7eb',
                background: 'white',
                color: '#666',
                borderRadius: '6px',
                cursor: isCreatingClient ? 'not-allowed' : 'pointer',
                fontSize: '1rem',
                fontWeight: 600,
                fontFamily: '"Crimson Pro", Georgia, serif',
                opacity: isCreatingClient ? 0.6 : 1
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSaveNewClient}
              disabled={isCreatingClient || !newClientData.name.trim()}
              style={{
                padding: '0.75rem 1.5rem',
                border: 'none',
                background: isCreatingClient || !newClientData.name.trim() ? '#94a3b8' : '#3b82f6',
                color: 'white',
                borderRadius: '6px',
                cursor: isCreatingClient || !newClientData.name.trim() ? 'not-allowed' : 'pointer',
                fontSize: '1rem',
                fontWeight: 600,
                fontFamily: '"Crimson Pro", Georgia, serif',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}
            >
              <Check size={18} />
              {isCreatingClient ? 'Creating...' : 'Save Client'}
            </button>
          </div>
        </div>
      )}
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
            Client
          </label>
          <select
            value={appointment.selectedClientId || (appointment.suggestedClient?.id || '')}
            onChange={(e) => {
              onUpdate({ selectedClientId: e.target.value || null });
            }}
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '2px solid #e5e7eb',
              borderRadius: '8px',
              fontSize: '1rem',
              fontFamily: '"Crimson Pro", Georgia, serif',
              background: 'white'
            }}
          >
            <option value="">Select client...</option>
            {activeClients.map(client => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
          {appointment.confidence >= 0.7 && appointment.reason && (
            <div style={{
              marginTop: '0.5rem',
              padding: '0.5rem',
              background: `${confidenceColor}15`,
              borderRadius: '6px',
              fontSize: '0.85rem',
              color: confidenceColor,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <Sparkles size={14} />
              {Math.round(appointment.confidence * 100)}% match · {appointment.reason}
            </div>
          )}
        </div>
        
        <div>
          <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
            CPT Code
          </label>
          <select
            value={appointment.selectedCPT || appointment.suggestedCPT}
            onChange={(e) => onUpdate({ selectedCPT: e.target.value })}
            style={{
              width: '100%',
              padding: '0.75rem',
              border: '2px solid #e5e7eb',
              borderRadius: '8px',
              fontSize: '1rem',
              fontFamily: '"Crimson Pro", Georgia, serif',
              background: 'white'
            }}
          >
            {cptCodes.map(code => (
              <option key={code.code} value={code.code}>
                {code.code} - {code.description}
              </option>
            ))}
          </select>
        </div>
      </div>
      
      {selectedClient && (
        <div style={{
          marginTop: '1rem',
          padding: '1rem',
          background: '#f9fafb',
          borderRadius: '8px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div style={{ fontSize: '0.9rem', color: '#666' }}>
            Amount to bill
          </div>
          <div style={{
            fontSize: '1.5rem',
            fontWeight: 700,
            color: '#667eea',
            fontFamily: '"Space Mono", monospace'
          }}>
            ${selectedClient.rate}
          </div>
        </div>
      )}
    </div>
  );
};

// Clients View Component
const ClientsView = ({ clients, saveClient }) => {
  const [showAddForm, setShowAddForm] = useState(false);
  const [showBulkUpdate, setShowBulkUpdate] = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [bulkUpdateText, setBulkUpdateText] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    fullName: '',
    rate: '',
    email: '',
    billingType: 'direct',
    dateOfBirth: '',
    diagnosis: ''
  });
  
  const activeClients = clients.filter(c => c.active).sort((a, b) => a.name.localeCompare(b.name));
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name || !formData.rate) {
      alert('Please fill in client name and rate');
      return;
    }
    
    const client = {
      id: editingClient?.id || `client-${Date.now()}-${Math.random()}`,
      name: formData.name.trim(),
      fullName: formData.fullName.trim() || null,
      rate: parseFloat(formData.rate),
      email: formData.email.trim(),
      billingType: formData.billingType,
      dateOfBirth: formData.dateOfBirth || null,
      diagnosis: formData.diagnosis || '',
      active: true,
      timePatterns: editingClient?.timePatterns || [],
      sessionCount: editingClient?.sessionCount || 0,
      lastSeen: editingClient?.lastSeen || null
    };
    
    try {
      await saveClient(client);
      
      setFormData({ name: '', fullName: '', rate: '', email: '', billingType: 'direct', dateOfBirth: '', diagnosis: '' });
      setShowAddForm(false);
      setEditingClient(null);
    } catch (error) {
      console.error('Error saving client:', error);
      alert('Error saving client. Please try again.');
    }
  };
  
  const handleEdit = (client) => {
    setEditingClient(client);
    setFormData({
      name: client.name,
      fullName: client.fullName || '',
      rate: client.rate.toString(),
      email: client.email || '',
      billingType: client.billingType || 'direct',
      dateOfBirth: client.dateOfBirth || '',
      diagnosis: client.diagnosis || ''
    });
    setShowAddForm(true);
  };
  
  const handleArchive = async (client) => {
    client.active = false;
    await saveClient(client);
  };
  
  const exportClients = async () => {
    const exportData = {
      version: '1.0',
      exportDate: new Date().toISOString(),
      clients: clients
    };
    const filename = `clients_backup_${new Date().toISOString().split('T')[0]}.json`;
    const r = await saveJsonToDevice(exportData, filename);
    if (r.aborted) return;
    localStorage.setItem('lastBackupExportDate', new Date().toISOString());
    const where = r.mode === 'picker' ? 'to the folder you chose' : 'check your Downloads folder';
    alert(`Saved ${clients.length} client(s) as ${filename} (${where}).`);
  };

  const exportBulkUpdateTemplate = async () => {
    let csv = 'Name,FullName,Email,DOB,Diagnosis\n';

    activeClients.forEach((client) => {
      const name = client.name;
      const fullName = client.fullName || '';
      const email = client.email || '';
      let dob = '';
      if (client.dateOfBirth) {
        try {
          let date;
          if (typeof client.dateOfBirth === 'string') {
            if (client.dateOfBirth.match(/^\d{4}-\d{2}-\d{2}$/)) {
              const [year, month, day] = client.dateOfBirth.split('-').map(Number);
              date = new Date(year, month - 1, day);
            } else {
              date = new Date(client.dateOfBirth);
            }
          } else {
            date = new Date(client.dateOfBirth);
          }
          if (!isNaN(date.getTime())) {
            dob = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
          }
        } catch (e) {
          dob = String(client.dateOfBirth);
        }
      }
      const diagnosis = client.diagnosis || '';
      csv +=
        [
          formatCsvBulkField(name),
          formatCsvBulkField(fullName),
          formatCsvBulkField(email),
          formatCsvBulkField(dob),
          formatCsvBulkField(diagnosis)
        ].join(',') + '\n';
    });
    
    const filename = `bulk_update_template_${new Date().toISOString().split('T')[0]}.csv`;
    const r = await saveCsvToDevice(csv, filename);
    if (r.aborted) return;
    alert(
      `Saved template with ${activeClients.length} client(s) as ${filename}.\n\n` +
        'Fields with commas are quoted in the CSV so columns stay aligned. ' +
        'Paste back into Bulk Update, or use JSON format to avoid spreadsheet issues.'
    );
  };
  
  const handleImportClients = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!file.name.endsWith('.json')) {
      alert('Please select a JSON file');
      return;
    }
    
    try {
      const text = await file.text();
      const importData = JSON.parse(text);
      
      // Validate the import data structure
      if (!importData.clients || !Array.isArray(importData.clients)) {
        alert('Invalid file format. Expected a JSON file with a "clients" array.');
        return;
      }
      
      const importedClients = importData.clients;
      const confirmMessage = `This will import ${importedClients.length} client(s).\n\n` +
        `Existing clients with the same ID will be updated.\n` +
        `New clients will be added.\n\n` +
        `Do you want to continue?`;
      
      if (!window.confirm(confirmMessage)) {
        return;
      }
      
      // Import each client
      let importedCount = 0;
      let updatedCount = 0;
      
      for (const clientData of importedClients) {
        // Validate required fields
        if (!clientData.name) {
          console.warn('Skipping client without name:', clientData);
          continue;
        }
        
        // Ensure client has all required fields
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
        
        // Check if client already exists
        const exists = clients.find(c => c.id === clientToSave.id);
        if (exists) {
          updatedCount++;
        } else {
          importedCount++;
        }
        
        await saveClient(clientToSave);
      }
      
      alert(`Import complete!\n\n` +
        `✓ ${importedCount} new client(s) added\n` +
        `✓ ${updatedCount} existing client(s) updated`);
      
      // Reset file input
      event.target.value = '';
    } catch (error) {
      console.error('Error importing clients:', error);
      alert('Error importing clients. Please check the file format and try again.');
      event.target.value = '';
    }
  };
  
  const handleBulkUpdate = async () => {
    if (!bulkUpdateText.trim()) {
      alert('Please enter data to update');
      return;
    }

    const looksLikeDobOrDate = (s) => {
      if (!s || typeof s !== 'string') return false;
      const t = s.trim();
      return (
        /^\d{1,4}[-/]\d{1,2}[-/]\d{2,4}$/.test(t) ||
        /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(t)
      );
    };
    const looksLikeEmailCell = (s) =>
      typeof s === 'string' && /^[^\s,]+@[^\s,]+\.[^\s,]+$/.test(s.trim());
    
    try {
      // Parse the bulk update text
      // Support formats:
      // 1. CSV: Name,Email,Diagnosis
      // 2. Simple: Name | Email | Diagnosis (pipe-separated)
      // 3. JSON: [{"name": "...", "email": "...", "diagnosis": "..."}]
      
      let updates = [];
      
      // Try JSON first
      if (bulkUpdateText.trim().startsWith('[') || bulkUpdateText.trim().startsWith('{')) {
        try {
          const jsonData = JSON.parse(bulkUpdateText);
          updates = Array.isArray(jsonData) ? jsonData : [jsonData];
        } catch (e) {
          // Not valid JSON, try CSV/pipe format
        }
      }
      
      // If not JSON, parse as CSV or pipe-separated
      if (updates.length === 0) {
        const lines = bulkUpdateText.split('\n').filter(line => line.trim());
        const firstLine = lines[0].toLowerCase();
        
        // Check if first line is a header
        const hasHeader = firstLine.includes('name') && (firstLine.includes('email') || firstLine.includes('diagnosis'));
        const startIndex = hasHeader ? 1 : 0;
        
        // If header exists, determine column indices
        let nameIndex = -1, fullNameIndex = -1, emailIndex = -1, dobIndex = -1, diagnosisIndex = -1;
        if (hasHeader) {
          const headerParts = parseCsvBulkLine(lines[0]).map((p) => p.toLowerCase());
          nameIndex = headerParts.findIndex(h => h.includes('name') && !h.includes('full'));
          fullNameIndex = headerParts.findIndex(
            h =>
              h.includes('fullname') ||
              (h.includes('full') && h.includes('name') && !h.includes('email'))
          );
          emailIndex = headerParts.findIndex(h => h.includes('email'));
          dobIndex = headerParts.findIndex(
            h =>
              h.includes('dob') ||
              h.includes('dateofbirth') ||
              (h.includes('birth') && h.includes('date'))
          );
          diagnosisIndex = headerParts.findIndex(h => h.includes('diagnosis'));
        }
        
        for (let i = startIndex; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          
          // Pipe | Excel tabs | RFC CSV (quoted commas in diagnosis, etc.)
          let parts;
          if (line.includes('|')) {
            parts = line.split('|').map((p) => p.trim());
          } else if (line.includes('\t')) {
            parts = line.split(/\t+/).map((p) => p.trim());
          } else {
            parts = parseCsvBulkLine(line);
          }
          
          if (parts.length >= 2) {
            let name = parts[0];
            let fullName = '';
            let email = '';
            let diagnosis = '';
            let dateOfBirth = '';
            
            // Use column indices if header exists, otherwise use positional parsing
            if (hasHeader && nameIndex >= 0) {
              // Use header-based column mapping
              if (nameIndex < parts.length) name = parts[nameIndex] || name;
              if (fullNameIndex >= 0 && fullNameIndex < parts.length) fullName = parts[fullNameIndex] || '';
              if (emailIndex >= 0 && emailIndex < parts.length) email = parts[emailIndex] || '';
              if (dobIndex >= 0 && dobIndex < parts.length) dateOfBirth = parts[dobIndex] || '';
              if (diagnosisIndex >= 0 && diagnosisIndex < parts.length) diagnosis = parts[diagnosisIndex] || '';
            } else {
              // No header: infer columns (detect DOB vs email to avoid wrong-field imports)
              if (parts.length >= 5) {
                fullName = parts[1] || '';
                email = parts[2] || '';
                dateOfBirth = parts[3] || '';
                diagnosis = parts[4] || '';
              } else if (parts.length === 4) {
                if (looksLikeDobOrDate(parts[1]) && looksLikeEmailCell(parts[2])) {
                  dateOfBirth = parts[1] || '';
                  email = parts[2] || '';
                  diagnosis = parts[3] || '';
                } else if (looksLikeEmailCell(parts[1]) && looksLikeDobOrDate(parts[2])) {
                  email = parts[1] || '';
                  dateOfBirth = parts[2] || '';
                  diagnosis = parts[3] || '';
                } else {
                  fullName = parts[1] || '';
                  email = parts[2] || '';
                  diagnosis = parts[3] || '';
                }
              } else if (parts.length === 3) {
                if (looksLikeEmailCell(parts[1])) {
                  email = parts[1] || '';
                  diagnosis = parts[2] || '';
                } else if (looksLikeDobOrDate(parts[1]) && looksLikeEmailCell(parts[2])) {
                  dateOfBirth = parts[1] || '';
                  email = parts[2] || '';
                } else {
                  email = parts[1] || '';
                  diagnosis = parts[2] || '';
                }
              } else {
                email = parts[1] || '';
              }
            }
            
            if (name) {
              console.log('Parsed update:', { name, fullName, email, diagnosis, dateOfBirth });
              updates.push({ name, fullName, email, diagnosis, dateOfBirth });
            }
          }
        }
      }
      
      if (updates.length === 0) {
        alert('No valid data found. Please use one of these formats:\n\n' +
          'CSV (quoted fields OK): Name,FullName,Email,DOB,Diagnosis\n' +
          'CSV (simple): Name,Email,Diagnosis\n' +
          'CSV (with DOB): Name,Email,DOB,Diagnosis\n' +
          'Excel: copy rows from sheet (tab-separated) or use Download CSV Template\n' +
          'Pipe: Name | FullName | Email | DOB | Diagnosis\n' +
          'JSON (safest): [{"name":"...","fullName":"...","email":"...","dateOfBirth":"...","diagnosis":"..."}]');
        return;
      }
      
      // Match updates to clients by name (case-insensitive, fuzzy match)
      let updatedCount = 0;
      let createdCount = 0;
      let notFoundCount = 0;
      const notFoundNames = [];
      
      for (const update of updates) {
        // Find matching client (exact match first, then fuzzy)
        let matchedClient = clients.find(c => 
          c.name.toLowerCase().trim() === update.name.toLowerCase().trim()
        );
        
        // If no exact match, try fuzzy match
        if (!matchedClient) {
          matchedClient = clients.find(c => 
            c.name.toLowerCase().includes(update.name.toLowerCase()) ||
            update.name.toLowerCase().includes(c.name.toLowerCase())
          );
        }
        
        if (matchedClient) {
          // Convert DOB string to YYYY-MM-DD format if provided
          let dateOfBirth = matchedClient.dateOfBirth || null;
          if (update.dateOfBirth && update.dateOfBirth.trim()) {
            try {
              const dobStr = update.dateOfBirth.trim();
              console.log('Processing DOB for', update.name, ':', dobStr);
              // Handle formats like "5/16/2003", "3/19/03", "1/31/96"
              if (dobStr.includes('/')) {
                const parts = dobStr.split('/');
                if (parts.length === 3) {
                  let year = parseInt(parts[2]);
                  // Handle 2-digit years (assume 2000s if < 50, 1900s if >= 50)
                  if (year < 100) {
                    year = year < 50 ? 2000 + year : 1900 + year;
                  }
                  const month = parseInt(parts[0]);
                  const day = parseInt(parts[1]);
                  dateOfBirth = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  console.log('Converted DOB to:', dateOfBirth);
                } else {
                  dateOfBirth = dobStr; // Keep as-is if format is unexpected
                }
              } else {
                dateOfBirth = dobStr; // Keep as-is if no slashes
              }
            } catch (e) {
              console.error('Error parsing DOB:', e);
              dateOfBirth = update.dateOfBirth; // Keep original if parsing fails
            }
          }
          
          // Update existing client - always use the new dateOfBirth if provided, even if empty string
          const updatedClient = {
            ...matchedClient,
            fullName: update.fullName || matchedClient.fullName || null,
            email: update.email || matchedClient.email || '',
            diagnosis: update.diagnosis || matchedClient.diagnosis || '',
            dateOfBirth: dateOfBirth !== null ? dateOfBirth : (matchedClient.dateOfBirth || null)
          };
          
          console.log('Updating client:', matchedClient.name, 'with DOB:', updatedClient.dateOfBirth);
          await saveClient(updatedClient);
          updatedCount++;
        } else {
          // Create new client if name is provided
          if (update.name && update.name.trim()) {
            // Convert DOB string to YYYY-MM-DD format if provided
            let dateOfBirth = null;
            if (update.dateOfBirth && update.dateOfBirth.trim()) {
              try {
                const dobStr = update.dateOfBirth.trim();
                // Handle formats like "5/16/2003", "3/19/03", "1/31/96"
                if (dobStr.includes('/')) {
                  const parts = dobStr.split('/');
                  if (parts.length === 3) {
                    let year = parseInt(parts[2]);
                    // Handle 2-digit years (assume 2000s if < 50, 1900s if >= 50)
                    if (year < 100) {
                      year = year < 50 ? 2000 + year : 1900 + year;
                    }
                    const month = parseInt(parts[0]);
                    const day = parseInt(parts[1]);
                    dateOfBirth = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  } else {
                    dateOfBirth = dobStr; // Keep as-is if format is unexpected
                  }
                } else {
                  dateOfBirth = dobStr; // Keep as-is if no slashes
                }
              } catch (e) {
                console.error('Error parsing DOB:', e);
                dateOfBirth = update.dateOfBirth; // Keep original if parsing fails
              }
            }
            
            const newClient = {
              id: `client-${Date.now()}-${Math.random()}`,
              name: update.name.trim(),
              fullName: update.fullName || null,
              rate: 0, // Default rate, can be updated later
              email: update.email || '',
              billingType: 'direct',
              active: true,
              timePatterns: [],
              sessionCount: 0,
              lastSeen: null,
              dateOfBirth: dateOfBirth,
              diagnosis: update.diagnosis || ''
            };
            
            await saveClient(newClient);
            createdCount++;
          } else {
            notFoundCount++;
            notFoundNames.push(update.name || 'Unknown');
          }
        }
      }
      
      let message = `Bulk update complete!\n\n` +
        `✓ ${updatedCount} client(s) updated`;
      
      if (createdCount > 0) {
        message += `\n✓ ${createdCount} new client(s) created`;
      }
      
      if (notFoundCount > 0) {
        message += `\n⚠ ${notFoundCount} entry(ies) skipped (missing name): ${notFoundNames.slice(0, 5).join(', ')}${notFoundNames.length > 5 ? '...' : ''}`;
      }
      
      alert(message);
      
      // Clear the form
      setBulkUpdateText('');
      setShowBulkUpdate(false);
      
    } catch (error) {
      console.error('Error in bulk update:', error);
      alert('Error updating clients. Please check the format and try again.');
    }
  };
  
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '2rem', fontWeight: 700, margin: 0, color: 'white' }}>
          Clients ({activeClients.length})
        </h2>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            onClick={exportClients}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1.5rem',
              border: '2px solid white',
              background: 'transparent',
              color: 'white',
              borderRadius: '12px',
              cursor: 'pointer',
              fontSize: '1rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
            title="Download clients backup"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Export Clients
          </button>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1.5rem',
              border: '2px solid white',
              background: 'transparent',
              color: 'white',
              borderRadius: '12px',
              cursor: 'pointer',
              fontSize: '1rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
            title="Import clients from backup"
          >
            <input
              type="file"
              accept=".json"
              onChange={handleImportClients}
              style={{ display: 'none' }}
            />
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="17 8 12 3 7 8"></polyline>
              <line x1="12" y1="3" x2="12" y2="15"></line>
            </svg>
            Import Clients
          </label>
          <button
            onClick={() => setShowBulkUpdate(!showBulkUpdate)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1.5rem',
              border: '2px solid white',
              background: 'transparent',
              color: 'white',
              borderRadius: '12px',
              cursor: 'pointer',
              fontSize: '1rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
            title="Bulk update emails and diagnoses"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
            Bulk Update
          </button>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1.5rem',
              border: 'none',
              background: 'white',
              color: '#667eea',
              borderRadius: '12px',
              cursor: 'pointer',
              fontSize: '1rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
          >
            <Plus size={20} />
            Add Client
          </button>
        </div>
      </div>
      
      {showBulkUpdate && (
        <div style={{
          background: 'white',
          borderRadius: '16px',
          padding: '2rem',
          marginBottom: '2rem',
          boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
        }}>
          <h3 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '1rem' }}>
            Bulk Update Emails & Diagnoses
          </h3>
          <p style={{ color: '#666', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
            Paste your data in one of these formats. Clients will be matched by name (case-insensitive).
          </p>
          
          <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f8f9fa', borderRadius: '8px', fontSize: '0.85rem' }}>
            <strong>Supported formats:</strong><br/>
            • CSV: <code>Name,FullName,Email,DOB,Diagnosis</code> (FullName and DOB optional)<br/>
            • CSV (simple): <code>Name,Email,Diagnosis</code><br/>
            • CSV (with DOB): <code>Name,Email,DOB,Diagnosis</code><br/>
            • Pipe-separated: <code>Name | FullName | Email | DOB | Diagnosis</code><br/>
            • JSON: <code>{'[{"name": "...", "fullName": "...", "email": "...", "dateOfBirth": "...", "diagnosis": "..."}]'}</code>
            <br/>
            <strong>DOB format:</strong> Use mm/dd/yyyy or mm/dd/yy (e.g., 5/16/2003 or 5/16/03)
            <br/><br/>
            <strong>Note:</strong> New clients will be created automatically if they don't exist.
            <br/><br/>
            <button
              onClick={exportBulkUpdateTemplate}
              style={{
                padding: '0.5rem 1rem',
                border: '1px solid #667eea',
                background: 'white',
                color: '#667eea',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: 600,
                marginTop: '0.5rem'
              }}
            >
              📥 Download CSV Template
            </button>
          </div>
          
          <textarea
            value={bulkUpdateText}
            onChange={(e) => setBulkUpdateText(e.target.value)}
            placeholder={`Example CSV format:\nName,FullName,Email,Diagnosis\nAuri,Abigail Masterson,Carolyn.dunbarmasterso@aol.com,F33.1; F42.9; F84.0\nAbby,Abigail Burgess,lisabethny@aol.com,F41.1; F90.0\n\nOr simple format (FullName optional):\nName,Email,Diagnosis\nAuri,Carolyn.dunbarmasterso@aol.com,F33.1; F42.9; F84.0`}
            style={{
              width: '100%',
              minHeight: '200px',
              padding: '1rem',
              border: '2px solid #e5e7eb',
              borderRadius: '8px',
              fontSize: '0.9rem',
              fontFamily: 'monospace',
              marginBottom: '1rem',
              resize: 'vertical'
            }}
          />
          
          <div style={{ display: 'flex', gap: '1rem' }}>
            <button
              onClick={handleBulkUpdate}
              style={{
                padding: '0.75rem 1.5rem',
                border: 'none',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '1rem',
                fontWeight: 600
              }}
            >
              Update Clients
            </button>
            <button
              onClick={() => {
                setShowBulkUpdate(false);
                setBulkUpdateText('');
              }}
              style={{
                padding: '0.75rem 1.5rem',
                border: '2px solid #e5e7eb',
                background: 'white',
                color: '#666',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '1rem',
                fontWeight: 600
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      
      {showAddForm && (
        <div className="card" style={{
          background: 'white',
          borderRadius: '16px',
          padding: '2rem',
          marginBottom: '2rem',
          boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
        }}>
          <h3 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '1.5rem' }}>
            {editingClient ? 'Edit Client' : 'Add New Client'}
          </h3>
          
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Client Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Enter client name"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}
                />
              </div>
              
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Full Name
                </label>
                <input
                  type="text"
                  value={formData.fullName}
                  onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                  placeholder="Enter full name (optional)"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}
                />
              </div>
              
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Rate (per session) *
                </label>
                <input
                  type="number"
                  value={formData.rate}
                  onChange={(e) => setFormData({ ...formData, rate: e.target.value })}
                  min="0"
                  step="0.01"
                  placeholder="150.00"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}
                />
              </div>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Email
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="client@example.com"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}
                />
              </div>
              
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Billing Type
                </label>
                <select
                  value={formData.billingType}
                  onChange={(e) => setFormData({ ...formData, billingType: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif',
                    background: 'white'
                  }}
                >
                  <option value="direct">Direct Pay</option>
                  <option value="insurance">Insurance</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Date of Birth <span style={{ fontWeight: 400, color: '#999', fontSize: '0.8rem' }}>(optional)</span>
                </label>
                <input
                  type="date"
                  value={formData.dateOfBirth}
                  onChange={(e) => setFormData({ ...formData, dateOfBirth: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                  Diagnosis <span style={{ fontWeight: 400, color: '#999', fontSize: '0.8rem' }}>(optional)</span>
                </label>
                <input
                  type="text"
                  value={formData.diagnosis}
                  onChange={(e) => setFormData({ ...formData, diagnosis: e.target.value })}
                  placeholder="Enter diagnosis"
                  style={{
                    width: '100%',
                    padding: '0.75rem',
                    border: '2px solid #e5e7eb',
                    borderRadius: '8px',
                    fontSize: '1rem',
                    fontFamily: '"Crimson Pro", Georgia, serif'
                  }}
                />
              </div>
            </div>
            
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  console.log('Submit button clicked');
                  console.log('Form data:', formData);
                  await handleSubmit(e);
                }}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  border: 'none',
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  color: 'white',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '1rem',
                  fontWeight: 600,
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              >
                {editingClient ? 'Update Client' : 'Add Client'}
              </button>
              <button
                onClick={() => {
                  console.log('Cancel clicked');
                  setShowAddForm(false);
                  setEditingClient(null);
                  setFormData({ name: '', rate: '', email: '', billingType: 'direct' });
                }}
                style={{
                  padding: '0.75rem 1.5rem',
                  border: '2px solid #e5e7eb',
                  background: 'white',
                  color: '#666',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '1rem',
                  fontWeight: 600,
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '1rem' }}>
        {activeClients.map((client, idx) => (
          <div
            key={client.id}
            className="card"
            style={{
              background: 'white',
              borderRadius: '16px',
              padding: '1.5rem',
              boxShadow: '0 10px 30px rgba(0,0,0,0.1)',
              animationDelay: `${idx * 0.05}s`
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <div>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                  {client.name}
                  {client.fullName && (
                    <span style={{ fontSize: '0.9rem', fontWeight: 400, color: '#666', marginLeft: '0.5rem' }}>
                      ({client.fullName})
                    </span>
                  )}
                </h3>
                <div style={{ fontSize: '0.85rem', color: '#666', fontFamily: '"Space Mono", monospace' }}>
                  {client.billingType === 'insurance' ? '📋 Insurance' : '💳 Direct Pay'}
                </div>
              </div>
              
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  onClick={() => handleEdit(client)}
                  style={{
                    padding: '0.5rem',
                    border: 'none',
                    background: '#f0f0f0',
                    color: '#667eea',
                    borderRadius: '6px',
                    cursor: 'pointer'
                  }}
                >
                  <Edit2 size={14} />
                </button>
                <button
                  onClick={() => handleArchive(client)}
                  style={{
                    padding: '0.5rem',
                    border: 'none',
                    background: '#fee',
                    color: '#ef4444',
                    borderRadius: '6px',
                    cursor: 'pointer'
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            
            <div style={{
              padding: '1rem',
              background: '#f9fafb',
              borderRadius: '8px',
              marginBottom: '1rem'
            }}>
              <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.25rem' }}>
                Session Rate
              </div>
              <div style={{
                fontSize: '1.75rem',
                fontWeight: 700,
                color: '#667eea',
                fontFamily: '"Space Mono", monospace'
              }}>
                ${client.rate}
              </div>
            </div>
            
            <div style={{ fontSize: '0.85rem', color: '#666' }}>
              <div style={{ marginBottom: '0.25rem' }}>
                📧 {client.email || 'No email provided'}
              </div>
              {client.dateOfBirth && (
                <div style={{ marginBottom: '0.25rem' }}>
                  🎂 DOB: {new Date(client.dateOfBirth).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                </div>
              )}
              {client.diagnosis && (
                <div style={{ marginBottom: '0.25rem' }}>
                  🏥 Diagnosis: {client.diagnosis}
                </div>
              )}
              <div>
                📊 {client.sessionCount || 0} sessions
                {client.lastSeen && ` · Last seen ${new Date(client.lastSeen).toLocaleDateString()}`}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// Export View Component
const ExportView = ({ sessions, clients }) => {
  const [dateRange, setDateRange] = useState('lastWeek');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [csvContent, setCsvContent] = useState('');
  const [showCsv, setShowCsv] = useState(false);
  
  const getFilteredSessions = () => {
    const now = new Date();
    let filtered = [...sessions];
    
    console.log(`Total sessions available: ${sessions.length}`);
    
    switch (dateRange) {
      case 'lastWeek':
        const weekAgo = new Date(now);
        weekAgo.setDate(now.getDate() - 7);
        weekAgo.setHours(0, 0, 0, 0);
        filtered = sessions.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          if (!sessionDate) return false;
          sessionDate.setHours(0, 0, 0, 0);
          return sessionDate >= weekAgo;
        });
        break;
      case 'lastMonth':
        const monthAgo = new Date(now);
        monthAgo.setMonth(now.getMonth() - 1);
        monthAgo.setHours(0, 0, 0, 0);
        filtered = sessions.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          if (!sessionDate) return false;
          sessionDate.setHours(0, 0, 0, 0);
          return sessionDate >= monthAgo;
        });
        break;
      case 'custom':
        if (startDate && endDate) {
          const start = new Date(startDate);
          start.setHours(0, 0, 0, 0);
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          filtered = sessions.filter(s => {
            const date = parseLocalDate(s.date);
            if (!date) return false;
            date.setHours(0, 0, 0, 0);
            return date >= start && date <= end;
          });
        }
        break;
      default:
        break;
    }
    
    console.log(`Filtered sessions: ${filtered.length}`);
    
    // Group by client to verify we have multiple sessions per client
    const sessionsByClient = {};
    filtered.forEach(s => {
      if (!sessionsByClient[s.clientId]) {
        sessionsByClient[s.clientId] = [];
      }
      sessionsByClient[s.clientId].push(s);
    });
    
    const clientsWithMultipleSessions = Object.keys(sessionsByClient).filter(
      clientId => sessionsByClient[clientId].length > 1
    );
    console.log(`Clients with multiple sessions: ${clientsWithMultipleSessions.length}`);
    clientsWithMultipleSessions.forEach(clientId => {
      const client = clients.find(c => c.id === clientId);
      console.log(`  - ${client?.name || 'Unknown'}: ${sessionsByClient[clientId].length} sessions`);
    });
    
    // Sort by date, then by time if same date
    return filtered.sort((a, b) => {
      const dateCompare = new Date(a.date) - new Date(b.date);
      if (dateCompare !== 0) return dateCompare;
      // If same date, sort by time
      return (a.time || '').localeCompare(b.time || '');
    });
  };
  
  const exportSimple = () => {
    const filtered = getFilteredSessions();
    
    console.log(`Exporting ${filtered.length} sessions`);
    
    // CSV header matching your exact format
    let csv = 'First Name,Date of Session,Month,Code,Fee\n';
    
    // Process ALL sessions - ensure each session gets its own row
    filtered.forEach((session, index) => {
      const client = clients.find(c => c.id === session.clientId);
      
      // Parse date manually to avoid timezone issues
      const dateStr = typeof session.date === 'string' ? session.date : session.date.toISOString().split('T')[0];
      const [year, monthNum, day] = dateStr.split('-').map(Number);
      const sessionDate = new Date(year, monthNum - 1, day);
      
      // Extract first name only
      const firstName = client?.name?.split(' ')[0] || 'Unknown';
      
      // Format date as MM/DD/YYYY
      const formattedDateStr = `${(sessionDate.getMonth() + 1).toString().padStart(2, '0')}/${sessionDate.getDate().toString().padStart(2, '0')}/${sessionDate.getFullYear()}`;
      
      // Month name for filtering
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const month = monthNames[sessionDate.getMonth()];
      
      // CPT Code with description
      const cptInfo = DEFAULT_CPT_CODES.find(c => c.code === session.cptCode);
      const codeWithDesc = cptInfo ? `${cptInfo.code} - ${cptInfo.description}` : session.cptCode;
      
      // Fee
      const fee = session.amountCharged || 0;
      
      // Add row for this session - each session gets its own row
      csv += `${firstName},${formattedDateStr},${month},"${codeWithDesc}",${fee}\n`;
      
      console.log(`Added session ${index + 1}: ${firstName} on ${formattedDateStr}`);
    });
    
    console.log(`CSV generated with ${filtered.length} rows (plus header)`);
    setCsvContent(csv);
    setShowCsv(true);
  };
  
  const exportDetailed = () => {
    const filtered = getFilteredSessions();
    
    console.log(`Exporting ${filtered.length} sessions (detailed)`);
    
    // Detailed CSV with all fields for reference
    let csv = 'First Name,Last Name,Date of Session,Time,Month,Code,Duration,Fee,Paid,Paid Date,Notes\n';
    
    // Process ALL sessions - ensure each session gets its own row
    filtered.forEach((session, index) => {
      const client = clients.find(c => c.id === session.clientId);
      
      // Parse date manually to avoid timezone issues
      const dateStr = typeof session.date === 'string' ? session.date : session.date.toISOString().split('T')[0];
      const [year, monthNum, day] = dateStr.split('-').map(Number);
      const sessionDate = new Date(year, monthNum - 1, day);
      
      // Split name
      const nameParts = (client?.name || 'Unknown').split(' ');
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || '';
      
      // Format date
      const formattedDateStr = `${(sessionDate.getMonth() + 1).toString().padStart(2, '0')}/${sessionDate.getDate().toString().padStart(2, '0')}/${sessionDate.getFullYear()}`;
      
      // Month name
      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const month = monthNames[sessionDate.getMonth()];
      
      // CPT Code with description
      const cptInfo = DEFAULT_CPT_CODES.find(c => c.code === session.cptCode);
      const codeWithDesc = cptInfo ? `${cptInfo.code} - ${cptInfo.description}` : session.cptCode;
      
      // Paid date if applicable - also parse manually to avoid timezone issues
      let paidDateStr = '';
      if (session.paidDate) {
        const paidDateStrRaw = typeof session.paidDate === 'string' ? session.paidDate : session.paidDate.toISOString().split('T')[0];
        const [paidYear, paidMonth, paidDay] = paidDateStrRaw.split('-').map(Number);
        const paidDateObj = new Date(paidYear, paidMonth - 1, paidDay);
        paidDateStr = `${(paidDateObj.getMonth() + 1).toString().padStart(2, '0')}/${paidDateObj.getDate().toString().padStart(2, '0')}/${paidDateObj.getFullYear()}`;
      }
      
      // Add row for this session - each session gets its own row
      csv += `${firstName},${lastName},${formattedDateStr},${session.time || ''},${month},"${codeWithDesc}",${session.duration || 0},${session.amountCharged || 0},${session.paid ? 'Yes' : 'No'},${paidDateStr},"${(session.notes || '').replace(/"/g, '""')}"\n`;
      
      console.log(`Added session ${index + 1}: ${firstName} ${lastName} on ${formattedDateStr} at ${session.time}`);
    });
    
    console.log(`CSV generated with ${filtered.length} rows (plus header)`);
    setCsvContent(csv);
    setShowCsv(true);
  };
  
  const copyToClipboard = () => {
    navigator.clipboard.writeText(csvContent).then(() => {
      alert('CSV copied to clipboard!');
    }).catch(() => {
      console.log('Copy to clipboard not available, please select and copy manually');
    });
  };
  
  const downloadCSV = async () => {
    const dateRangeStr = dateRange === 'custom' && startDate && endDate 
      ? `${startDate}_to_${endDate}`
      : dateRange;
    const filename = `billing_export_${dateRangeStr}_${new Date().toISOString().split('T')[0]}.csv`;
    const r = await saveCsvToDevice(csvContent, filename);
    if (r.aborted) return;
    const where = r.mode === 'picker' ? 'Saved where you chose.' : 'Saved to your Downloads folder (or your browser’s default).';
    alert(`CSV file saved. ${where} Open it in Excel when ready.`);
  };
  
  const filtered = getFilteredSessions();
  const totalAmount = filtered.reduce((sum, s) => sum + s.amountCharged, 0);
  const paidAmount = filtered.filter(s => s.paid).reduce((sum, s) => sum + s.amountCharged, 0);
  const unpaidAmount = totalAmount - paidAmount;
  
  return (
    <div>
      <h2 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '2rem', color: 'white' }}>
        Export Sessions
      </h2>
      
      <div className="card" style={{
        background: 'white',
        borderRadius: '16px',
        padding: '2rem',
        marginBottom: '2rem',
        boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
      }}>
        <h3 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: '1.5rem' }}>
          Select Date Range
        </h3>
        
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
          {[
            { id: 'lastWeek', label: 'Last Week' },
            { id: 'lastMonth', label: 'Last Month' },
            { id: 'custom', label: 'Custom Range' }
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setDateRange(id)}
              style={{
                padding: '0.75rem 1.5rem',
                border: 'none',
                background: dateRange === id 
                  ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                  : '#f0f0f0',
                color: dateRange === id ? 'white' : '#666',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '1rem',
                fontWeight: dateRange === id ? 600 : 400,
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            >
              {label}
            </button>
          ))}
        </div>
        
        {dateRange === 'custom' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '2px solid #e5e7eb',
                  borderRadius: '8px',
                  fontSize: '1rem',
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: '2px solid #e5e7eb',
                  borderRadius: '8px',
                  fontSize: '1rem',
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              />
            </div>
          </div>
        )}
        
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '1rem',
          padding: '1.5rem',
          background: '#f9fafb',
          borderRadius: '12px',
          marginBottom: '1.5rem'
        }}>
          <div>
            <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.5rem' }}>
              Total Sessions
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 700, color: '#667eea', fontFamily: '"Space Mono", monospace' }}>
              {filtered.length}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.5rem' }}>
              Total Amount
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 700, color: '#667eea', fontFamily: '"Space Mono", monospace' }}>
              ${totalAmount}
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.5rem' }}>
              Unpaid
            </div>
            <div style={{ fontSize: '2rem', fontWeight: 700, color: '#ef4444', fontFamily: '"Space Mono", monospace' }}>
              ${unpaidAmount}
            </div>
          </div>
        </div>
        
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button
            onClick={exportSimple}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              padding: '1rem',
              border: 'none',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
              borderRadius: '12px',
              cursor: 'pointer',
              fontSize: '1.1rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
          >
            <Download size={20} />
            Generate Billing CSV
          </button>
          <button
            onClick={exportDetailed}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              padding: '1rem',
              border: '2px solid #667eea',
              background: 'white',
              color: '#667eea',
              borderRadius: '12px',
              cursor: 'pointer',
              fontSize: '1.1rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
          >
            <Download size={20} />
            Generate Detailed CSV
          </button>
        </div>
      </div>
      
      {showCsv && (
        <div className="card" style={{
          background: 'white',
          borderRadius: '16px',
          padding: '2rem',
          boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>CSV Data</h3>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={downloadCSV}
                style={{
                  padding: '0.5rem 1rem',
                  border: 'none',
                  background: '#3b82f6',
                  color: 'white',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  fontFamily: '"Crimson Pro", Georgia, serif',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                Download CSV File
              </button>
              <button
                onClick={copyToClipboard}
                style={{
                  padding: '0.5rem 1rem',
                  border: 'none',
                  background: '#22c55e',
                  color: 'white',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              >
                Copy to Clipboard
              </button>
              <button
                onClick={() => setShowCsv(false)}
                style={{
                  padding: '0.5rem 1rem',
                  border: '2px solid #e5e7eb',
                  background: 'white',
                  color: '#666',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  fontFamily: '"Crimson Pro", Georgia, serif'
                }}
              >
                Close
              </button>
            </div>
          </div>
          
          <div style={{ 
            background: '#f0f9ff', 
            border: '2px solid #3b82f6', 
            borderRadius: '8px', 
            padding: '1rem', 
            marginBottom: '1rem' 
          }}>
            <div style={{ fontWeight: 600, color: '#1e40af', marginBottom: '0.5rem' }}>
              📥 How to open in Excel:
            </div>
            <ol style={{ margin: 0, paddingLeft: '1.5rem', color: '#1e40af', lineHeight: '1.8' }}>
              <li><strong>Click "Download CSV File"</strong> above to save the file</li>
              <li>Open Excel</li>
              <li>Go to <strong>File → Open</strong> and select the downloaded .csv file</li>
              <li>Excel will automatically format the columns correctly!</li>
            </ol>
            <div style={{ marginTop: '0.75rem', fontSize: '0.9rem', color: '#666' }}>
              <strong>Alternative:</strong> You can also copy the text below and paste it into Excel. When pasting, Excel should automatically detect the columns.
            </div>
          </div>
          
          <textarea
            value={csvContent}
            readOnly
            onClick={(e) => e.target.select()}
            style={{
              width: '100%',
              height: '400px',
              padding: '1rem',
              border: '2px solid #e5e7eb',
              borderRadius: '8px',
              fontFamily: '"Space Mono", monospace',
              fontSize: '0.85rem',
              resize: 'vertical',
              background: '#f9fafb'
            }}
          />
        </div>
      )}
    </div>
  );
};

// Invoicing View Component
const InvoicingView = ({ sessions, clients, saveSession, providerInfo, setProviderInfo }) => {
  const [selectedSessions, setSelectedSessions] = useState([]);
  const [invoicePreview, setInvoicePreview] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [googleUser, setGoogleUser] = useState(null);
  const [filterUnpaid, setFilterUnpaid] = useState(true);
  const [invoiceDateFilter, setInvoiceDateFilter] = useState('lastWeek');
  const [invoiceFilterStartDate, setInvoiceFilterStartDate] = useState('');
  const [invoiceFilterEndDate, setInvoiceFilterEndDate] = useState('');
  const [invoiceFilterClientId, setInvoiceFilterClientId] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [clientPaidStatus, setClientPaidStatus] = useState({}); // Track which clients have paid
  /** sessionId -> true when that line should include the no-show note on the invoice */
  const [invoiceSessionNoShow, setInvoiceSessionNoShow] = useState({});
  /** sessionId -> true when that line should include the late cancel note on the invoice */
  const [invoiceSessionLateCancel, setInvoiceSessionLateCancel] = useState({});
  const signaturePasteRef = useRef(null);
  const googleButtonRef = useRef(null);

  const handleSaveProviderInfo = () => {
    setSaveStatus('saved');
    setTimeout(() => setSaveStatus(''), 2000);
    alert('Provider information saved successfully!');
  };

  
  const handleGoogleSignIn = (response) => {
    if (response.credential) {
      try {
        const payload = JSON.parse(atob(response.credential.split('.')[1]));
        setGoogleUser(payload);
        setIsAuthenticated(true);
      } catch (error) {
        console.error('Error parsing Google sign-in response:', error);
      }
    }
  };
  
  const handleGoogleSignOut = () => {
    if (window.google?.accounts?.id) {
      try {
        window.google.accounts.id.disableAutoSelect();
      } catch (e) {}
    }
    setGoogleUser(null);
    setIsAuthenticated(false);
  };
  
  // Load Google Identity Services and render one-click sign-in button
  useEffect(() => {
    const clientId = process.env.REACT_APP_GOOGLE_CLIENT_ID || '';
    if (!clientId) return;
    
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (!window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: clientId,
        callback: handleGoogleSignIn,
        auto_select: false
      });
      // Render the Sign in with Google button after ref is mounted
      const renderButton = () => {
        if (googleButtonRef.current && !googleButtonRef.current.hasChildNodes()) {
          try {
            window.google.accounts.id.renderButton(googleButtonRef.current, {
              type: 'standard',
              theme: 'outline',
              size: 'large',
              text: 'signin_with',
              shape: 'rectangular',
              width: 280
            });
          } catch (e) {
            console.warn('Google button render:', e);
          }
        }
      };
      renderButton();
      setTimeout(renderButton, 300);
    };
    document.head.appendChild(script);
  }, []);
  
  // Get available sessions for invoicing (unpaid by default, then date + client filters)
  const getAvailableSessions = () => {
    let available = [...sessions];
    
    if (filterUnpaid) {
      available = available.filter(s => !s.paid);
    }
    
    // Date range filter
    const now = new Date();
    switch (invoiceDateFilter) {
      case 'today':
        available = available.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          return sessionDate && sessionDate.toDateString() === now.toDateString();
        });
        break;
      case 'thisWeek': {
        const startOfThisWeek = new Date(now);
        startOfThisWeek.setDate(now.getDate() - now.getDay());
        startOfThisWeek.setHours(0, 0, 0, 0);
        const endOfThisWeek = new Date(startOfThisWeek);
        endOfThisWeek.setDate(startOfThisWeek.getDate() + 6);
        endOfThisWeek.setHours(23, 59, 59, 999);
        available = available.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          return sessionDate && sessionDate >= startOfThisWeek && sessionDate <= endOfThisWeek;
        });
        break;
      }
      case 'lastWeek': {
        const startOfLastWeek = new Date(now);
        startOfLastWeek.setDate(now.getDate() - now.getDay() - 7);
        startOfLastWeek.setHours(0, 0, 0, 0);
        const endOfLastWeek = new Date(startOfLastWeek);
        endOfLastWeek.setDate(startOfLastWeek.getDate() + 6);
        endOfLastWeek.setHours(23, 59, 59, 999);
        available = available.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          return sessionDate && sessionDate >= startOfLastWeek && sessionDate <= endOfLastWeek;
        });
        break;
      }
      case 'thisMonth':
        available = available.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          return sessionDate && sessionDate.getMonth() === now.getMonth() && sessionDate.getFullYear() === now.getFullYear();
        });
        break;
      case 'lastMonth': {
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        startOfLastMonth.setHours(0, 0, 0, 0);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
        endOfLastMonth.setHours(23, 59, 59, 999);
        available = available.filter(s => {
          const sessionDate = parseLocalDate(s.date);
          return sessionDate && sessionDate >= startOfLastMonth && sessionDate <= endOfLastMonth;
        });
        break;
      }
      case 'custom':
        if (invoiceFilterStartDate && invoiceFilterEndDate) {
          const start = parseLocalDate(invoiceFilterStartDate);
          const end = parseLocalDate(invoiceFilterEndDate);
          if (start && end) {
            start.setHours(0, 0, 0, 0);
            end.setHours(23, 59, 59, 999);
            available = available.filter(s => {
              const sessionDate = parseLocalDate(s.date);
              return sessionDate && sessionDate >= start && sessionDate <= end;
            });
          }
        }
        break;
      default:
        break;
    }
    
    // Client filter
    if (invoiceFilterClientId) {
      available = available.filter(s => s.clientId === invoiceFilterClientId);
    }
    
    // Sort by date descending
    available.sort((a, b) => (parseLocalDate(b.date) || 0) - (parseLocalDate(a.date) || 0));
    
    return available;
  };
  
  const toggleSessionSelection = (sessionId) => {
    setSelectedSessions(prev => {
      if (prev.includes(sessionId)) {
        return prev.filter(id => id !== sessionId);
      } else {
        return [...prev, sessionId];
      }
    });
  };
  
  const selectAllSessions = () => {
    const available = getAvailableSessions();
    setSelectedSessions(available.map(s => s.id));
  };
  
  const clearSelection = () => {
    setSelectedSessions([]);
  };
  
  // Generate invoice preview — group by client first name so same first name = one combined invoice
  const generatePreview = () => {
    if (selectedSessions.length === 0) {
      alert('Please select at least one session to invoice.');
      return;
    }
    
    const sessionsToInvoice = sessions.filter(s => selectedSessions.includes(s.id));
    
    const getFirstName = (client) => {
      const name = (client.fullName || client.name || '').trim();
      if (!name) return 'Unknown';
      const first = name.split(/\s+/)[0];
      return first || 'Unknown';
    };
    
    // Group sessions by first name (combine all sessions for clients with same first name)
    const sessionsByFirstName = {};
    sessionsToInvoice.forEach(session => {
      const client = clients.find(c => c.id === session.clientId);
      if (client) {
        const firstName = getFirstName(client);
        if (!sessionsByFirstName[firstName]) {
          sessionsByFirstName[firstName] = {
            client, // use first client seen for DOB, diagnosis, etc.
            sessions: []
          };
        }
        sessionsByFirstName[firstName].sessions.push(session);
      }
    });
    
    // Sort sessions by date within each group
    Object.keys(sessionsByFirstName).forEach(firstName => {
      sessionsByFirstName[firstName].sessions.sort((a, b) => (parseLocalDate(a.date) || 0) - (parseLocalDate(b.date) || 0));
    });
    
    setInvoicePreview(sessionsByFirstName);
    setInvoiceSessionNoShow({});
    setInvoiceSessionLateCancel({});
    setShowPreview(true);
  };

  const buildInvoiceServiceDescription = (session, noShowMap, lateCancelMap) => {
    const cptCode = session.cptCode || '90837';
    const base = `${cptCode} Individual Therapy ${session.duration || 60} min`;
    const notes = [];
    if (noShowMap[session.id]) notes.push('No show, cannot be billed to insurance');
    if (lateCancelMap[session.id]) notes.push('Late cancel, cannot be billed to insurance');
    if (!notes.length) return base;
    return `${base} — ${notes.join('; ')}`;
  };
  
  // Format invoice HTML for email
  const formatInvoiceHTML = (clientSessions, isPaid = false, sessionNoShow = {}, sessionLateCancel = {}) => {
    const { client, sessions: clientSessionsList } = clientSessions;
    
    // Calculate totals
    const subtotal = clientSessionsList.reduce((sum, s) => sum + (s.amountCharged || 0), 0);
    const grandTotal = subtotal;
    
    // Format date to match template: m/dd/yy (e.g., 7/18/19)
    const formatDate = (dateString) => {
      const date = parseLocalDate(dateString);
      if (!date) return dateString || '';
      const month = date.getMonth() + 1; // 1-12
      const day = date.getDate();
      const year = date.getFullYear().toString().slice(-2); // Last 2 digits
      return `${month}/${day}/${year}`;
    };
    
    // Get month name
    const getMonthName = (dateString) => {
      const date = parseLocalDate(dateString);
      return date ? date.toLocaleDateString('en-US', { month: 'long' }) : '';
    };
    
    // Format DOB - handle both string and Date object
    const formatDOB = (dob) => {
      if (!dob) return 'm/dd/yyyy';
      try {
        // If it's already a date string in YYYY-MM-DD format, parse it
        let date;
        if (typeof dob === 'string') {
          // Check if it's in YYYY-MM-DD format
          if (dob.match(/^\d{4}-\d{2}-\d{2}$/)) {
            const [year, month, day] = dob.split('-').map(Number);
            date = new Date(year, month - 1, day);
          } else if (dob.includes('/')) {
            // Handle M/D/YYYY or MM/DD/YYYY format
            const parts = dob.split('/');
            if (parts.length === 3) {
              date = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
            } else {
              date = new Date(dob);
            }
          } else {
            date = new Date(dob);
          }
        } else {
          date = new Date(dob);
        }
        
        // Check if date is valid
        if (isNaN(date.getTime())) {
          console.log('Invalid date for DOB:', dob);
          return 'm/dd/yyyy';
        }
        
        // Format as mm/dd/yyyy
        const month = date.getMonth() + 1;
        const day = date.getDate();
        const year = date.getFullYear();
        return `${month}/${day}/${year}`;
      } catch (e) {
        console.error('Error formatting DOB:', e, dob);
        return 'm/dd/yyyy';
      }
    };
    
    // Format phone/fax
    const formatPhone = (phone) => {
      if (!phone) return 'xxx-xxx-xxxxx';
      return phone.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
    };
    
    // Format NPI
    const formatNPI = (npi) => {
      if (!npi) return 'xxxxxxxxxx';
      return npi.replace(/(\d{3})(\d{3})(\d{4})/, '$1$2$3');
    };
    
    // Format Tax ID
    const formatTaxId = (taxId) => {
      if (!taxId) return 'xx xxxx xxx';
      // Remove any existing formatting
      const cleaned = taxId.replace(/\s/g, '');
      return cleaned.replace(/(\d{2})(\d{4})(\d{3})/, '$1 $2 $3');
    };
    
    const phoneFax = providerInfo.phone ? 
      (providerInfo.fax ? `Ph: ${formatPhone(providerInfo.phone)} and Fax: ${formatPhone(providerInfo.fax)}` : 
       `Ph: ${formatPhone(providerInfo.phone)}`) : 
      'Ph: and Fax: xxx-xxx-xxxxx';
    
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body {
            font-family: 'Times New Roman', serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
          }
          .provider-header {
            text-align: center;
            margin-bottom: 20px;
          }
          .provider-header p {
            margin: 5px 0;
          }
          .client-info {
            margin: 20px 0;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
          }
          th, td {
            border: 1px solid #ddd;
            padding: 8px;
            text-align: left;
          }
          th {
            background-color: #f2f2f2;
            font-weight: bold;
          }
          .text-right {
            text-align: right;
          }
          .subtotal {
            font-weight: bold;
          }
          .grand-total {
            font-weight: bold;
            font-size: 1.1em;
            margin: 10px 0;
          }
          .payment-note {
            font-style: italic;
            margin: 10px 0;
          }
          .professional-info {
            margin: 20px 0;
          }
          .signature {
            margin-top: 30px;
          }
          .signature-line {
            border-bottom: 1px solid #333;
            width: 200px;
            margin: 20px 0 8px 0;
          }
          .signature-img {
            max-width: 220px;
            max-height: 70px;
            margin-top: 10px;
            display: block;
          }
        </style>
      </head>
      <body>
        <div class="provider-header">
          ${providerInfo.company ? `<p><strong>${providerInfo.company}</strong></p>` : ''}
          <p><strong>${providerInfo.providerName || 'Provider Name'}, Psy.D.</strong></p>
          <p>${providerInfo.email || 'email'}</p>
          <p>${phoneFax}</p>
          <p>${providerInfo.address || 'address'}</p>
        </div>
        
        <div class="client-info">
          <p><strong>Client:</strong> ${client.fullName || client.name || 'Client name'}</p>
          <p><strong>DOB:</strong> ${formatDOB(client.dateOfBirth)}</p>
        </div>
        
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Month</th>
              <th>Service Description</th>
              <th class="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${clientSessionsList.map(session => {
              const description = buildInvoiceServiceDescription(session, sessionNoShow, sessionLateCancel);
              return `
                <tr>
                  <td>${formatDate(session.date)}</td>
                  <td>${getMonthName(session.date)}</td>
                  <td>${description}</td>
                  <td class="text-right">$${session.amountCharged || 0}</td>
                </tr>
              `;
            }).join('')}
            <tr>
              <td colspan="3" class="subtotal text-right">Subtotal:</td>
              <td class="text-right subtotal">$${subtotal.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
        
        <div class="grand-total">
          <p>Grand total = $${grandTotal.toFixed(2)}</p>
        </div>
        
        ${isPaid ? `
        <div class="payment-note">
          <p>*client has paid this balance in full*</p>
        </div>
        ` : ''}
        
        <div class="professional-info">
          <p><strong>Diagnosis:</strong> ${client.diagnosis || 'added from client list'}</p>
          <p><strong>NPI:</strong> ${formatNPI(providerInfo.npi) || 'xxxxxxxxxx'}</p>
          <p><strong>Tax ID:</strong> ${formatTaxId(providerInfo.taxId) || 'xx xxxx xxx'}</p>
        </div>
        
        <div class="signature">
          <p>Sincerely,</p>
          ${providerInfo.signatureImage ? `<img src="${providerInfo.signatureImage}" alt="Signature" class="signature-img" />` : '<div class="signature-line"></div>'}
          <p>${providerInfo.providerName || 'Provider Name'}, Psy.D.</p>
        </div>
      </body>
      </html>
    `;
  };
  
  // Preview invoice in a new window (test mode - doesn't send)
  const previewInvoice = (clientId) => {
    const clientInvoice = invoicePreview[clientId];
    if (!clientInvoice) return;
    
    const isPaid = clientPaidStatus[clientId] || false;
    const htmlContent = formatInvoiceHTML(clientInvoice, isPaid, invoiceSessionNoShow, invoiceSessionLateCancel);
    
    // Open HTML in a new window for preview
    const previewWindow = window.open('', '_blank');
    if (previewWindow) {
      previewWindow.document.write(htmlContent);
      previewWindow.document.close();
      previewWindow.focus();
    } else {
      alert('Please allow pop-ups to preview the invoice.');
    }
  };
  
  // Mark sessions as invoice sent and persist
  const markSessionsInvoiceSent = async (clientInvoice) => {
    if (!saveSession) return;
    const sentDate = new Date().toISOString();
    for (const session of clientInvoice.sessions) {
      const updated = { ...session, invoiceSent: true, invoiceSentDate: sentDate };
      await saveSession(updated);
    }
  };

  // Download invoice as HTML file (test mode - doesn't send)
  const downloadInvoice = async (clientId) => {
    const clientInvoice = invoicePreview[clientId];
    if (!clientInvoice) return;
    
    const client = clientInvoice.client;
    const isPaid = clientPaidStatus[clientId] || false;
    const htmlContent = formatInvoiceHTML(clientInvoice, isPaid, invoiceSessionNoShow, invoiceSessionLateCancel);
    
    const blob = new Blob([htmlContent], { type: 'text/html' });
    const filename = `Invoice_${client.name}_${new Date().toISOString().split('T')[0]}.html`;
    const r = await saveBlobToDevice(blob, filename, {
      description: 'HTML invoice',
      accept: { 'text/html': ['.html'] }
    });
    if (r.aborted) return;
    await markSessionsInvoiceSent(clientInvoice);
    const where = r.mode === 'picker' ? 'saved where you chose' : 'saved (check Downloads)';
    alert(`Invoice for ${client.name} ${where}. Sessions marked as invoice sent.`);
  };
  
  // Base64url encode for Gmail API raw message
  const base64UrlEncode = (str) => {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  // Send invoice via Gmail API (one-click after Google sign-in)
  const sendInvoice = async (clientId) => {
    const clientInvoice = invoicePreview[clientId];
    if (!clientInvoice) return;
    
    const client = clientInvoice.client;
    const toEmail = client.email || '';
    if (!toEmail) {
      alert('Client email is required to send the invoice.');
      return;
    }

    if (!isAuthenticated || !googleUser) {
      alert('Please sign in with Google first (use the button above), then send the invoice.');
      return;
    }

    const clientIdEnv = process.env.REACT_APP_GOOGLE_CLIENT_ID || '';
    if (!clientIdEnv) {
      alert('Gmail send is not configured. Add REACT_APP_GOOGLE_CLIENT_ID to .env and enable Gmail API in Google Cloud Console.');
      return;
    }

    const isPaid = clientPaidStatus[clientId] || false;
    const htmlContent = formatInvoiceHTML(clientInvoice, isPaid, invoiceSessionNoShow, invoiceSessionLateCancel);
    const subject = `Invoice for ${client.fullName || client.name || 'Client'}`;

    return new Promise((resolve, reject) => {
      if (!window.google?.accounts?.oauth2) {
        alert('Google sign-in not loaded. Refresh the page and try again.');
        resolve();
        return;
      }
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientIdEnv,
        scope: 'https://www.googleapis.com/auth/gmail.send',
        callback: async (tokenResponse) => {
          if (!tokenResponse?.access_token) {
            alert('Could not get permission to send email. Please try again.');
            resolve();
            return;
          }
          try {
            const mime = [
              `To: ${toEmail}`,
              `Subject: ${subject}`,
              'MIME-Version: 1.0',
              'Content-Type: text/html; charset=UTF-8',
              '',
              htmlContent
            ].join('\r\n');
            const raw = base64UrlEncode(mime);

            const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${tokenResponse.access_token}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ raw })
            });

            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              throw new Error(err.error?.message || res.statusText || 'Gmail API error');
            }
            await markSessionsInvoiceSent(clientInvoice);
            alert(`Invoice sent to ${toEmail}. Sessions marked as invoice sent.`);
          } catch (err) {
            console.error('Send invoice error:', err);
            alert(`Failed to send: ${err.message || err}. You can still use Download Invoice and attach it manually.`);
          }
          resolve();
        }
      });
      tokenClient.requestAccessToken();
    });
  };
  
  const availableSessions = getAvailableSessions();
  
  return (
    <div>
      <h2 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '2rem', color: 'white' }}>
        Invoicing
      </h2>
      
      {/* One-click Google sign-in for sending invoices */}
      <div className="card" style={{
        background: 'white',
        borderRadius: '16px',
        padding: '1.25rem 2rem',
        marginBottom: '2rem',
        boxShadow: '0 10px 30px rgba(0,0,0,0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '1rem'
      }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: '1.1rem', marginBottom: '0.25rem', color: '#374151' }}>
            Send invoices by email
          </div>
          <div style={{ fontSize: '0.9rem', color: '#6b7280' }}>
            {isAuthenticated
              ? `Signed in as ${googleUser?.email || 'Google account'} — you can use "Send Invoice via Email" below.`
              : 'Sign in with Google once, then send invoices with one click from the preview.'}
          </div>
        </div>
        {isAuthenticated ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: '0.9rem', color: '#166534', fontWeight: 500 }}>✓ Signed in</span>
            <button
              type="button"
              onClick={handleGoogleSignOut}
              style={{
                padding: '0.5rem 1rem',
                border: '1px solid #d1d5db',
                background: '#f9fafb',
                color: '#374151',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '0.9rem'
              }}
            >
              Sign out
            </button>
          </div>
        ) : process.env.REACT_APP_GOOGLE_CLIENT_ID ? (
          <div ref={googleButtonRef} />
        ) : (
          <div style={{ fontSize: '0.9rem', color: '#6b7280', maxWidth: '320px' }}>
            Add <code style={{ background: '#f3f4f6', padding: '0.2rem 0.4rem', borderRadius: '4px' }}>REACT_APP_GOOGLE_CLIENT_ID</code> to a <code style={{ background: '#f3f4f6', padding: '0.2rem 0.4rem', borderRadius: '4px' }}>.env</code> file (see <code>.env.example</code>). Enable Gmail API in Google Cloud Console.
          </div>
        )}
      </div>
      
      {/* Provider Information Form */}
      <div className="card" style={{
        background: 'white',
        borderRadius: '16px',
        padding: '2rem',
        marginBottom: '2rem',
        boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>
            Provider Information
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            {saveStatus === 'saved' && (
              <span style={{ 
                fontSize: '0.85rem', 
                color: '#10b981', 
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem'
              }}>
                <Check size={16} />
                Saved
              </span>
            )}
            <button
              onClick={handleSaveProviderInfo}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.5rem 1rem',
                border: 'none',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '0.9rem',
                fontWeight: 600,
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
              title="Provider info is automatically saved, but you can click here to confirm"
            >
              <Check size={16} />
              Save Provider Info
            </button>
          </div>
        </div>
        <p style={{ 
          fontSize: '0.85rem', 
          color: '#666', 
          marginBottom: '1rem',
          fontStyle: 'italic'
        }}>
          💾 Provider information is automatically saved as you type. Your settings will persist on this device.
        </p>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
          <div>
            <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
              Provider Name (with credentials)
            </label>
            <input
              type="text"
              value={providerInfo.providerName}
              onChange={(e) => setProviderInfo({ ...providerInfo, providerName: e.target.value })}
              placeholder="Provider Name, Psy.D."
              style={{
                width: '100%',
                padding: '0.75rem',
                border: '2px solid #e5e7eb',
                borderRadius: '8px',
                fontSize: '1rem',
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            />
          </div>
          
          <div>
            <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
              Company (optional)
            </label>
            <input
              type="text"
              value={providerInfo.company || ''}
              onChange={(e) => setProviderInfo({ ...providerInfo, company: e.target.value })}
              placeholder="Practice or company name"
              style={{
                width: '100%',
                padding: '0.75rem',
                border: '2px solid #e5e7eb',
                borderRadius: '8px',
                fontSize: '1rem',
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            />
          </div>
          
          <div>
            <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
              Email
            </label>
            <input
              type="email"
              value={providerInfo.email}
              onChange={(e) => setProviderInfo({ ...providerInfo, email: e.target.value })}
              placeholder="provider@example.com"
              style={{
                width: '100%',
                padding: '0.75rem',
                border: '2px solid #e5e7eb',
                borderRadius: '8px',
                fontSize: '1rem',
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            />
          </div>
          
          <div>
            <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
              Phone
            </label>
            <input
              type="tel"
              value={providerInfo.phone}
              onChange={(e) => setProviderInfo({ ...providerInfo, phone: e.target.value })}
              placeholder="xxx-xxx-xxxx"
              style={{
                width: '100%',
                padding: '0.75rem',
                border: '2px solid #e5e7eb',
                borderRadius: '8px',
                fontSize: '1rem',
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            />
          </div>
          
          <div>
            <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
              Fax
            </label>
            <input
              type="tel"
              value={providerInfo.fax}
              onChange={(e) => setProviderInfo({ ...providerInfo, fax: e.target.value })}
              placeholder="xxx-xxx-xxxx"
              style={{
                width: '100%',
                padding: '0.75rem',
                border: '2px solid #e5e7eb',
                borderRadius: '8px',
                fontSize: '1rem',
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            />
          </div>
          
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
              Address
            </label>
            <textarea
              value={providerInfo.address}
              onChange={(e) => setProviderInfo({ ...providerInfo, address: e.target.value })}
              placeholder="Street address, City, State ZIP"
              rows={3}
              style={{
                width: '100%',
                padding: '0.75rem',
                border: '2px solid #e5e7eb',
                borderRadius: '8px',
                fontSize: '1rem',
                fontFamily: '"Crimson Pro", Georgia, serif',
                resize: 'vertical'
              }}
            />
          </div>
          
          <div>
            <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
              NPI
            </label>
            <input
              type="text"
              value={providerInfo.npi}
              onChange={(e) => setProviderInfo({ ...providerInfo, npi: e.target.value })}
              placeholder="xxxxxxxxxx"
              maxLength={10}
              style={{
                width: '100%',
                padding: '0.75rem',
                border: '2px solid #e5e7eb',
                borderRadius: '8px',
                fontSize: '1rem',
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            />
          </div>
          
          <div>
            <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
              Tax ID
            </label>
            <input
              type="text"
              value={providerInfo.taxId}
              onChange={(e) => setProviderInfo({ ...providerInfo, taxId: e.target.value })}
              placeholder="xx xxxx xxx"
              style={{
                width: '100%',
                padding: '0.75rem',
                border: '2px solid #e5e7eb',
                borderRadius: '8px',
                fontSize: '1rem',
                fontFamily: '"Crimson Pro", Georgia, serif'
              }}
            />
          </div>
          
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ display: 'block', fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.5rem', color: '#666' }}>
              Signature (for invoices)
            </label>
            <p style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.5rem' }}>
              Click the box below, then press <strong>Ctrl+V</strong> (Windows) or <strong>Cmd+V</strong> (Mac) to paste your signature image. Or choose a file.
            </p>
            {/* Hidden textarea: focused when box is clicked so Ctrl+V paste is received */}
            <textarea
              ref={signaturePasteRef}
              aria-label="Paste signature image here"
              tabIndex={-1}
              onPaste={(e) => {
                e.preventDefault();
                const items = e.clipboardData?.items ? Array.from(e.clipboardData.items) : [];
                const item = items.find(i => i.type.startsWith('image/'));
                if (item) {
                  const file = item.getAsFile();
                  if (file) {
                    const reader = new FileReader();
                    reader.onload = () => setProviderInfo(prev => ({ ...prev, signatureImage: reader.result }));
                    reader.readAsDataURL(file);
                  }
                }
              }}
              style={{
                position: 'absolute',
                left: '-9999px',
                width: 1,
                height: 1,
                opacity: 0,
                pointerEvents: 'none'
              }}
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => signaturePasteRef.current?.focus()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); signaturePasteRef.current?.focus(); } }}
              style={{
                border: '2px dashed #cbd5e1',
                borderRadius: '8px',
                minHeight: '80px',
                padding: '1rem',
                marginBottom: '0.5rem',
                background: providerInfo.signatureImage ? '#f8fafc' : '#f1f5f9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                outline: 'none'
              }}
            >
              {providerInfo.signatureImage ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                  <img src={providerInfo.signatureImage} alt="Signature" style={{ maxHeight: '60px', maxWidth: '200px' }} />
                  <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Click box then Ctrl+V to replace</span>
                </div>
              ) : (
                <span style={{ color: '#94a3b8', fontSize: '0.9rem' }}>Click this box, then press Ctrl+V to paste signature</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.4rem 0.75rem',
                border: '1px solid #e2e8f0',
                borderRadius: '6px',
                background: '#f8fafc',
                cursor: 'pointer',
                fontSize: '0.9rem'
              }}>
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file && file.type.startsWith('image/')) {
                      const reader = new FileReader();
                      reader.onload = () => setProviderInfo({ ...providerInfo, signatureImage: reader.result });
                      reader.readAsDataURL(file);
                    }
                    e.target.value = '';
                  }}
                />
                Choose image file
              </label>
              {providerInfo.signatureImage && (
                <button
                  type="button"
                  onClick={() => setProviderInfo({ ...providerInfo, signatureImage: '' })}
                  style={{
                    padding: '0.4rem 0.75rem',
                    border: '1px solid #fecaca',
                    background: '#fef2f2',
                    color: '#dc2626',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '0.9rem'
                  }}
                >
                  Clear signature
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {/* Session Selection */}
      <div className="card" style={{
        background: 'white',
        borderRadius: '16px',
        padding: '2rem',
        marginBottom: '2rem',
        boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h3 style={{ fontSize: '1.5rem', fontWeight: 600 }}>
            Select Sessions to Invoice
          </h3>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={filterUnpaid}
                onChange={(e) => setFilterUnpaid(e.target.checked)}
              />
              <span>Show unpaid only</span>
            </label>
            <button
              onClick={selectAllSessions}
              style={{
                padding: '0.5rem 1rem',
                border: '1px solid #667eea',
                background: 'transparent',
                color: '#667eea',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.9rem'
              }}
            >
              Select All
            </button>
            <button
              onClick={clearSelection}
              style={{
                padding: '0.5rem 1rem',
                border: '1px solid #ccc',
                background: 'transparent',
                color: '#666',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.9rem'
              }}
            >
              Clear
            </button>
          </div>
        </div>
        
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
          <span style={{ fontSize: '0.9rem', color: '#666', marginRight: '0.25rem' }}>Date:</span>
          {[
            { id: 'today', label: 'Today' },
            { id: 'thisWeek', label: 'This Week' },
            { id: 'lastWeek', label: 'Last Week' },
            { id: 'thisMonth', label: 'This Month' },
            { id: 'lastMonth', label: 'Last Month' },
            { id: 'custom', label: 'Date range' }
          ].map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setInvoiceDateFilter(id)}
              style={{
                padding: '0.4rem 0.75rem',
                border: 'none',
                background: invoiceDateFilter === id ? '#667eea' : '#e5e7eb',
                color: invoiceDateFilter === id ? 'white' : '#374151',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.85rem',
                fontWeight: invoiceDateFilter === id ? 600 : 400
              }}
            >
              {label}
            </button>
          ))}
          {invoiceDateFilter === 'custom' && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.5rem' }}>
              <input
                type="date"
                value={invoiceFilterStartDate}
                onChange={(e) => setInvoiceFilterStartDate(e.target.value)}
                style={{
                  padding: '0.35rem 0.5rem',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '0.9rem'
                }}
                title="Start date"
              />
              <span style={{ color: '#666' }}>–</span>
              <input
                type="date"
                value={invoiceFilterEndDate}
                onChange={(e) => setInvoiceFilterEndDate(e.target.value)}
                style={{
                  padding: '0.35rem 0.5rem',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '0.9rem'
                }}
                title="End date"
              />
            </span>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '0.75rem', fontSize: '0.9rem', color: '#666' }}>
            Client:
            <select
              value={invoiceFilterClientId}
              onChange={(e) => setInvoiceFilterClientId(e.target.value)}
              style={{
                padding: '0.35rem 0.5rem',
                border: '1px solid #d1d5db',
                borderRadius: '6px',
                background: 'white',
                fontSize: '0.9rem',
                minWidth: '140px'
              }}
              title="Filter by client"
            >
              <option value="">All clients</option>
              {clients.filter(c => c.active !== false).sort((a, b) => a.name.localeCompare(b.name)).map(client => (
                <option key={client.id} value={client.id}>{client.name}</option>
              ))}
            </select>
          </label>
        </div>
        
        {availableSessions.length === 0 ? (
          <p style={{ color: '#666', textAlign: 'center', padding: '2rem' }}>
            No sessions available for invoicing.
          </p>
        ) : (
          <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
            {availableSessions.map(session => {
              const client = clients.find(c => c.id === session.clientId);
              if (!client) return null;
              
              const isSelected = selectedSessions.includes(session.id);
              
              return (
                <label
                  key={session.id}
                  htmlFor={`session-${session.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '1rem',
                    border: `2px solid ${isSelected ? '#667eea' : '#e5e7eb'}`,
                    borderRadius: '8px',
                    marginBottom: '0.5rem',
                    cursor: 'pointer',
                    background: isSelected ? '#f0f4ff' : 'white',
                    transition: 'all 0.2s'
                  }}
                >
                  <input
                    id={`session-${session.id}`}
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {
                      toggleSessionSelection(session.id);
                    }}
                    style={{ marginRight: '1rem', cursor: 'pointer', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                      {client.name}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: '#666' }}>
                      {(parseLocalDate(session.date)?.toLocaleDateString?.()) || session.date} at {session.startTime || session.time || 'N/A'} · 
                      {session.cptCode || 'N/A'} · ${session.amountCharged || 0}
                      {session.paid && <span style={{ color: '#22c55e', marginLeft: '0.5rem' }}>✓ Paid</span>}
                      {session.invoiceSent && (
                        <span style={{ marginLeft: '0.5rem', color: '#166534', fontWeight: 500 }}>
                          <Mail size={12} style={{ verticalAlign: 'middle', marginRight: '0.2rem' }} />
                          Invoice sent
                        </span>
                      )}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
        
        <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>{selectedSessions.length}</strong> session(s) selected
          </div>
          <button
            onClick={generatePreview}
            disabled={selectedSessions.length === 0}
            style={{
              padding: '0.75rem 1.5rem',
              border: 'none',
              background: selectedSessions.length === 0 
                ? '#ccc' 
                : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
              borderRadius: '8px',
              cursor: selectedSessions.length === 0 ? 'not-allowed' : 'pointer',
              fontSize: '1rem',
              fontWeight: 600,
              fontFamily: '"Crimson Pro", Georgia, serif'
            }}
          >
            Generate Invoice Preview
          </button>
        </div>
      </div>
      
      {/* Invoice Preview */}
      {showPreview && invoicePreview && (
        <div className="card" style={{
          background: 'white',
          borderRadius: '16px',
          padding: '2rem',
          marginBottom: '2rem',
          boxShadow: '0 10px 30px rgba(0,0,0,0.1)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h3 style={{ fontSize: '1.5rem', fontWeight: 600 }}>
              Invoice Preview
            </h3>
            <button
              onClick={() => setShowPreview(false)}
              style={{
                padding: '0.5rem',
                border: 'none',
                background: '#f0f0f0',
                borderRadius: '6px',
                cursor: 'pointer'
              }}
            >
              <X size={20} />
            </button>
          </div>
          
          {Object.entries(invoicePreview).map(([clientId, clientInvoice]) => {
            const { client, sessions: clientSessionsList } = clientInvoice;
            const subtotal = clientSessionsList.reduce((sum, s) => sum + (s.amountCharged || 0), 0);
            const grandTotal = subtotal;
            
            const isPaid = clientPaidStatus[clientId] || false;
            
            return (
              <div key={clientId} style={{ marginBottom: '3rem' }}>
                {/* Payment Status Toggle */}
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center',
                  marginBottom: '1rem',
                  padding: '1rem',
                  background: '#f8f9fa',
                  borderRadius: '8px',
                  gap: '1rem',
                  flexWrap: 'wrap'
                }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', flex: '1 1 220px' }}>
                    <label style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '0.5rem',
                      cursor: 'pointer',
                      fontSize: '1rem',
                      fontWeight: 600
                    }}>
                      <input
                        type="checkbox"
                        checked={isPaid}
                        onChange={(e) => {
                          setClientPaidStatus(prev => ({
                            ...prev,
                            [clientId]: e.target.checked
                          }));
                        }}
                        style={{ 
                          width: '18px', 
                          height: '18px', 
                          cursor: 'pointer' 
                        }}
                      />
                      <span>Client has paid this balance in full</span>
                    </label>
                    <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 400, color: '#4b5563', lineHeight: 1.4 }}>
                      Mark <strong>No show</strong> or <strong>Late cancel</strong> per session in the table below; each note is added to that row&apos;s service description on the invoice.
                    </p>
                  </div>
                  {(() => {
                    const sentSessionIds = clientSessionsList.map(s => s.id);
                    const allSent = sentSessionIds.length > 0 && sentSessionIds.every(id => sessions.find(s => s.id === id)?.invoiceSent);
                    const firstSent = sessions.find(s => s.id === clientSessionsList[0]?.id);
                    const sentDate = firstSent?.invoiceSentDate;
                    return allSent && (
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        padding: '0.35rem 0.6rem',
                        background: '#dcfce7',
                        color: '#166534',
                        borderRadius: '6px',
                        fontSize: '0.85rem',
                        fontWeight: 600
                      }}>
                        <Mail size={14} />
                        Invoice sent
                        {sentDate && (
                          <span style={{ fontWeight: 400, opacity: 0.9 }}>
                            {parseLocalDate(sentDate.split('T')[0])?.toLocaleDateString()}
                          </span>
                        )}
                      </span>
                    );
                  })()}
                </div>
                
                {/* Preview matches template layout */}
                <div style={{ 
                  fontFamily: '"Times New Roman", serif',
                  maxWidth: '800px',
                  margin: '0 auto',
                  padding: '20px',
                  border: '1px solid #ddd',
                  borderRadius: '8px',
                  background: '#fafafa'
                }}>
                  {/* Provider Header */}
                  <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                    {providerInfo.company && (
                      <p style={{ margin: '5px 0', fontWeight: 'bold' }}>{providerInfo.company}</p>
                    )}
                    <p style={{ margin: '5px 0', fontWeight: 'bold' }}>
                      {providerInfo.providerName || 'Provider Name'}, Psy.D.
                    </p>
                    <p style={{ margin: '5px 0' }}>{providerInfo.email || 'email'}</p>
                    <p style={{ margin: '5px 0' }}>
                      {providerInfo.phone ? 
                        (providerInfo.fax ? `Ph: ${providerInfo.phone} and Fax: ${providerInfo.fax}` : 
                         `Ph: ${providerInfo.phone}`) : 
                        'Ph: and Fax: xxx-xxx-xxxxx'}
                    </p>
                    <p style={{ margin: '5px 0' }}>{providerInfo.address || 'address'}</p>
                  </div>
                  
                  {/* Client Info */}
                  <div style={{ marginBottom: '20px' }}>
                    <p><strong>Client:</strong> {client.fullName || client.name || 'Client name'}</p>
                    <p><strong>DOB:</strong> {(() => {
                      // Debug: log the client object to see what we have
                      console.log('Client DOB debug:', { client, dateOfBirth: client.dateOfBirth, type: typeof client.dateOfBirth });
                      
                      if (!client.dateOfBirth) {
                        console.log('No dateOfBirth found for client:', client.name);
                        return 'm/dd/yyyy';
                      }
                      
                      try {
                        let date;
                        const dob = client.dateOfBirth;
                        
                        if (typeof dob === 'string') {
                          // Check if it's in YYYY-MM-DD format
                          if (dob.match(/^\d{4}-\d{2}-\d{2}$/)) {
                            const [year, month, day] = dob.split('-').map(Number);
                            date = new Date(year, month - 1, day);
                          } else if (dob.includes('/')) {
                            // Handle M/D/YYYY or MM/DD/YYYY format
                            const parts = dob.split('/');
                            if (parts.length === 3) {
                              date = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
                            } else {
                              date = new Date(dob);
                            }
                          } else {
                            date = new Date(dob);
                          }
                        } else {
                          date = new Date(dob);
                        }
                        
                        if (isNaN(date.getTime())) {
                          console.log('Invalid date for DOB:', dob);
                          return 'm/dd/yyyy';
                        }
                        
                        // Format as mm/dd/yyyy
                        const month = date.getMonth() + 1;
                        const day = date.getDate();
                        const year = date.getFullYear();
                        const formatted = `${month}/${day}/${year}`;
                        console.log('Formatted DOB:', formatted);
                        return formatted;
                      } catch (e) {
                        console.error('Error formatting DOB:', e, client.dateOfBirth);
                        return 'm/dd/yyyy';
                      }
                    })()}</p>
                  </div>
                  
                  {/* Sessions Table */}
                  <table style={{ 
                    width: '100%', 
                    borderCollapse: 'collapse', 
                    marginBottom: '20px',
                    border: '1px solid #ddd'
                  }}>
                    <thead>
                      <tr style={{ background: '#f2f2f2' }}>
                        <th style={{ border: '1px solid #ddd', padding: '8px', textAlign: 'left' }}>Date</th>
                        <th style={{ border: '1px solid #ddd', padding: '8px', textAlign: 'left' }}>Month</th>
                        <th style={{ border: '1px solid #ddd', padding: '8px', textAlign: 'left' }}>Service Description</th>
                        <th style={{ border: '1px solid #ddd', padding: '8px', textAlign: 'right' }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clientSessionsList.map(session => {
                        const date = parseLocalDate(session.date);
                        const sid = session.id;
                        const description = buildInvoiceServiceDescription(
                          session,
                          invoiceSessionNoShow,
                          invoiceSessionLateCancel
                        );
                        const toggleNoShow = () => {
                          if (sid == null) return;
                          setInvoiceSessionNoShow((prev) => ({ ...prev, [sid]: !prev[sid] }));
                        };
                        const toggleLateCancel = () => {
                          if (sid == null) return;
                          setInvoiceSessionLateCancel((prev) => ({ ...prev, [sid]: !prev[sid] }));
                        };
                        return (
                          <tr key={sid ?? `${session.clientId}-${session.date}-${session.time}`}>
                            <td style={{ border: '1px solid #ddd', padding: '8px' }}>
                              {date ? date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }) : session.date}
                            </td>
                            <td style={{ border: '1px solid #ddd', padding: '8px' }}>
                              {date ? date.toLocaleDateString('en-US', { month: 'long' }) : ''}
                            </td>
                            <td style={{ border: '1px solid #ddd', padding: '8px', verticalAlign: 'top' }}>
                              <div style={{ fontFamily: '"Times New Roman", serif', marginBottom: '8px' }}>{description}</div>
                              {sid != null && (
                                <div
                                  style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: '10px 14px',
                                    fontSize: '0.8rem',
                                    fontWeight: 600,
                                    fontFamily: '"Crimson Pro", Georgia, serif'
                                  }}
                                >
                                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                    <input
                                      type="checkbox"
                                      checked={!!invoiceSessionNoShow[sid]}
                                      onChange={toggleNoShow}
                                      style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                                    />
                                    <span>No show, cannot be billed to insurance</span>
                                  </label>
                                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                                    <input
                                      type="checkbox"
                                      checked={!!invoiceSessionLateCancel[sid]}
                                      onChange={toggleLateCancel}
                                      style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                                    />
                                    <span>Late cancel, cannot be billed to insurance</span>
                                  </label>
                                </div>
                              )}
                            </td>
                            <td style={{ border: '1px solid #ddd', padding: '8px', textAlign: 'right' }}>
                              ${session.amountCharged || 0}
                            </td>
                          </tr>
                        );
                      })}
                      <tr>
                        <td colSpan="3" style={{ border: '1px solid #ddd', padding: '8px', textAlign: 'right', fontWeight: 'bold' }}>
                          Subtotal:
                        </td>
                        <td style={{ border: '1px solid #ddd', padding: '8px', textAlign: 'right', fontWeight: 'bold' }}>
                          ${subtotal.toFixed(2)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  
                  {/* Grand Total */}
                  <div style={{ marginBottom: '10px', fontWeight: 'bold', fontSize: '1.1em' }}>
                    <p>Grand total = ${grandTotal.toFixed(2)}</p>
                  </div>
                  
                  {/* Payment Note - Only show if toggle is on */}
                  {clientPaidStatus[clientId] && (
                    <div style={{ fontStyle: 'italic', marginBottom: '20px' }}>
                      <p>*client has paid this balance in full*</p>
                    </div>
                  )}
                  
                  {/* Professional Info */}
                  <div style={{ marginBottom: '20px' }}>
                    <p><strong>Diagnosis:</strong> {client.diagnosis || 'added from client list'}</p>
                    <p><strong>NPI:</strong> {providerInfo.npi || 'xxxxxxxxxx'}</p>
                    <p><strong>Tax ID:</strong> {providerInfo.taxId || 'xx xxxx xxx'}</p>
                  </div>
                  
                  {/* Signature */}
                  <div style={{ marginTop: '30px' }}>
                    <p>Sincerely,</p>
                    {providerInfo.signatureImage ? (
                      <img src={providerInfo.signatureImage} alt="Signature" style={{ maxWidth: '220px', maxHeight: '70px', marginTop: '10px', display: 'block' }} />
                    ) : (
                      <div style={{ borderBottom: '1px solid #333', width: '200px', margin: '20px 0 8px 0' }} />
                    )}
                    <p>{providerInfo.providerName || 'Provider Name'}, Psy.D.</p>
                  </div>
                </div>
                
                {/* Action Buttons */}
                <div style={{ 
                  display: 'flex', 
                  gap: '1rem', 
                  justifyContent: 'center', 
                  flexWrap: 'wrap',
                  marginTop: '2rem' 
                }}>
                  <button
                    onClick={() => previewInvoice(clientId)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.75rem 1.5rem',
                      border: '2px solid #667eea',
                      background: 'white',
                      color: '#667eea',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '1rem',
                      fontWeight: 600,
                      fontFamily: '"Crimson Pro", Georgia, serif'
                    }}
                    title="Preview invoice in a new window (test mode)"
                  >
                    <FileText size={18} />
                    Preview Invoice
                  </button>
                  
                  <button
                    onClick={() => downloadInvoice(clientId)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.75rem 1.5rem',
                      border: '2px solid #667eea',
                      background: 'white',
                      color: '#667eea',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      fontSize: '1rem',
                      fontWeight: 600,
                      fontFamily: '"Crimson Pro", Georgia, serif'
                    }}
                    title="Download invoice as HTML file (test mode)"
                  >
                    <Download size={18} />
                    Download Invoice
                  </button>
                  
                  <button
                    onClick={() => sendInvoice(clientId)}
                    disabled={!client.email}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.75rem 1.5rem',
                      border: 'none',
                      background: client.email 
                        ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' 
                        : '#ccc',
                      color: 'white',
                      borderRadius: '8px',
                      cursor: client.email ? 'pointer' : 'not-allowed',
                      fontSize: '1rem',
                      fontWeight: 600,
                      fontFamily: '"Crimson Pro", Georgia, serif'
                    }}
                    title="Generate invoice for email (requires Google sign-in)"
                  >
                    <Mail size={18} />
                    {client.email ? 'Send Invoice via Email' : 'Client email required'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default PracticeManager;

