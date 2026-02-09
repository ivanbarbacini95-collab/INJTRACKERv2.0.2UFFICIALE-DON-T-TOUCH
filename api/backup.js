// /api/backup.js
// Snapshot per-address (latest only) using Vercel Blob.
// ✅ Uses only put + head (same pattern as /api/point.js) for maximum compatibility.
import { put, head } from "@vercel/blob";

const MAX_BODY_BYTES = 950_000;
const PREFIX_VER = "inj_backup/v1";

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // CORS (match point.js)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(obj));
}

function normalizeAddr(a) {
  const s = String(a || "").trim();
  if (!/^inj[a-z0-9]{20,80}$/i.test(s)) return "";
  return s;
}

async function readBlobJsonByPathname(pathname) {
  try {
    const meta = await head(pathname); // if not exists -> throw
    const resp = await fetch(meta.url, { cache: "no-store" });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => null);
    const uploadedAt = meta?.uploadedAt ? new Date(meta.uploadedAt).getTime() : 0;
    return { data, uploadedAt };
  } catch {
    return null;
  }
}

async function readRawBody(req) {
  // If Vercel already parsed JSON
  if (req?.body != null) {
    if (typeof req.body === "string") return req.body;
    try { return JSON.stringify(req.body); } catch { return null; }
  }

  return await new Promise((resolve) => {
    let raw = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooLarge = true;
        raw = "";
        try { req.destroy(); } catch {}
      }
    });
    req.on("end", () => resolve(tooLarge ? null : raw));
  });
}

export default async function handler(req, res) {
  // Preflight
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.end();
    return;
  }

  const { address } = req.query || {};
  const addr = normalizeAddr(address);
  if (!addr) return json(res, 400, { ok: false, error: "Invalid address" });

  const pathname = `${PREFIX_VER}/${addr}/latest.json`;

  // GET latest snapshot
  if (req.method === "GET") {
    const got = await readBlobJsonByPathname(pathname);
    if (!got || !got.data) {
      return json(res, 200, { ok: true, data: null, meta: { uploadedAt: 0 } });
    }
    const uploadedAt = Number(got.uploadedAt || got.data?.ts || 0);
    return json(res, 200, { ok: true, data: got.data, meta: { uploadedAt } });
  }

  // POST save latest snapshot
  if (req.method === "POST") {
    const raw = await readRawBody(req);
    if (!raw) return json(res, 413, { ok: false, error: "Snapshot too large" });

    let payload = null;
    try { payload = JSON.parse(raw); } catch {}
    if (!payload || payload.address !== addr) {
      return json(res, 400, { ok: false, error: "Payload/address mismatch" });
    }

    // minimal sanity: must include ts
    const ts = Number(payload.ts || Date.now());
    payload.ts = ts;

    try {
      await put(pathname, JSON.stringify(payload), {
        access: "public",
        addRandomSuffix: false,
        contentType: "application/json",
      });
      return json(res, 200, { ok: true, meta: { uploadedAt: ts } });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  return json(res, 405, { ok: false, error: "Method not allowed" });
}
