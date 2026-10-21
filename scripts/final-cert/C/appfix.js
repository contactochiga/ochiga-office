"use strict";
// AREA C shared application-level fixture: Supabase Postgres 17 + PostgREST + fault proxy(ies) + one or more real application servers.
const L = require("./lib");

/** Build the stack. proxies: number of independent fault proxies (one per app instance). */
async function buildStack(suite, { tag = "app", instances = 1, mfa = true, extraEnv = {}, appEnvFor, suts } = {}) {
  const st = await L.DbStack.create({ kind: "supabase17", tag, postgrest: true, suite });
  st.applyAll();
  await st.settle(async () => (await st.rpc("service_role", "office_mfa_schema_version")).json === 1);
  const admin = st.session();
  const sessionSecret = L.SESSION_SECRET();
  const apiKey = L.API_KEY();
  const fx = { st, admin, sessionSecret, apiKey, apps: [], proxies: [], mfa };
  for (let i = 0; i < instances; i++) {
    const proxy = await new L.FaultProxy(st.url).start();
    suite.onCleanup(() => proxy.stop());
    const env = L.appEnv({ restUrl: proxy.url, serviceJwt: st.jwt("service_role"), sessionSecret, mfa, apiKey, extra: { ...extraEnv, ...(appEnvFor ? appEnvFor(i) : {}) } });
    const app = await L.AppServer.start({ sut: (suts && suts[i]) || L.SUT, env, name: `app${i}`, suite });
    fx.apps.push(app); fx.proxies.push(proxy);
  }
  fx.app = fx.apps[0]; fx.proxy = fx.proxies[0];
  fx.client = (i = 0, o) => new L.Client(fx.apps[i].url, o);
  return fx;
}

/** Seed an account and (optionally) enrol TOTP through the real routes. Returns { user, client, totp, recoveryCodes }. */
async function accountWithTotp(fx, { role = "super_admin", appIndex = 0, enrol = true } = {}) {
  const user = await L.seedUser(fx.admin, { role });
  const c = fx.client(appIndex);
  const l = await c.login(user.email, user.password);
  if (l.status !== 200 || !l.cookie) throw new Error(`fixture login failed: ${l.status} ${l.text.slice(0, 200)}`);
  let e = null;
  if (enrol) e = await L.enrollTotp(c, user.password);
  return { user, client: c, enrolment: e, totp: e && e.totp, recoveryCodes: e ? e.recoveryCodes : [] };
}

/** Rows of a table through the superuser session. */
const rows = (fx, sql) => fx.admin.json(sql);

module.exports = { buildStack, accountWithTotp, rows };
