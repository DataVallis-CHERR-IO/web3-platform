/**
 * In-memory sliding window rate limiter per container.
 * Extracts client IP from X-Forwarded-For as set by kamal-proxy (last entry).
 */

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
}

export function getClientIp(request: Request): string {
  const xForwardedFor = request.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const entries = xForwardedFor.split(",");
    const lastIp = entries[entries.length - 1]?.trim();
    if (lastIp) return lastIp;
  }
  const xRealIp = request.headers.get("x-real-ip");
  if (xRealIp) return xRealIp.trim();
  return "127.0.0.1";
}

class MemoryRateLimiter {
  private requests: Map<string, number[]> = new Map();
  private checkCount: number = 0;

  check(key: string, options: RateLimitOptions): RateLimitResult {
    const now = Date.now();
    const windowStart = now - options.windowMs;

    this.checkCount++;
    if (this.checkCount % 100 === 0 || this.requests.size > 10000) {
      this.prune(windowStart);
    }

    const timestamps = this.requests.get(key) ?? [];
    const validTimestamps = timestamps.filter((t) => t > windowStart);

    if (validTimestamps.length >= options.maxRequests) {
      const oldestInWindow = validTimestamps[0] ?? now;
      const reset = Math.ceil((oldestInWindow + options.windowMs - now) / 1000);

      this.requests.set(key, validTimestamps);
      return {
        success: false,
        limit: options.maxRequests,
        remaining: 0,
        reset: Math.max(reset, 1),
      };
    }

    validTimestamps.push(now);
    this.requests.set(key, validTimestamps);

    return {
      success: true,
      limit: options.maxRequests,
      remaining: options.maxRequests - validTimestamps.length,
      reset: Math.ceil(options.windowMs / 1000),
    };
  }

  private prune(windowStart: number): void {
    for (const [k, timestamps] of this.requests.entries()) {
      const valid = timestamps.filter((t) => t > windowStart);
      if (valid.length === 0) {
        this.requests.delete(k);
      } else {
        this.requests.set(k, valid);
      }
    }
  }

  reset(): void {
    this.requests.clear();
    this.checkCount = 0;
  }
}

export const authRateLimiter = new MemoryRateLimiter();
export const filesRateLimiter = new MemoryRateLimiter();

/** Private file uploads: 30 requests per minute per user */
export const FILES_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 30,
};

/** Default rate limit configuration for /api/auth/session: 20 requests per minute */
export const AUTH_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 20,
};

export const applicationRateLimiter = new MemoryRateLimiter();

/** Organisation applications: 10 requests per minute per user */
export const APPLICATION_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 10,
};

export const mediaRateLimiter = new MemoryRateLimiter();

/** Campaign media (ADR-039): 30 requests per minute per user — a gallery of 10 images fits in one go. */
export const MEDIA_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 30,
};

export const preferencesRateLimiter = new MemoryRateLimiter();

/** Display preferences (ADR-040): 30 changes per minute per client IP. */
export const PREFERENCES_RATE_LIMIT: RateLimitOptions = {
  windowMs: 60 * 1000,
  maxRequests: 30,
};
