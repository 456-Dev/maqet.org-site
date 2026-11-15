#!/usr/bin/env python3
"""Pull 1 Minute Film Festival uploads off maqet.org onto the box.

For every finished upload not yet saved:
  1. download the MP4 to ~/.openclaw/workspace/projects/oneminute-films/ (size-checked)
  2. grab a still at ~40% and add the film to the audience-vote list (name = title, team)
  3. Telegram Michael a one-liner
State lives in oneminute-films/pull-state.json. Run by fest-pull.timer every 3 min.
Usage: fest_pull.py [--dry] [--no-vote] [--no-tg] [--no-immich]
Also uploads each film to Michael's Immich album "🎬 1 Minute Fest films".
"""
import json, os, re, subprocess, sys, tempfile, urllib.request, urllib.error
from pathlib import Path

SITE = os.environ.get("MAQET_SITE", "https://maqet.org")
OUT = Path(os.environ.get("FEST_OUT") or Path.home() / ".openclaw/workspace/projects/oneminute-films")
STATE = OUT / "pull-state.json"
FFMPEG = Path.home() / ".openclaw/workspace/timelapse/bin/ffmpeg"
GIVE = Path.home() / ".openclaw/workspace/tools/immich/give.sh"
ENV = Path.home() / ".config/v4keys/maqet-cloudflare.env"
TG_TARGET = "8588336807"
PURGE_OVER = 3.5 * 1024 ** 3   # drop the D1 copy of saved films only if D1 storage gets near the 5 GB free cap

args = set(sys.argv[1:])
DRY = "--dry" in args


def admin_key():
    for line in ENV.read_text().splitlines():
        if line.startswith("MAQET_ADMIN_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("no MAQET_ADMIN_KEY")


KEY = os.environ.get("MAQET_KEY") or admin_key()
UA = {"x-admin-key": KEY, "user-agent": "maqet-box/1"}


def get_json(path):
    with urllib.request.urlopen(urllib.request.Request(SITE + path, headers=UA), timeout=60) as r:
        return json.load(r)


def post_json(path, body):
    req = urllib.request.Request(SITE + path, data=json.dumps(body).encode(), headers={**UA, "content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def post_film(name, team, jpg):
    boundary = "----maqet" + os.urandom(8).hex()
    parts = []
    for k, v in (("name", name), ("team", team)):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="still.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode() + jpg + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(SITE + "/api/fest/admin/film", data=b"".join(parts), headers={**UA, "content-type": f"multipart/form-data; boundary={boundary}"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


WINDOW = 20 * 512_000   # ~10 MB per request: free-plan Workers allow ~50 D1 queries per request


def download(sub, dest):
    """Fetch in byte-range windows so each request stays under the per-request D1 query cap."""
    tmp = dest.with_suffix(".part")
    have = tmp.stat().st_size if tmp.exists() else 0
    fails = 0
    while have < sub["size"] and fails < 12:
        end = min(sub["size"], have + WINDOW) - 1
        try:
            req = urllib.request.Request(f"{SITE}/api/fest/admin/sub/{sub['id']}", headers={**UA, "range": f"bytes={have}-{end}"})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
            if r.status != 206 or len(body) != end - have + 1:
                raise OSError(f"short read {len(body)}")
            with open(tmp, "ab") as f:
                f.write(body)
            have += len(body)
            fails = 0
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            fails += 1
            print("  retry", fails, e)
            import time; time.sleep(2 * fails)
    if have == sub["size"]:
        tmp.rename(dest)
        return True
    return False


def duration(path):
    p = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(path)], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", p.stderr)
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]) if m else None


def still(path, dur):
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "s.jpg"
        t = max(0.5, (dur or 10) * 0.4)
        subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", str(path), "-frames:v", "1",
                        "-vf", "scale='min(1600,iw)':-2", "-q:v", "4", str(out)], check=False)
        return out.read_bytes() if out.exists() and out.stat().st_size > 0 else None


def tg(text):
    if "--no-tg" in args or DRY:
        print("TG:", text); return
    import datetime
    h = datetime.datetime.now().hour
    subprocess.run(["openclaw", "message", "send", *(["--silent"] if 2 <= h < 8 else []), "--channel", "telegram", "--target", TG_TARGET, "--message", text],
                   capture_output=True, timeout=60)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    state = json.loads(STATE.read_text()) if STATE.exists() else {"saved": {}}
    subs = get_json("/api/fest/admin/subs")["subs"]
    for s in subs:
        if s["status"] not in ("done", "saved") or s["id"] in state["saved"]:
            continue
        if s["status"] == "saved":
            continue   # bytes already purged and not ours; nothing to fetch
        safe = re.sub(r"[^\w\- ]+", "", s["title"]).strip().replace(" ", "_")[:60] or "film"
        dest = OUT / f"{s['created'][11:16].replace(':', '')}_{safe}_{s['id']}.mp4"
        print("pull", s["id"], s["title"], s["size"])
        if DRY:
            continue
        if not download(s, dest):
            print("  FAILED", s["id"]); continue
        dur = duration(dest)
        rec = {"file": str(dest), "title": s["title"], "team": s["team"], "email": s["email"], "size": s["size"], "duration": dur, "created": s["created"], "done": s["done"]}
        if "--no-vote" not in args:
            jpg = still(dest, dur)
            try:
                rec["vote_id"] = post_film(s["title"], s["team"] or "", jpg)["id"] if jpg else None
            except Exception as e:
                print("  vote add failed", e)
        if "--no-immich" not in args:
            try:
                note = f"{s['title']}" + (f" / {s['team']}" if s["team"] else "") + f" · {s['email']}"
                p = subprocess.run([str(GIVE), str(dest), note, "--quiet"], capture_output=True, text=True, timeout=1800,
                                   env={**os.environ, "IMMICH_ALBUM": "🎬 1 Minute Fest films"})
                rec["immich"] = p.stdout.strip().splitlines()[-1] if p.returncode == 0 and p.stdout.strip() else None
            except Exception as e:
                print("  immich failed", e)
        state["saved"][s["id"]] = rec
        STATE.write_text(json.dumps(state, indent=1));
        n = len(state["saved"])
        dtxt = f"{dur:.0f}s" if dur else "?s"
        flag = " ⚠️ over 60s" if dur and dur > 61 else ""
        late = " · LATE" if (s["done"] or "") > "2026-11-15T16:00:00" else ""
        tg(f"🎬 Film #{n} in: “{s['title']}”{' / ' + s['team'] if s['team'] else ''} · {dtxt}{flag}{late} · {s['size'] / 1048576:.0f} MB · added to the vote list" + (f"\n{rec['immich']}" if rec.get("immich") else ""))
    # keep D1 under the free cap: only purge saved files when storage gets big
    stored = sum(x["size"] for x in subs if x["status"] == "done")
    if stored > PURGE_OVER and not DRY:
        for sid in list(state["saved"]):
            if stored <= PURGE_OVER * 0.6:
                break
            x = next((x for x in subs if x["id"] == sid and x["status"] == "done"), None)
            if x:
                post_json("/api/fest/admin/sub-purge", {"id": sid}); stored -= x["size"]; print("purged", sid)


if __name__ == "__main__":
    main()
