/**
 * Identifier generation — SPEC §12.5 ("UUIDv7 PKs generated client-side").
 *
 * UUIDv7 is time-ordered, so it doubles as a creation-order key and keeps SQLite
 * B-tree inserts append-mostly. Once assigned, an id NEVER changes (§9.2 step 6) —
 * `feast-ingest` persists an `id ↔ contentHash` map so re-imports are stable and the
 * user's ratings never orphan.
 */

const HEX = '0123456789abcdef';

/**
 * `crypto.getRandomValues` where the runtime has it; a degraded fallback otherwise.
 *
 * Typed structurally rather than as `Crypto`, because this package compiles without
 * the DOM lib (it also runs in Node) and both runtimes expose the same one method.
 */
function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  // Reached only on a runtime without WebCrypto. Ids stay unique enough for a
  // single-user library because the 48-bit timestamp prefix already separates them.
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += HEX[b >> 4]! + HEX[b & 0x0f]!;
  return s;
}

/**
 * UUIDv7: 48-bit big-endian millisecond timestamp, 4-bit version, 12 bits random,
 * 2-bit variant, 62 bits random.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  const ts = Math.floor(now);
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10

  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * A short, stable per-install id. It suffixes every fractional `orderKey` (§12.4) —
 * two devices independently generating a key between the same neighbours produce the
 * *same* key, and the suffix is what restores a total order.
 */
export function newDeviceId(): string {
  return hex(randomBytes(6));
}

/** Slugify a collection/series name into an id. */
export function slugify(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
