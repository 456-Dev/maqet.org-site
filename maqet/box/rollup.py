#!/usr/bin/env python3
"""Build the Friday voting PDF from a synced week (run sync.py first).

  rollup.py [--week YYYY-MM-DD] [--out file.pdf]

Page 1: theme, how to vote, contact-sheet grid of every numbered piece.
Then one page per piece: big number, its images (carousel slides, video
stills, music cover), artist, title, media type, suggested caption.
Writes <DATA>/<week>/rollup.pdf and numbers.json (number -> submission id).
"""
import argparse, hashlib, hmac, io, json, os, subprocess, textwrap
from pathlib import Path

from PIL import Image, ImageOps
from reportlab.lib.colors import Color, HexColor
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

DATA = Path(os.environ.get("MAQET_DATA", Path.home() / ".openclaw/workspace/projects/maqet-showcase-data"))
INK = HexColor("#222222")
GREY = HexColor("#6a6a6a")
STAR = Color(228 / 255, 24 / 255, 180 / 255)
W, H = letter
M = 42  # margin
SITE = os.environ.get("MAQET_SITE", "https://maqet.org")
ENV = Path.home() / ".config/v4keys/maqet-cloudflare.env"


def sheet_url(week):
    """Private voting-gallery link; same HMAC as functions/api/showcase sheetToken()."""
    key = next(l.split("=", 1)[1].strip() for l in ENV.read_text().splitlines() if l.startswith("MAQET_ADMIN_KEY="))
    t = hmac.new(key.encode(), ("sheet:" + week).encode(), hashlib.sha256).hexdigest()[:24]
    return f"{SITE}/showcase/vote/?w={week}&t={t}"


def qr(url):
    import qrcode
    img = qrcode.make(url, box_size=8, border=1).convert("RGB")
    buf = io.BytesIO(); img.save(buf, "PNG"); buf.seek(0)
    return ImageReader(buf)


def still(path, mime, cache):
    """A PIL image for any piece file: the image itself, a video frame, or None for audio."""
    if mime.startswith("image/"):
        try:
            im = Image.open(path)
            im = ImageOps.exif_transpose(im)
            return im.convert("RGB")
        except Exception:
            out = cache / (path.name + ".jpg")   # HEIC etc: let ffmpeg decode
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-frames:v", "1", str(out)])
            return Image.open(out).convert("RGB") if out.exists() else None
    if mime.startswith("video/"):
        out = cache / (path.name + ".jpg")
        if not out.exists():
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", "1", "-i", str(path), "-frames:v", "1", "-vf", "scale='min(1600,iw)':-2", str(out)])
            if not out.exists():
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(path), "-frames:v", "1", str(out)])
        return Image.open(out).convert("RGB") if out.exists() else None
    return None


def duration(path):
    p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        s = float(p.stdout.strip())
        return f"{int(s // 60)}:{int(s % 60):02d}"
    except ValueError:
        return ""


def fit(c, im, x, y, w, h):
    """Draw im inside box (x,y,w,h), whole image, centered, as a ~200 dpi JPEG."""
    iw, ih = im.size
    target = max(w, h) * 200 / 72
    if max(iw, ih) > target:
        im = im.copy(); im.thumbnail((int(target), int(target)))
    buf = __import__("io").BytesIO(); im.convert("RGB").save(buf, "JPEG", quality=85); buf.seek(0)
    s = min(w / iw, h / ih)
    dw, dh = iw * s, ih * s
    c.drawImage(ImageReader(buf), x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)


def wrap(c, text, x, y, width, font, size, leading, color=INK, max_lines=99):
    c.setFont(font, size)
    c.setFillColor(color)
    chars = max(10, int(width / (size * 0.5)))
    lines = []
    for para in (text or "").splitlines() or [""]:
        lines += textwrap.wrap(para, chars) or [""]
    for i, line in enumerate(lines[:max_lines]):
        if i == max_lines - 1 and len(lines) > max_lines:
            line = line[: max(0, len(line) - 1)] + "…"
        c.drawString(x, y - i * leading, line)
    return y - min(len(lines), max_lines) * leading


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--week")
    ap.add_argument("--out")
    args = ap.parse_args()
    weeks = sorted(p.name for p in DATA.iterdir() if (p / "manifest.json").exists())
    week = args.week or weeks[-1]
    wdir = DATA / week
    man = json.loads((wdir / "manifest.json").read_text())
    subs = [s for s in man["submissions"] if s.get("status") != "hidden"]   # same set + order as the gallery
    subs.sort(key=lambda s: s["created"])
    cache = wdir / ".stills"
    cache.mkdir(exist_ok=True)

    pieces = []
    for n, s in enumerate(subs, 1):
        sdir = wdir / s["id"]
        visuals, audio = [], None
        for f in s["files"]:
            p = sdir / f["path"]
            if f["mime"].startswith("audio/"):
                audio = p
                continue
            im = still(p, f["mime"], cache)
            if im:
                visuals.append((im, f["mime"], p))
        pieces.append({"n": n, "sub": s, "visuals": visuals, "audio": audio})

    gallery = sheet_url(week)
    out = Path(args.out) if args.out else wdir / "rollup.pdf"
    c = canvas.Canvas(str(out), pagesize=letter)
    c.setTitle(f"MAQET Showcase · {man['theme']} · week of {week}")

    # ── page 1: cover + contact sheet ──
    c.setFillColor(INK); c.setFont("Helvetica", 20)
    c.drawString(M, H - M - 14, "MAQET COLLECTIVE")
    c.setFont("Helvetica-Bold", 10); c.setFillColor(STAR)
    c.drawString(M, H - M - 40, f"DAILY MAQET SHOWCASE · VOTING SHEET · FRIDAY {week}")
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 30)
    c.drawString(M, H - M - 78, (man["theme"] or "This week").upper())
    c.setFont("Helvetica", 11); c.setFillColor(INK)
    c.drawString(M, H - M - 100, f"{len(pieces)} submissions. Pick your 7 favorites and reply in the group:")
    c.setFont("Helvetica-Bold", 14)
    c.drawString(M, H - M - 122, "vote 3 7 12 1 9 14 5")
    c.setFont("Helvetica", 9); c.setFillColor(GREY)
    c.drawString(M, H - M - 138, "Seven different numbers. Send again to change your vote; your last one counts. Top 7 post to @_maqet_.")
    c.drawImage(qr(gallery), W - M - 92, H - M - 128, 92, 92)
    c.setFillColor(STAR); c.setFont("Helvetica-Bold", 8)
    c.drawRightString(W - M, H - M - 28, "SCAN OR TAP TO PLAY VIDEOS + SONGS")
    c.linkURL(gallery, (W - M - 92, H - M - 128, W - M, H - M - 36), relative=0)
    c.setStrokeColor(INK); c.setLineWidth(.6); c.line(M, H - M - 150, W - M, H - M - 150)

    cols = 4 if len(pieces) > 9 else 3
    gap = 12
    cw = (W - 2 * M - (cols - 1) * gap) / cols
    ch = cw * 1.0 + 30
    top = H - M - 165
    x0 = M
    base = 0  # index of the first piece on the current contact-sheet page
    for i, p in enumerate(pieces):
        k = i - base
        col, row = k % cols, k // cols
        y = top - (row + 1) * (ch + gap)
        if y < M:   # continue the contact sheet on a new page
            c.showPage(); top = H - M; base = i - col; row = 0
            y = top - (ch + gap)
        x = x0 + col * (cw + gap)
        c.setFillColor(HexColor("#f2f2f2")); c.rect(x, y + 30, cw, cw, stroke=0, fill=1)
        if p["visuals"]:
            fit(c, p["visuals"][0][0], x, y + 30, cw, cw)
        c.linkURL(f"{gallery}#{p['n']}", (x, y, x + cw, y + 30 + cw), relative=0)
        c.setFillColor(STAR); c.circle(x + 15, y + 30 + cw - 15, 12, stroke=0, fill=1)
        c.setFillColor(HexColor("#ffffff")); c.setFont("Helvetica-Bold", 12)
        c.drawCentredString(x + 15, y + 30 + cw - 19.5, str(p["n"]))
        s = p["sub"]
        extra = f" · {len(p['visuals'])} slides" if len(p["visuals"]) > 1 else ""
        c.setFillColor(INK); c.setFont("Helvetica-Bold", 9)
        c.drawString(x, y + 18, s["artist"][:34])
        c.setFillColor(GREY); c.setFont("Helvetica", 8)
        c.drawString(x, y + 7, ((s.get("title") or "") + (" · " if s.get("title") else "") + s["mediaType"] + extra)[:46])
    c.showPage()

    # ── one page per piece ──
    for p in pieces:
        s = p["sub"]
        c.setFillColor(STAR); c.setFont("Helvetica-Bold", 64)
        c.drawString(M, H - M - 52, str(p["n"]))
        c.setFillColor(INK); c.setFont("Helvetica-Bold", 18)
        c.drawString(M + 90, H - M - 22, s["artist"][:48])
        c.setFont("Helvetica", 11); c.setFillColor(GREY)
        meta = [s.get("title") or "", s["mediaType"]]
        if s.get("handle"): meta.append("@" + s["handle"].lstrip("@"))
        if p["audio"]: meta.append("song " + duration(p["audio"]))
        vids = [v for v in p["visuals"] if v[1].startswith("video/")]
        if vids: meta.append("video " + duration(vids[0][2]))
        c.drawString(M + 90, H - M - 40, "  ·  ".join(x for x in meta if x)[:95])
        c.setStrokeColor(INK); c.setLineWidth(.6); c.line(M, H - M - 66, W - M, H - M - 66)

        cap_h = 120
        area_top, area_bot = H - M - 80, M + cap_h
        vis = p["visuals"]
        if len(vis) <= 1:
            if vis: fit(c, vis[0][0], M, area_bot, W - 2 * M, area_top - area_bot)
        else:
            k = len(vis)
            gcols = 2 if k <= 4 else 3
            grows = -(-k // gcols)
            gw = (W - 2 * M - (gcols - 1) * 8) / gcols
            gh = (area_top - area_bot - (grows - 1) * 8) / grows
            for j, (im, mime, _) in enumerate(vis):
                gx = M + (j % gcols) * (gw + 8)
                gy = area_top - (j // gcols + 1) * gh - (j // gcols) * 8
                fit(c, im, gx, gy, gw, gh)
                c.setFillColor(INK); c.setFont("Helvetica-Bold", 8)
                c.drawString(gx + 3, gy + gh - 10, f"{j + 1}/{k}")
        if vids:
            c.setFillColor(GREY); c.setFont("Helvetica", 8)
            c.drawString(M, area_bot - 12, "Video: still frame shown. Tap the picture or scan the code to play it.")
        if p["audio"]:
            c.setFillColor(GREY); c.setFont("Helvetica", 8)
            c.drawString(M, area_bot - 12, "Music: cover shown. Tap the picture or scan the code to listen.")
        piece_url = f"{gallery}#{p['n']}"
        c.linkURL(piece_url, (M, area_bot, W - M, area_top), relative=0)
        if not vis:
            c.setFillColor(GREY); c.setFont("Helvetica", 11)
            c.drawCentredString(W / 2, (area_top + area_bot) / 2, "Open the link to see this piece.")
        c.drawImage(qr(piece_url), W - M - 64, M + cap_h - 92, 64, 64)
        c.setFillColor(STAR); c.setFont("Helvetica-Bold", 8)
        c.drawRightString(W - M - 70, M + cap_h - 40, "OPEN / PLAY →")
        c.linkURL(piece_url, (W - M - 64, M + cap_h - 92, W - M, M + cap_h - 28), relative=0)
        c.setFillColor(INK); c.setFont("Helvetica-Bold", 9)
        c.drawString(M, M + cap_h - 30, "SUGGESTED CAPTION")
        wrap(c, s.get("caption") or "—", M, M + cap_h - 46, W - 2 * M - 150, "Helvetica", 10, 13, INK, max_lines=6)
        c.setFillColor(GREY); c.setFont("Helvetica", 8)
        c.drawRightString(W - M, M - 18, f"MAQET showcase · {man['theme']} · #{p['n']}")
        c.showPage()
    c.save()
    (wdir / "numbers.json").write_text(json.dumps({str(p["n"]): p["sub"]["id"] for p in pieces}, indent=1))
    print(out, len(pieces), "pieces")


if __name__ == "__main__":
    main()
