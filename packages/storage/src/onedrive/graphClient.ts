/**
 * The Microsoft Graph HTTP client — SPEC §4.4.
 *
 * ⚠️ THE OPERATIONAL RISK IS THROTTLING, AND IT CORRELATES WITH CONCURRENCY, NOT
 * VOLUME. rclone users syncing 10,000 small files hit `Retry-After: 322` — a 5m22s
 * enforced pause. The fix that worked was going fully serial. Hence, non-negotiably:
 *
 *   • max concurrency 3 against Graph, enforced here rather than by convention;
 *   • `Retry-After` honoured EXACTLY, and applied as a global gate — one 429 pauses
 *     every request, because the limit is per-app, not per-request;
 *   • exponential backoff with jitter for everything else.
 *
 * This file, and this file only, knows what a Graph URL looks like (§7.2 rule 1 /
 * acceptance criterion 18).
 */
import { StorageError, classifyHttp } from '../errors.js';
import type { TokenProvider } from '../types.js';

export const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

/** §4.4: hard rule, max 3 concurrent requests against Graph. */
const MAX_CONCURRENCY = 3;
const MAX_ATTEMPTS = 4;

export interface GraphRequest {
  method?: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
  /** Absolute URL, or a path appended to the Graph root. */
  url: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  /** Statuses to return rather than throw on — e.g. 404 for probe reads, 412 for merges. */
  expect?: number[];
  signal?: AbortSignal;
}

export interface GraphResponse {
  status: number;
  headers: Headers;
  /** Absent for 204/304 and for the statuses named in `expect`. */
  json<T>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
  raw: Response;
}

/** Reports throttling upward so §16's "Syncing paused, resuming in 5 min" can be shown. */
export type ThrottleListener = (info: { retryAfterSec: number; url: string }) => void;

export class GraphClient {
  #tokens: TokenProvider;
  #inFlight = 0;
  #waiters: Array<() => void> = [];
  /** Epoch ms. While in the future, every request waits — the limit is per-app. */
  #gateUntil = 0;
  #onThrottle: ThrottleListener | undefined;

  constructor(tokens: TokenProvider, opts: { onThrottle?: ThrottleListener } = {}) {
    this.#tokens = tokens;
    this.#onThrottle = opts.onThrottle;
  }

  /** Epoch ms until which requests are gated, or 0. Surfaced in Settings → diagnostics. */
  get throttledUntil(): number {
    return this.#gateUntil > Date.now() ? this.#gateUntil : 0;
  }

  async request(req: GraphRequest): Promise<GraphResponse> {
    await this.#acquire();
    try {
      return await this.#attempt(req, 1);
    } finally {
      this.#release();
    }
  }

  async #attempt(req: GraphRequest, attempt: number): Promise<GraphResponse> {
    await this.#waitForGate(req.signal);

    const url = req.url.startsWith('http') ? req.url : `${GRAPH_ROOT}${req.url}`;
    const token = await this.#tokens.getAccessToken();

    let res: Response;
    try {
      res = await fetch(url, {
        method: req.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(req.headers ?? {}),
        },
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (cause) {
      // fetch only rejects on transport failure — DNS, TLS, no route. That is
      // "offline", and §11.4 depends on it being distinguishable from a 403.
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        return this.#attempt(req, attempt + 1);
      }
      throw new StorageError('offline', url, { cause });
    }

    if (res.ok || res.status === 304 || (req.expect?.includes(res.status) ?? false)) {
      return wrap(res);
    }

    const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'));

    // 429/503 — gate everything, then retry. Honour the header exactly; do not
    // second-guess it with a shorter backoff.
    if ((res.status === 429 || res.status === 503) && attempt < MAX_ATTEMPTS) {
      const waitSec = retryAfterSec ?? backoffMs(attempt) / 1000;
      this.#gateUntil = Math.max(this.#gateUntil, Date.now() + waitSec * 1000);
      this.#onThrottle?.({ retryAfterSec: waitSec, url });
      await sleep(waitSec * 1000);
      return this.#attempt(req, attempt + 1);
    }

    if (res.status === 401 && attempt < MAX_ATTEMPTS) {
      this.#tokens.invalidate?.();
      return this.#attempt(req, attempt + 1);
    }

    if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
      await sleep(backoffMs(attempt));
      return this.#attempt(req, attempt + 1);
    }

    const detail = await safeText(res);
    throw new StorageError(classifyHttp(res.status, retryAfterSec), url, {
      status: res.status,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      message: `Graph ${res.status} on ${redact(url)}${detail ? `: ${detail}` : ''}`,
    });
  }

  async #waitForGate(signal?: AbortSignal): Promise<void> {
    const remaining = this.#gateUntil - Date.now();
    if (remaining > 0) await sleep(remaining, signal);
  }

  async #acquire(): Promise<void> {
    if (this.#inFlight < MAX_CONCURRENCY) {
      this.#inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#inFlight++;
  }

  #release(): void {
    this.#inFlight--;
    const next = this.#waiters.shift();
    if (next) next();
  }
}

function wrap(res: Response): GraphResponse {
  return {
    status: res.status,
    headers: res.headers,
    json: <T>() => res.json() as Promise<T>,
    bytes: async () => new Uint8Array(await res.arrayBuffer()),
    raw: res,
  };
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both occur in the wild. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, (date - Date.now()) / 1000);
  return undefined;
}

/** Full jitter, capped at 30 s. */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(30_000, 500 * 2 ** attempt);
  return Math.random() * ceiling;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new StorageError('unknown', undefined, { message: 'Aborted' }));
      },
      { once: true },
    );
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 400);
  } catch {
    return '';
  }
}

/**
 * Delta and download URLs carry tokens in the query string. Strip them before any
 * message that could reach a log or the UI.
 */
function redact(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?…`;
}
