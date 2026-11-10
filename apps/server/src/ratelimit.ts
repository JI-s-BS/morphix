// Fixed-window rate limiter keyed by IP or user. In memory; resets on restart.

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit. Returns false when the key is over its limit for this window. */
  hit(key: string): boolean {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) {
      if (this.hits.size > 10_000) this.sweep(t);
      e = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    return e.count <= this.limit;
  }

  retryAfterSec(key: string): number {
    const e = this.hits.get(key);
    return e ? Math.max(1, Math.ceil((e.resetAt - this.now()) / 1000)) : 1;
  }

  private sweep(t: number): void {
    for (const [k, e] of this.hits) if (e.resetAt <= t) this.hits.delete(k);
  }
}
