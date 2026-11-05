// Daily MAQET Showcase API (Cloudflare Pages Function).
// Bindings: DB (D1), ADMIN_KEY (secret). Files live in D1 as 1.5 MB chunks
// (sc_chunks); if an R2 bucket is bound as MEDIA later, new uploads go there instead.
//
//   GET  /api/showcase                 theme, deadline, posted picks (public)
//   POST /api/showcase/submit          multipart submission (public)
//   GET  /api/showcase/media/<id>/<n>  file n of a posted pick (admin key sees any)
//   GET  /api/showcase/admin/list      ?week=YYYY-MM-DD  (X-Admin-Key)
//   POST /api/showcase/admin/update    {id, status, postDate, rank}  (X-Admin-Key)
//   POST /api/showcase/admin/theme     {week, theme}  (X-Admin-Key)
//
// A "week" is named by the Friday its voting happens on. Submissions close
// Friday 6PM New York time; anything later counts toward the next Friday.

const MAX_BYTES = 30 * 1024 * 1024;   // whole submission; 42 MB tested over the free-plan Worker limit, 32 MB OK
const CHUNK = 1_500_000;              // D1 rows max out at 2 MB
const MAX_FILES = 10;                 // Instagram carousel limit
const MEDIA_TYPES = ["Photo", "Painting / drawing", "Digital art", "Video", "Sculpture / 3D", "Textile / fashion", "Mixed media", "Writing", "Music", "Other"];
const IMAGE = /^image\/(jpeg|png|webp|heic|heif|gif)$/;
const VIDEO = /^video\/(mp4|quicktime|webm)$/;
const AUDIO = /^audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac|wav|x-wav|wave)$/;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "image/gif": "gif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav" };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sc_submissions (
     id TEXT PRIMARY KEY, week TEXT NOT NULL, created TEXT NOT NULL,
     artist TEXT NOT NULL, handle TEXT, email TEXT NOT NULL, title TEXT,
     media_type TEXT NOT NULL, caption TEXT, files TEXT NOT NULL, size INTEGER,
     status TEXT NOT NULL DEFAULT 'new',
     post_date TEXT, rank INTEGER, ip_hash TEXT)`,
  `CREATE INDEX IF NOT EXISTS sc_sub_week ON sc_submissions(week)`,
  `CREATE TABLE IF NOT EXISTS sc_weeks (week TEXT PRIMARY KEY, theme TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sc_chunks (key TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (key, n))`,
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  try { await db.prepare("ALTER TABLE sc_submissions ADD COLUMN link TEXT").run(); } catch (e) { /* already there */ }
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

// A week's voting-sheet token: HMAC(ADMIN_KEY, week), so the link works without storing anything.
async function sheetToken(env, week) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ADMIN_KEY || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("sheet:" + week));
  return [...new Uint8Array(sig)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sheetOk(request, env, week) {
  const t = new URL(request.url).searchParams.get("t") || "";
  return Boolean(env.ADMIN_KEY && week && t && t === (await sheetToken(env, week)));
}

function isAdmin(request, env) {
  const key = request.headers.get("x-admin-key") || new URL(request.url).searchParams.get("key");
  return Boolean(env.ADMIN_KEY && key && key === env.ADMIN_KEY);
}

const publicPick = (r) => ({
  id: r.id, artist: r.artist, handle: r.handle, title: r.title, mediaType: r.media_type,
  caption: r.caption, postDate: r.post_date, week: r.week,
  files: JSON.parse(r.files).map((f, n) => ({ url: `/api/showcase/media/${r.id}/${n}`, mime: f.mime, role: f.role })),
});

// Which files a submission needs, by media type. Returns an error string or "".
function checkFiles(mediaType, media, cover, audio, link) {
  if (mediaType === "Music") {
    if (!audio && !link) return "Attach your song (MP3, M4A, WAV or AAC) or paste a link to it.";
    if (audio && !AUDIO.test(audio.type)) return "The song has to be an MP3, M4A, WAV or AAC file.";
    if (!cover) return "Music needs a cover image too.";
    if (!IMAGE.test(cover.type)) return "The cover has to be a JPG, PNG, HEIC or WEBP image.";
    return "";
  }
  if (!media.length && link) return "";
  if (!media.length) return mediaType === "Writing" ? "Attach your writing as images (one per slide)." : "Attach your photo or video.";
  if (media.length > MAX_FILES) return `Up to ${MAX_FILES} files, the most Instagram allows in one post.`;
  for (const f of media) {
    if (mediaType === "Writing" ? !IMAGE.test(f.type) : !(IMAGE.test(f.type) || VIDEO.test(f.type)))
      return mediaType === "Writing" ? "Writing has to be images (JPG, PNG, HEIC, WEBP), one per slide." : "Use JPG, PNG, HEIC, WEBP, GIF, MP4, MOV or WEBM files.";
  }
  return "";
}

async function submit(request, env) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) return json({ error: "Send the form as multipart/form-data." }, 400);
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BYTES + 1e6) return json({ error: "That file is too big. Keep it under 30 MB." }, 413);

  const form = await request.formData();
  if (clean(form.get("website"), 10)) return json({ ok: true }); // honeypot
  const artist = clean(form.get("artist"), 80);
  const email = clean(form.get("email"), 120);
  const handle = clean(form.get("handle"), 60).replace(/^https?:\/\/(www\.)?instagram\.com\//i, "@").replace(/\/$/, "");
  const title = clean(form.get("title"), 120);
  const mediaType = clean(form.get("mediaType"), 40);
  const caption = clean(form.get("caption"), 2000);

  if (!artist) return json({ error: "Add your name as you want it credited." }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Add an email so we can reach you." }, 400);
  if (!MEDIA_TYPES.includes(mediaType)) return json({ error: "Pick a media type." }, 400);
  if (form.get("consent") !== "yes") return json({ error: "Check the box so we can post your work." }, 400);
  const isFile = (f) => f && typeof f !== "string" && f.size;
  const media = form.getAll("files").filter(isFile);
  const cover = isFile(form.get("cover")) ? form.get("cover") : null;
  const audio = isFile(form.get("audio")) ? form.get("audio") : null;
  let link = clean(form.get("link"), 500);
  if (link) {
    try { const u = new URL(/^https?:\/\//i.test(link) ? link : "https://" + link); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw 0; link = u.href; }
    catch (e) { return json({ error: "That link doesn't look right. Paste the full share link." }, 400); }
  }
  const problem = checkFiles(mediaType, media, cover, audio, link);
  if (problem) return json({ error: problem }, 400);
  const parts = mediaType === "Music" ? [[cover, "cover"], ...(audio ? [[audio, "audio"]] : [])] : media.map((f) => [f, "media"]);
  const total = parts.reduce((n, [f]) => n + f.size, 0);
  if (total > MAX_BYTES) return json({ error: "That's too big. Keep everything under 30 MB." }, 413);
  const db = env.DB;
  await ensureSchema(db);
  const ih = await ipHash(request);
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM sc_submissions WHERE ip_hash = ?1 AND created > ?2")
    .bind(ih, new Date(Date.now() - 3600e3).toISOString()).first();
  if (recent && recent.n >= 10) return json({ error: "Too many uploads from here in the last hour. Try again later." }, 429);

  const week = currentWeek();
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const files = [];
  for (const [n, [f, role]] of parts.entries()) {
    const mime = (f.type || "").toLowerCase();
    const key = `submissions/${week}/${id}-${n}.${EXT[mime] || "bin"}`;
    await putFile(env, key, f, mime);
    files.push({ key, mime, size: f.size, role, ...(env.MEDIA ? {} : { d1: 1 }) });
  }
  await db.prepare(`INSERT INTO sc_submissions (id, week, created, artist, handle, email, title, media_type, caption, files, size, ip_hash, link)
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`)
    .bind(id, week, new Date().toISOString(), artist, handle, email, title, mediaType, caption, JSON.stringify(files), total, ih, link || null).run();
  return json({ ok: true, id, week });
}

// ── file storage: R2 when bound, otherwise chunked into D1 ──
async function putFile(env, key, f, mime) {
  if (env.MEDIA) return env.MEDIA.put(key, f.stream(), { httpMetadata: { contentType: mime } });
  // Stream the file so only one chunk is held at a time.
  const reader = f.stream().getReader();
  const buf = new Uint8Array(CHUNK);
  let fill = 0, n = 0;
  const flush = async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO sc_chunks (key, n, data) VALUES (?1, ?2, ?3)").bind(key, n++, buf.slice(0, fill)).run();
    fill = 0;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let off = 0; off < value.length;) {
      const take = Math.min(CHUNK - fill, value.length - off);
      buf.set(value.subarray(off, off + take), fill); fill += take; off += take;
      if (fill === CHUNK) await flush();
    }
  }
  if (fill) await flush();
}

// Bytes [start, end] of a D1-chunked file, streamed chunk by chunk.
function d1Stream(env, key, start, end) {
  let n = Math.floor(start / CHUNK);
  const last = Math.floor(end / CHUNK);
  return new ReadableStream({
    async pull(ctl) {
      if (n > last) return ctl.close();
      const row = await env.DB.prepare("SELECT data FROM sc_chunks WHERE key = ?1 AND n = ?2").bind(key, n).first();
      if (!row) return ctl.error(new Error("missing chunk"));
      const bytes = new Uint8Array(row.data);
      const base = n * CHUNK;
      ctl.enqueue(bytes.subarray(Math.max(0, start - base), Math.min(bytes.length, end - base + 1)));
      n++;
    },
  });
}

async function media(request, env, id, n) {
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT files, status, week FROM sc_submissions WHERE id = ?1").bind(id).first();
  if (!row || (row.status !== "posted" && row.status !== "hidden" && !isAdmin(request, env) && !(await sheetOk(request, env, row.week)))) return new Response("Not found", { status: 404 });
  if (row.status === "hidden" && !isAdmin(request, env)) return new Response("Not found", { status: 404 });
  const file = JSON.parse(row.files)[Number(n) || 0];
  if (!file) return new Response("Not found", { status: 404 });
  const headers = new Headers({ "content-type": file.mime, "accept-ranges": "bytes",
    "cache-control": row.status === "posted" ? "public, max-age=86400" : "private, no-store" });
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  if (env.MEDIA && !file.d1) {
    const obj = await env.MEDIA.get(file.key, range ? { range: request.headers } : undefined);
    if (!obj) return new Response("Not found", { status: 404 });
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
  const size = file.size;
  let start = 0, end = size - 1;
  if (range) {
    if (range[1] === "") { start = Math.max(0, size - Number(range[2])); }
    else { start = Number(range[1]); if (range[2] !== "") end = Math.min(end, Number(range[2])); }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    headers.set("content-range", `bytes ${start}-${end}/${size}`);
  }
  headers.set("content-length", String(end - start + 1));
  return new Response(d1Stream(env, file.key, start, end), { status: range ? 206 : 200, headers });
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
    if (parts[0] === "media" && parts[1] && method === "GET") return media(request, env, parts[1], parts[2]);

    // Voting gallery for one week: /api/showcase/sheet/<week>?t=<token>&order=<id,id,...>
    if (parts[0] === "sheet" && parts[1] && method === "GET") {
      const week = parts[1];
      if (!(await sheetOk(request, env, week))) return json({ error: "This voting link isn't valid." }, 403);
      await ensureSchema(env.DB);
      const t = new URL(request.url).searchParams.get("t");
      const { results } = await env.DB.prepare("SELECT * FROM sc_submissions WHERE week = ?1 AND status != 'hidden' ORDER BY created ASC").bind(week).all();
      return json({ week, theme: await themeFor(env.DB, week), pieces: results.map((r) => {
        const pk = publicPick(r);
        pk.files = pk.files.map((f) => ({ ...f, url: f.url + "?t=" + t }));
        return pk;
      }) });
    }
    if (parts[0] === "admin" && parts[1] === "sheet-token" && isAdmin(request, env)) {
      const week = new URL(request.url).searchParams.get("week") || currentWeek();
      return json({ week, t: await sheetToken(env, week) });
    }

    if (parts[0] === "admin") {
      if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
      await ensureSchema(env.DB);
      if (parts[1] === "list" && method === "GET") {
        const week = new URL(request.url).searchParams.get("week") || currentWeek();
        const { results } = await env.DB.prepare("SELECT * FROM sc_submissions WHERE week = ?1 ORDER BY created ASC").bind(week).all();
        return json({ week, theme: await themeFor(env.DB, week), submissions: results.map((r) => ({ ...publicPick(r), email: r.email, status: r.status, rank: r.rank, size: r.size, created: r.created, link: r.link, keys: JSON.parse(r.files).map((f) => f.key) })) });
      }
      if (parts[1] === "update" && method === "POST") {
        const b = await request.json();
        if (!["new", "hidden", "winner", "posted"].includes(b.status)) return json({ error: "bad status" }, 400);
        await env.DB.prepare("UPDATE sc_submissions SET status = ?2, post_date = ?3, rank = ?4 WHERE id = ?1")
          .bind(String(b.id), b.status, b.postDate || null, b.rank ?? null).run();
        return json({ ok: true });
      }
      // Box pushes files it fetched from share links: raw chunks first, then attach.
      if (parts[1] === "chunk" && method === "POST") {
        const q = new URL(request.url).searchParams;
        const key = String(q.get("key") || ""), n = Number(q.get("n"));
        if (!/^links\/[\w.\/-]+$/.test(key) || !(n >= 0)) return json({ error: "bad key" }, 400);
        const buf = new Uint8Array(await request.arrayBuffer());
        if (buf.length > CHUNK) return json({ error: "chunk too big" }, 413);
        await env.DB.prepare("INSERT OR REPLACE INTO sc_chunks (key, n, data) VALUES (?1, ?2, ?3)").bind(key, n, buf).run();
        return json({ ok: true });
      }
      if (parts[1] === "attach" && method === "POST") {
        const b = await request.json();
        const row = await env.DB.prepare("SELECT files FROM sc_submissions WHERE id = ?1").bind(String(b.id)).first();
        if (!row) return json({ error: "no such submission" }, 404);
        const files = JSON.parse(row.files).filter((f) => f.key !== b.key);
        files.push({ key: String(b.key), mime: String(b.mime), size: Number(b.size), role: String(b.role || "media"), d1: 1, fromLink: 1 });
        await env.DB.prepare("UPDATE sc_submissions SET files = ?2 WHERE id = ?1").bind(String(b.id), JSON.stringify(files)).run();
        return json({ ok: true, n: files.length - 1 });
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
