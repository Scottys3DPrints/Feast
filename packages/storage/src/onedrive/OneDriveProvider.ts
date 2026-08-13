/**
 * OneDriveProvider — SPEC §4.4, §7.1, §7.2.
 *
 * The only implementation of `StorageProvider` that ships in Phase 1, and the only
 * place in the repo where a Graph URL or driveItem id may appear.
 *
 * The three findings that shape every method here:
 *
 *   • ✅ Range requests work on the pre-signed `@microsoft.graph.downloadUrl`, and
 *     ExoPlayer/AVPlayer consume that URL natively. Seeking works.
 *   • ⚠️ You must NOT send `Authorization` to the download URL. Many HTTP clients
 *     auto-follow the 302 from `/content` and forward the header to
 *     `*.files.1drv.com` — a different origin, which rejects it and leaks your Graph
 *     token to a CDN host. So we never point anything at `/content`: we `$select` the
 *     downloadUrl and hand over the bare URL.
 *   • ⚠️ Expiry is undocumented and the docs contradict themselves. Never persist a
 *     URL; re-resolve immediately before playback; treat 403 as normal (§11.4).
 */
import { encodePathForUrl, normalizePath } from '@feast/core';
import { StorageError, classifyHttp } from '../errors.js';
import type {
  AppFileRead,
  ChangeSet,
  ListResult,
  PathMapStore,
  SignedUrl,
  StorageItem,
  StorageProvider,
  StorageRef,
  TokenProvider,
} from '../types.js';
import { isPathRef } from '../types.js';
import { GraphClient, type ThrottleListener, parseRetryAfter } from './graphClient.js';
import { FolderTree, MemoryPathMap } from './pathMap.js';
import {
  ITEM_SELECT,
  STREAM_SELECT,
  type GraphCollection,
  type GraphDriveItem,
} from './graphTypes.js';

/**
 * ⚠️ SPEC INCONSISTENCY, resolved here and surfaced as one constant.
 *
 * §6.3 lays the app documents out at `/Apps/Feast/catalog.json`; §4.4's example URL
 * is `approot:/feast/catalog.json`, which would put them at `/Apps/Feast/feast/…`.
 * §6.3 is the layout section and is used throughout the rest of the document, so it
 * wins. Change this one string if the other reading turns out to be intended — the
 * desktop tool and the app both read it from here.
 */
export const APP_FOLDER_PREFIX = '';

/**
 * How long we *assume* a signed URL is good for. Practitioners consistently observe
 * ~1 hour; the docs say both "1 hour" and "might expire within minutes"
 * ([onedrive-api-docs#884], never answered). ADVISORY ONLY — §11.4's recovery path
 * must work regardless of what this says.
 */
const ASSUMED_URL_TTL_MS = 55 * 60 * 1000;

export interface OneDriveProviderOptions {
  /** Library root, provider-relative. Default `Talks` (§6.3 `catalog.root`). */
  root?: string;
  /** Persistent `path → id` map (§7.1 step 1). Defaults to in-memory. */
  pathMap?: PathMapStore;
  /** Restored alongside the delta cursor so incremental deltas can rebuild paths. */
  folderTree?: FolderTree;
  /** §16 — surface throttling, never spin silently. */
  onThrottle?: ThrottleListener;
}

export class OneDriveProvider implements StorageProvider {
  readonly id = 'onedrive' as const;

  #graph: GraphClient;
  #pathMap: PathMapStore;
  #folders: FolderTree;
  #root: string;

  constructor(tokens: TokenProvider, opts: OneDriveProviderOptions = {}) {
    this.#graph = new GraphClient(tokens, opts.onThrottle ? { onThrottle: opts.onThrottle } : {});
    this.#pathMap = opts.pathMap ?? new MemoryPathMap();
    this.#folders = opts.folderTree ?? new FolderTree();
    this.#root = normalizePath(opts.root ?? 'Talks');
  }

  /** Epoch ms until which Graph requests are gated, or 0. For Settings → diagnostics. */
  get throttledUntil(): number {
    return this.#graph.throttledUntil;
  }

  /** Persist alongside the delta cursor; pass back via `folderTree` next run. */
  exportFolderTree(): ReturnType<FolderTree['toJSON']> {
    return this.#folders.toJSON();
  }

  // ── playback hot path ─────────────────────────────────────────────────────────

  /**
   * §7.1: exactly one Graph call in every case — a warm map hit addresses by id, a
   * miss addresses by path. Both `$select` the downloadUrl, so neither needs a
   * follow-up. That is what §17's < 1.5 s tap-to-audio budget is built on.
   */
  async getStreamUrl(ref: StorageRef, _ttlHint?: number): Promise<SignedUrl> {
    const item = await this.#fetchItem(ref, STREAM_SELECT);
    const url = item['@microsoft.graph.downloadUrl'];
    if (!url) {
      throw new StorageError('not-found', subjectOf(ref), {
        message: 'OneDrive returned no download URL — the item may be a folder.',
      });
    }
    return {
      url,
      expiresAt: Date.now() + ASSUMED_URL_TTL_MS,
      supportsRange: true,
    };
  }

  /**
   * A raw ranged read of the signed URL.
   *
   * ⚠️ No `Authorization` header — see the file header. And note this is NOT the
   * playback path: you cannot issue a Range header through `expo-audio`. Range applies
   * to the cache layer's raw downloads (§4.4, §11.3), where a resumed download uses
   * `Range: bytes=<bytesWritten>-`.
   */
  async openRange(ref: StorageRef, start: number, end?: number): Promise<ReadableStream<Uint8Array>> {
    const { url } = await this.getStreamUrl(ref);
    const range = end === undefined ? `bytes=${start}-` : `bytes=${start}-${end}`;

    let res: Response;
    try {
      res = await fetch(url, { headers: { Range: range } });
    } catch (cause) {
      throw new StorageError('offline', subjectOf(ref), { cause });
    }

    if (!res.ok) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      throw new StorageError(classifyHttp(res.status, retryAfter), subjectOf(ref), {
        status: res.status,
        message:
          res.status === 403
            ? 'The download link expired mid-read. Re-resolve and retry (§11.4).'
            : `Range read failed with ${res.status}.`,
      });
    }
    if (!res.body) {
      throw new StorageError('unknown', subjectOf(ref), {
        message: 'This runtime does not expose a streaming response body.',
      });
    }
    return res.body as ReadableStream<Uint8Array>;
  }

  async stat(ref: StorageRef): Promise<StorageItem | null> {
    try {
      const item = await this.#fetchItem(ref, ITEM_SELECT);
      return this.#toStorageItem(item, isPathRef(ref) ? normalizePath(ref.path) : undefined);
    } catch (e) {
      if (StorageError.is(e, 'not-found')) return null;
      throw e;
    }
  }

  /**
   * §7.1 resolution order: cached id → path addressing → 404.
   *
   * A cached id that 404s means the file moved. We drop the stale entry and fall
   * through to path addressing rather than failing, because the path is the identity
   * everywhere above this package.
   */
  async #fetchItem(ref: StorageRef, select: string): Promise<GraphDriveItem> {
    if (!isPathRef(ref)) {
      return this.#getById(ref.id, select);
    }

    const path = normalizePath(ref.path);
    const cachedId = this.#pathMap.get(path);

    if (cachedId) {
      try {
        const item = await this.#getById(cachedId, select);
        return item;
      } catch (e) {
        if (!StorageError.is(e, 'not-found')) throw e;
        this.#pathMap.delete(path);
      }
    }

    const item = await this.#getByPath(path, select);
    this.#pathMap.set(path, item.id);
    return item;
  }

  async #getById(id: string, select: string): Promise<GraphDriveItem> {
    const res = await this.#graph.request({
      url: `/me/drive/items/${encodeURIComponent(id)}?$select=${encodeURIComponent(select)}`,
      expect: [404],
    });
    if (res.status === 404) throw new StorageError('not-found', id, { status: 404 });
    return res.json<GraphDriveItem>();
  }

  /** Path addressing — Graph supports it directly and it needs no map at all. */
  async #getByPath(path: string, select: string): Promise<GraphDriveItem> {
    const res = await this.#graph.request({
      url: `/me/drive/root:/${encodePathForUrl(path)}?$select=${encodeURIComponent(select)}`,
      expect: [404],
    });
    if (res.status === 404) throw new StorageError('not-found', path, { status: 404 });
    return res.json<GraphDriveItem>();
  }

  // ── enumeration (INGEST ONLY) ────────────────────────────────────────────────

  /** Non-recursive children listing. For recursive work use `changesSince` (§4.4). */
  async list(o: { prefix?: string; cursor?: string; pageSize?: number } = {}): Promise<ListResult> {
    const prefix = normalizePath(o.prefix ?? this.#root);
    const url =
      o.cursor ??
      `/me/drive/root:/${encodePathForUrl(prefix)}:/children?$top=${o.pageSize ?? 999}&$select=${encodeURIComponent(ITEM_SELECT)}`;

    const res = await this.#graph.request({ url, expect: [404] });
    if (res.status === 404) throw new StorageError('not-found', prefix, { status: 404 });

    const page = await res.json<GraphCollection<GraphDriveItem>>();
    const items = page.value.map((item) => {
      if (item.folder && item.name) {
        this.#folders.add(item.id, item.name, item.parentReference?.id);
      }
      const path = item.name ? `${prefix}/${item.name}` : prefix;
      if (!item.folder) this.#pathMap.set(normalizePath(path), item.id);
      return this.#toStorageItem(item, path);
    });

    const next = page['@odata.nextLink'];
    return next ? { items, cursor: next, done: false } : { items, done: true };
  }

  /**
   * Recursive enumeration via `/delta` — §4.4 documents it as "the only guaranteed
   * way to retrieve all items in a hierarchy if writes occur during enumeration."
   *
   * Four consumer-OneDrive quirks are handled here and are easy to get wrong:
   *   • `parentReference.path` is omitted ⇒ paths are rebuilt from `parentReference.id`.
   *   • The same item may appear more than once in one response ⇒ LAST occurrence wins.
   *   • An expired token returns HTTP 410 Gone with a `Location` header carrying a
   *     fresh delta URL ⇒ restart from it and report `full: true`.
   *   • `Prefer: deltaExcludeParent` is ignored ⇒ filter the root item ourselves.
   */
  async changesSince(cursor?: string, opts: { prefix?: string } = {}): Promise<ChangeSet> {
    const prefix = normalizePath(opts.prefix ?? this.#root);
    let url =
      cursor ??
      `/me/drive/root:/${encodePathForUrl(prefix)}:/delta?$top=999&$select=${encodeURIComponent(ITEM_SELECT)}`;

    // Last-occurrence-wins, achieved by keying on id and overwriting as pages arrive.
    const upserted = new Map<string, GraphDriveItem>();
    const deletedIds = new Set<string>();
    let full = cursor === undefined;
    let nextCursor = cursor ?? '';

    for (;;) {
      const res = await this.#graph.request({ url, expect: [410] });

      if (res.status === 410) {
        // Token expired. Graph hands back a fresh delta URL; everything we collected
        // so far is unreliable, so start over and tell the caller to reconcile.
        const fresh = res.headers.get('location');
        if (!fresh) {
          throw new StorageError('unknown', prefix, {
            status: 410,
            message: 'Delta token expired and Graph returned no replacement Location.',
          });
        }
        url = fresh;
        upserted.clear();
        deletedIds.clear();
        full = true;
        continue;
      }

      const page = await res.json<GraphCollection<GraphDriveItem>>();

      for (const item of page.value) {
        if (item.deleted) {
          deletedIds.add(item.id);
          upserted.delete(item.id);
          this.#folders.remove(item.id);
          continue;
        }
        deletedIds.delete(item.id);
        upserted.set(item.id, item);

        // Folders must be registered as they stream past, because a child can appear
        // in the same page as its parent and path reconstruction needs the ancestor.
        if (item.folder && item.name) {
          this.#folders.add(item.id, item.name, item.parentReference?.id);
        }
      }

      const next = page['@odata.nextLink'];
      if (next) {
        url = next;
        continue;
      }
      nextCursor = page['@odata.deltaLink'] ?? nextCursor;
      break;
    }

    // The root of the enumeration is itself returned and is not part of the library.
    // Identify it as the one folder whose parent is not in the result set.
    const rootItem = [...upserted.values()].find(
      (i) => i.folder && i.parentReference?.id && !upserted.has(i.parentReference.id),
    );
    if (rootItem) this.#folders.setRoot(rootItem.id);

    const items: StorageItem[] = [];
    for (const item of upserted.values()) {
      if (rootItem && item.id === rootItem.id) continue;
      if (!item.name) continue;
      const path = this.#folders.pathFor(item.name, item.parentReference?.id);
      if (path === null) continue; // ancestor unknown — a later run will pick it up
      const logical = normalizePath(`${prefix}/${path}`);
      if (!item.folder) this.#pathMap.set(logical, item.id);
      items.push(this.#toStorageItem(item, logical));
    }

    return { upserted: items, deletedIds: [...deletedIds], cursor: nextCursor, full };
  }

  // ── app documents (§6.3) ─────────────────────────────────────────────────────

  /**
   * §12.1 steps 1–2: conditional GET, and a 304 costs nothing.
   *
   * Done in two stages deliberately. The `ETag` on a `/content` response comes from
   * the CDN, not the driveItem, so it is not a reliable change token. We condition on
   * the driveItem's own eTag — 1 call when unchanged (the common case, and §17's
   * < 300 ms budget), 2 calls when it actually changed.
   */
  async readAppFile(name: string, opts: { ifNoneMatch?: string } = {}): Promise<AppFileRead> {
    const path = this.#appPath(name);

    const metaRes = await this.#graph.request({
      url: `/me/drive/special/approot:/${encodePathForUrl(path)}?$select=id,eTag,size,lastModifiedDateTime`,
      headers: opts.ifNoneMatch ? { 'If-None-Match': opts.ifNoneMatch } : {},
      expect: [404],
    });

    if (metaRes.status === 304) return { notModified: true, file: null };
    if (metaRes.status === 404) return { notModified: false, file: null };

    const meta = await metaRes.json<GraphDriveItem>();
    const etag = meta.eTag ?? metaRes.headers.get('etag') ?? undefined;

    // Hand-built ETags occasionally round-trip with different quoting; compare the
    // parsed value rather than the raw header so a match isn't missed.
    if (opts.ifNoneMatch && etag && normalizeEtag(etag) === normalizeEtag(opts.ifNoneMatch)) {
      return { notModified: true, file: null };
    }

    const contentRes = await this.#graph.request({
      url: `/me/drive/items/${encodeURIComponent(meta.id)}/content`,
      expect: [404],
    });
    if (contentRes.status === 404) return { notModified: false, file: null };

    const data = await contentRes.bytes();
    return { notModified: false, file: etag ? { data, etag } : { data } };
  }

  /**
   * ETag-guarded PUT. A 412 is not an error — it is §12.2's merge path, and the
   * caller is expected to re-read, merge the outbox change-set, and PUT again.
   *
   * Special folders auto-create on first write, so there is no mkdir step.
   */
  async writeAppFile(name: string, data: Uint8Array, ifMatch?: string): Promise<{ etag: string }> {
    const path = this.#appPath(name);
    const res = await this.#graph.request({
      method: 'PUT',
      url: `/me/drive/special/approot:/${encodePathForUrl(path)}:/content`,
      headers: {
        'Content-Type': 'application/json',
        ...(ifMatch ? { 'If-Match': ifMatch } : {}),
      },
      body: toBodyInit(data),
      expect: [412],
    });

    if (res.status === 412) {
      throw new StorageError('conflict', name, {
        status: 412,
        message: `${name} changed on another device. Re-read, merge, and retry.`,
      });
    }

    const item = await res.json<GraphDriveItem>();
    return { etag: item.eTag ?? res.headers.get('etag') ?? '' };
  }

  /** One cheap Graph call — this is how the app polls `results/` for job status (§6.3). */
  async listAppFiles(prefix: string): Promise<{ name: string; modifiedAt: string }[]> {
    const path = this.#appPath(prefix);
    const url = path
      ? `/me/drive/special/approot:/${encodePathForUrl(path)}:/children?$select=name,lastModifiedDateTime&$top=999`
      : `/me/drive/special/approot/children?$select=name,lastModifiedDateTime&$top=999`;

    const res = await this.#graph.request({ url, expect: [404] });
    if (res.status === 404) return [];

    const page = await res.json<GraphCollection<GraphDriveItem>>();
    return page.value
      .filter((i) => i.name)
      .map((i) => ({ name: i.name!, modifiedAt: i.lastModifiedDateTime ?? '' }));
  }

  #appPath(name: string): string {
    return normalizePath(APP_FOLDER_PREFIX ? `${APP_FOLDER_PREFIX}/${name}` : name);
  }

  // ── mapping ──────────────────────────────────────────────────────────────────

  #toStorageItem(item: GraphDriveItem, path?: string): StorageItem {
    const hashes = item.file?.hashes;
    const out: StorageItem = {
      id: item.id,
      path: normalizePath(path ?? item.name ?? ''),
      name: item.name ?? '',
      size: item.size ?? 0,
      modifiedAt: item.lastModifiedDateTime ?? '',
    };
    // §6.0 — provider-reported, for change detection inside this package only.
    const providerHash = hashes?.quickXorHash ?? hashes?.sha256Hash ?? hashes?.sha1Hash;
    if (providerHash) out.providerHash = providerHash;
    // The `audio` facet is free on OneDrive Personal and materializes the whole
    // catalog from metadata alone — no byte of audio downloaded (§4.4).
    if (item.audio) out.audio = { ...item.audio };
    if (item.folder) out.isFolder = true;
    return out;
  }
}

function subjectOf(ref: StorageRef): string {
  return isPathRef(ref) ? ref.path : ref.id;
}

function normalizeEtag(etag: string): string {
  return etag.replace(/^W\//, '').replace(/"/g, '').trim();
}

/**
 * `fetch` accepts a Uint8Array body on Node and on React Native, but the DOM lib's
 * `BodyInit` union does not name it. Narrow once, here, rather than at each call.
 */
function toBodyInit(data: Uint8Array): BodyInit {
  return data as unknown as BodyInit;
}
