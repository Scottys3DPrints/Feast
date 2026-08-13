/**
 * The `path → driveItemId` map — SPEC §7.1 step 1.
 *
 * A hit means streaming a talk costs exactly one Graph call. A miss costs exactly one
 * Graph call too (path addressing), so this is a latency optimization rather than a
 * correctness requirement — which is why an in-memory default is a legitimate choice
 * and the persistent store is optional.
 *
 * ⚠️ Entries go stale whenever a file moves. `feast dedupe --apply` moves files, so it
 * must invalidate here *and* rewrite `archivePath` in the same run (§7.1, §9.3).
 */
import type { PathMapStore } from '../types.js';

export class MemoryPathMap implements PathMapStore {
  #map = new Map<string, string>();

  constructor(initial?: Iterable<[string, string]>) {
    if (initial) for (const [path, id] of initial) this.#map.set(path, id);
  }

  get(path: string): string | undefined {
    return this.#map.get(path);
  }

  set(path: string, id: string): void {
    this.#map.set(path, id);
  }

  delete(path: string): void {
    this.#map.delete(path);
  }

  entries(): Iterable<[string, string]> {
    return this.#map.entries();
  }

  get size(): number {
    return this.#map.size;
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.#map);
  }

  static fromJSON(json: Record<string, string> | null | undefined): MemoryPathMap {
    return new MemoryPathMap(Object.entries(json ?? {}));
  }
}

/**
 * id → { name, parentId } for every folder seen during enumeration.
 *
 * §4.4: `parentReference.path` is omitted in delta responses, so the only way to know
 * where an item lives is to reconstruct the tree from `parentReference.id`. On a full
 * delta every ancestor arrives in the same enumeration; on an incremental one it may
 * not, which is why this survives between runs alongside the delta cursor.
 */
export interface FolderNode {
  name: string;
  parentId?: string;
}

export class FolderTree {
  #nodes = new Map<string, FolderNode>();
  #rootId: string | undefined;

  constructor(initial?: { rootId?: string; nodes?: Record<string, FolderNode> }) {
    if (initial?.rootId) this.#rootId = initial.rootId;
    for (const [id, node] of Object.entries(initial?.nodes ?? {})) this.#nodes.set(id, node);
  }

  /** The item the enumeration was rooted at. Its own name is not part of any path. */
  setRoot(id: string): void {
    this.#rootId = id;
  }

  get rootId(): string | undefined {
    return this.#rootId;
  }

  add(id: string, name: string, parentId?: string): void {
    const node: FolderNode = { name };
    if (parentId !== undefined) node.parentId = parentId;
    this.#nodes.set(id, node);
  }

  remove(id: string): void {
    this.#nodes.delete(id);
  }

  /**
   * Build a root-relative logical path for an item, or null when an ancestor is
   * unknown. Callers treat null as "resolve this one lazily" rather than as an error.
   */
  pathFor(name: string, parentId: string | undefined): string | null {
    const segments: string[] = [name];
    let cursor = parentId;
    let guard = 0;

    while (cursor && cursor !== this.#rootId) {
      if (guard++ > 64) return null; // cycle or corrupt tree — refuse rather than hang
      const node = this.#nodes.get(cursor);
      if (!node) return null;
      segments.push(node.name);
      cursor = node.parentId;
    }

    // Fell off the top without reaching the root: the item is outside the enumeration.
    if (!cursor && this.#rootId !== undefined && parentId !== this.#rootId) return null;

    return segments.reverse().join('/');
  }

  toJSON(): { rootId?: string; nodes: Record<string, FolderNode> } {
    const nodes: Record<string, FolderNode> = {};
    for (const [id, node] of this.#nodes) nodes[id] = node;
    return this.#rootId ? { rootId: this.#rootId, nodes } : { nodes };
  }
}
