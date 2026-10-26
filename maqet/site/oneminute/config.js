// Festival settings, shared by every version of the site. Edit them here once.
window.FESTIVAL = {
  // Paste your Google Form link here once it exists (see README.md).
  // Use the full https://docs.google.com/forms/d/e/.../viewform link so the
  // form can also be embedded on the page. A forms.gle short link works for
  // the buttons only.
  formUrl: "https://docs.google.com/forms/d/e/1FAIpQLSdCEW4OdAh7mZwz4xWZQ97NLCtT65v2WufraNq6ow87wP694w/viewform",
  embedForm: true,

  // Version D's on-page RSVP form. Paste the block printed by
  // google-form/create-rsvp-form.gs. Until then, the form runs in preview
  // mode and tells people nothing was sent.
  rsvp: {
    action: "https://docs.google.com/forms/d/e/1FAIpQLSdCEW4OdAh7mZwz4xWZQ97NLCtT65v2WufraNq6ow87wP694w/formResponse",
    fields: {"name":"entry.1666411830","email":"entry.1930397110","phone":"entry.1783030360","workLink":"entry.927707821","roles":"entry.1827480192","experience":"entry.1638446186","groupRegistered":"entry.361540500","gear":"entry.480374014","leastFavorite":"entry.925028679"},
  },

  // Screening RSVPs on Partiful. Paste the event link; the Partiful buttons appear once it's set.
  partifulUrl: "",

  // Live registration count + cast & crew list. Paste the Apps Script web app URL (ends in /exec).
  guestListUrl: "",

  contactEmail: "maqetcollective@gmail.com",   // shown at the bottom: "Any questions? Email ..."
  instagramUrl: "",   // e.g. "https://instagram.com/maqet"

  // Where the prompt is revealed on Saturday. Blank shows "Location to be announced."
  promptLocation: "Tompkins Square Park",

  // US Eastern time. Daylight saving ends Nov 1, so the offset is -05:00.
  promptReveal:  "2026-11-14T11:00:00-05:00",
  submissionDue: "2026-11-15T11:00:00-05:00",
  screening:     "2026-11-15T19:00:00-05:00",
};
