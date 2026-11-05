// Daily MAQET Showcase API (Cloudflare Pages Function).
// Bindings: DB (D1), MEDIA (R2), ADMIN_KEY (secret).
//
//   GET  /api/showcase                 theme, deadline, posted picks (public)
//   POST /api/showcase/submit          multipart submission (public)
//   GET  /api/showcase/media/<id>      file for a posted pick (admin key sees any)
//   GET  /api/showcase/admin/list      ?week=YYYY-MM-DD  (X-Admin-Key)
//   POST /api/showcase/admin/update    {id, status, postDate, rank}  (X-Admin-Key)
//   POST /api/showcase/admin/theme     {week, theme}  (X-Admin-Key)
//
// A "week" is named by the Friday its voting happens on. Submissions close
// Friday 6PM New York time; anything later counts toward the next Friday.

const MAX_BYTES = 95 * 1024 * 1024;
const MEDIA_TYPES = ["Photo", "Painting / drawing", "Digital art", "Video", "Sculpture / 3D", "Textile / fashion", "Mixed media", "Writing", "Other"];
const OK_MIME = /^(image\/(jpeg|png|webp|heic|heif|gif)|video\/(mp4|quicktime|webm))$/;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "image/gif": "gif", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sc_submissions (
     id TEXT PRIMARY KEY, week TEXT NOT NULL, created TEXT NOT NULL,
     artist TEXT NOT NULL, handle TEXT, email TEXT NOT NULL, title TEXT,
     media_type TEXT NOT NULL, caption TEXT, mime TEXT NOT NULL, size INTEGER,
     media_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
     post_date TEXT, rank INTEGER, ip_hash TEXT)`,
  `CREATE INDEX IF NOT EXISTS sc_sub_week ON sc_submissions(week)`,
  `CREATE TABLE IF NOT EXISTS sc_weeks (week TEXT PRIMARY KEY, theme TEXT NOT NULL)`,
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  schemaReady = true;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

// New York wall-clock parts for a Date.
function nyParts(d) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
// The Friday (YYYY-MM-DD, New York) whose vote a submission made now belongs to.
function currentWeek(now = new Date()) {
  const p = nyParts(now);
  let add = (5 - p.wd + 7) % 7;
  if (add === 0 && p.h >= 18) add = 7;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + add));
  return t.toISOString().slice(0, 10);
}

async function themeFor(db, week) {
  const row = await db.prepare("SELECT theme FROM sc_weeks WHERE week <= ?1 ORDER BY week DESC LIMIT 1").bind(week).first();
  return row ? row.theme : "";
}

async function ipHash(request) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const day = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + day));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isAdmin(request, env) {
  const key = request.headers.get("x-admin-key") || new URL(request.url).searchParams.get("key");
  return Boolean(env.ADMIN_KEY && key && key === env.ADMIN_KEY);
}

const publicPick = (r) => ({
  id: r.id, artist: r.artist, handle: r.handle, title: r.title, mediaType: r.media_type,
  caption: r.caption, mime: r.mime, postDate: r.post_date, week: r.week,
  media: `/api/showcase/media/${r.id}`,
});

async function submit(request, env) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) return json({ error: "Send the form as multipart/form-data." }, 400);
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BYTES + 1e6) return json({ error: "That file is too big. Keep it under 95 MB." }, 413);

  const form = await request.formData();
  if (clean(form.get("website"), 10)) return json({ ok: true }); // honeypot
  const artist = clean(form.get("artist"), 80);
  const email = clean(form.get("email"), 120);
  const handle = clean(form.get("handle"), 60).replace(/^https?:\/\/(www\.)?instagram\.com\//i, "@").replace(/\/$/, "");
  const title = clean(form.get("title"), 120);
  const mediaType = clean(form.get("mediaType"), 40);
  const caption = clean(form.get("caption"), 2000);
  const file = form.get("file");

  if (!artist) return json({ error: "Add your name as you want it credited." }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Add an email so we can reach you." }, 400);
  if (!MEDIA_TYPES.includes(mediaType)) return json({ error: "Pick a media type." }, 400);
  if (form.get("consent") !== "yes") return json({ error: "Check the box so we can post your work." }, 400);
  // Writing can come in as pasted text instead of a file.
  const writing = String(form.get("writing") ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, 5000);
  const hasFile = file && typeof file !== "string" && file.size;
  if (!hasFile && !(mediaType === "Writing" && writing)) return json({ error: mediaType === "Writing" ? "Paste your writing or attach a photo of it." : "Attach your photo or video." }, 400);
  if (hasFile && file.size > MAX_BYTES) return json({ error: "That file is too big. Keep it under 95 MB." }, 413);
  const mime = hasFile ? (file.type || "").toLowerCase() : "text/plain";
  if (hasFile && !OK_MIME.test(mime)) return json({ error: "Use a JPG, PNG, HEIC, WEBP, GIF, MP4, MOV or WEBM file." }, 415);

  const db = env.DB;
  await ensureSchema(db);
  const ih = await ipHash(request);
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM sc_submissions WHERE ip_hash = ?1 AND created > ?2")
    .bind(ih, new Date(Date.now() - 3600e3).toISOString()).first();
  if (recent && recent.n >= 10) return json({ error: "Too many uploads from here in the last hour. Try again later." }, 429);

  const week = currentWeek();
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const key = `submissions/${week}/${id}.${hasFile ? EXT[mime] || "bin" : "txt"}`;
  const body = hasFile ? file.stream() : new TextEncoder().encode(writing);
  await env.MEDIA.put(key, body, { httpMetadata: { contentType: hasFile ? mime : "text/plain; charset=utf-8" } });
  const size = hasFile ? file.size : new TextEncoder().encode(writing).length;
  await db.prepare(`INSERT INTO sc_submissions (id, week, created, artist, handle, email, title, media_type, caption, mime, size, media_key, ip_hash)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
    .bind(id, week, new Date().toISOString(), artist, handle, email, title, mediaType, caption, mime, size, key, ih).run();
  return json({ ok: true, id, week });
}

async function media(request, env, id) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT media_key, mime, status FROM sc_submissions WHERE id = ?1").bind(id).first();
  if (!row || (row.status !== "posted" && !isAdmin(request, env))) return new Response("Not found", { status: 404 });
  const range = request.headers.get("range");
  const obj = await env.MEDIA.get(row.media_key, range ? { range: request.headers } : undefined);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "content-type": row.mime === "text/plain" ? "text/plain; charset=utf-8" : row.mime, "accept-ranges": "bytes",
    "cache-control": row.status === "posted" ? "public, max-age=86400" : "private, no-store" });
  if (range && obj.range) {
    const start = obj.range.offset ?? 0;
    const end = start + (obj.range.length ?? obj.size - start) - 1;
    headers.set("content-range", `bytes ${start}-${end}/${obj.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}

async function overview(env) {
  const db = env.DB;
  await ensureSchema(db);
  const week = currentWeek();
  const theme = await themeFor(db, week);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const { results } = await db.prepare(
    "SELECT * FROM sc_submissions WHERE status = 'posted' AND post_date <= ?1 ORDER BY post_date DESC, rank ASC LIMIT 70").bind(today).all();
  const count = await db.prepare("SELECT COUNT(*) AS n FROM sc_submissions WHERE week = ?1").bind(week).first();
  return json({ week, theme, closes: `${week}T18:00`, submittedThisWeek: count ? count.n : 0, picks: results.map(publicPick) });
}

export async function onRequest({ request, env, params }) {
  const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const route = parts.join("/");
  const method = request.method;
  try {
    if (route === "" && method === "GET") return overview(env);
    if (route === "submit" && method === "POST") return submit(request, env);
    if (parts[0] === "media" && parts[1] && method === "GET") return media(request, env, parts[1]);

    if (parts[0] === "admin") {
      if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
      await ensureSchema(env.DB);
      if (parts[1] === "list" && method === "GET") {
        const week = new URL(request.url).searchParams.get("week") || currentWeek();
        const { results } = await env.DB.prepare("SELECT * FROM sc_submissions WHERE week = ?1 ORDER BY created ASC").bind(week).all();
        return json({ week, theme: await themeFor(env.DB, week), submissions: results.map((r) => ({ ...publicPick(r), email: r.email, status: r.status, rank: r.rank, size: r.size, created: r.created })) });
      }
      if (parts[1] === "update" && method === "POST") {
        const b = await request.json();
        if (!["new", "hidden", "winner", "posted"].includes(b.status)) return json({ error: "bad status" }, 400);
        await env.DB.prepare("UPDATE sc_submissions SET status = ?2, post_date = ?3, rank = ?4 WHERE id = ?1")
          .bind(String(b.id), b.status, b.postDate || null, b.rank ?? null).run();
        return json({ ok: true });
      }
      if (parts[1] === "theme" && method === "POST") {
        const b = await request.json();
        const week = b.week || currentWeek();
        await env.DB.prepare("INSERT INTO sc_weeks (week, theme) VALUES (?1, ?2) ON CONFLICT(week) DO UPDATE SET theme = ?2")
          .bind(week, clean(b.theme, 120)).run();
        return json({ ok: true, week });
      }
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: "Something went wrong on our side. Try again in a minute." }, 500);
  }
}
