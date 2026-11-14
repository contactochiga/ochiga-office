// Initialization plan for DISPOSABLE test databases: the approved manifest (db/migration-order.txt), never filename
// order. It starts with the security baseline, runs the schema once, applies the dated migrations with Track B as
// inbound -> staff_replies -> dispatch_fence, re-applies the baseline and ends with the verification gate.
// A test that exercises one migration itself (apply, re-apply, rollback) excludes it here and applies it afterwards.
"use strict";

const path = require("node:path");
const { migrationOrder } = require("./init-office-database");

function fixtureFiles(exclude = []) {
  const skip = new Set(exclude.map((file) => path.basename(file)));
  const order = migrationOrder();
  for (const file of skip) if (!order.includes(file)) throw new Error(`fixture exclusion ${file} is not in db/migration-order.txt`);
  return order.filter((file) => !skip.has(file));
}

module.exports = { fixtureFiles };
