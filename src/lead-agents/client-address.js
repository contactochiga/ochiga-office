"use strict";
// R6 (H3): the ONE place where X-Forwarded-For is read. A client can put anything in that header; only the entries appended by proxies WE operate are trustworthy,
// and a proxy appends the address it saw to the RIGHT. With N trusted proxy hops in front of the application the client address is therefore the N-th entry from the
// right. N = 0 (the default) trusts nothing: the TCP peer address is used and the header is ignored, so rotating or forging it cannot create a new rate-limit identity.
// A chain shorter than N (a request that did not pass through every expected proxy) is not trusted either: the peer address is used.
const net = require("node:net");

const MAX_HOPS = 8;

function parseTrustedProxyHops(value) {
  if (value === undefined || value === null || String(value).trim() === "") return { hops: 0, valid: true };
  const text = String(value).trim();
  if (!/^\d{1,2}$/.test(text)) return { hops: 0, valid: false };
  const hops = Number(text);
  return hops <= MAX_HOPS ? { hops, valid: true } : { hops: 0, valid: false };
}

function normalizeAddress(raw) {
  let text = String(raw || "").trim();
  if (!text || text.length > 64) return "";
  if (text.startsWith("[") && text.includes("]")) text = text.slice(1, text.indexOf("]")); // [v6]:port
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(":")); // v4:port
  if (text.toLowerCase().startsWith("::ffff:") && net.isIPv4(text.slice(7))) text = text.slice(7);
  return net.isIP(text) ? text.toLowerCase() : "";
}

function peerAddress(req) {
  return normalizeAddress(req && req.socket && req.socket.remoteAddress) || "unknown";
}

/** Address used for every per-network limit and audit record. Never throws; never returns attacker-chosen free text. */
function resolveClientAddress(req, trustedHops = 0) {
  const hops = Number.isInteger(trustedHops) && trustedHops > 0 ? Math.min(trustedHops, MAX_HOPS) : 0;
  if (hops === 0) return peerAddress(req);
  const header = req && req.headers ? req.headers["x-forwarded-for"] : "";
  const chain = (Array.isArray(header) ? header.join(",") : String(header || "")).split(",").map((part) => part.trim()).filter(Boolean);
  if (chain.length < hops) return peerAddress(req);
  return normalizeAddress(chain[chain.length - hops]) || peerAddress(req);
}

module.exports = { resolveClientAddress, parseTrustedProxyHops, MAX_HOPS };
