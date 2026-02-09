// /api/backup.js
import { put, head, list, del } from "@vercel/blob";

const MAX_BODY_BYTES = 950_000;      // limite snapshot (client-side dovrebbe restare sotto)
const MAX_KEEP = 30;                // quante snapshot tenere per address
const PREFIX_VER = "inj_backup/v1";  // namespace nello store

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function normalizeAddr(a) {
  const s = String(a || "").trim();
  if (!/^inj[a-z0-9]{20,80}$/i.test(s)) return "";
  return s;
}

async function readRawBody(req) {
  // Se Vercel ha già parsato il body
  if (req?.body != null) {
    if (typeof req.body === "string") return req.body;
    try { return JSON.stringify(req.body); } catch { return ""; }
  }

  let raw = "";
  let tooLarge = false;

  await new Promise((resolve) => {
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        tooLarge = true;
        raw = "";
        try { req.destroy(); } catch {}
      }
    });
    req.on("end", resolve);
  });

  if (tooLarge) return null; // segnale body troppo grande
  return raw;
}

function sanitizeSnapshot(p, addr) {
  // snapshot minimale: consente evoluzioni future senza rompere
  const out = {
    v: 1,
    address: addr,
    t: Date.now(),
    // payload
    stake: p?.stake ?? null,
    wd: p?.wd ?? null,
    nw: p?.nw ?? null,
    events: Array.isArray(p?.events) ? p.events : null,
    meta: p?.meta ?? null
  };
  // se il client passa t, preservalo (ma clamp)
  const tt = Number(p?.t);
  if (Number.isFinite(tt) && tt > 0) out.t = tt;
  return out;
}

async function readJsonByPathname(pathname) {
  try {
    const meta = await head(pathname);
    const r = await fetch(meta.url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    // ✅ CORS (identico a point.js)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    const address = normalizeAddr(req.query?.address);
    if (!address) return json(res, 400, { ok: false, error: "Invalid address" });

    const base = `${PREFIX_VER}/${address}/`;
    const latestPath = `${base}latest.json`;
    const snapPrefix = `${base}snapshots/`;

    if (req.method === "GET") {
      const data = await readJsonByPathname(latestPath);
      return json(res, 200, { ok: true, data });
    }

    if (req.method === "POST") {
      const raw = await readRawBody(req);
      if (raw === null) return json(res, 413, { ok: false, error: "Body too large" });
      if (!raw) return json(res, 400, { ok: false, error: "Empty body" });

      let parsed = null;
      try { parsed = JSON.parse(raw); }
      catch { return json(res, 400, { ok: false, error: "Invalid JSON" }); }

      if (parsed?.address !== address) {
        return json(res, 400, { ok: false, error: "Payload/address mismatch" });
      }

      const clean = sanitizeSnapshot(parsed, address);
      const ts = Date.now();
      const snapPath = `${snapPrefix}${ts}.json`;

      // 1) salva snapshot storica
      const snap = await put(snapPath, JSON.stringify(clean), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false
      });

      // 2) aggiorna latest (overwrite)
      await put(latestPath, JSON.stringify(clean), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true
      });

      // 3) prune vecchie snapshot
      try {
        const { blobs } = await list({ prefix: snapPrefix, limit: 1000 });
        if (blobs && blobs.length > MAX_KEEP) {
          blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
          const toDelete = blobs.slice(MAX_KEEP).map(b => b.url);
          if (toDelete.length) await del(toDelete);
        }
      } catch {
        // prune non critico
      }

      return json(res, 200, { ok: true, meta: { uploadedAt: ts, url: snap?.url || null } });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
}
