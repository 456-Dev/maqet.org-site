// Festival settings, shared by every version of the site. Edit them here once.
window.FESTIVAL = {
  // Paste your Google Form link here once it exists (see README.md).
  // Use the full https://docs.google.com/forms/d/e/.../viewform link so the
  // form can also be embedded on the page. A forms.gle short link works for
  // the buttons only.
  formUrl: "",
  embedForm: true,

  // Version D's on-page RSVP form. Paste the block printed by
  // google-form/create-rsvp-form.gs. Until then, the form runs in preview
  // mode and tells people nothing was sent.
  rsvp: {
    action: "",   // https://docs.google.com/forms/d/e/.../formResponse
    fields: {},   // { name: "entry.123", email: "entry.456", ... }
  },

  contactEmail: "",   // e.g. "hello@maqet.com"
  instagramUrl: "",   // e.g. "https://instagram.com/maqet"

  // Where the prompt is revealed on Saturday. Blank shows "Location to be announced."
  promptLocation: "",

  // US Eastern time. Daylight saving ends Nov 1, so the offset is -05:00.
  promptReveal:  "2026-11-07T11:00:00-05:00",
  submissionDue: "2026-11-08T11:00:00-05:00",
  screening:     "2026-11-08T19:00:00-05:00",
};
