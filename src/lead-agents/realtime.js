const REALTIME_EVENT_NAMES = Object.freeze([
  "device.status.updated",
  "visitor.created",
  "support.ticket.created",
  "support.ticket.assigned",
  "wallet.funded",
  "estate.updated",
  "office.notification",
  "office.message",
  "edge.heartbeat",
  "twin.state.updated",
  "audit.recorded",
]);

function createRealtimeHub() {
  const clients = new Set();

  function send(res, event, payload) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload || {})}\n\n`);
  }

  return {
    eventNames: REALTIME_EVENT_NAMES,
    add(res, session, filter = {}) {
      const client = { res, session, filter };
      clients.add(client);
      send(res, "ready", {
        message: "ochiga_realtime_ready",
        email: session?.email || "",
        role: session?.role || "",
        ts: new Date().toISOString(),
      });
      return () => clients.delete(client);
    },
    // options.recipients (array of staff emails) restricts delivery to
    // matching connected sessions — used for per-user notifications so a
    // private event never reaches every connected client. Omit it (as
    // every pre-existing caller does) for genuine broadcast events;
    // behavior for those is unchanged.
    publish(event, payload = {}, options = {}) {
      const data = { ...payload, event, ts: new Date().toISOString() };
      const recipients = Array.isArray(options.recipients) ? options.recipients : null;
      for (const client of clients) {
        if (recipients && !recipients.includes(client.session?.email)) continue;
        try {
          send(client.res, event, data);
        } catch {
          clients.delete(client);
        }
      }
      return data;
    },
    stats() {
      return { clients: clients.size, events: REALTIME_EVENT_NAMES };
    },
  };
}

module.exports = {
  REALTIME_EVENT_NAMES,
  createRealtimeHub,
};
