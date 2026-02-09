// /api/backup.js
import { put, head } from "@vercel/blob";

const MAX_BODY_BYTES = 950_000;   // allow bigger snapshots than /api/point
const MAX_POINTS_NW  = 24000;
const MAX_POINTS_STAKE = 8000;
const MAX_POINTS_WD = 8000;
const MAX_EVENTS = 3000;

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

async function readBody(req) {
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

function clampArray(a, max) {
  if (!Array.isArray(a)) return [];
  if (a.length <= max) return a.slice();
  return a.slice(a.length - max);
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function toStr(x, maxLen = 64) {
  const s = String(x ?? "");
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function sanitizePayload(p) {
  const out = {
    v: 2,
    t: toNum(p?.t) || Date.now(),
    stake: { labels: [], data: [], moves: [], types: [] },
    wd: { labels: [], values: [], times: [] },
    nw: { times: [], usd: [], inj: [] },
    events: []
  };

  if (p?.stake) {
    out.stake.labels = clampArray(p.stake.labels, MAX_POINTS_STAKE).map((x) => toStr(x, 48));
    out.stake.data   = clampArray(p.stake.data,   MAX_POINTS_STAKE).map(toNum);
    out.stake.moves  = clampArray(p.stake.moves,  MAX_POINTS_STAKE).map(toNum);
    out.stake.types  = clampArray(p.stake.types,  MAX_POINTS_STAKE).map((x) => toStr(x, 40));
  }

  if (p?.wd) {
    out.wd.labels = clampArray(p.wd.labels, MAX_POINTS_WD).map((x) => toStr(x, 48));
    out.wd.values = clampArray(p.wd.values, MAX_POINTS_WD).map(toNum);
    out.wd.times  = clampArray(p.wd.times,  MAX_POINTS_WD).map(toNum);
  }

  if (p?.nw) {
    out.nw.times = clampArray(p.nw.times, MAX_POINTS_NW).map(toNum);
    out.nw.usd   = clampArray(p.nw.usd,   MAX_POINTS_NW).map(toNum);
    out.nw.inj   = clampArray(p.nw.inj,   MAX_POINTS_NW).map(toNum);

    // align lengths
    const n = Math.min(out.nw.times.length, out.nw.usd.length, out.nw.inj.length);
    out.nw.times = out.nw.times.slice(-n);
    out.nw.usd   = out.nw.usd.slice(-n);
    out.nw.inj   = out.nw.inj.slice(-n);
  }

  if (Array.isArray(p?.events)) {
    const arr = clampArray(p.events, MAX_EVENTS).map((e) => ({
      id: toStr(e?.id || `${toNum(e?.ts) || Date.now()}_${toStr(e?.title || "event", 24)}`, 80),
      ts: toNum(e?.ts) || Date.now(),
      kind: toStr(e?.kind || e?.type || "event", 32),
      title: toStr(e?.title || e?.kind || "event", 80),
      detail: toStr(e?.detail || e?.desc || "", 240),
      value: toNum(e?.value),
      usd: toNum(e?.usd),
      status: toStr(e?.status || "", 16)
    }));
    // dedup by id
    const map = new Map();
    for (const ev of arr) map.set(ev.id, ev);
    out.events = Array.from(map.values()).sort((a,b) => (a.ts||0) - (b.ts||0));
  }

  out.t = Date.now();
  return out;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    const addr = normalizeAddr(req.query?.address);
    if (!addr) return json(res, 400, { ok: false, error: "Invalid address" });

    const pathname = `inj-backup/${addr}/latest.json`;

    if (req.method === "GET") {
      const h = await head(pathname).catch(() => null);
      if (!h?.url) return json(res, 200, { ok: true, data: null, t: 0 });

      const r = await fetch(h.url, { cache: "no-store" });
      if (!r.ok) return json(res, 500, { ok: false, error: "Blob fetch failed" });

      const data = await r.json().catch(() => null);
      const t = toNum(data?.t) || Date.now();
      return json(res, 200, { ok: true, data, t });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const payload = body?.data || body?.payload || body;
      const clean = sanitizePayload(payload);

      const raw = JSON.stringify({ v: body?.v || 1, address: addr, t: Date.now(), data: clean });
      const size = Buffer.byteLength(raw, "utf-8");
      if (size > MAX_BODY_BYTES) return json(res, 413, { ok: false, error: "Snapshot too large" });

      await put(pathname, raw, {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true
      });

      return json(res, 200, { ok: true, t: clean.t });
    }

    return json(res, 405, { ok: false, error: "Method not allowed" });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("BodyTooLarge")) return json(res, 413, { ok: false, error: "Snapshot too large" });
    console.error(e);
    return json(res, 500, { ok: false, error: "Server error" });
  }
}
