/**
 * Saving the world.
 *
 * The world is a pure function of its seed, so the only thing worth storing is
 * **the difference** — the blocks the player changed. A thousand placed blocks
 * is four kilobytes, not four megabytes, and loading a world is regenerating it
 * and replaying the difference on top.
 *
 * One edit packs into a single 32-bit word:
 *
 *   bits 0..17   index into the column (`y << 10 | z << 5 | x`, up to 196607)
 *   bits 18..25  block id
 *
 * Edits are kept per column and deduplicated by index, so breaking and
 * replacing the same block a hundred times still costs one word. The whole set
 * for a world is read into memory when it opens: it is small, and having it
 * synchronously available is what lets a freshly generated column be patched
 * the moment it arrives, before anything reads it.
 */

/** Where the player was and what the sky was doing. One record per world. */
export interface SavedState {
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  /** 0..1 through the day. */
  time: number;
  hotbar: number;
}

const DB_NAME = 'supergraph';
const DB_VERSION = 1;
const STORE = 'edits';

const INDEX_BITS = 18;
const INDEX_MASK = (1 << INDEX_BITS) - 1;

export const packEdit = (index: number, block: number): number =>
  ((index & INDEX_MASK) | (block << INDEX_BITS)) >>> 0;

export const editIndex = (packed: number): number => packed & INDEX_MASK;
export const editBlock = (packed: number): number => packed >>> INDEX_BITS;

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // A browser in private mode, or with storage denied, simply gets no saving.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export class WorldSave {
  /** Edits per column, keyed by `cx,cz`. */
  private readonly columns = new Map<string, Map<number, number>>();
  /** Columns changed since the last flush. */
  private readonly dirty = new Set<string>();
  private flushing = false;

  /** The player's own record. Keyed apart from the columns by the '@' prefix. */
  private playerState: SavedState | null = null;
  private stateDirty = false;

  private constructor(
    private readonly db: IDBDatabase | null,
    private readonly seed: number,
  ) {}

  /**
   * Opens the store for one seed and reads every edit it holds.
   *
   * Never rejects: a browser that refuses storage gets a save object that
   * quietly does nothing, because losing persistence is not a reason to refuse
   * to start the game.
   */
  static async open(seed: number): Promise<WorldSave> {
    const db = await openDatabase();
    const save = new WorldSave(db, seed);
    if (db) await save.load();
    return save;
  }

  private load(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.db) { resolve(); return; }
      const prefix = `${this.seed}/`;
      const tx = this.db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).openCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        const key = String(cursor.key);
        if (key === `${prefix}@state`) {
          this.playerState = cursor.value as SavedState;
        } else if (key.startsWith(prefix)) {
          const packed = cursor.value as Uint32Array;
          const map = new Map<number, number>();
          for (const word of packed) map.set(editIndex(word), editBlock(word));
          this.columns.set(key.slice(prefix.length), map);
        }
        cursor.continue();
      };
      request.onerror = () => resolve();
    });
  }

  /** Where the player left off, or null for a world never visited. */
  get state(): SavedState | null {
    return this.playerState;
  }

  /**
   * Remembers the player's position. Called every frame, so it does nothing
   * until something has actually moved: writing is what costs, not comparing.
   */
  recordState(next: SavedState): void {
    const prev = this.playerState;
    if (prev &&
      Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5 &&
      Math.abs(prev.z - next.z) < 0.5 && Math.abs(prev.time - next.time) < 0.004 &&
      prev.hotbar === next.hotbar) return;
    this.playerState = next;
    this.stateDirty = true;
  }

  /** Edits for one column, or null. Synchronous by design. */
  get(cx: number, cz: number): Map<number, number> | null {
    return this.columns.get(`${cx},${cz}`) ?? null;
  }

  /** Records one edit. Cheap: the write to storage happens on flush. */
  record(cx: number, cz: number, index: number, block: number): void {
    const key = `${cx},${cz}`;
    let map = this.columns.get(key);
    if (!map) {
      map = new Map();
      this.columns.set(key, map);
    }
    map.set(index, block);
    this.dirty.add(key);
  }

  get dirtyColumns(): number {
    return this.dirty.size;
  }

  get totalEdits(): number {
    let total = 0;
    for (const map of this.columns.values()) total += map.size;
    return total;
  }

  /**
   * Writes changed columns.
   *
   * Only the dirty ones, and only whole columns: an edit list is a few hundred
   * bytes, so read-modify-write per column is simpler and no slower than
   * tracking individual words.
   */
  async flush(): Promise<void> {
    if (!this.db || this.flushing) return;
    if (this.dirty.size === 0 && !this.stateDirty) return;
    this.flushing = true;

    const keys = [...this.dirty];
    this.dirty.clear();

    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);

      if (this.stateDirty && this.playerState) {
        store.put(this.playerState, `${this.seed}/@state`);
        this.stateDirty = false;
      }

      for (const key of keys) {
        const map = this.columns.get(key);
        if (!map || map.size === 0) {
          store.delete(`${this.seed}/${key}`);
          continue;
        }
        const packed = new Uint32Array(map.size);
        let i = 0;
        for (const [index, block] of map) packed[i++] = packEdit(index, block);
        store.put(packed, `${this.seed}/${key}`);
      }

      tx.oncomplete = () => resolve();
      // A failed write is put back on the dirty list rather than lost.
      tx.onerror = () => { for (const key of keys) this.dirty.add(key); resolve(); };
      tx.onabort = () => { for (const key of keys) this.dirty.add(key); resolve(); };
    });

    this.flushing = false;
  }

  /** Forgets this world's edits, in memory and on disk. */
  async clear(): Promise<void> {
    this.columns.clear();
    this.dirty.clear();
    if (!this.db) return;
    await new Promise<void>((resolve) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.openCursor();
      const prefix = `${this.seed}/`;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith(prefix)) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}
