/**
 * The 1 Minute Film Festival · RSVP form builder
 *
 * Run this ONCE while signed in to the Google account that should own the
 * form (the festival email). It creates:
 *   1. a registration Google Form (the same questions as the website)
 *   2. a Google Sheet that collects every RSVP
 *   3. an email alert to NOTIFY_EMAIL for each new RSVP
 *      (plus an optional confirmation email to the person who RSVP'd)
 *
 * The Execution log then prints a block to paste into config.js. That block
 * lets the website's own RSVP form (styled like the rest of the site) send
 * answers straight into this Google Form.
 *
 * How to run:
 *   script.google.com → New project → paste this whole file → Save
 *   → choose `createRsvpForm` in the toolbar → Run → approve access.
 *
 * You can change NOTIFY_EMAIL or SEND_CONFIRMATION later without re-running;
 * the email trigger reads them each time someone RSVPs.
 */

const NOTIFY_EMAIL = '';          // where new-RSVP alerts go; blank = the account that ran this script
const SEND_CONFIRMATION = true;   // email each person a "you're on the call sheet" note

// These choices must match site/oneminute/index.html exactly, or the website's
// answers won't land in the form.
const ROLES = ['Director', 'Writer', 'Editor', 'Camera / DOP', 'Sound', 'Actor', 'Producer', 'Never made a film'];
const TEAM = ['Just me. Find me a team.', '2 of us', '3 or more (award eligible)'];
const GEAR = ['Camera', 'Mics / sound gear', 'Lights', 'Laptop with editing software', 'Just my brilliant self'];
const EXPERIENCE = ['Hobby', 'Independent', 'Pro'];
const HEARD = ['Poster', 'Social media', 'A friend', 'Artists Talking Together at Nook'];

function createRsvpForm() {
  const form = FormApp.create('The 1 Minute Film Festival · Registration');
  form
    .setDescription(
      'Free to register, solo or as a group.\n\n' +
      'Sat Nov 14, 11:00 AM: meet at Tompkins Square Park. Teams are made, the prompt is handed out and the clock starts.\n' +
      'Sun Nov 15, 11:00 AM: final cut due. 60 seconds or less.\n' +
      'Sun Nov 15, 7:00 PM (location TBD): all works submitted on time are screened together.\n\n' +
      'Prizes for the top films, picked by our judges (to be revealed soon!). To be prize eligible, a team needs at least 3 crew members ' +
      'and a film that at least loosely follows the prompt. Everything submitted on time is screened.\n\n' +
      'Hosted by MAQET.'
    )
    .setConfirmationMessage('You\'re on the call sheet! See you at Tompkins Square Park, Saturday Nov 14 at 11:00 AM, for the prompt.');

  // ── The questions, in the same order as the website ────────────────────
  const name = form.addTextItem()
    .setTitle('What\'s your name?')
    .setRequired(true);
  const email = form.addTextItem()
    .setTitle('Email')
    .setValidation(FormApp.createTextValidation()
      .requireTextIsEmail()
      .setHelpText('Please enter a valid email address.')
      .build())
    .setRequired(true);
  const phone = form.addTextItem()
    .setTitle('Phone')
    .setHelpText('Optional. For texts during the 24 hours.');
  const workLink = form.addTextItem()
    .setTitle('Link to your work')
    .setHelpText('Optional. YouTube, Vimeo, Instagram, website... so we can promote your work.');
  const roles = form.addCheckboxItem()
    .setTitle('What do you do?')
    .setHelpText('Check everything that applies.')
    .setChoiceValues(ROLES)
    .setRequired(true);
  const experience = form.addMultipleChoiceItem()
    .setTitle('Movie-making experience')
    .setChoiceValues(EXPERIENCE)
    .setRequired(true);
  const team = form.addMultipleChoiceItem()
    .setTitle('Who\'s on your team?')
    .setHelpText('Teams of 3 or more can win prizes. Coming solo? Teams are made at Tompkins Square Park. Every film submitted on time is screened.')
    .setChoiceValues(TEAM)
    .setRequired(true);
  const teamName = form.addTextItem()
    .setTitle('Team name')
    .setHelpText('Optional.');
  const gear = form.addCheckboxItem()
    .setTitle('What can you bring?')
    .setHelpText('Optional. Helps us match crews.')
    .setChoiceValues(GEAR);
  const drives = form.addParagraphTextItem()
    .setTitle('What drives you to make movies?')
    .setRequired(true);
  const heard = form.addMultipleChoiceItem()
    .setTitle('How did you hear about this?')
    .setChoiceValues(HEARD)
    .setRequired(true);
  const eightTen = form.addTextItem()
    .setTitle('Just for fun: a movie you think is an 8/10')
    .setHelpText('Optional.');
  const leastFavorite = form.addTextItem()
    .setTitle('Just for fun: your least favorite movie')
    .setHelpText('Optional.');

  // ── Responses sheet ─────────────────────────────────────────────────────
  const sheet = SpreadsheetApp.create('1 Minute Film Festival · Registrations');
  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());

  // ── Email alerts on every RSVP ──────────────────────────────────────────
  ScriptApp.newTrigger('onRsvp').forForm(form).onFormSubmit().create();

  // Newer Google Forms start unpublished; publish if this API is available.
  if (typeof form.setPublished === 'function') form.setPublished(true);
  form.setAcceptingResponses(true);

  // ── The IDs the website posts answers to ────────────────────────────────
  const fields = entryIds_(form, {
    name: [name, '__name__'],
    email: [email, 'rsvp@example.com'],
    phone: [phone, '__phone__'],
    workLink: [workLink, '__link__'],
    roles: [roles, [ROLES[0]]],
    experience: [experience, EXPERIENCE[0]],
    team: [team, TEAM[0]],
    teamName: [teamName, '__team__'],
    gear: [gear, [GEAR[0]]],
    drives: [drives, '__drives__'],
    heard: [heard, HEARD[0]],
    eightTen: [eightTen, '__eight__'],
    leastFavorite: [leastFavorite, '__least__'],
  });
  const published = form.getPublishedUrl();
  const action = published.replace(/\/viewform.*$/, '/formResponse');

  Logger.log(
    'Paste these lines into config.js, replacing the formUrl and rsvp lines there:\n\n' +
    `  formUrl: "${published}",\n` +
    '  rsvp: {\n' +
    `    action: "${action}",\n` +
    `    fields: ${JSON.stringify(fields)},\n` +
    '  },'
  );
  Logger.log('Edit the form: ' + form.getEditUrl());
  Logger.log('RSVP sheet: ' + sheet.getUrl());
}

/**
 * Finds each question's "entry.123" ID by building a prefilled link with a
 * sample answer per question and reading the IDs back out of it.
 */
function entryIds_(form, samples) {
  let response = form.createResponse();
  Object.keys(samples).forEach((key) => {
    const [item, value] = samples[key];
    response = response.withItemResponse(item.createResponse(value));
  });

  const idByValue = {};
  const query = response.toPrefilledUrl().split('?')[1] || '';
  query.split('&').forEach((pair) => {
    const [param, raw = ''] = pair.split('=');
    if (param.startsWith('entry.')) idByValue[decodeURIComponent(raw.replace(/\+/g, ' '))] = param;
  });

  const fields = {};
  Object.keys(samples).forEach((key) => {
    const value = samples[key][1];
    fields[key] = idByValue[Array.isArray(value) ? value[0] : value] || '';
  });
  return fields;
}

/** Runs on every RSVP (installed by createRsvpForm). */
function onRsvp(e) {
  const answers = {};
  e.response.getItemResponses().forEach((r) => {
    const value = r.getResponse();
    answers[r.getItem().getTitle()] = Array.isArray(value) ? value.join(', ') : value;
  });

  const name = answers['What\'s your name?'] || 'Someone';
  const email = answers['Email'];
  const team = answers['Who\'s on your team?'] || '';
  const teamName = answers['Team name'];
  const owner = NOTIFY_EMAIL || Session.getEffectiveUser().getEmail();

  const summary = Object.keys(answers)
    .map((title) => `${title}:\n  ${answers[title]}`)
    .join('\n\n');

  MailApp.sendEmail({
    to: owner,
    replyTo: email || owner,
    subject: `New registration: ${name}${teamName ? ` (${teamName})` : ''} · ${team}`,
    body: summary,
  });

  if (SEND_CONFIRMATION && email) {
    let teamLine;
    if (team === TEAM[2]) {
      teamLine = 'Your team is prize eligible, as long as your film at least loosely follows the prompt.';
    } else if (team === TEAM[1]) {
      teamLine = 'Find one more teammate and you\'re prize eligible. Either way, every film submitted on time is screened.';
    } else {
      teamLine = 'You registered solo. Teams are made at Tompkins Square Park on Saturday morning.';
    }

    MailApp.sendEmail({
      to: email,
      replyTo: owner,
      name: 'The 1 Minute Film Festival',
      subject: 'You\'re on the call sheet: The 1 Minute Film Festival',
      body:
        `Hi ${name},\n\n` +
        'Thanks for registering for The 1 Minute Film Festival, hosted by MAQET.\n\n' +
        'Sat Nov 14, 11:00 AM: meet at Tompkins Square Park. The prompt is handed out and the 24-hour clock starts.\n' +
        'Sun Nov 15, 11:00 AM: final cut due.\n' +
        'Sun Nov 15, 7:00 PM: all works submitted on time are screened together (location TBD).\n\n' +
        'The rules: all creative activity happens within the 24 hours, submit by 11:00 AM Sunday (60 seconds or less), and come enjoy everyone\'s work at the screening.\n\n' +
        teamLine + '\n\n' +
        'See you there!\nMAQET',
    });
  }
}
