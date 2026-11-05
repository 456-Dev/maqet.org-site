#!/usr/bin/env python3
"""Weekly showcase jobs for the DAILY MAQET SHOWCASE WhatsApp group.

  weekly.py open     Friday 6PM: pull the week (sync.py), clear votes cast before
                     the sheet went out, post a short message + the private voting link.
  weekly.py results  Saturday 12AM: post the top 7 once voting has closed.
  add --dry to print instead of sending.
"""
import argparse, json, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from rollup import sheet_url, ENV  # noqa: E402

GROUP = "120363413350010996@g.us"
API = "https://maqet.org/api/showcase"
STATE = Path.home() / ".openclaw/workspace/projects/maqet-showcase-data/weekly-state.json"


def key():
    return next(l.split("=", 1)[1].strip() for l in ENV.read_text().splitlines() if l.startswith("MAQET_ADMIN_KEY="))


def send(text, dry):
    if dry:
        print("--- would send ---\n" + text)
        return
    r = subprocess.run(["openclaw", "message", "send", "--channel", "whatsapp", "--target", GROUP, "--message", text],
                       capture_output=True, text=True, timeout=120)
    if "Sent" not in (r.stdout + r.stderr):
        raise SystemExit("WhatsApp send failed: " + (r.stdout + r.stderr)[-400:])


def state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(st):
    STATE.write_text(json.dumps(st, indent=1))


def week_now():
    return requests.get(API, timeout=60).json()["week"]


def cmd_open(dry, week_arg=None):
    # The sheet is for the week that just closed at 6PM (now counts toward next Friday), so take the latest week with entries.
    h = {"x-admin-key": key()}
    today = week_arg or datetime.now().astimezone().date().isoformat()
    listing = requests.get(API + "/admin/list", params={"week": today}, headers=h, timeout=60).json()
    week, theme, n = listing["week"], listing.get("theme") or "this week's theme", len(listing["submissions"])
    st = state()
    if st.get(f"open:{week}") and not dry:
        print("already sent for", week); return
    subprocess.run([sys.executable, str(Path(__file__).parent / "sync.py"), "--week", week], check=True)
    if n == 0:
        send(f"No submissions came in for {theme} this week, so there's no vote. New theme coming soon.", dry)
    else:
        if not dry:   # votes cast before the sheet went out (tests) don't count
            requests.post(API + "/admin/clear-votes", json={"week": week}, headers=h, timeout=60).raise_for_status()
        pick = min(7, n)
        send(f"Voting is open for {theme}: {n} pieces.\n"
             f"Tap VOTE on your {pick} favorites, add your name, submit. Closes tonight at midnight.\n"
             f"{sheet_url(week)}\n"
             f"(Private link, please keep it in this group.)", dry)
    if not dry:
        st[f"open:{week}"] = datetime.now(timezone.utc).isoformat(); st["last_week"] = week; save(st)


def cmd_results(dry):
    st = state()
    week = st.get("last_week")
    if not week:
        print("no open week"); return
    if st.get(f"results:{week}") and not dry:
        print("already posted results for", week); return
    t = requests.get(API + "/admin/tally", params={"week": week}, headers={"x-admin-key": key()}, timeout=60).json()
    if datetime.now(timezone.utc) < datetime.fromisoformat(t["closes"].replace("Z", "+00:00")):
        print("voting still open until", t["closes"]); return
    if not t["ranked"]:
        return
    top = t["ranked"][:7]
    lines = [f"{i}. #{r['n']} {r['artist']}" + (f" · {r['title']}" if r.get("title") else "") + f" ({r['points']})" for i, r in enumerate(top, 1)]
    send(f"Voting's closed. {t['voters']} people voted. This week's 7:\n" + "\n".join(lines) +
         "\nThey post to @_maqet_ one a day starting today.", dry)
    if not dry:
        st[f"results:{week}"] = datetime.now(timezone.utc).isoformat(); save(st)
        (STATE.parent / week / "winners.json").write_text(json.dumps(top, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("job", choices=["open", "results"])
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--week")
    a = ap.parse_args()
    cmd_open(a.dry, a.week) if a.job == "open" else cmd_results(a.dry)
