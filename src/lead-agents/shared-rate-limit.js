"use strict";
// R6 (H3/H4): rate-limit counters that survive more than one process. Same surface as MemoryRateLimiter (checkKey / hit / isLimited / resetKey / resetAtOf) but asynchronous.
//   - With a store that implements rateLimit* (Supabase + db/20261028_shared_rate_limits.sql) the counters live in Postgres, so every instance sees the same budget.
//   - Without it (file store, or the migration not applied yet) the counters are PER PROCESS and `scope()` says so: this is reported, never presented as distributed protection.
//   - A store that claims the capability but fails is FAIL-CLOSED: callers receive `rate_limit_store_error` and answer 503; a counter that cannot be read never means "allow".
// Keys are never stored raw: they are HMAC-SHA256 digests under the session secret, so the table holds no e-mail address and no network address.
const crypto = require("node:crypto");
const { MemoryRateLimiter } = require("./rate-limit");

class SharedRateLimiter {
  constructor({ store, namespace, windowMs, maxRequests, secret }) {
    this.store = store;
    this.namespace = String(namespace || "rl");
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.secret = String(secret || "");
    this.memory = new MemoryRateLimiter({ windowMs, maxRequests });
  }

  digest(key) { return crypto.createHmac("sha256", this.secret).update(`${this.namespace}|${String(key || "unknown")}`).digest("hex"); }

  async shared() {
    const s = this.store;
    if (!s || typeof s.supportsSharedRateLimit !== "function") return false;
    try { return (await s.supportsSharedRateLimit()) === true; } catch { throw this.storeError(); }
  }

  storeError() { const e = new Error("rate_limit_store_error"); e.code = "rate_limit_store_error"; return e; }

  /** "shared" (all instances) or "process" (this process only). */
  async scope() { try { return (await this.shared()) ? "shared" : "process"; } catch { return "unavailable"; } }

  async call(op, key) {
    try { return await this.store.rateLimitOp(op, this.digest(key), Math.max(1, Math.ceil(this.windowMs / 1000))); } catch { throw this.storeError(); }
  }

  async checkKey(key) {
    if (!(await this.shared())) return this.memory.checkKey(key);
    const { hits, resetAt } = await this.call("hit", key);
    if (hits > this.maxRequests) {
      const error = new Error("rate_limit_exceeded");
      error.statusCode = 429;
      error.rateLimit = { remaining: 0, resetAt };
      throw error;
    }
    return { remaining: this.maxRequests - hits, resetAt };
  }

  async hit(key) {
    if (!(await this.shared())) return this.memory.hit(key);
    return (await this.call("hit", key)).hits;
  }

  async isLimited(key) {
    if (!(await this.shared())) return this.memory.isLimited(key);
    const { hits } = await this.call("peek", key);
    return hits >= this.maxRequests;
  }

  async resetAtOf(key) {
    if (!(await this.shared())) return this.memory.resetAtOf(key);
    const { resetAt } = await this.call("peek", key);
    return resetAt || Date.now() + this.windowMs;
  }

  async resetKey(key) {
    if (!(await this.shared())) return this.memory.resetKey(key);
    await this.call("reset", key);
    return undefined;
  }
}

module.exports = { SharedRateLimiter };
