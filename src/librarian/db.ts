// IndexedDB storage for the librarian. Everything stays in this browser.

import type { LibraryEntry } from './syx';

const DB_NAME = 'shed';
const DB_VERSION = 1;
const STORE = 'entries';

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class Library {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('name', 'name');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.db()).transaction(STORE, mode).objectStore(STORE);
  }

  async list(): Promise<LibraryEntry[]> {
    const all = await promisify((await this.store('readonly')).getAll() as IDBRequest<LibraryEntry[]>);
    return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  async put(entry: LibraryEntry): Promise<number> {
    const copy: LibraryEntry = { ...entry };
    if (copy.id === undefined) delete copy.id;
    return (await promisify((await this.store('readwrite')).put(copy))) as number;
  }

  async putMany(entries: LibraryEntry[]): Promise<void> {
    const store = await this.store('readwrite');
    await Promise.all(
      entries.map((e) => {
        const copy: LibraryEntry = { ...e };
        if (copy.id === undefined) delete copy.id;
        return promisify(store.put(copy));
      }),
    );
  }

  async remove(id: number): Promise<void> {
    await promisify((await this.store('readwrite')).delete(id));
  }
}
