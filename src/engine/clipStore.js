// Clips are kept in the browser's private storage for this site (the Origin Private
// File System) instead of in memory, so a big batch is limited by free disk space
// rather than RAM. Nothing here reaches the user's Downloads or gallery: the user
// still picks which clips to download. Each tab gets its own session folder, held
// with a Web Lock; a folder whose lock is gone belongs to a closed tab and is deleted.

const STORE_ROOT = 'clipfinder-clips';
const LOCK_PREFIX = 'clipfinder-session-';

async function storeRoot() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(STORE_ROOT, { create: true });
}

/**
 * Page side. Starts this tab's storage session and deletes folders left by closed tabs.
 * Resolves to { id, release } or null when the browser can't store clips on disk.
 */
export async function startClipSession() {
  if (!navigator.storage?.getDirectory || !navigator.locks?.request || !globalThis.crypto?.randomUUID) return null;
  const id = crypto.randomUUID();
  let release = () => {};
  try {
    await new Promise((resolve, reject) => {
      navigator.locks.request(`${LOCK_PREFIX}${id}`, () => {
        resolve();
        // Held until release() is called or the tab closes.
        return new Promise((done) => { release = done; });
      }).catch(reject);
    });
    await storeRoot();
  } catch {
    release();
    return null;
  }
  void removeClosedSessions(id);
  return { id, release: () => release() };
}

/** Deletes session folders whose tab has closed. Failing here only leaves old files behind. */
async function removeClosedSessions(ownId) {
  try {
    const store = await storeRoot();
    const { held = [] } = await navigator.locks.query();
    const live = new Set(held.map((lock) => lock.name));
    for await (const name of store.keys()) {
      if (name !== ownId && !live.has(`${LOCK_PREFIX}${name}`)) {
        await store.removeEntry(name, { recursive: true }).catch(() => {});
      }
    }
  } catch {
    // Older browsers may not list folders; the next successful cleanup removes them.
  }
}

/** Worker side. The folder for one recording's clips, or null if storage isn't usable. */
export async function openRunFolder(session, run) {
  if (!session || typeof session !== 'string' || !Number.isSafeInteger(run)) return null;
  if (!navigator.storage?.getDirectory || !globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle) return null;
  try {
    const store = await storeRoot();
    const folder = await store.getDirectoryHandle(session, { create: true });
    return await folder.getDirectoryHandle(String(run), { create: true });
  } catch {
    return null;
  }
}

/** Worker side. Writes one clip to disk and returns it as a disk-backed File. */
export async function storeClip(folder, name, bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const handle = await folder.getFileHandle(name, { create: true });
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    let written = 0;
    while (written < data.byteLength) {
      const count = access.write(data.subarray(written), { at: written });
      if (!count) throw new Error('Could not write the clip to storage.');
      written += count;
    }
    access.flush();
  } finally {
    access.close();
  }
  const file = await handle.getFile();
  if (file.size !== data.byteLength) throw new Error('The stored clip is incomplete.');
  return file;
}
