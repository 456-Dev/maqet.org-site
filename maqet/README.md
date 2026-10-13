# maqet.org

The MAQET Collective site and The 1 Minute Film Festival (Nov 14–15). Plain HTML, no build step, hosted on Cloudflare Pages.

```
site/                                   ← the folder you upload to Cloudflare (this is maqet.org)
  index.html                            maqet.org: landing page, modelled on the Cargo site for now
  favicon.svg, favicon.ico,             the pink M☆QET star, used as the browser-tab icon on every page
  apple-touch-icon.png                  (the PNG is the icon for iPhone home screens)
  oneminute/
    index.html                          maqet.org/oneminute: the festival (call-sheet design + on-page RSVP)
    config.js                           festival settings: RSVP form link, times, contact
google-form/create-rsvp-form.gs         builds the 5-question RSVP Google Form + sheet
drafts/                                 earlier festival designs (A–C), not uploaded
```

To preview locally, run `python3 -m http.server 8124 --directory site` in this folder and open http://localhost:8124.

## Landing page notes

The landing page copies the layout and text of maqetcollective.cargo.site. Until the full migration:

- Its images load from Cargo's servers, and **About Us** and **Artists Talking Together** link to the Cargo pages. Keep the Cargo site up until those are moved over.
- Cargo's font (Diatype) is a paid font, so the copy uses Hanken Grotesk, a free lookalike.

## 1. Create the RSVP form

1. Sign in to the Google account that should own the form (the festival email).
2. Go to [script.google.com](https://script.google.com) and click **New project**.
3. Delete the starter code, paste in all of `google-form/create-rsvp-form.gs`, and click **Save**.
4. Optional: set `NOTIFY_EMAIL` at the top to the address that should get new-RSVP alerts. Blank means the account running the script.
5. Pick `createRsvpForm` in the toolbar dropdown and click **Run**. Approve the permissions prompt.
6. Open **Execution log**. It prints a block of settings for `config.js`, plus the edit link and the RSVP sheet.

The form asks the same 5 questions as the site: name, how to reach you (email + optional phone), what you do, who's on your team (solo / 2 / 3+, plus an optional team name) and what gear you can bring. Every RSVP lands in the sheet, emails you an alert, and emails the person a confirmation.

The festival page's RSVP is styled like the rest of the site and sends answers into the Google Form in the background. The answer choices in `site/oneminute/index.html` and the script must match exactly; if you change one, change the other.

In the form's settings, keep **Collect email addresses** off and leave **Limit to 1 response** unchecked. Both make people sign in to Google, which blocks the site from sending answers.

To move the form to another account later, open it and use **⋮ → Add collaborators**, or change `NOTIFY_EMAIL` in the script. Alerts pick up the new address on the next RSVP.

## 2. Connect the form to the site

Open `site/oneminute/config.js` and replace the `formUrl` and `rsvp` lines with the block from the Execution log. Then fill in the rest:

| Setting          | What to put                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `formUrl`        | From the log                                                                             |
| `rsvp`           | From the log. Lets the on-page RSVP send answers into the form                           |
| `contactEmail`   | Shows in the festival footer                                                             |
| `instagramUrl`   | Shows in the festival footer                                                             |
| `promptLocation` | Where the prompt is revealed Saturday. Blank shows "TBA"                                 |
| Times            | Set to US Eastern (`-05:00`). Change the offset if the festival is in another time zone. |

Until `rsvp` is filled in, the RSVP runs in preview mode: it shows "Preview · not connected" and tells people nothing was sent.

**Test it once** after connecting: RSVP on the live site, then check that the row shows up in the RSVP sheet.

## 3. Put it online with Cloudflare Pages (free)

**First upload**

1. Sign in (or sign up free) at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Go to **Workers & Pages → Create → Pages**, and choose the option to **upload assets** (direct upload).
3. Name the project `maqet`, drag in the **`site`** folder, and deploy.
4. It's live at a `*.pages.dev` address (for example `maqet.pages.dev`), with the festival at `/oneminute/`.

**Point maqet.org at it**

1. In the project, open **Custom domains → Set up a custom domain** and enter `maqet.org`. Add `www.maqet.org` too.
2. For the bare `maqet.org`, Cloudflare has to run the domain's DNS. If it doesn't yet, Cloudflare will walk you through adding the domain (free plan) and give you two nameservers to set at your domain registrar. Switching nameservers moves maqet.org over; the Cargo site stays reachable at maqetcollective.cargo.site.

**Updating later**

Edit the files, then in the project go to **Deployments → Create deployment** and upload the `site` folder again.

Once it's live, point the QR code on the flyer at **maqet.org/oneminute**.
