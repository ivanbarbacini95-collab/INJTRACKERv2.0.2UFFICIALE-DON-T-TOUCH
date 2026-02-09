// /api/backup.js
// Per-wallet snapshot backup using Vercel Blob.
// Requires: "@vercel/blob" in package.json dependencies.

import { put, list, del } from "@vercel/blob";

const MAX_BODY_BYTES = 320_000;   // keep payloads bounded
const MAX_ITEMS_PER_ADDR = 40;    // prevent unbounded storage growth

function json(res, code, obj){
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function normalizeAddr(a){
  const s = String(a || "").trim();
  return /^inj[a-z0-9]{20,80}$/i.test(s) ? s : "";
}

async function readBlobJSON(url){
  const r = await fetch(url, { cache:"no-store" });
  if (!r.ok) throw new Error("fetch blob failed");
  const txt = await r.text();
  try{ return JSON.parse(txt); } catch { return null; }
}

export default async function handler(req, res){
  try{
    const addr = normalizeAddr(req.query?.address);
    if (!addr) return json(res, 400, { ok:false, error:"invalid address" });

    const prefix = `inj-backup/${addr}/`;

    if (req.method === "GET"){
      const ls = await list({ prefix, limit: 200 });
      const blobs = (ls?.blobs || []).slice();

      if (!blobs.length){
        return json(res, 200, { ok:true, meta:{ uploadedAt:0 }, data:null });
      }

      // pick latest by uploadedAt (fallback: by pathname ts)
      blobs.sort((a,b) => {
        const at = +new Date(a.uploadedAt || 0);
        const bt = +new Date(b.uploadedAt || 0);
        return bt - at;
      });
      const latest = blobs[0];

      const data = await readBlobJSON(latest.url);
      return json(res, 200, {
        ok:true,
        meta:{ uploadedAt: +new Date(latest.uploadedAt || 0), pathname: latest.pathname },
        data
      });
    }

    if (req.method === "POST"){
      // body size guard
      let raw = "";
      await new Promise((resolve, reject) => {
        req.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > MAX_BODY_BYTES){
            reject(new Error("body too large"));
            try{ req.destroy(); } catch {}
          }
        });
        req.on("end", resolve);
        req.on("error", reject);
      });

      let snap = null;
      try{ snap = JSON.parse(raw || "{}"); } catch { snap = null; }
      if (!snap || typeof snap !== "object") return json(res, 400, { ok:false, error:"invalid json" });

      if (normalizeAddr(snap.address) !== addr){
        return json(res, 400, { ok:false, error:"address mismatch" });
      }
      if (!snap.stores || typeof snap.stores !== "object"){
        return json(res, 400, { ok:false, error:"missing stores" });
      }

      const ts = Number(snap.ts || Date.now());
      const pathname = `${prefix}${ts}.json`;

      const putRes = await put(pathname, JSON.stringify(snap), {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: true
      });

      // cleanup: keep latest MAX_ITEMS_PER_ADDR
      try{
        const ls = await list({ prefix, limit: 200 });
        const blobs = (ls?.blobs || []).slice();
        blobs.sort((a,b) => +new Date(b.uploadedAt || 0) - +new Date(a.uploadedAt || 0));
        const toDelete = blobs.slice(MAX_ITEMS_PER_ADDR);
        for (const b of toDelete){
          try{ await del(b.url); } catch {}
        }
      }catch{}

      return json(res, 200, { ok:true, meta:{ uploadedAt: Date.now(), url: putRes?.url || "" } });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { ok:false, error:"method not allowed" });

  } catch (e){
    return json(res, 500, { ok:false, error: String(e?.message || e) });
  }
}
