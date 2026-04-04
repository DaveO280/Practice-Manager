/**
 * Save files to the user's device. Uses the File System Access API (Chrome, Edge, Opera)
 * so the user can pick the folder and filename; falls back to a normal download elsewhere.
 */

export function supportsSaveFilePicker() {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

/**
 * @param {Blob} blob
 * @param {string} suggestedName
 * @param {{ description?: string, accept?: Record<string, string[]> }} [pickerMeta]
 * @returns {Promise<{ ok: boolean, aborted?: boolean, mode: 'picker' | 'download' }>}
 */
export async function saveBlobToDevice(blob, suggestedName, pickerMeta = {}) {
  const description = pickerMeta.description || 'File';
  const accept = pickerMeta.accept || { 'application/octet-stream': ['.*'] };

  if (supportsSaveFilePicker()) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, mode: 'picker' };
    } catch (e) {
      if (e.name === 'AbortError') {
        return { ok: false, aborted: true };
      }
      console.warn('Save dialog failed, using download instead:', e);
      downloadBlob(blob, suggestedName);
      return { ok: true, mode: 'download' };
    }
  }

  downloadBlob(blob, suggestedName);
  return { ok: true, mode: 'download' };
}

export async function saveJsonToDevice(data, suggestedName) {
  const jsonString = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  return saveBlobToDevice(blob, suggestedName, {
    description: 'JSON backup',
    accept: { 'application/json': ['.json'] }
  });
}

export async function saveCsvToDevice(csvString, suggestedName) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8' });
  return saveBlobToDevice(blob, suggestedName, {
    description: 'CSV spreadsheet',
    accept: { 'text/csv': ['.csv'] }
  });
}
