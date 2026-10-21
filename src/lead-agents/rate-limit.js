class MemoryRateLimiter {
  constructor({ windowMs, maxRequests }) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.buckets = new Map();
  }

  keyFromRequest(req) {
    // R6: never the raw X-Forwarded-For (client-controlled). The server sets req.clientAddress from the trusted-proxy boundary.
    return req.clientAddress || req.socket.remoteAddress || "unknown";
  }

  check(req) {
    return this.checkKey(this.keyFromRequest(req));
  }

  checkKey(key) {
    const safeKey = String(key || "unknown");
    const now = Date.now();
    const current = this.buckets.get(safeKey);

    if (!current || current.resetAt <= now) {
      this.buckets.set(safeKey, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      return {
        remaining: this.maxRequests - 1,
        resetAt: now + this.windowMs,
      };
    }

    if (current.count >= this.maxRequests) {
      const error = new Error("rate_limit_exceeded");
      error.statusCode = 429;
      error.rateLimit = {
        remaining: 0,
        resetAt: current.resetAt,
      };
      throw error;
    }

    current.count += 1;
    return {
      remaining: this.maxRequests - current.count,
      resetAt: current.resetAt,
    };
  }

  resetKey(key) {
    this.buckets.delete(String(key || "unknown"));
  }

  // R1: failure-only counters. `hit` records one event without ever throwing; `isLimited` reads without recording. Both use the same window as `checkKey`.
  hit(key) {
    const safeKey = String(key || "unknown");
    const now = Date.now();
    const current = this.buckets.get(safeKey);
    if (!current || current.resetAt <= now) {
      this.buckets.set(safeKey, { count: 1, resetAt: now + this.windowMs });
      return 1;
    }
    current.count += 1;
    return current.count;
  }

  isLimited(key) {
    const current = this.buckets.get(String(key || "unknown"));
    return Boolean(current && current.resetAt > Date.now() && current.count >= this.maxRequests);
  }

  resetAtOf(key) {
    const current = this.buckets.get(String(key || "unknown"));
    return current ? current.resetAt : Date.now() + this.windowMs;
  }
}

module.exports = {
  MemoryRateLimiter,
};
