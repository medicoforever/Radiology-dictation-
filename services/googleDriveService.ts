import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut,
  User
} from 'firebase/auth';
import firebaseConfig from '../firebase-applet-config.json';
import { generateSingleDictationHTML, generateBatchDictationHTML } from './htmlGenerator';

// Initialize Firebase App
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const auth = getAuth(app);

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const provider = new GoogleAuthProvider();
SCOPES.forEach(scope => provider.addScope(scope));

// Persistent Drive auth storage key
const DRIVE_AUTH_STORAGE_KEY = 'radiology_dictation_gdrive_auth';

export interface DriveUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export interface PersistedDriveSession {
  accessToken: string;
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
  savedAt: number;
}

export interface SaveResult {
  success: boolean;
  fileName?: string;
  folderPath?: string;
  fileId?: string;
  webViewLink?: string;
  webContentLink?: string;
  folderLink?: string;
  htmlContent?: string;
  error?: string;
}

// In-flight deduplication and sequential mutexes to prevent duplicate uploads
const fileSaveMutexes = new Map<string, Promise<any>>();
const inFlightDictationSaves = new Map<string, Promise<SaveResult>>();
const recentSavesCache = new Map<string, { result: SaveResult; savedAt: number }>();

/**
 * Opens an HTML report directly in a new Google Chrome / browser tab with full
 * interactive features (inline editing, rich copying, reordering, merging, styles).
 */
export function openHtmlInBrowser(htmlContent: string): Window | null {
  try {
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    // Keep blob URL alive long enough for Chrome to load and render
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }, 120000);
    return win;
  } catch (err) {
    console.error('Error opening HTML in browser tab:', err);
    return null;
  }
}

/**
 * Opens a saved Google Drive HTML report directly in Google Chrome / browser.
 * If htmlContent is provided or cached, it opens immediately in pure HTML format.
 * Otherwise, fetches the file from Google Drive and renders it.
 */
export async function openDriveHtmlInBrowser(fileId?: string, fallbackHtml?: string): Promise<boolean> {
  if (fallbackHtml) {
    const win = openHtmlInBrowser(fallbackHtml);
    if (win) return true;
  }

  if (fileId) {
    try {
      const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      if (res.ok) {
        const html = await res.text();
        const win = openHtmlInBrowser(html);
        if (win) return true;
      }
    } catch (e) {
      console.warn('Could not fetch HTML directly from Drive for browser render:', e);
    }

    // Direct download/view fallback
    const directUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
    window.open(directUrl, '_blank');
    return false;
  }

  return false;
}

// Helpers for persisting and restoring the Google Drive OAuth session indefinitely
function loadPersistedSession(): PersistedDriveSession | null {
  try {
    const raw = localStorage.getItem(DRIVE_AUTH_STORAGE_KEY);
    if (!raw) return null;
    const session: PersistedDriveSession = JSON.parse(raw);
    if (!session || !session.accessToken) {
      return null;
    }
    return session;
  } catch (err) {
    console.warn('Failed to load persisted Google Drive session:', err);
    return null;
  }
}

function savePersistedSession(session: PersistedDriveSession): void {
  try {
    localStorage.setItem(DRIVE_AUTH_STORAGE_KEY, JSON.stringify(session));
  } catch (err) {
    console.warn('Failed to save Google Drive session to localStorage:', err);
  }
}

function clearPersistedSession(): void {
  try {
    localStorage.removeItem(DRIVE_AUTH_STORAGE_KEY);
  } catch (err) {}
}

// Initialize from permanent storage so that browser reloads or crashes preserve the connection indefinitely
const initialSession = loadPersistedSession();
let cachedAccessToken: string | null = initialSession ? initialSession.accessToken : null;
let cachedUser: DriveUser | null = initialSession
  ? {
      uid: initialSession.uid,
      email: initialSession.email,
      displayName: initialSession.displayName,
      photoURL: initialSession.photoURL,
    }
  : null;

let isSigningIn = false;

// Cached folder IDs for current session to avoid redundant queries
let cachedRootFolderId: string | null = null;
let cachedDateFolderId: { date: string; id: string } | null = null;

type AuthListener = (user: User | DriveUser | null, token: string | null) => void;
const authListeners: Set<AuthListener> = new Set();

function notifyAuthListeners() {
  const currentUser = auth.currentUser || cachedUser;
  authListeners.forEach(listener => {
    try {
      listener(currentUser, cachedAccessToken);
    } catch (e) {
      console.warn('Error in auth listener:', e);
    }
  });
}

export const subscribeToAuth = (listener: AuthListener) => {
  authListeners.add(listener);
  // Immediate trigger with current state (persisted or in-memory)
  const current = auth.currentUser || cachedUser;
  listener(current, cachedAccessToken);
  return () => {
    authListeners.delete(listener);
  };
};

// Initialize Auth listener from Firebase Auth
onAuthStateChanged(auth, async (user: User | null) => {
  if (user) {
    cachedUser = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
    };

    // Check if we have a persisted session for this user
    const session = loadPersistedSession();
    if (session) {
      cachedAccessToken = session.accessToken;
      // Sync user profile fields if updated
      session.uid = user.uid;
      session.email = user.email;
      session.displayName = user.displayName;
      session.photoURL = user.photoURL;
      savePersistedSession(session);
    }
  } else {
    // If Firebase auth state is null, keep persisted session unless user explicitly signed out
    if (!isSigningIn) {
      const session = loadPersistedSession();
      if (!session) {
        cachedAccessToken = null;
        cachedUser = null;
        cachedRootFolderId = null;
        cachedDateFolderId = null;
      }
    }
  }
  notifyAuthListeners();
});

export const signInWithGoogle = async (): Promise<{ user: User | DriveUser; accessToken: string }> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Could not retrieve access token from Google sign in');
    }
    const token = credential.accessToken;
    cachedAccessToken = token;

    const user = result.user;
    const newSession: PersistedDriveSession = {
      accessToken: token,
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      savedAt: Date.now(),
    };

    savePersistedSession(newSession);
    cachedUser = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
    };

    notifyAuthListeners();

    return { user, accessToken: token };
  } catch (error: any) {
    console.error('Google Sign-in Error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const signOutGoogle = async (): Promise<void> => {
  clearPersistedSession();
  cachedAccessToken = null;
  cachedUser = null;
  cachedRootFolderId = null;
  cachedDateFolderId = null;

  try {
    await signOut(auth);
  } catch (e) {
    console.warn('Firebase signOut notice:', e);
  }

  authListeners.forEach(listener => listener(null, null));
};

export const getAccessToken = (): string | null => {
  if (!cachedAccessToken) {
    const session = loadPersistedSession();
    if (session?.accessToken) {
      cachedAccessToken = session.accessToken;
    }
  }
  return cachedAccessToken;
};

export const getCurrentUser = (): User | DriveUser | null => {
  return auth.currentUser || cachedUser;
};

export const isDriveConnected = (): boolean => {
  if (!cachedAccessToken) {
    const session = loadPersistedSession();
    if (session?.accessToken) {
      cachedAccessToken = session.accessToken;
      if (!cachedUser) {
        cachedUser = {
          uid: session.uid,
          email: session.email,
          displayName: session.displayName,
          photoURL: session.photoURL,
        };
      }
    }
  }
  return !!cachedAccessToken;
};

export function getDriveSessionInfo(): {
  isConnected: boolean;
  user: User | DriveUser | null;
} {
  return {
    isConnected: isDriveConnected(),
    user: auth.currentUser || cachedUser,
  };
}

// Helper to format date string YYYY-MM-DD
export const getLocalDateString = (dateInput?: Date | number): string => {
  const d = dateInput ? new Date(dateInput) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Helper to format time string HH-MM-SS
export const getLocalTimeString = (dateInput?: Date | number): string => {
  const d = dateInput ? new Date(dateInput) : new Date();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${hours}-${minutes}-${seconds}`;
};

/**
 * Executes a fetch request to Google Drive API with automatic authorization
 */
async function driveFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getAccessToken();
  if (!token) {
    throw new Error('Google Drive is not connected. Please sign in with Google to auto-save.');
  }

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) {
      console.warn('Google Drive API returned 401 Unauthorized: token expired or invalid.');
      cachedAccessToken = null;
      clearPersistedSession();
      notifyAuthListeners();
      throw new Error('Google Drive session has expired. Please click Reconnect to continue auto-saving.');
    }
    let errorDetail = '';
    try {
      const errJson = await response.json();
      errorDetail = errJson.error?.message || JSON.stringify(errJson);
    } catch {
      errorDetail = await response.text();
    }
    throw new Error(`Google Drive API error (${response.status}): ${errorDetail}`);
  }

  return response;
}

/**
 * Searches for a folder with a given name in a specific parent folder.
 */
async function findFolder(folderName: string, parentId?: string): Promise<string | null> {
  let query = `mimeType = 'application/vnd.google-apps.folder' and name = '${folderName.replace(/'/g, "\\'")}' and trashed = false`;
  if (parentId) {
    query += ` and '${parentId}' in parents`;
  } else {
    query += ` and 'root' in parents`;
  }

  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`;
  const res = await driveFetch(url);
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }
  return null;
}

/**
 * Creates a folder inside a specified parent folder.
 */
async function createFolder(folderName: string, parentId?: string): Promise<string> {
  const metadata: { name: string; mimeType: string; parents?: string[] } = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) {
    metadata.parents = [parentId];
  }

  const res = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(metadata),
  });

  const data = await res.json();
  return data.id;
}

/**
 * Ensures the root "Radiology Dictations" folder exists in the user's Drive.
 */
export async function getOrCreateRootFolder(): Promise<string> {
  if (cachedRootFolderId) {
    return cachedRootFolderId;
  }

  const existingId = await findFolder('Radiology Dictations');
  if (existingId) {
    cachedRootFolderId = existingId;
    return existingId;
  }

  const newId = await createFolder('Radiology Dictations');
  cachedRootFolderId = newId;
  return newId;
}

/**
 * Ensures today's or specified date's folder (e.g. "2026-09-11") exists inside "Radiology Dictations".
 */
export async function getOrCreateDateFolder(dateStrInput?: string): Promise<{ dateFolderId: string; dateStr: string }> {
  const rootId = await getOrCreateRootFolder();
  const dateStr = dateStrInput || getLocalDateString();

  if (cachedDateFolderId && cachedDateFolderId.date === dateStr) {
    return { dateFolderId: cachedDateFolderId.id, dateStr };
  }

  const existingId = await findFolder(dateStr, rootId);
  if (existingId) {
    cachedDateFolderId = { date: dateStr, id: existingId };
    return { dateFolderId: existingId, dateStr };
  }

  const newId = await createFolder(dateStr, rootId);
  cachedDateFolderId = { date: dateStr, id: newId };
  return { dateFolderId: newId, dateStr };
}

/**
 * Searches for an existing file with a specific name inside a parent folder.
 */
export async function findFileInFolder(
  fileName: string,
  parentId: string
): Promise<{ id: string; name: string; webViewLink?: string } | null> {
  const safeName = fileName.replace(/'/g, "\\'");
  const query = `name = '${safeName}' and '${parentId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink)&spaces=drive`;
  const res = await driveFetch(url);
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    return data.files[0];
  }
  return null;
}

/**
 * Updates the content of an existing HTML file in Google Drive.
 */
export async function updateHTMLFile(
  fileId: string,
  htmlContent: string
): Promise<{ id: string; name: string; webViewLink?: string }> {
  const res = await driveFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,webViewLink`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/html; charset=UTF-8',
      },
      body: htmlContent,
    }
  );
  return await res.json();
}

/**
 * Uploads an HTML file to Google Drive in the specified parent folder.
 * Ensures mimeType is set to 'text/html' so clicking opens in Chrome / Web preview.
 */
export async function uploadHTMLFile(
  fileName: string,
  htmlContent: string,
  parentFolderId: string
): Promise<{ id: string; name: string; webViewLink: string; webContentLink?: string; folderLink?: string }> {
  const metadata = {
    name: fileName.endsWith('.html') ? fileName : `${fileName}.html`,
    parents: [parentFolderId],
    mimeType: 'text/html',
    description: 'Radiology Dictation HTML Report. Opens with Google Chrome for full interactive editing, copying, and merging features.',
  };

  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const multipartRequestBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: text/html; charset=UTF-8\r\n\r\n' +
    htmlContent +
    closeDelimiter;

  const res = await driveFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink',
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartRequestBody,
    }
  );

  const data = await res.json();
  return {
    ...data,
    webContentLink: data.webContentLink || `https://drive.google.com/uc?id=${data.id}&export=download`,
    folderLink: `https://drive.google.com/drive/folders/${parentFolderId}`,
  };
}

/**
 * Saves or updates an HTML file in Google Drive.
 * Uses a sequential mutex to prevent concurrent duplicate file uploads.
 * If a file with the same name already exists in the folder, its contents are updated.
 * Otherwise, a new file is uploaded.
 */
export async function saveOrUpdateHTMLFile(
  fileName: string,
  htmlContent: string,
  parentFolderId: string
): Promise<{ id: string; name: string; webViewLink: string; webContentLink?: string; folderLink?: string; updated: boolean }> {
  const targetName = fileName.endsWith('.html') ? fileName : `${fileName}.html`;
  const mutexKey = `${parentFolderId}::${targetName}`;

  // Chain onto existing in-flight operation for this file to prevent duplicate uploads
  const prevOp = fileSaveMutexes.get(mutexKey) || Promise.resolve();

  const currentOp = prevOp.then(async () => {
    try {
      const existing = await findFileInFolder(targetName, parentFolderId);
      if (existing) {
        try {
          const updated = await updateHTMLFile(existing.id, htmlContent);
          return {
            id: existing.id,
            name: targetName,
            webViewLink: updated.webViewLink || existing.webViewLink || `https://drive.google.com/file/d/${existing.id}/view`,
            webContentLink: `https://drive.google.com/uc?id=${existing.id}&export=download`,
            folderLink: `https://drive.google.com/drive/folders/${parentFolderId}`,
            updated: true,
          };
        } catch (patchErr) {
          console.warn(`Patch failed for ${targetName}, falling back to upload:`, patchErr);
        }
      }
    } catch (err) {
      console.warn(`File lookup error for ${targetName}:`, err);
    }

    const created = await uploadHTMLFile(targetName, htmlContent, parentFolderId);
    return { ...created, updated: false };
  });

  fileSaveMutexes.set(mutexKey, currentOp);
  try {
    return await currentOp;
  } finally {
    if (fileSaveMutexes.get(mutexKey) === currentOp) {
      fileSaveMutexes.delete(mutexKey);
    }
  }
}

/**
 * Automatically saves a Single Dictation report as HTML to Google Drive.
 * Path: Radiology Dictations / YYYY-MM-DD / Dictation_HH-MM-SS.html
 * Includes concurrency deduplication to prevent duplicate saves.
 */
export async function autoSaveSingleDictation(
  findings: string[],
  customName?: string,
  timestamp?: number | Date
): Promise<SaveResult> {
  if (!isDriveConnected() || findings.length === 0) {
    return { success: false, error: 'Not connected or empty findings' };
  }

  const targetDate = timestamp ? new Date(timestamp) : new Date();
  const dateStr = getLocalDateString(targetDate);
  const timeStr = getLocalTimeString(targetDate);
  const findingsHash = findings.join('|||');
  const dedupeKey = `single:${dateStr}:${customName || timeStr}:${findingsHash}`;

  // 1. Check recent saves cache (last 15 seconds) to immediately block rapid re-saves of same content
  const cached = recentSavesCache.get(dedupeKey);
  if (cached && Date.now() - cached.savedAt < 15000) {
    return cached.result;
  }

  // 2. Check if a save is already in-flight for this exact dictation
  const inFlight = inFlightDictationSaves.get(dedupeKey);
  if (inFlight) {
    return inFlight;
  }

  const savePromise = (async (): Promise<SaveResult> => {
    try {
      const { dateFolderId } = await getOrCreateDateFolder(dateStr);
      
      let baseName = customName
        ? customName.replace(/[^a-zA-Z0-9_-]/g, '_')
        : `Dictation_${timeStr}`;
        
      const fileName = `${baseName}.html`;
      const htmlContent = generateSingleDictationHTML(findings, targetDate);

      const file = await saveOrUpdateHTMLFile(fileName, htmlContent, dateFolderId);

      const result: SaveResult = {
        success: true,
        fileName,
        folderPath: `Radiology Dictations/${dateStr}`,
        fileId: file.id,
        webViewLink: file.webViewLink,
        webContentLink: file.webContentLink || `https://drive.google.com/uc?id=${file.id}&export=download`,
        folderLink: `https://drive.google.com/drive/folders/${dateFolderId}`,
        htmlContent,
      };

      recentSavesCache.set(dedupeKey, { result, savedAt: Date.now() });
      return result;
    } catch (err: any) {
      console.error('Error auto-saving single dictation to Drive:', err);
      return {
        success: false,
        error: err.message || 'Failed to auto-save to Google Drive',
      };
    }
  })();

  inFlightDictationSaves.set(dedupeKey, savePromise);
  try {
    return await savePromise;
  } finally {
    inFlightDictationSaves.delete(dedupeKey);
  }
}

/**
 * Automatically saves a Live Dictation report as HTML to Google Drive.
 * Path: Radiology Dictations / YYYY-MM-DD / Live_Dictation_HH-MM-SS.html
 * Includes concurrency deduplication to prevent duplicate saves.
 */
export async function autoSaveLiveDictation(
  findings: string[],
  timestamp?: number | Date
): Promise<SaveResult> {
  if (!isDriveConnected() || findings.length === 0) {
    return { success: false, error: 'Not connected or empty findings' };
  }

  const targetDate = timestamp ? new Date(timestamp) : new Date();
  const dateStr = getLocalDateString(targetDate);
  const timeStr = getLocalTimeString(targetDate);
  const findingsHash = findings.join('|||');
  const dedupeKey = `live:${dateStr}:${timeStr}:${findingsHash}`;

  const cached = recentSavesCache.get(dedupeKey);
  if (cached && Date.now() - cached.savedAt < 15000) {
    return cached.result;
  }

  const inFlight = inFlightDictationSaves.get(dedupeKey);
  if (inFlight) {
    return inFlight;
  }

  const savePromise = (async (): Promise<SaveResult> => {
    try {
      const { dateFolderId } = await getOrCreateDateFolder(dateStr);
      const fileName = `Live_Dictation_${timeStr}.html`;
      const htmlContent = generateSingleDictationHTML(findings, targetDate);

      const file = await saveOrUpdateHTMLFile(fileName, htmlContent, dateFolderId);

      const result: SaveResult = {
        success: true,
        fileName,
        folderPath: `Radiology Dictations/${dateStr}`,
        fileId: file.id,
        webViewLink: file.webViewLink,
        webContentLink: file.webContentLink || `https://drive.google.com/uc?id=${file.id}&export=download`,
        folderLink: `https://drive.google.com/drive/folders/${dateFolderId}`,
        htmlContent,
      };

      recentSavesCache.set(dedupeKey, { result, savedAt: Date.now() });
      return result;
    } catch (err: any) {
      console.error('Error auto-saving live dictation to Drive:', err);
      return {
        success: false,
        error: err.message || 'Failed to auto-save to Google Drive',
      };
    }
  })();

  inFlightDictationSaves.set(dedupeKey, savePromise);
  try {
    return await savePromise;
  } finally {
    inFlightDictationSaves.delete(dedupeKey);
  }
}

export interface BatchFolderInfo {
  id: string;
  name: string;
  dateStr: string;
}

export interface BatchSaveResult extends SaveResult {
  batchFolder?: BatchFolderInfo;
}

/**
 * Automatically saves or updates Batch Dictations in a dedicated batch folder in Google Drive.
 * If existingBatchFolder is provided, reuses that folder so retried files are added to the existing batch!
 * Path: Radiology Dictations / YYYY-MM-DD / Batch_HH-MM-SS / [Item_Name].html + 00_Batch_Summary.html
 */
export async function autoSaveBatchDictations(
  batches: Array<{ id: string; name: string; findings: string[] | null }>,
  existingBatchFolder?: BatchFolderInfo | null,
  batchTimestamp?: number | Date
): Promise<BatchSaveResult> {
  const completedBatches = batches.filter(b => b.findings && b.findings.length > 0);
  if (!isDriveConnected() || completedBatches.length === 0) {
    return { success: false, error: 'Not connected or no completed batches' };
  }

  const targetDate = batchTimestamp ? new Date(batchTimestamp) : new Date();
  const dateStr = existingBatchFolder?.dateStr || getLocalDateString(targetDate);
  const batchFolderKey = existingBatchFolder?.id || 'new';
  const batchHash = completedBatches.map(b => `${b.id}:${(b.findings || []).join('|')}`).join(';;;');
  const dedupeKey = `batch:${dateStr}:${batchFolderKey}:${batchHash}`;

  const cached = recentSavesCache.get(dedupeKey);
  if (cached && Date.now() - cached.savedAt < 15000) {
    return cached.result as BatchSaveResult;
  }

  const inFlight = inFlightDictationSaves.get(dedupeKey);
  if (inFlight) {
    return inFlight as Promise<BatchSaveResult>;
  }

  const savePromise = (async (): Promise<BatchSaveResult> => {
    try {
      const { dateFolderId } = await getOrCreateDateFolder(dateStr);
      
      let batchFolderId: string;
      let batchSubfolderName: string;

      // Check if existing folder can be reused
      if (existingBatchFolder && existingBatchFolder.id) {
        try {
          const checkRes = await driveFetch(`https://www.googleapis.com/drive/v3/files/${existingBatchFolder.id}?fields=id,trashed`);
          const checkData = await checkRes.json();
          if (checkData && !checkData.trashed && checkData.id) {
            batchFolderId = existingBatchFolder.id;
            batchSubfolderName = existingBatchFolder.name;
          } else {
            const timeStr = getLocalTimeString(targetDate);
            batchSubfolderName = `Batch_${timeStr}`;
            batchFolderId = await createFolder(batchSubfolderName, dateFolderId);
          }
        } catch {
          const timeStr = getLocalTimeString(targetDate);
          batchSubfolderName = `Batch_${timeStr}`;
          batchFolderId = await createFolder(batchSubfolderName, dateFolderId);
        }
      } else {
        const timeStr = getLocalTimeString(targetDate);
        batchSubfolderName = `Batch_${timeStr}`;
        batchFolderId = await createFolder(batchSubfolderName, dateFolderId);
      }

      // 1. Save or update each completed batch item in the folder
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        if (!b.findings || b.findings.length === 0) continue;

        const safeName = (b.name || `Dictation_${i + 1}`)
          .replace(/[/\\?%*:|"<>]/g, '_')
          .replace(/\s+/g, '_');
        const itemFileName = `${String(i + 1).padStart(2, '0')}_${safeName}.html`;
        const itemHTML = generateSingleDictationHTML(b.findings, targetDate);
        await saveOrUpdateHTMLFile(itemFileName, itemHTML, batchFolderId);
      }

      // 2. Save or update the consolidated 00_Batch_Summary.html
      const summaryHTML = generateBatchDictationHTML(completedBatches, targetDate);
      const summaryFile = await saveOrUpdateHTMLFile('00_Batch_Summary.html', summaryHTML, batchFolderId);

      const folderInfo: BatchFolderInfo = {
        id: batchFolderId,
        name: batchSubfolderName,
        dateStr,
      };

      const result: BatchSaveResult = {
        success: true,
        fileName: `${completedBatches.length} reports in ${batchSubfolderName}`,
        folderPath: `Radiology Dictations/${dateStr}/${batchSubfolderName}`,
        fileId: summaryFile.id,
        webViewLink: summaryFile.webViewLink,
        webContentLink: summaryFile.webContentLink || `https://drive.google.com/uc?id=${summaryFile.id}&export=download`,
        folderLink: `https://drive.google.com/drive/folders/${batchFolderId}`,
        htmlContent: summaryHTML,
        batchFolder: folderInfo,
      };

      recentSavesCache.set(dedupeKey, { result, savedAt: Date.now() });
      return result;
    } catch (err: any) {
      console.error('Error auto-saving batch to Google Drive:', err);
      return {
        success: false,
        error: err.message || 'Failed to auto-save batch to Google Drive',
      };
    }
  })();

  inFlightDictationSaves.set(dedupeKey, savePromise as Promise<SaveResult>);
  try {
    return await savePromise;
  } finally {
    inFlightDictationSaves.delete(dedupeKey);
  }
}

/**
 * Checks localStorage for dictations that were transcribed while offline or disconnected,
 * and uploads them to Google Drive with their original timestamps upon reconnecting.
 */
export async function syncPendingLocalDictationsToDrive(): Promise<{
  singleResult?: SaveResult;
  batchResult?: BatchSaveResult;
}> {
  if (!isDriveConnected()) {
    return {};
  }

  const results: { singleResult?: SaveResult; batchResult?: BatchSaveResult } = {};

  // 1. Check Single Mode storage
  try {
    const singleRaw = localStorage.getItem('radiologyDictationSingleMode');
    if (singleRaw) {
      const singleState = JSON.parse(singleRaw);
      if (
        singleState &&
        Array.isArray(singleState.findings) &&
        singleState.findings.length > 0 &&
        !singleState.driveSynced
      ) {
        const res = singleState.isLive
          ? await autoSaveLiveDictation(singleState.findings, singleState.timestamp)
          : await autoSaveSingleDictation(singleState.findings, undefined, singleState.timestamp);

        if (res.success) {
          singleState.driveSynced = true;
          singleState.driveFileId = res.fileId;
          singleState.driveSyncedHash = singleState.findings.join('|||');
          localStorage.setItem('radiologyDictationSingleMode', JSON.stringify(singleState));
          results.singleResult = res;
        }
      }
    }
  } catch (e) {
    console.warn('Error checking pending single dictations:', e);
  }

  // 2. Check Batch Mode storage
  try {
    const batchRaw = localStorage.getItem('radiologyDictationBatchMode');
    if (batchRaw) {
      const batches = JSON.parse(batchRaw);
      if (Array.isArray(batches)) {
        const completed = batches.filter((b: any) => b.findings && b.findings.length > 0);
        const savedFolderRaw = localStorage.getItem('radiologyDictationBatchDriveFolder');
        const savedTimestampRaw = localStorage.getItem('radiologyDictationBatchSessionTimestamp');
        const savedHash = localStorage.getItem('radiologyDictationBatchDriveSyncedHash');

        const currentHash = completed.map((b: any) => `${b.id}:${(b.findings || []).join('|')}`).join(';;;');
        
        if (completed.length > 0 && currentHash !== savedHash) {
          const existingFolder = savedFolderRaw ? JSON.parse(savedFolderRaw) : null;
          const sessionTimestamp = savedTimestampRaw ? parseInt(savedTimestampRaw, 10) : Date.now();

          const batchRes = await autoSaveBatchDictations(batches, existingFolder, sessionTimestamp);
          if (batchRes.success) {
            if (batchRes.batchFolder) {
              localStorage.setItem('radiologyDictationBatchDriveFolder', JSON.stringify(batchRes.batchFolder));
            }
            localStorage.setItem('radiologyDictationBatchDriveSyncedHash', currentHash);
            results.batchResult = batchRes;
          }
        }
      }
    }
  } catch (e) {
    console.warn('Error checking pending batch dictations:', e);
  }

  return results;
}

export interface DriveReportItem {
  id: string;
  name: string;
  createdTime: string;
  size?: string;
  webViewLink?: string;
}

/**
 * Lists all available date subfolders inside "Radiology Dictations".
 */
export async function listAvailableDates(): Promise<string[]> {
  try {
    const rootId = await getOrCreateRootFolder();
    const query = `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)&orderBy=name desc&pageSize=30`;
    const res = await driveFetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.files || []).map((f: any) => f.name);
  } catch (err) {
    console.error('Error listing available date folders:', err);
    return [];
  }
}

/**
 * Lists all HTML reports saved in the specified date folder (defaults to today).
 */
export async function listReportsForDate(dateStr?: string): Promise<DriveReportItem[]> {
  try {
    const targetDate = dateStr || getLocalDateString();
    const rootId = await getOrCreateRootFolder();
    const dateFolderId = await findFolder(targetDate, rootId);
    if (!dateFolderId) return [];

    const query = `'${dateFolderId}' in parents and mimeType = 'text/html' and trashed = false`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,createdTime,size,webViewLink)&orderBy=createdTime desc&pageSize=100`;
    const res = await driveFetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.files || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      createdTime: f.createdTime,
      size: f.size,
      webViewLink: f.webViewLink,
    }));
  } catch (err) {
    console.error('Error listing reports for date:', err);
    return [];
  }
}

/**
 * Fetches the raw HTML text of a report directly from Google Drive.
 */
export async function getReportHtml(fileId: string): Promise<string | null> {
  try {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (res.ok) {
      return await res.text();
    }
    return null;
  } catch (err) {
    console.error('Error fetching report HTML from Drive:', err);
    return null;
  }
}

/**
 * Extracts transcribed findings array from a generated report HTML string.
 */
export function extractFindingsFromHtml(html: string): string[] {
  try {
    const findings: string[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const items = doc.querySelectorAll('.finding-item');
    if (items.length > 0) {
      items.forEach((item) => {
        const raw = item.getAttribute('data-finding-raw');
        if (raw) {
          findings.push(decodeURIComponent(raw));
        } else {
          const textEl = item.querySelector('.finding-text') || item;
          findings.push(textEl.textContent?.trim() || '');
        }
      });
      return findings.filter(f => f.length > 0);
    }
  } catch (e) {
    console.warn('DOMParser failed to parse findings from HTML:', e);
  }
  return [];
}
