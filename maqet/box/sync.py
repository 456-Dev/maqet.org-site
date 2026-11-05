#!/usr/bin/env python3
"""Pull a showcase week onto the box: every submission's uploaded files plus
anything behind its share link (Google Drive, Dropbox, WeTransfer, or a direct
file URL). Writes <DATA>/<week>/<id>/ and <DATA>/<week>/manifest.json.

  sync.py [--week YYYY-MM-DD] [--base https://maqet.org]

Needs MAQET_ADMIN_KEY in ~/.config/v4keys/maqet-cloudflare.env.
Run with tools/venvs/ml/bin/python (requests, gdown).
"""
import argparse, json, mimetypes, os, re, shutil, subprocess, sys, tempfile, zipfile
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

import requests

DATA = Path(os.environ.get("MAQET_DATA", Path.home() / ".openclaw/workspace/projects/maqet-showcase-data"))
ENV = Path.home() / ".config/v4keys/maqet-cloudflare.env"
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36"}
MAX_BYTES = 2 * 1024**3
KEEP = re.compile(r"^(image|video|audio)/")


def admin_key():
    for line in ENV.read_text().splitlines():
        if line.startswith("MAQET_ADMIN_KEY="):
            return line.split("=", 1)[1].strip()
    sys.exit("MAQET_ADMIN_KEY missing from " + str(ENV))


def stream_to(resp, dest):
    total = 0
    with open(dest, "wb") as fh:
        for chunk in resp.iter_content(1 << 20):
            total += len(chunk)
            if total > MAX_BYTES:
                raise RuntimeError("file over 2 GB")
            fh.write(chunk)
    return dest


def filename_from(resp, fallback):
    cd = resp.headers.get("content-disposition", "")
    m = re.search(r"filename\*=UTF-8''([^;]+)", cd) or re.search(r'filename="?([^";]+)"?', cd)
    name = requests.utils.unquote(m.group(1)) if m else fallback
    return re.sub(r"[^\w.\- ]+", "_", name).strip() or fallback


def direct(url, out, session=None):
    s = session or requests.Session()
    r = s.get(url, headers=UA, stream=True, timeout=60, allow_redirects=True)
    r.raise_for_status()
    if "text/html" in r.headers.get("content-type", ""):
        raise RuntimeError("link opened a web page, not a file (is it shared publicly?)")
    return [stream_to(r, out / filename_from(r, "download"))]


def google_drive(url, out):
    import gdown
    if "/folders/" in url:
        got = gdown.download_folder(url=url, output=str(out), quiet=True, use_cookies=False) or []
        return [Path(p) for p in got]
    m = re.search(r"/d/([\w-]{20,})", url) or re.search(r"[?&]id=([\w-]{20,})", url)
    if not m:
        raise RuntimeError("couldn't find the file id in that Google Drive link")
    got = gdown.download(id=m.group(1), output=str(out) + "/", quiet=True, use_cookies=False, retries=2)
    if not got:
        raise RuntimeError("Google Drive refused the download (is the link set to 'Anyone with the link'?)")
    return [Path(got)]


def dropbox(url, out):
    u = urlparse(url)
    q = {k: v[-1] for k, v in parse_qs(u.query).items()}
    q["dl"] = "1"
    return direct(urlunparse(u._replace(query=urlencode(q))), out)


def wetransfer(url, out):
    s = requests.Session()
    page = s.get(url, headers=UA, timeout=60, allow_redirects=True)
    m = re.search(r"/downloads/([0-9a-f]+)/(?:[0-9a-f]+/)?([0-9a-f]+)", page.url)
    if not m:
        raise RuntimeError("couldn't read that WeTransfer link (expired?)")
    transfer_id, security_hash = m.group(1), m.group(2)
    token = re.search(r'name="csrf-token" content="([^"]+)"', page.text)
    headers = {**UA, "Content-Type": "application/json", "x-requested-with": "XMLHttpRequest"}
    if token:
        headers["x-csrf-token"] = token.group(1)
    r = s.post(f"https://wetransfer.com/api/v4/transfers/{transfer_id}/download", headers=headers,
               json={"security_hash": security_hash, "intent": "entire_transfer"}, timeout=60)
    r.raise_for_status()
    link = r.json().get("direct_link")
    if not link:
        raise RuntimeError("WeTransfer didn't give a download link (expired?)")
    return direct(link, out, s)


def fetch_link(url, out):
    host = urlparse(url).hostname or ""
    if "drive.google.com" in host or "docs.google.com" in host:
        return google_drive(url, out)
    if host.endswith("dropbox.com") or host.endswith("dropboxusercontent.com"):
        return dropbox(url, out)
    if host in ("we.tl", "wetransfer.com") or host.endswith(".wetransfer.com"):
        return wetransfer(url, out)
    return direct(url, out)


def sniff(path):
    """Real MIME type from the file contents (ffprobe for media, extension as a hint)."""
    guess = mimetypes.guess_type(path.name)[0] or ""
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=format_name",
                            "-of", "json", str(path)], capture_output=True, text=True, timeout=60)
        info = json.loads(p.stdout or "{}")
        kinds = {s.get("codec_type") for s in info.get("streams", [])}
        fmt = info.get("format", {}).get("format_name", "")
        if fmt.endswith("_pipe") or fmt in ("png_pipe", "jpeg_pipe", "image2", "webp_pipe", "gif"):
            return guess if guess.startswith("image/") else "image/jpeg"
        if "video" in kinds and not guess.startswith("image/") and not guess.startswith("audio/"):
            return guess if guess.startswith("video/") else "video/mp4"
        if "audio" in kinds:
            return guess if guess.startswith("audio/") else "audio/mpeg"
    except Exception:
        pass
    return guess


def unpack(files, out):
    """Expand any zip into its media files; drop everything that isn't image/video/audio."""
    keep = []
    for f in files:
        if zipfile.is_zipfile(f):
            with zipfile.ZipFile(f) as z:
                for info in z.infolist():
                    name = Path(info.filename).name
                    if info.is_dir() or name.startswith((".", "__MACOSX")):
                        continue
                    dest = out / re.sub(r"[^\w.\- ]+", "_", name)
                    with z.open(info) as src, open(dest, "wb") as dst:
                        shutil.copyfileobj(src, dst)
                    keep.append(dest)
            f.unlink()
        else:
            keep.append(f)
    media = []
    for f in sorted(keep):
        mime = sniff(f)
        if KEEP.match(mime):
            media.append({"path": f.name, "mime": mime, "size": f.stat().st_size, "role": "media", "from": "link"})
        else:
            f.unlink()
    return media


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--week")
    ap.add_argument("--base", default="https://maqet.org")
    args = ap.parse_args()
    key = admin_key()
    api = args.base.rstrip("/") + "/api/showcase"
    q = {"week": args.week} if args.week else {}
    listing = requests.get(api + "/admin/list", params=q, headers={"x-admin-key": key}, timeout=60).json()
    week = listing["week"]
    wdir = DATA / week
    wdir.mkdir(parents=True, exist_ok=True)
    manifest = {"week": week, "theme": listing.get("theme", ""), "submissions": []}

    for sub in listing["submissions"]:
        sdir = wdir / sub["id"]
        sdir.mkdir(exist_ok=True)
        entry = {k: sub.get(k) for k in ("id", "artist", "handle", "email", "title", "mediaType", "caption", "created", "status", "link")}
        entry["files"], entry["errors"] = [], []
        # uploaded files
        for n, f in enumerate(sub["files"]):
            ext = mimetypes.guess_extension(f["mime"]) or ""
            dest = sdir / f"upload-{n}{ext}"
            if not dest.exists():
                try:
                    r = requests.get(args.base.rstrip("/") + f["url"], headers={"x-admin-key": key}, stream=True, timeout=120)
                    r.raise_for_status()
                    stream_to(r, dest)
                except Exception as e:
                    entry["errors"].append(f"upload {n}: {e}")
                    continue
            entry["files"].append({"path": dest.name, "mime": f["mime"], "size": dest.stat().st_size, "role": f["role"], "from": "upload"})
        # share link
        if sub.get("link"):
            ldir = sdir / "link"
            done = ldir / ".done.json"
            if done.exists():
                entry["files"] += json.loads(done.read_text())
            else:
                ldir.mkdir(exist_ok=True)
                try:
                    with tempfile.TemporaryDirectory(dir=ldir) as tmp:
                        got = fetch_link(sub["link"], Path(tmp))
                        moved = []
                        for g in got:
                            dest = ldir / Path(g).name
                            shutil.move(str(g), dest)
                            moved.append(dest)
                    media = unpack(moved, ldir)
                    for m in media:
                        m["path"] = "link/" + m["path"]
                        if sub["mediaType"] == "Music" and m["mime"].startswith("audio/"):
                            m["role"] = "audio"
                    if not media:
                        raise RuntimeError("the link had no photos, videos or audio in it")
                    done.write_text(json.dumps(media))
                    entry["files"] += media
                except Exception as e:
                    entry["errors"].append(f"link: {e}")
        manifest["submissions"].append(entry)
        status = "ok" if not entry["errors"] else "; ".join(entry["errors"])
        print(f'{sub["id"]}  {sub["artist"][:24]:24}  {len(entry["files"])} files  {status}')

    (wdir / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"{len(manifest['submissions'])} submissions → {wdir}")


if __name__ == "__main__":
    main()
