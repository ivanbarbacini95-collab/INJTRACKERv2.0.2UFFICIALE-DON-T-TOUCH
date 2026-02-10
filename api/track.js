// /api/track.js
import { put, list } from "@vercel/blob";

const SESSIONS_KEY = "analytics/sessions.json";
const NAMES_KEY = "analytics/names.json";

const MAX_SESSIONS = 6000;
const MAX_BODY_BYTES = 220_000;

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

async function readJsonOr(defaultValue, pathname) {
  const { blobs } = await list({ prefix: pathname, limit: 1 });
  if (!blobs?.length) return defaultValue;
  const url = blobs[0].url;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return defaultValue;
  return await r.json();
}

async function writeJson(pathname, data) {
  const body = JSON.stringify(data);
  if (body.length > MAX_BODY_BYTES && Array.isArray(data)) {
    const trimmed = data.slice(-Math.floor(data.length * 0.7));
    return await put(pathname, JSON.stringify(trimmed), {
      access: "public",
      contentType: "application/json",
    });
  }
  return await put(pathname, body, { access: "public", contentType: "application/json" });
}

function nowMs() { return Date.now(); }
function safeStr(x, max = 500) { return String(x ?? "").slice(0, max); }
function safeName(x) { return String(x ?? "").trim().slice(0, 32); }

export default async function handler(req, res) {
  try {
    const method = req.method || "GET";

    if (method === "GET") {
      const sessions = await readJsonOr([], SESSIONS_KEY);
      const names = await readJsonOr({}, NAMES_KEY);
      return json(res, 200, { ok: true, sessions, names, ts: nowMs() });
    }

    if (method !== "POST") return json(res, 405, { ok: false, error: "Method Not Allowed" });

    let body = "";
    await new Promise((resolve) => {
      req.on("data", (c) => (body += c));
      req.on("end", resolve);
    });

    if (!body) return json(res, 400, { ok: false, error: "Empty body" });
    if (body.length > MAX_BODY_BYTES) return json(res, 413, { ok: false, error: "Body too large" });

    const payload = JSON.parse(body);

    // rename: { type:"name", deviceId, name }
    if (payload?.type === "name") {
      const deviceId = safeStr(payload.deviceId, 120);
      const name = safeName(payload.name);
      if (!deviceId) return json(res, 400, { ok: false, error: "Missing deviceId" });
      if (!name) return json(res, 400, { ok: false, error: "Empty name" });

      const names = await readJsonOr({}, NAMES_KEY);
      names[deviceId] = name;
      await writeJson(NAMES_KEY, names);
      return json(res, 200, { ok: true });
    }

    const type = safeStr(payload?.type, 16);
    const sessionId = safeStr(payload?.sessionId, 120);
    const deviceId = safeStr(payload?.deviceId, 120);
    const ts = Number(payload?.ts || nowMs());

    if (!type) return json(res, 400, { ok: false, error: "Missing type" });
    if (!sessionId || !deviceId) return json(res, 400, { ok: false, error: "Missing sessionId/deviceId" });

    const sessions = await readJsonOr([], SESSIONS_KEY);
    let s = sessions.find((x) => x.sessionId === sessionId);

    if (type === "start") {
      const deviceInfo = payload?.deviceInfo && typeof payload.deviceInfo === "object" ? payload.deviceInfo : {};
      const page = safeStr(payload?.page, 220);

      if (!s) {
        s = {
          sessionId,
          deviceId,
          startTs: ts,
          lastTs: ts,
          endTs: null,
          beats: 0,
          page,
          deviceInfo: {
            ua: safeStr(deviceInfo.ua, 400),
            lang: safeStr(deviceInfo.lang, 30),
            tz: safeStr(deviceInfo.tz, 80),
            screen: safeStr(deviceInfo.screen, 40),
            platform: safeStr(deviceInfo.platform, 80),
          },
        };
        sessions.push(s);
      } else {
        s.startTs = s.startTs || ts;
        s.lastTs = Math.max(s.lastTs || 0, ts);
      }
    } else if (type === "beat") {
      if (!s) {
        s = { sessionId, deviceId, startTs: ts, lastTs: ts, endTs: null, beats: 0, page: "", deviceInfo: {} };
        sessions.push(s);
      }
      s.lastTs = Math.max(s.lastTs || 0, ts);
      s.beats = (s.beats || 0) + 1;
    } else if (type === "end") {
      if (!s) {
        s = { sessionId, deviceId, startTs: ts, lastTs: ts, endTs: ts, beats: 0, page: "", deviceInfo: {} };
        sessions.push(s);
      }
      s.lastTs = Math.max(s.lastTs || 0, ts);
      s.endTs = s.endTs || ts;
      s.endReason = safeStr(payload?.reason || "end", 60);
    } else {
      return json(res, 400, { ok: false, error: "Unknown type" });
    }

    if (sessions.length > MAX_SESSIONS) sessions.splice(0, sessions.length - MAX_SESSIONS);
    await writeJson(SESSIONS_KEY, sessions);
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}
