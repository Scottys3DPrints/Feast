/**
 * Storage errors — provider-neutral by design.
 *
 * §16 requires honest, actionable errors ("Couldn't reach OneDrive. This talk isn't
 * downloaded — try again on Wi-Fi, or pin it for later."). That is only possible if
 * the UI can tell the failure modes apart, so the provider classifies them here
 * rather than leaking an HTTP status upward.
 */

export type StorageErrorCode =
  /** The logical path resolved to nothing. §7.1 step 3 — mark the talk `missing_since`. */
  | 'not-found'
  /** Token missing, expired beyond refresh, or revoked. Re-prompt interactively. */
  | 'unauthorized'
  /** A signed URL expired mid-stream. Normal, not exceptional — see §11.4. */
  | 'url-expired'
  /** 429/503 with Retry-After. §16: surface it, never spin silently. */
  | 'throttled'
  /** ETag mismatch on a guarded PUT — the 412 merge path of §12.2. */
  | 'conflict'
  /** No usable network. Distinguished from throttling so §11.4 doesn't burn a re-mint. */
  | 'offline'
  /** Anything else. */
  | 'unknown';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  /** The logical path or app-file name involved, when there is one. */
  readonly subject?: string;
  /** Seconds, from a `Retry-After` header. Honour it exactly (§4.4). */
  readonly retryAfterSec?: number;
  readonly status?: number;

  constructor(
    code: StorageErrorCode,
    subject?: string,
    opts: { retryAfterSec?: number; status?: number; message?: string; cause?: unknown } = {},
  ) {
    super(opts.message ?? defaultMessage(code, subject), opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'StorageError';
    this.code = code;
    if (subject !== undefined) this.subject = subject;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
    if (opts.status !== undefined) this.status = opts.status;
  }

  static is(e: unknown, code?: StorageErrorCode): e is StorageError {
    return e instanceof StorageError && (code === undefined || e.code === code);
  }
}

function defaultMessage(code: StorageErrorCode, subject?: string): string {
  const at = subject ? ` (${subject})` : '';
  switch (code) {
    case 'not-found':
      return `This file has moved or been removed${at}. Re-run \`feast import\`.`;
    case 'unauthorized':
      return `Your Microsoft sign-in has expired. Sign in again to keep streaming.`;
    case 'url-expired':
      return `The download link expired${at}. Retrying.`;
    case 'throttled':
      return `OneDrive is rate-limiting requests. Syncing is paused and will resume.`;
    case 'conflict':
      return `Another device changed this first${at}. Merging.`;
    case 'offline':
      return `Couldn't reach OneDrive${at}. Check your connection.`;
    default:
      return `Storage request failed${at}.`;
  }
}

/** Map an HTTP response onto the taxonomy above. */
export function classifyHttp(status: number, retryAfterSec?: number): StorageErrorCode {
  if (status === 404 || status === 410) return 'not-found';
  if (status === 401) return 'unauthorized';
  // 403 on a *download URL* means the signature expired; 403 on Graph means no
  // permission. The caller passes the right subject so the UI can tell them apart.
  if (status === 403) return 'url-expired';
  if (status === 412) return 'conflict';
  if (status === 429 || status === 503 || status === 509) return 'throttled';
  if (retryAfterSec !== undefined) return 'throttled';
  return 'unknown';
}
