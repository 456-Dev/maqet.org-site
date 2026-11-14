// 1 Minute Film Festival audience vote (Cloudflare Pages Function).
// Bindings: DB (D1, shared with the showcase), ADMIN_KEY (secret).
//
//   GET  /api/fest                 films, voting state, voter names; results once voting has closed
//   GET  /api/fest/img/<id>        a film's still
//   POST /api/fest/vote            {name, picks:[1st, 2nd, 3rd]}  (one ballot per name, last one counts)
//   Admin (X-Admin-Key or ?key=):
//   POST /api/fest/admin/film      multipart {name, team, image}         add a film
//   POST /api/fest/admin/edit      {id, name?, team?, ord?}              rename / reorder
//   POST /api/fest/admin/delete    {id}
//   POST /api/fest/admin/start     {minutes=5}                           open voting now for N minutes
//   POST /api/fest/admin/stop                                            close voting now (shows results)
//   POST /api/fest/admin/reset     {votes=true}                          back to "not open yet"
//   GET  /api/fest/admin/results                                         live tally, any time
//
// Scoring: 1st pick = 3 points, 2nd = 2, 3rd = 1. Ties go to the film with more 1st-place picks, then 2nd.

const POINTS = [3, 2, 1];
const MAX_IMG = 1_800_000;   // D1 rows max out at 2 MB; the admin page resizes stills before upload

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fv_films (id TEXT PRIMARY KEY, name TEXT NOT NULL, team TEXT, ord INTEGER NOT NULL DEFAULT 0, mime TEXT, img BLOB, created TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fv_state (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS fv_votes (voter TEXT PRIMARY KEY, name TEXT NOT NULL, picks TEXT NOT NULL, updated TEXT NOT NULL, ip_hash TEXT)`,
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

function isAdmin(request, env) {
  const key = request.headers.get("x-admin-key") || new URL(request.url).searchParams.get("key");
  return Boolean(env.ADMIN_KEY && key && key === env.ADMIN_KEY);
}
async function ipHash(request) {
  const ip = request.headers.get("cf-connecting-ip") || "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fest|" + ip));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getState(db) {
  const { results } = await db.prepare("SELECT k, v FROM fv_state").all();
  const s = Object.fromEntries(results.map((r) => [r.k, r.v]));
  const now = Date.now();
  let phase = "before";
  if (s.closes) phase = now < Date.parse(s.closes) ? "open" : "closed";
  return { phase, opens: s.opens || null, closes: s.closes || null };
}
async function setState(db, obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) await db.prepare("DELETE FROM fv_state WHERE k = ?1").bind(k).run();
    else await db.prepare("INSERT INTO fv_state (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2").bind(k, v).run();
  }
}

async function films(db) {
  const { results } = await db.prepare("SELECT id, name, team, ord, mime, created FROM fv_films ORDER BY ord ASC, created ASC").all();
  return results.map((r) => ({ id: r.id, name: r.name, team: r.team || "", ord: r.ord, img: r.mime ? `/api/fest/img/${r.id}?v=${encodeURIComponent(r.created)}` : null }));
}

async function tally(db, list) {
  const { results: votes } = await db.prepare("SELECT name, picks FROM fv_votes ORDER BY updated ASC").all();
  const score = Object.fromEntries(list.map((f) => [f.id, { ...f, points: 0, places: [0, 0, 0] }]));
  for (const v of votes) {
    JSON.parse(v.picks).forEach((id, i) => { if (score[id] && i < 3) { score[id].points += POINTS[i]; score[id].places[i]++; } });
  }
  const ranked = Object.values(score).sort((a, b) =>
    b.points - a.points || b.places[0] - a.places[0] || b.places[1] - a.places[1] || a.ord - b.ord);
  let rank = 0, prev = null;
  ranked.forEach((f, i) => {
    const key = f.points + "|" + f.places.join(",");
    if (key !== prev) rank = i + 1;
    f.rank = rank; prev = key;
  });
  return { voters: votes.length, ranked };
}

async function overview(env) {
  const db = env.DB;
  const list = await films(db);
  const state = await getState(db);
  const { results: votes } = await db.prepare("SELECT name FROM fv_votes ORDER BY updated ASC").all();
  const out = { ...state, now: new Date().toISOString(), films: list, voters: votes.map((v) => v.name) };
  if (state.phase === "closed") out.results = (await tally(db, list)).ranked;
  return json(out);
}

async function vote(request, env) {
  const db = env.DB;
  const state = await getState(db);
  if (state.phase === "before") return json({ error: "Voting hasn't opened yet. Hang tight." }, 403);
  if (state.phase === "closed") return json({ error: "Voting is closed. Results are up." }, 403);
  const b = await request.json().catch(() => ({}));
  const name = clean(b.name, 60);
  if (name.length < 2) return json({ error: "Write your name so we know who voted." }, 400);
  const ids = (await films(db)).map((f) => f.id);
  const need = Math.min(3, ids.length);
  const picks = [...new Set((Array.isArray(b.picks) ? b.picks : []).map(String))].filter((id) => ids.includes(id));
  if (picks.length !== need) return json({ error: `Pick your top ${need}.` }, 400);
  const voter = name.toLowerCase().replace(/\s+/g, " ");
  await db.prepare(`INSERT INTO fv_votes (voter, name, picks, updated, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5)
                    ON CONFLICT(voter) DO UPDATE SET name = ?2, picks = ?3, updated = ?4, ip_hash = ?5`)
    .bind(voter, name, JSON.stringify(picks), new Date().toISOString(), await ipHash(request)).run();
  const { results: votes } = await db.prepare("SELECT name FROM fv_votes ORDER BY updated ASC").all();
  return json({ ok: true, voters: votes.map((v) => v.name) });
}

async function admin(request, env, action) {
  const db = env.DB;
  const method = request.method;
  if (action === "results" && method === "GET") {
    const list = await films(db);
    const { results: ballots } = await db.prepare("SELECT name, picks, updated FROM fv_votes ORDER BY updated ASC").all();
    return json({ ...(await getState(db)), ...(await tally(db, list)), ballots: ballots.map((b) => ({ ...b, picks: JSON.parse(b.picks) })) });
  }
  if (method !== "POST") return json({ error: "not found" }, 404);
  if (action === "film") {
    const form = await request.formData();
    const name = clean(form.get("name"), 100);
    if (!name) return json({ error: "The film needs a name." }, 400);
    const img = form.get("image");
    let mime = null, bytes = null;
    if (img && typeof img === "object" && img.size) {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(img.type)) return json({ error: "Use a JPG, PNG or WEBP image." }, 400);
      if (img.size > MAX_IMG) return json({ error: "Image is too big (max 1.8 MB)." }, 400);
      mime = img.type; bytes = await img.arrayBuffer();
    }
    const max = await db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM fv_films").first();
    const id = crypto.randomUUID().slice(0, 8);
    await db.prepare("INSERT INTO fv_films (id, name, team, ord, mime, img, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(id, name, clean(form.get("team"), 100), (max ? max.m : 0) + 1, mime, bytes, new Date().toISOString()).run();
    return json({ ok: true, id });
  }
  if (action === "image") {
    const form = await request.formData();
    const id = String(form.get("id") || "");
    const img = form.get("image");
    if (!img || !img.size || !/^image\/(jpeg|png|webp|gif)$/.test(img.type) || img.size > MAX_IMG) return json({ error: "Use a JPG, PNG or WEBP under 1.8 MB." }, 400);
    await db.prepare("UPDATE fv_films SET mime = ?2, img = ?3, created = ?4 WHERE id = ?1").bind(id, img.type, await img.arrayBuffer(), new Date().toISOString()).run();
    return json({ ok: true });
  }
  const b = await request.json().catch(() => ({}));
  if (action === "edit") {
    const row = await db.prepare("SELECT * FROM fv_films WHERE id = ?1").bind(String(b.id)).first();
    if (!row) return json({ error: "No such film." }, 404);
    await db.prepare("UPDATE fv_films SET name = ?2, team = ?3, ord = ?4 WHERE id = ?1")
      .bind(row.id, b.name != null ? clean(b.name, 100) || row.name : row.name, b.team != null ? clean(b.team, 100) : row.team, Number.isFinite(+b.ord) && b.ord !== null ? +b.ord : row.ord).run();
    return json({ ok: true });
  }
  if (action === "delete") {
    await db.prepare("DELETE FROM fv_films WHERE id = ?1").bind(String(b.id)).run();
    return json({ ok: true });
  }
  if (action === "start") {
    const minutes = Math.max(0.5, Math.min(180, +b.minutes || 5));
    const now = Date.now();
    await setState(db, { opens: new Date(now).toISOString(), closes: new Date(now + minutes * 60e3).toISOString() });
    return json({ ok: true, ...(await getState(db)) });
  }
  if (action === "stop") {
    await setState(db, { closes: new Date().toISOString() });
    return json({ ok: true, ...(await getState(db)) });
  }
  if (action === "reset") {
    await setState(db, { opens: null, closes: null });
    if (b.votes !== false) await db.prepare("DELETE FROM fv_votes").run();
    return json({ ok: true, ...(await getState(db)) });
  }
  return json({ error: "not found" }, 404);
}

export async function onRequest({ request, env, params }) {
  const parts = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
  const method = request.method;
  try {
    await ensureSchema(env.DB);
    if (parts.length === 0 && method === "GET") return overview(env);
    if (parts[0] === "vote" && method === "POST") return vote(request, env);
    if (parts[0] === "img" && parts[1] && method === "GET") {
      const row = await env.DB.prepare("SELECT mime, img FROM fv_films WHERE id = ?1").bind(parts[1]).first();
      if (!row || !row.img) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(row.img), { headers: { "content-type": row.mime, "cache-control": "public, max-age=86400" } });
    }
    if (parts[0] === "admin") {
      if (!isAdmin(request, env)) return json({ error: "Wrong admin key." }, 403);
      return admin(request, env, parts[1]);
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: "Something went wrong on our side. Try again." }, 500);
  }
}
