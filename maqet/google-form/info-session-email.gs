/**
 * Info-session email to everyone who registered.
 *
 * Add this file to the SAME Apps Script project as create-rsvp-form.gs
 * (it uses RESPONSES_SHEET_ID from there): Editor → + → Script → name it
 * "info-session-email" → paste → Save.
 *
 * 1. Fill in INFO_LOCATION below.
 * 2. Run `testInfoSessionEmail`: sends ONE copy to you only. Check it.
 * 3. Run `sendInfoSessionEmail`: sends to every registered person once
 *    (one email per address). It remembers who already got it, so running it
 *    again later only emails new registrants.
 *
 * Gmail lets a free account send about 100 of these a day.
 */

const INFO_LOCATION = '';  // e.g. 'Nook Brooklyn, 45 Irving Ave, Unit 1' or a Zoom link

const INFO_SUBJECT = 'Free info sessions this week · The 1 Minute Film Festival';

function infoBody_(name) {
  return (
    `Hi ${name},\n\n` +
    'Thanks for registering for The 1 Minute Film Festival! Before the weekend we are hosting 3 free info sessions. Come to whichever one works for you:\n\n' +
    '  · Monday, Nov 9 at 5:00 PM\n' +
    '  · Wednesday, Nov 11 at 8:00 PM\n' +
    '  · Friday, Nov 13 at 6:00 PM\n\n' +
    `Where: ${INFO_LOCATION || 'TBA'}\n\n` +
    'We will go over how the 24 hours work, how teams are made, and the prizes, and answer your questions. It is also a good chance to meet other filmmakers and find a crew.\n\n' +
    'Prizes for the top 3 films:\n' +
    '  1st place: 3 rolls of Kodak Portra 400\n' +
    '  2nd place: 3 rolls of Ilford HP5\n' +
    '  3rd place: 3 rolls of Kodak Gold 200\n\n' +
    'The weekend:\n' +
    '  Sat Nov 14, 11:00 AM: crew call at Tompkins Square Park. Teams are made, the prompt is handed out.\n' +
    '  Sun Nov 15, 11:00 AM: final cut due (60 seconds or less).\n' +
    '  Sun Nov 15, 7:00 PM: screening at Millennium Film Workshop, 167 Wilson Ave, Brooklyn.\n\n' +
    'Details: https://maqet.org/oneminute\n\n' +
    'See you soon!\nMAQET'
  );
}

function registrants_() {
  const sheet = SpreadsheetApp.openById(RESPONSES_SHEET_ID).getSheets().find((sh) =>
    sh.getLastColumn() > 0 &&
    sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].includes('What\'s your name?'));
  if (!sheet) return [];
  const rows = sheet.getDataRange().getDisplayValues();
  const header = rows.shift().map((h) => h.trim());
  const cName = header.indexOf('What\'s your name?');
  const cEmail = header.indexOf('Email');
  const byEmail = new Map();
  rows.forEach((r) => {
    const email = (r[cEmail] || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    const name = (r[cName] || '').trim().split(/\s+/)[0] || 'there';
    byEmail.set(email, name);  // latest registration wins
  });
  return [...byEmail.entries()].map(([email, name]) => ({ email, name }));
}

function testInfoSessionEmail() {
  const me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: me, name: 'The 1 Minute Film Festival', subject: '[TEST] ' + INFO_SUBJECT, body: infoBody_('Michael') });
  Logger.log(`Test sent to ${me}. ${registrants_().length} registered addresses would get the real one.`);
}

function sendInfoSessionEmail() {
  if (!INFO_LOCATION) throw new Error('Fill in INFO_LOCATION at the top first.');
  const props = PropertiesService.getScriptProperties();
  const sent = new Set(JSON.parse(props.getProperty('infoSent') || '[]'));
  const me = Session.getEffectiveUser().getEmail();
  let count = 0;
  for (const { email, name } of registrants_()) {
    if (sent.has(email)) continue;
    if (MailApp.getRemainingDailyQuota() < 1) { Logger.log('Daily Gmail limit reached; run again tomorrow.'); break; }
    MailApp.sendEmail({ to: email, replyTo: me, name: 'The 1 Minute Film Festival', subject: INFO_SUBJECT, body: infoBody_(name) });
    sent.add(email);
    props.setProperty('infoSent', JSON.stringify([...sent]));
    count++;
  }
  Logger.log(`Sent ${count}. ${sent.size} people have the email in total.`);
}
