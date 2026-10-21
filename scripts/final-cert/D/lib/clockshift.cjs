"use strict";
// Test-harness preload for the SUT child process (the SUT is never modified): lets the harness move the server's clock FORWARD
// (to exercise expiry, grace periods and lock windows deterministically). The offset in ms is read from CLOCK_OFFSET_FILE.
const fs = require("fs");
const RealDate = Date;
let cached = 0, at = 0;
function off() {
  const t = RealDate.now();
  if (t - at > 15) { at = t; try { cached = Number(fs.readFileSync(process.env.CLOCK_OFFSET_FILE, "utf8")) || 0; } catch { cached = 0; } }
  return cached;
}
class ShiftDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + off()); else super(...a); }
  static now() { return RealDate.now() + off(); }
}
globalThis.Date = ShiftDate;
