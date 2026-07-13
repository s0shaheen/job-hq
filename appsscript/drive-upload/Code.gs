/**
 * Job Search HQ — Drive upload web app. Deployed from the account that owns
 * the "Job Search & Recruiting" Drive folder.
 *
 * WHY this exists: Google gives service accounts zero storage quota in
 * consumer My Drive, so the CI resume pipeline cannot upload PDFs with the
 * Sheets service account — uploads must run AS THE OWNER (resume-editing
 * research report §2). This doPost does exactly that: CI POSTs base64
 * content + a shared token; the file lands owned by the owner, in his real
 * folder tree.
 *
 * Deployment: Execute as **Me**, access **Anyone**. "Anyone" is safe here:
 *   1. the unguessable 256-bit UPLOAD_TOKEN is the real gate — the same
 *      trust model as an ntfy topic or a webhook secret;
 *   2. the surface is write-only into ONE fixed subtree (Resume/ under the
 *      folder below) — no read, list, or delete beyond replacing a
 *      same-named file there;
 *   3. a bad token gets a uniform JSON refusal, revealing nothing.
 *
 * Request:  POST JSON {token, target: "current"|"current-alt"|"archive",
 *                      label?, filename, content_b64, mime}
 * Response: {ok:true, fileId, path} | {ok:false, error}
 * Note: Apps Script web apps always answer HTTP 200 (after a 302 hop —
 * callers must follow redirects) — check the `ok` field, not the status.
 */

// "Job Search & Recruiting" — hq.config.yaml: drive.job_search_folder
const FOLDER_ID = "REDACTED-FOLDER-ID";

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    const want = PropertiesService.getScriptProperties().getProperty("UPLOAD_TOKEN");
    if (!want || !req.token || String(req.token) !== want) {
      return json_({ ok: false, error: "forbidden" }); // 403-equivalent
    }
    if (!req.filename || !req.content_b64) {
      return json_({ ok: false, error: "filename and content_b64 are required" });
    }
    const dest = resolveTarget_(String(req.target || "current"), req.label);
    if (dest.replace) {
      // Current targets keep a stable name with fresh content: trash the old
      // file(s) first so Drive links/pins always point at the newest render.
      const dup = dest.folder.getFilesByName(String(req.filename));
      while (dup.hasNext()) dup.next().setTrashed(true);
    }
    const blob = Utilities.newBlob(Utilities.base64Decode(String(req.content_b64)),
                                   String(req.mime || "application/octet-stream"),
                                   String(req.filename));
    const file = dest.folder.createFile(blob);
    return json_({ ok: true, fileId: file.getId(), path: dest.path + "/" + req.filename });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** target -> {folder, path, replace}. Archive folders are dated (plus an
 * optional label) and never replace — history accumulates. */
function resolveTarget_(target, label) {
  const resume = ensureFolder_(DriveApp.getFolderById(FOLDER_ID), "Resume");
  if (target === "current") {
    return { folder: ensureFolder_(resume, "Current"), path: "Resume/Current", replace: true };
  }
  if (target === "current-alt") {
    return { folder: ensureFolder_(resume, "Current-Alt"), path: "Resume/Current-Alt", replace: true };
  }
  if (target === "archive") {
    let name = Utilities.formatDate(new Date(), "America/Chicago", "yyyy-MM-dd");
    const clean = String(label || "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    if (clean) name += "-" + clean;
    const archive = ensureFolder_(resume, "Archive");
    return { folder: ensureFolder_(archive, name), path: "Resume/Archive/" + name, replace: false };
  }
  throw new Error('unknown target "' + target + '" (use current | current-alt | archive)');
}

function ensureFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

/** Liveness probe for provisioning — open the /exec URL in a browser. */
function doGet() {
  return json_({ ok: true, service: "hq-drive-upload",
                 hint: "POST JSON {token, target, filename, content_b64, mime}" });
}
