/**
 * The date codec — SPEC §6.0.
 *
 * `catalog.json` and `state.json` use ISO-8601 strings. SQLite stores epoch
 * milliseconds (INTEGER). **Every conversion goes through this file and nowhere else.**
 *
 * The one exception is `ListenState.updatedAt` and every other `updatedAt` /
 * `deletedAt`, which are epoch-ms *everywhere* because they are logical clocks
 * rather than dates. Those need no conversion — do not route them through here.
 */

/** ISO-8601 → epoch ms. Returns null for null/undefined/unparseable input. */
export function isoToEpoch(iso: string | null | undefined): number | null {
  if (iso == null || iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** ISO-8601 → epoch ms, throwing on bad input. For fields the schema says are required. */
export function isoToEpochRequired(iso: string): number {
  const ms = isoToEpoch(iso);
  if (ms === null) throw new TypeError(`Not an ISO-8601 date: ${JSON.stringify(iso)}`);
  return ms;
}

/** Epoch ms → ISO-8601 (UTC, `Z`-suffixed). Returns undefined for null/undefined. */
export function epochToIso(ms: number | null | undefined): string | undefined {
  if (ms == null) return undefined;
  return new Date(ms).toISOString();
}

/** Epoch ms → ISO-8601, throwing on null. */
export function epochToIsoRequired(ms: number): string {
  return new Date(ms).toISOString();
}

/** SQLite has no boolean type; it stores 0/1. */
export function boolToInt(b: boolean | null | undefined): number {
  return b ? 1 : 0;
}

export function intToBool(n: number | null | undefined): boolean {
  return n === 1;
}

/** JSON columns (`aliases`, `original_paths`, `flags`) round-trip through these. */
export function jsonToText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function textToJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(text);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}
