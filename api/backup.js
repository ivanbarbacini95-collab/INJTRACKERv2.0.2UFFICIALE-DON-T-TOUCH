// /api/backup.js
import { put, list, del } from "@vercel/blob";

const MAX_BODY_BYTES = 950_000;   // snapshot può essere più grande dei points
const MAX_KEEP = 30;             // quante snapshot mantenere per address
const PREFIX_VER = "inj_backup/v1";

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function normalizeAddr(a) {
  const s = String(a || "").trim();
  if (!/^inj[a-z0-9]{20,80}$/i.test(s)) return "";
  return s;
}

async function readBody(req) {
  // Vercel spesso fa già parsing JSON, ma gestiamo entrambi
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY_BYTES) throw new Error("BodyTooLarge");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : null;
}

export default async function handler(req, res) {
  try {
    const { address } = req.query || {};
    const addr = normalizeAddr(address);

    if (!addr) {
      return json(res, 400, { ok: false, error: "Invalid address" });
    }

    const prefix = `${PREFIX_VER}/${addr}/`;

    // ---------- GET: ritorna l’ultima snapshot ----------
    if (req.method === "GET") {
      const { blobs } = await list({ prefix, limit: 1000 });

      if (!blobs || !blobs.length) {
        return json(res, 200, { ok: true, data: null, meta: { uploadedAt: 0 } });
      }

      // scegli la più recente tramite uploadedAt
      blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
      const latest = blobs[0];

      // contenuto: fetch dal blob url (non esiste get() nello SDK)
      const r = await fetch(latest.url, { cache: "no-store" });
      if (!r.ok) {
        return json(res, 500, { ok: false, error: "BlobFetchFailed" });
      }
      const data = await r.json();

      return json(res, 200, {
        ok: true,
        data,
        meta: { uploadedAt: new Date(latest.uploadedAt).getTime() }
      });
    }

    // ---------- POST: salva una nuova snapshot ----------
    if (req.method === "POST") {
      const payload = await readBody(req);

      // sicurezza minima
      if (!payload || payload.address !== addr) {
        return json(res, 400, { ok: false, error: "Payload/address mismatch" });
      }

      const ts = Date.now();
      const pathname = `${prefix}${ts}.json`;

      const blob = await put(pathname, JSON.stringify(payload), {
        access: "public",
        addRandomSuffix: true,
        contentType: "application/json"
      });

      // prune vecchi backup
      const { blobs } = await list({ prefix, limit: 1000 });
      if (blobs && blobs.length > MAX_KEEP) {
        blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
        const toDelete = blobs.slice(MAX_KEEP).map(b => b.url);
        if (toDelete.length) await del(toDelete);
      }

      return json(res, 200, {
        ok: true,
        meta: { uploadedAt: ts, url: blob.url }
      });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("BodyTooLarge")) {
      return json(res, 413, { ok: false, error: "Snapshot too large" });
    }
    return json(res, 500, { ok: false, error: msg });
  }
}
