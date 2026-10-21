const H = require("./harness");
(async () => {
  const mail = await H.startMailCapture();
  const srv = await H.makeServer({ mail });
  try {
    const hz = await fetch(srv.base + "/healthz").then((r) => r.json());
    console.log("healthz", JSON.stringify(hz.mfa), hz.ready);
    const admin = await H.adminLogin(srv);
    const p = await H.newPerson(admin, {});
    console.log("enrolled", p.secret, p.recovery.length);
    const s = await p.signIn();
    console.log("signin", s.login.status, JSON.stringify(s.login.body).slice(0, 200), s.res.status, JSON.stringify(s.res.body).slice(0, 300));
    const me = await s.client.get(H.A + "/session/me");
    console.log("me", me.status, JSON.stringify(me.body.mfa));
    console.log("mail", mail.messages.map((m) => m.subject));
    const w = await H.registerWebauthn(p, s.client, srv, {});
    console.log("webauthn", w.ok, w.ok ? "" : JSON.stringify(w).slice(0, 500));
  } finally { await srv.stop(); await mail.close(); H.rmrf(srv.dir); }
})().catch((e) => { console.error(e); process.exit(1); });
