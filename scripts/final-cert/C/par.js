"use strict";
// Parallel database connections released together (advisory-lock barrier). Own implementation (output of the unlock is discarded with \gset so a worker's rows are exactly its own).
const crypto = require("crypto");
const L = require("./lib");

/** n separate connections each run perSession(i) (SQL text) at the same moment. Returns the parsed result of each ({rows, error}). */
async function barrier(stack, n, perSession, { user = "postgres", key = 700000 + crypto.randomInt(0, 90000), lockTimeout = "60s" } = {}) {
  const ctl = stack.session({ user });
  await ctl.scalar(`select pg_advisory_lock(${key})`);
  const workers = await Promise.all(Array.from({ length: n }, async () => { const w = stack.session({ user }); await w.query("select 1"); return w; }));
  const pending = workers.map((w, i) => w.send(`select pg_advisory_lock_shared(${key});\n\\echo @@GO\nset lock_timeout = '${lockTimeout}';\n${perSession(i)}\n;\nselect pg_advisory_unlock_shared(${key}) as _u \\gset`));
  await L.waitFor(async () => Number(await ctl.scalar(`select count(*) from pg_locks where locktype='advisory' and not granted and objid=${key}`)) >= n, { timeoutMs: 60000, intervalMs: 50, what: "all workers waiting on the barrier" });
  await ctl.query(`select pg_advisory_unlock(${key})`);
  const raws = await Promise.all(pending);
  await Promise.all(workers.map((w) => w.close())); await ctl.close();
  return raws.map((raw) => L.PsqlSession.parse(raw.slice(raw.indexOf("@@GO\n") + 5)));
}
const first = (r) => (r.rows[0] ? r.rows[0][0] : undefined);
const trues = (rs) => rs.filter((r) => !r.error && first(r) === "t").length;
const errors = (rs) => rs.filter((r) => r.error);
const errCodes = (rs) => errors(rs).map((r) => r.error.code + ":" + r.error.message.slice(0, 60));
const withRows = (rs) => rs.filter((r) => !r.error && r.rows.length > 0).length;

module.exports = { barrier, first, trues, errors, errCodes, withRows };
