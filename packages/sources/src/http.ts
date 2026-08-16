/**
 * Shared fetch discipline for every adapter — SPEC §8, §20.1.
 *
 * ⚠️ This file is a commitment, not a utility. §20.1 is explicit that the Church's
 * terms permit personal downloading and prohibit automated access, and that BYU
 * publishes no terms at all — "absence of a prohibition is not a grant". The posture
 * that makes this defensible is: ask rarely, identify honestly, never re-ask for what
 * we already have, and stop the moment we're told to.
 *
 * Every rule here exists because of a specific finding:
 *
 *  • Concurrency 1 for polite sources. §4.4: rclone users syncing 10,000 small files
 *    hit `Retry-After: 322`, and the maintainer's diagnosis was that severity
 *    correlates with CONCURRENCY, not volume. Serial is the fix that worked.
 *  • ≥1,000 ms between requests to the same host.
 *  • An identifying User-Agent with a contact address, so a publisher who objects can
 *    reach a human instead of silently blocking a range.
 *  • Conditional requests, so a re-run of a 6,000-item index costs almost nothing.
 *  • `Retry-After` honoured exactly, never approximated.
 */

export interface FetchOptions {
  /** Cached ETag from a previous run; sends If-None-Match. */
  etag?: string;
  /** Cached Last-Modified; sends If-Modified-Since. */
  lastModified?: string;
  signal?: AbortSignal;
}

export interface FetchResult<T> {
  /** null when the server answered 304 — the caller should reuse its cached copy. */
  data: T | null;
  notModified: boolean;
  etag?: string;
  lastModified?: string;
}

export interface PoliteClientOptions {
  /** Minimum gap between requests to the same host. */
  minIntervalMs?: number;
  /** Hard ceiling per run, so a bug cannot turn into a crawl. */
  dailyRequestLimit?: number;
  userAgent: string;
}

/*
 * ⚠️ Fields are declared and assigned explicitly rather than using TypeScript's
 * `constructor(readonly x: number)` shorthand. Node runs this package directly under
 * `--experimental-strip-types`, which ERASES types but performs no transformation —
 * and parameter properties are the one common syntax that needs transforming, so they
 * fail at load with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. The mobile app never hits this
 * because Babel compiles it properly; only the CLI does.
 */
export class RateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Rate limited; retry after ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class RequestCeilingError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`Request ceiling of ${limit} reached for this run. Re-run later to continue.`);
    this.name = 'RequestCeilingError';
    this.limit = limit;
  }
}

/**
 * One serial, rate-limited HTTP client per host.
 *
 * Requests queue rather than run concurrently — see the concurrency note above.
 */
export class PoliteClient {
  private readonly minInterval: number;
  private readonly limit: number;
  private readonly userAgent: string;
  private lastRequestAt = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private count = 0;

  constructor(opts: PoliteClientOptions) {
    this.minInterval = opts.minIntervalMs ?? 1_000;
    this.limit = opts.dailyRequestLimit ?? 10_000;
    this.userAgent = opts.userAgent;
  }

  get requestsMade(): number {
    return this.count;
  }

  /** Serialise everything through one promise chain: never two requests in flight. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // Swallow rejections on the chain itself so one failure cannot poison the queue.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async pace(host: string): Promise<void> {
    const last = this.lastRequestAt.get(host) ?? 0;
    const wait = this.minInterval - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt.set(host, Date.now());
  }

  async getJson<T>(url: string, opts: FetchOptions = {}): Promise<FetchResult<T>> {
    return this.enqueue(async () => {
      if (this.count >= this.limit) throw new RequestCeilingError(this.limit);

      const host = new URL(url).host;
      await this.pace(host);

      const headers: Record<string, string> = {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      };
      if (opts.etag) headers['If-None-Match'] = opts.etag;
      if (opts.lastModified) headers['If-Modified-Since'] = opts.lastModified;

      this.count += 1;
      const res = await fetch(url, {
        headers,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      if (res.status === 304) {
        return { data: null, notModified: true };
      }

      if (res.status === 429 || res.status === 503) {
        // Honour the number they gave us, exactly. Guessing shorter is how a temporary
        // throttle becomes a block.
        const retryAfter = res.headers.get('retry-after');
        const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : 60;
        throw new RateLimitError((Number.isFinite(seconds) ? seconds : 60) * 1000);
      }

      if (!res.ok) {
        throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as T;
      const result: FetchResult<T> = { data, notModified: false };
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      if (etag) result.etag = etag;
      if (lastModified) result.lastModified = lastModified;
      return result;
    });
  }

  async getText(url: string, opts: FetchOptions = {}): Promise<string> {
    return this.enqueue(async () => {
      if (this.count >= this.limit) throw new RequestCeilingError(this.limit);
      const host = new URL(url).host;
      await this.pace(host);
      this.count += 1;
      const res = await fetch(url, {
        headers: { 'User-Agent': this.userAgent },
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
      return res.text();
    });
  }
}

/** Retry with backoff and jitter, obeying RateLimitError's own delay when present. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (e instanceof RequestCeilingError) throw e;
      const base = e instanceof RateLimitError ? e.retryAfterMs : 1000 * 2 ** i;
      const jitter = Math.floor(base * 0.2);
      await new Promise((r) => setTimeout(r, base + jitter));
    }
  }
  throw lastError;
}
