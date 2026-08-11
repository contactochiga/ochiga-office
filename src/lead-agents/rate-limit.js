class MemoryRateLimiter {
  constructor({ windowMs, maxRequests }) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.buckets = new Map();
  }

  keyFromRequest(req) {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    return forwarded || req.socket.remoteAddress || "unknown";
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
}

module.exports = {
  MemoryRateLimiter,
};
