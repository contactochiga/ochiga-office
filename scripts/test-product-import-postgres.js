"use strict";
// Disposable embedded PostgreSQL (PGlite); deliberately does not use the shared Docker environment.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { extract } = require("../src/lead-agents/product-import-extract");
const { validateContent } = require("../src/lead-agents/catalogue");
const { workbook, rows } = require("./test-product-import");
async function main() {
  const db = new PGlite(); let checks = 0;
  const pass = (s) => { checks++; console.log(`PASS ${s}`); };
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create table office_files(id text primary key, filename text);");
    for (const filename of ["20261102_catalogue_foundation.sql", "20261103_catalogue_archived_review_guard.sql", "20261104_catalogue_media.sql", "20261105_catalogue_public_release.sql", "20261106_catalogue_merchandising.sql"]) await db.exec(fs.readFileSync(path.join(__dirname, "../db", filename), "utf8"));
    pass("reviewed catalogue migrations apply in separate disposable PostgreSQL");
    const { candidates } = await extract(workbook(rows), "xlsx");
    const category = (await db.query("select id from catalogue_categories limit 1")).rows[0].id;
    const ids = [];
    for (const candidate of candidates.slice(0, 3)) {
      const content = validateContent({ ...candidate, category_id: category });
      const result = await db.query("select catalogue_create_product($1,$2::uuid,null,$3::jsonb,$4) as product", [`synthetic-${candidate.variants[0].sku.toLowerCase()}`, category, JSON.stringify(content), "author@import.test"]);
      ids.push(result.rows[0].product.id);
    }
    const products = (await db.query("select * from catalogue_products")).rows;
    assert.equal(products.length, 3); assert.ok(products.every((p) => p.workflow_status === "draft" && p.publication_status === "never_published" && p.current_version === 1));
    pass("selected XLSX candidates save via existing authoritative draft RPC");
    assert.equal((await db.query("select count(*)::int as n from catalogue_variants where price_ngn_kobo is not null or stock_on_hand <> 0")).rows[0].n, 0);
    pass("benchmarks cannot become prices or inventory");
    await assert.rejects(db.query("update catalogue_product_versions set content = '{}'")); pass("immutable versions refuse edits");
    const content = validateContent({ ...candidates[0], category_id: category });
    await assert.rejects(db.query("select catalogue_create_product($1,$2::uuid,null,$3::jsonb,$4)", ["duplicate-new-slug", category, JSON.stringify(content), "author@import.test"]));
    assert.equal((await db.query("select count(*)::int as n from catalogue_products")).rows[0].n, 3); pass("duplicate SKU transaction rolls back without orphan product");
    await db.query("select catalogue_transition($1,1,'submit',$2,'','')", [ids[0], "author@import.test"]);
    await assert.rejects(db.query("select catalogue_transition($1,2,'approve',$2,'','')", [ids[0], "author@import.test"])); pass("self-approval still refused in PostgreSQL");
    await assert.rejects(db.query("select catalogue_transition($1,2,'publish',$2,'','')", [ids[0], "publisher@import.test"])); pass("publishing unapproved imported draft still refused");
    assert.equal((await db.query("select count(*)::int as n from catalogue_public_listings")).rows[0].n, 0); pass("no public listings created");
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select * from catalogue_products"));
      await db.exec("reset role"); pass(`${role} catalogue access denied`);
    }
    console.log(JSON.stringify({ suite: "import-disposable-postgres", passed: checks, failed: 0 }));
  } finally { await db.close(); }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
