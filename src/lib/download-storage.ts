// IndexedDB-based offline video storage.
// Blobs survive page reloads, app restarts, and offline sessions.
// Zustand/localStorage cannot hold binary data — IndexedDB can (no size limit).

const DB_NAME = 'streamvault-offline';
const DB_VERSION = 1;
const STORE_NAME = 'downloads';

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      _dbPromise = null; // allow retry
      reject(request.error);
    };
  });

  return _dbPromise;
}

/** Save a video blob to IndexedDB keyed by task ID */
export async function saveBlob(taskId: string, blob: Blob): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(blob, taskId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Save subtitle VTT content to IndexedDB keyed by `${taskId}:sub:${lang}` */
export async function saveSubtitle(taskId: string, language: string, vttContent: string): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(vttContent, `${taskId}:sub:${language}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load subtitle VTT content from IndexedDB by task ID and language */
export async function loadSubtitle(taskId: string, language: string): Promise<string | undefined> {
  const db = await openDB();
  return new Promise<string | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(`${taskId}:sub:${language}`);
    request.onsuccess = () => resolve(request.result ?? undefined);
    request.onerror = () => reject(tx.error);
  });
}

/** Load a video blob from IndexedDB by task ID */
export async function loadBlob(taskId: string): Promise<Blob | undefined> {
  const db = await openDB();
  return new Promise<Blob | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(taskId);
    request.onsuccess = () => resolve(request.result ?? undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Delete a video blob from IndexedDB */
export async function deleteBlob(taskId: string): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(taskId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Check if a blob exists for a given task ID */
export async function hasBlob(taskId: string): Promise<boolean> {
  const db = await openDB();
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getKey(taskId);
    request.onsuccess = () => resolve(request.result !== undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Delete all blobs (used for full cleanup) */
export async function clearAllBlobs(): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Save a poster image blob to IndexedDB keyed by content ID */
export async function savePoster(contentId: string | number, blob: Blob): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(blob, `poster:${contentId}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load a poster image blob from IndexedDB by content ID */
export async function loadPoster(contentId: string | number): Promise<Blob | undefined> {
  const db = await openDB();
  return new Promise<Blob | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(`poster:${contentId}`);
    request.onsuccess = () => resolve(request.result ?? undefined);
    request.onerror = () => reject(tx.error);
  });
}

/** Save a user avatar image blob to IndexedDB keyed by user ID */
export async function saveAvatar(userId: string, blob: Blob): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(blob, `avatar:${userId}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load a user avatar image blob from IndexedDB by user ID */
export async function loadAvatar(userId: string): Promise<Blob | undefined> {
  const db = await openDB();
  return new Promise<Blob | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(`avatar:${userId}`);
    request.onsuccess = () => resolve(request.result ?? undefined);
    request.onerror = () => reject(tx.error);
  });
}

/** Delete a poster image blob from IndexedDB by content ID */
export async function deletePoster(contentId: string | number): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(`poster:${contentId}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Save a FileSystemDirectoryHandle to IndexedDB for persistent download folder access.
 *  Handles cannot be serialized to localStorage, so we store them in IndexedDB. */
export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, 'dir-handle:download-folder');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Load the stored FileSystemDirectoryHandle from IndexedDB.
 *  Returns undefined if no handle has been saved or the handle is invalid. */
export async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await openDB();
  return new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('dir-handle:download-folder');
    request.onsuccess = () => resolve(request.result ?? undefined);
    request.onerror = () => reject(tx.error);
  });
}

/** Remove the stored FileSystemDirectoryHandle from IndexedDB. */
export async function removeDirectoryHandle(): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('dir-handle:download-folder');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
