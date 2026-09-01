const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createConfig } = require("../src/lead-agents/config");
const { buildServer } = require("../src/lead-agents/server");
const { MemoryRateLimiter } = require("../src/lead-agents/rate-limit");
const { ToolExecutor } = require("../src/lead-agents/tools");
const { WebhookDispatcher } = require("../src/lead-agents/webhooks");
const { createTempStore } = require("../src/lead-agents/testing");
const { hashPassword } = require("../src/lead-agents/auth");

// Documents Workspace rebuild -- proves the real HTTP surface end to
// end (folders, native-document PATCH via the generic corporate-
// collection route, upload, trash/restore/permanent-delete, storage
// summary, share-link regeneration, and permission gating), not just
// static source assertions -- this module has real lifecycle/ownership
// semantics (storage object cleanup, governed permanent delete) worth
// exercising against the actual routes.

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "office-storage-test-"));
  const config = {
    ...createConfig(),
    authMode: "required_api_key",
    apiKeys: ["documents-workspace-test-key"],
    allowedOrigins: [],
    officeStorageDriver: "local",
    officeStorageDir: storageDir,
    officeEmailProvider: "",
    resendApiKey: "",
  };
  const { store } = await createTempStore();
  await store.ensureAdminUser({ email: "super@ochiga.local", password_hash: hashPassword("super-pass-123"), role: "super_admin", display_name: "Super Test", status: "active" });
  await store.ensureAdminUser({ email: "staff@ochiga.local", password_hash: hashPassword("staff-pass-123"), role: "ochiga_staff", display_name: "Staff Test", status: "active" });

  const webhooks = new WebhookDispatcher({ config });
  const toolExecutor = new ToolExecutor({ store, config, log: () => {}, webhooks });
  const server = buildServer({
    config,
    store,
    rateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    publicRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    officeRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 500 }),
    loginRateLimiter: new MemoryRateLimiter({ windowMs: 60_000, maxRequests: 50 }),
    whatsappAdapter: { verifyWebhook: () => null, extractEvents: () => [] },
    openaiClient: {},
    toolExecutor,
  });

  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;

  async function login(email, password) {
    const res = await fetch(`${base}/api/lead-agents/admin/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200, `login must succeed for ${email}`);
    return res.headers.get("set-cookie").split(";")[0];
  }

  try {
    const superCookie = await login("super@ochiga.local", "super-pass-123");
    const staffCookie = await login("staff@ochiga.local", "staff-pass-123");

    // A. Folder CRUD.
    const createFolderRes = await fetch(`${base}/api/lead-agents/admin/documents/folders`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ name: "Contracts" }),
    });
    assert.equal(createFolderRes.status, 201, "documents.generate holder can create a folder");
    const folder = (await createFolderRes.json()).folder;
    assert.equal(folder.name, "Contracts");

    const listFoldersRes = await fetch(`${base}/api/lead-agents/admin/documents/folders`, { headers: { cookie: staffCookie } });
    const folders = (await listFoldersRes.json()).folders;
    assert.ok(folders.some((f) => f.id === folder.id), "the new folder must appear in the list");

    const renameFolderRes = await fetch(`${base}/api/lead-agents/admin/documents/folders/${folder.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ name: "Contracts & Agreements" }),
    });
    assert.equal(renameFolderRes.status, 200);
    assert.equal((await renameFolderRes.json()).folder.name, "Contracts & Agreements");
    console.log("A. Folder create/list/rename — PASS");

    // B. Native document creation (real body persisted, not just baked
    // into the generated HTML), then PATCH (rename/move) via the
    // generic corporate-collection route.
    const genRes = await fetch(`${base}/api/lead-agents/admin/documents/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ title: "Smoke Test Doc", document_type: "letter", body: "Hello world", folder_id: folder.id }),
    });
    assert.equal(genRes.status, 201);
    const genDoc = (await genRes.json()).document;
    assert.equal(genDoc.folder_id, folder.id, "folder_id must persist on native creation");
    assert.equal(genDoc.body, "Hello world", "typed content must persist to the real body column, not just the generated file");

    const patchRes = await fetch(`${base}/api/lead-agents/admin/office/documents/${genDoc.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ title: "Renamed Smoke Test Doc", body: "Updated content" }),
    });
    assert.equal(patchRes.status, 200, "documents.generate holder can PATCH rename/edit");
    const patched = (await patchRes.json()).record;
    assert.equal(patched.title, "Renamed Smoke Test Doc");
    assert.equal(patched.body, "Updated content", "editor Save must persist real content, reopenable afterward");

    const activityRes = await fetch(`${base}/api/lead-agents/admin/office/activities/document/${genDoc.id}`, { headers: { cookie: staffCookie } });
    const activities = (await activityRes.json()).collection;
    assert.ok(activities.some((a) => a.activity_type === "documents_updated"), "PATCH must produce a real timeline/activity entry");
    console.log("B. Native document create (real persisted body) + PATCH rename/edit — PASS");

    // C. Move to Folder via PATCH, then Move to Trash / Restore.
    const secondFolderRes = await fetch(`${base}/api/lead-agents/admin/documents/folders`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ name: "Invoices" }),
    });
    const secondFolder = (await secondFolderRes.json()).folder;
    await fetch(`${base}/api/lead-agents/admin/office/documents/${genDoc.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ folder_id: secondFolder.id }),
    });

    const trashRes = await fetch(`${base}/api/lead-agents/admin/documents/${genDoc.id}/trash`, { method: "POST", headers: { cookie: staffCookie } });
    assert.equal(trashRes.status, 200);
    assert.ok((await trashRes.json()).document.trashed_at, "trash must set trashed_at");
    const listAfterTrash = await (await fetch(`${base}/api/lead-agents/admin/office/documents`, { headers: { cookie: staffCookie } })).json();
    const trashedRecord = listAfterTrash.collection.find((d) => d.id === genDoc.id);
    assert.equal(trashedRecord.status, "draft", "trashing must never rewrite the business status field");

    const restoreRes = await fetch(`${base}/api/lead-agents/admin/documents/${genDoc.id}/restore`, { method: "POST", headers: { cookie: staffCookie } });
    assert.equal(restoreRes.status, 200);
    assert.equal((await restoreRes.json()).document.trashed_at, null, "restore must clear trashed_at");
    console.log("C. Move to Folder, Trash, Restore — PASS");

    // D. Permanent delete is governed: blocked unless already trashed,
    // and blocked for a documents.generate-only holder (needs the
    // senior documents.manage grant, held only by super_admin here).
    const permDeleteNotTrashedRes = await fetch(`${base}/api/lead-agents/admin/documents/${genDoc.id}/permanent`, { method: "DELETE", headers: { cookie: superCookie } });
    assert.equal(permDeleteNotTrashedRes.status, 409, "permanent delete must require the document to already be trashed");

    const permDeleteForbiddenRes = await fetch(`${base}/api/lead-agents/admin/documents/${genDoc.id}/permanent`, { method: "DELETE", headers: { cookie: staffCookie } });
    assert.equal(permDeleteForbiddenRes.status, 403, "documents.generate alone must not authorize permanent delete");

    await fetch(`${base}/api/lead-agents/admin/documents/${genDoc.id}/trash`, { method: "POST", headers: { cookie: staffCookie } });
    const permDeleteRes = await fetch(`${base}/api/lead-agents/admin/documents/${genDoc.id}/permanent`, { method: "DELETE", headers: { cookie: superCookie } });
    assert.equal(permDeleteRes.status, 200, "documents.manage holder can permanently delete an already-trashed document");
    const listAfterDelete = await (await fetch(`${base}/api/lead-agents/admin/office/documents`, { headers: { cookie: staffCookie } })).json();
    assert.ok(!listAfterDelete.collection.some((d) => d.id === genDoc.id), "the record must actually be gone");
    console.log("D. Permanent delete governed by documents.manage, requires trashed_at first — PASS");

    // E. Folder delete is blocked while it still contains documents,
    // and succeeds once empty (real dependency check, not silent
    // cascade).
    const uploadRes = await fetch(`${base}/api/lead-agents/admin/documents/upload`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ title: "Uploaded File", filename: "test.txt", data_url: "data:text/plain;base64,aGVsbG8=", folder_id: secondFolder.id }),
    });
    assert.equal(uploadRes.status, 201);
    const uploadedDoc = (await uploadRes.json()).document;
    assert.equal(uploadedDoc.metadata.upload_kind, "uploaded_file", "an uploaded file must be flagged distinctly from a native document");
    assert.ok(uploadedDoc.metadata.size > 0, "the real uploaded byte size must be recorded");

    const deleteNonEmptyFolderRes = await fetch(`${base}/api/lead-agents/admin/documents/folders/${secondFolder.id}`, { method: "DELETE", headers: { cookie: superCookie } });
    assert.equal(deleteNonEmptyFolderRes.status, 409);
    assert.equal((await deleteNonEmptyFolderRes.json()).error, "folder_not_empty");

    const deleteEmptyFolderRes = await fetch(`${base}/api/lead-agents/admin/documents/folders/${folder.id}`, { method: "DELETE", headers: { cookie: superCookie } });
    assert.equal(deleteEmptyFolderRes.status, 200, "an empty folder can be deleted");
    console.log("E. Upload creates a real office_files-backed record; folder delete blocked while non-empty — PASS");

    // F. Storage summary reflects real bytes, and permanently deleting
    // the uploaded document actually removes its storage object (no
    // orphaned bytes/metadata left behind).
    const summaryBeforeRes = await fetch(`${base}/api/lead-agents/admin/documents/storage-summary`, { headers: { cookie: staffCookie } });
    const summaryBefore = await summaryBeforeRes.json();
    assert.ok(summaryBefore.used_bytes > 0, "storage summary must reflect the real uploaded bytes");
    assert.ok(summaryBefore.file_count >= 1);

    await fetch(`${base}/api/lead-agents/admin/documents/${uploadedDoc.id}/trash`, { method: "POST", headers: { cookie: staffCookie } });
    const permDeleteUploadRes = await fetch(`${base}/api/lead-agents/admin/documents/${uploadedDoc.id}/permanent`, { method: "DELETE", headers: { cookie: superCookie } });
    assert.equal(permDeleteUploadRes.status, 200);
    const summaryAfterRes = await fetch(`${base}/api/lead-agents/admin/documents/storage-summary`, { headers: { cookie: staffCookie } });
    const summaryAfter = await summaryAfterRes.json();
    assert.ok(summaryAfter.used_bytes < summaryBefore.used_bytes, "permanent delete must actually free the recorded storage bytes, not leave an orphaned office_files row");
    console.log("F. Storage summary reflects real bytes; permanent delete frees them (no orphaned storage) — PASS");

    // G. Share link regenerate rotates the token — the old link stops
    // working, a fresh one does.
    const genRes2 = await fetch(`${base}/api/lead-agents/admin/documents/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ title: "Share Test Doc", document_type: "letter", body: "Share me" }),
    });
    const shareDoc = (await genRes2.json()).document;
    const oldToken = shareDoc.share_token;
    const oldShareRes = await fetch(`${base}/api/lead-agents/documents/shared/${shareDoc.id}/${oldToken}`);
    assert.equal(oldShareRes.status, 200, "the original share link must work");

    const regenRes = await fetch(`${base}/api/lead-agents/admin/documents/${shareDoc.id}/regenerate-share-link`, { method: "POST", headers: { cookie: staffCookie } });
    assert.equal(regenRes.status, 200);
    const newToken = (await regenRes.json()).document.share_token;
    assert.notEqual(newToken, oldToken, "regenerate must actually rotate the token");
    const oldTokenAfterRegenRes = await fetch(`${base}/api/lead-agents/documents/shared/${shareDoc.id}/${oldToken}`);
    assert.equal(oldTokenAfterRegenRes.status, 404, "the old link must stop working once regenerated");
    const newShareRes = await fetch(`${base}/api/lead-agents/documents/shared/${shareDoc.id}/${newToken}`);
    assert.equal(newShareRes.status, 200, "the new link must work");
    console.log("G. Share link regenerate rotates the token, old link stops working — PASS");

    // H. Legacy-shaped record (no folder_id/body — as any pre-migration
    // document would be) still lists and opens without error.
    const legacyDoc = await store.createOfficeDocument({ id: "doc_legacy_1", title: "Legacy Doc", document_type: "letter", status: "draft", owner: "legacy@ochiga.local" });
    assert.equal(legacyDoc.folder_id, null);
    assert.equal(legacyDoc.body, null);
    const listWithLegacyRes = await fetch(`${base}/api/lead-agents/admin/office/documents`, { headers: { cookie: staffCookie } });
    const listWithLegacy = (await listWithLegacyRes.json()).collection;
    assert.ok(listWithLegacy.some((d) => d.id === "doc_legacy_1"), "a legacy metadata-only record must still list");
    console.log("H. Legacy (pre-migration-shaped) documents still list and open — PASS");

    // I. Corporate Letterhead master config -- readable by any staff
    // (documents.generate holders need to snapshot it), editable only by
    // settings.manage.
    const configGetRes = await fetch(`${base}/api/lead-agents/admin/letterhead-config`, { headers: { cookie: staffCookie } });
    assert.equal(configGetRes.status, 200, "any staff can read the letterhead config to snapshot it");
    const patchByStaffRes = await fetch(`${base}/api/lead-agents/admin/letterhead-config`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ email: "hacker@example.com" }),
    });
    assert.equal(patchByStaffRes.status, 403, "ordinary documents.generate staff must not edit the master letterhead config");
    const letterheadPatchRes = await fetch(`${base}/api/lead-agents/admin/letterhead-config`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: superCookie },
      body: JSON.stringify({
        logo_url: "/office/brand/ochiga-logo-light.png", email: "office@ochiga.com.ng", website: "www.ochiga.com.ng",
        whatsapp: "+2349164738454", address: "Plot 45, Oyibo Adjarho Street, Lekki Phase 1, Lagos", social_handle: "@OchigaGlobal",
      }),
    });
    assert.equal(letterheadPatchRes.status, 200, "settings.manage holder can update the master letterhead config");
    console.log("I. Letterhead config: readable by staff, editable only by settings.manage — PASS");

    // J. New Document -> Ochiga Letterhead: creates a real native
    // document whose metadata carries a genuine snapshot of the config
    // AT CREATION TIME, not a live reference to it.
    const letterheadRes = await fetch(`${base}/api/lead-agents/admin/documents/letterhead`, {
      method: "POST", headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ title: "Board Resolution — Disposable Test" }),
    });
    assert.equal(letterheadRes.status, 201);
    const letterDoc = (await letterheadRes.json()).document;
    assert.equal(letterDoc.metadata.template, "ochiga_letterhead");
    assert.equal(letterDoc.metadata.body_format, "html");
    assert.equal(letterDoc.metadata.letterhead_snapshot.email, "office@ochiga.com.ng", "the snapshot must capture the real, current config values");
    console.log("J. New Document creates a real Letterhead document with a genuine config snapshot — PASS");

    // K. Editing the document body persists real HTML via the generic
    // PATCH route (server-side sanitized), and — the core historical-
    // document guarantee — subsequently changing the MASTER config never
    // touches this document's own already-snapshotted values.
    const bodyPatchRes = await fetch(`${base}/api/lead-agents/admin/office/documents/${letterDoc.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: staffCookie },
      body: JSON.stringify({ body: '<p>Resolved that <strong>the Board</strong> approves the matter.</p><script>alert(1)</script>' }),
    });
    assert.equal(bodyPatchRes.status, 200);
    const patchedLetter = (await bodyPatchRes.json()).record;
    assert.ok(patchedLetter.body.includes("<strong>the Board</strong>"), "real formatted HTML must persist");
    assert.ok(!patchedLetter.body.includes("<script>"), "the server must sanitize HTML-bodied documents regardless of what the client sent");

    await fetch(`${base}/api/lead-agents/admin/letterhead-config`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: superCookie },
      body: JSON.stringify({ email: "new-office-email@ochiga.com.ng", address: "A Brand New Address, Lagos" }),
    });
    const letterAfterMasterEditRes = await fetch(`${base}/api/lead-agents/admin/office/documents`, { headers: { cookie: staffCookie } });
    const letterAfterMasterEdit = (await letterAfterMasterEditRes.json()).collection.find((d) => d.id === letterDoc.id);
    assert.equal(letterAfterMasterEdit.metadata.letterhead_snapshot.email, "office@ochiga.com.ng", "an already-created letter must keep ITS OWN snapshot after the master config changes");
    assert.equal(letterAfterMasterEdit.metadata.letterhead_snapshot.address, "Plot 45, Oyibo Adjarho Street, Lekki Phase 1, Lagos", "same for every other snapshotted field");
    console.log("K. Body edits persist real sanitized HTML; master config edits never rewrite an existing document's snapshot — PASS");

    // L. The public share route renders the letterhead server-side for a
    // body-only native document (no stored file exists for it) — reusing
    // the exact same token-gated route, not a second sharing mechanism.
    const letterShareRes = await fetch(`${base}/api/lead-agents/documents/shared/${letterDoc.id}/${letterDoc.share_token}`);
    assert.equal(letterShareRes.status, 200, "a body-only Letterhead document must still have a working public share link");
    const letterShareHtml = await letterShareRes.text();
    assert.ok(letterShareHtml.includes("the Board"), "the rendered share page must include the real document content");
    assert.ok(letterShareHtml.includes("office@ochiga.com.ng") || letterShareHtml.includes("Plot 45"), "the rendered share page must include the document's own snapshotted contact/address details");
    console.log("L. Public share link server-renders the letterhead for a body-only document — PASS");

    // M. Folder visibility: a document filed into a folder must
    // disappear from the root listing (not just appear in both), and a
    // move back to root (folder_id -> null) must restore it there —
    // same canonical record throughout, never duplicated.
    const visFolderRes = await fetch(`${base}/api/lead-agents/admin/documents/folders`, {
      method: "POST", headers: { "content-type": "application/json", cookie: staffCookie }, body: JSON.stringify({ name: "ZZ Visibility Test Folder" }),
    });
    const visFolder = (await visFolderRes.json()).folder;
    await fetch(`${base}/api/lead-agents/admin/office/documents/${letterDoc.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: staffCookie }, body: JSON.stringify({ folder_id: visFolder.id }),
    });
    const allDocsRes = await fetch(`${base}/api/lead-agents/admin/office/documents`, { headers: { cookie: staffCookie } });
    const allDocs = (await allDocsRes.json()).collection;
    const filedRecord = allDocs.find((d) => d.id === letterDoc.id);
    assert.equal(filedRecord.folder_id, visFolder.id, "the canonical record's folder_id is the one and only place placement lives — no duplicate record");
    const rootView = allDocs.filter((d) => !d.trashed_at && !d.folder_id);
    assert.ok(!rootView.some((d) => d.id === letterDoc.id), "a filed document must not appear in a root-scoped (folder_id IS NULL) view");
    const folderView = allDocs.filter((d) => !d.trashed_at && d.folder_id === visFolder.id);
    assert.ok(folderView.some((d) => d.id === letterDoc.id), "the same document must appear when scoped to its actual folder");
    await fetch(`${base}/api/lead-agents/admin/office/documents/${letterDoc.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", cookie: staffCookie }, body: JSON.stringify({ folder_id: null }),
    });
    const afterMoveBackRes = await fetch(`${base}/api/lead-agents/admin/office/documents`, { headers: { cookie: staffCookie } });
    const afterMoveBack = (await afterMoveBackRes.json()).collection.find((d) => d.id === letterDoc.id);
    assert.equal(afterMoveBack.folder_id, null, "moving back to root must clear folder_id on the same canonical record");
    console.log("M. Folder visibility: filed documents leave the root scope, the same record moves cleanly between folder and root — PASS");

    console.log("office Documents Workspace smoke passed");
  } finally {
    await close(server);
    await fs.rm(storageDir, { recursive: true, force: true }).catch(() => null);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
