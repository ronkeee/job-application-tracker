// Usage: bun gmail_fetcher.js
// Reads Gmail for job application emails (last 60 days on first sync, then last 7 days), outputs applications.json
import { google } from 'googleapis';
import fs from 'fs';

const TOKEN_PATH = './token.json';
const CREDS_PATH = './credentials.json';
const OUTPUT_PATH = './applications.json';
const CONFIG_PATH = './config.json';
const CONFIG_EXAMPLE_PATH = './config.example.json';

if (!fs.existsSync(CONFIG_PATH)) {
  console.warn('⚠️  config.json not found — using defaults. Run: bun setup.js');
}
const config = JSON.parse(fs.readFileSync(
  fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : CONFIG_EXAMPLE_PATH, 'utf8'
));

// ── Auth ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(CREDS_PATH)) { console.error('❌ credentials.json not found.'); process.exit(1); }
if (!fs.existsSync(TOKEN_PATH)) { console.error('❌ token.json not found. Run: bun auth.js first'); process.exit(1); }

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
const keys = creds.installed || creds.web;
const { client_secret, client_id } = keys;
const auth = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001');
auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
auth.on('tokens', (tokens) => {
  const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...existing, ...tokens }, null, 2));
});

const gmail = google.gmail({ version: 'v1', auth });

// ── Helpers ───────────────────────────────────────────────────────────────────
function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// Known ATS/recruiting platforms — not the actual company name
const ATS_DOMAINS = ['greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'ashbyhq.com',
  'workday.com', 'jobvite.com', 'smartrecruiters.com', 'icims.com', 'taleo.net',
  'bamboohr.com', 'recruitee.com', 'workable.com', 'personio.com', 'hire.com',
  'breezy.hr', 'comeet-notifications.com', 'comeet.co'];

// Senders that match the job-keyword search but are never job applications
// (newsletters, marketing tools, account notices)
const NON_JOB_DOMAINS = ['google.com', 'tldrnewsletter.com', 'amplemarket.com', 'riverside.fm', 'producthunt.com'];

// Some ATS platforms (e.g. Comeet) put the company name directly in the
// sending subdomain — "notifications@guardio.comeet-notifications.com" — so
// the company can be recovered even when the sender display name is just a
// recruiter's personal name
function extractCompanyFromATSSubdomain(emailAddress) {
  const match = emailAddress.match(/@([\w-]+)\.(?:comeet-notifications\.com|comeet\.co)$/i);
  if (!match) return null;
  const name = match[1];
  if (name.length <= 2) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function extractCompanyFromEmail(emailAddress) {
  const match = emailAddress.match(/@([\w.-]+)/);
  if (!match) return null;
  const domain = match[1].toLowerCase();
  // Skip generic email providers
  if (/^(gmail|yahoo|outlook|hotmail|icloud|me|protonmail|googlemail)\./.test(domain)) return null;
  // Skip ATS platforms — subject parsing is more reliable
  if (ATS_DOMAINS.some(ats => domain.includes(ats))) return null;
  const clean = domain.replace(/^(mail|jobs|careers|noreply|no-reply|notifications|info|hello|team|us|eu|hire)\./i, '');
  const name = clean.split('.')[0];
  if (name.length <= 2) return null; // skip "us", "eu" etc
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Strip leading "Re:" / "Fwd:" / "Fw:" prefixes (possibly repeated)
function stripReplyPrefix(subject) {
  let s = subject.trim();
  while (/^(re|fwd?):\s*/i.test(s)) {
    s = s.replace(/^(re|fwd?):\s*/i, '').trim();
  }
  return s;
}

// Parse subject → { company, role }
function parseSubject(subject) {
  let company = null, role = null;

  // "COMPANY - Application Received for the ROLE (location) Role"
  let m = subject.match(/^([A-Za-z][A-Za-z0-9\s&.'-]{1,24}?)\s*[-–]\s*.*?for (?:the\s+)?(.+?)\s*(?:\(.*?\)\s*)?(?:role|position)?\s*$/i);
  if (m) { company = m[1].trim(); role = m[2].replace(/\s*\(.*?\)/g,'').trim(); }

  // "application to COMPANY" (Greenhouse / Lever pattern)
  if (!company) {
    m = subject.match(/application to\s+([A-Za-z][A-Za-z0-9\s&.!'-]{1,30}?)(?:\s*[!.,]|$)/i);
    if (m) company = m[1].replace(/[!]$/,'').trim();
  }

  // "applying to COMPANY"
  if (!company) {
    m = subject.match(/applying to\s+([A-Za-z][A-Za-z0-9\s&.!'-]{1,30}?)(?:\s*[!.,]|$)/i);
    if (m) company = m[1].replace(/[!]$/,'').trim();
  }

  // "application - COMPANY" (e.g. "We've received your application - Nas Company")
  if (!company) {
    m = subject.match(/application\s*[-–]\s*([A-Za-z][A-Za-z0-9\s&.'-]{1,30}?)(?:\s*[!.,]|$)/i);
    if (m) company = m[1].trim();
  }

  // "COMPANY - Application" (company before dash)
  if (!company) {
    m = subject.match(/^([A-Za-z][A-Za-z0-9\s&.'-]{1,24}?)\s*[-–:]\s*(?:application|your application|thanks|thank you)/i);
    if (m) company = m[1].trim();
  }

  // "applying for ROLE at COMPANY"
  if (!company) {
    m = subject.match(/applying (?:for )?(?:the\s+)?(.+?)\s+(?:position|role)\s+at\s+(.+?)(?:\s*[!.,]|$)/i);
    if (m) { role = role || m[1].trim(); company = m[2].trim(); }
  }

  // "for the ROLE Role/Position"
  if (!role) {
    m = subject.match(/for (?:the\s+)?(.+?)\s+(?:role|position)\b/i);
    if (m) role = m[1].replace(/\s*\(.*?\)/g,'').trim();
  }

  // "applying for ROLE" (no position/role keyword after)
  if (!role) {
    m = subject.match(/applying for\s+([A-Za-z].+?)(?:\s+at\s+|\s*[!.,]|$)/i);
    if (m) role = m[1].trim();
  }

  // "at COMPANY" last resort
  if (!company) {
    m = subject.match(/\bat\s+([A-Z][A-Za-z0-9\s&.'-]{1,25}?)(?:\s*[!.,]|$)/);
    if (m) company = m[1].trim();
  }

  // "... with COMPANY" (e.g. "Intro Call with Guardio")
  if (!company) {
    m = subject.match(/\bwith\s+([A-Z][A-Za-z0-9\s&.'-]{1,25}?)(?:\s*[!.,]|$)/);
    if (m) company = m[1].trim();
  }

  return { company, role };
}

// Extract the role title from the email body when the subject doesn't
// mention it (e.g. "Thank you for your interest in Circle and our open
// Lead Product Designer.") — used as a fallback before config.defaultRole
function extractRoleFromBody(bodyText) {
  if (!bodyText) return null;
  const clean = bodyText.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

  const patterns = [
    /received your application for (?:the\s+)?(.+?)\s+(?:position|role)\b/i,
    /received your application for (.+?)(?:,\s*and\b|[.!]|$)/i,
    /application for (?:a |an |the )?(.+?)\s+(?:position|role)\b/i,
    /apply(?:ing)? (?:to|for) (?:our\s+|the\s+)?(.+?)\s+(?:position|role)\b/i,
    /our open (.+?)(?:[.!,]|$)/i,
  ];

  for (const re of patterns) {
    const m = clean.match(re);
    if (m) {
      const role = m[1].trim().replace(/\s*\(.*?\)\s*$/, '').trim();
      if (role.length > 2 && role.length < 60 && !/^(the|a|an)$/i.test(role)) return role;
    }
  }
  return null;
}

// Is this subject (or body) likely a real job application email?
function isJobEmail(subject, bodyText) {
  const s = (subject + ' ' + (bodyText || '').slice(0, 1000)).toLowerCase();
  const jobKeywords = [
    'application', 'applying', 'applied', 'interview', 'position', 'role',
    'candidate', 'hiring', 'recruiter', 'opportunity', 'job offer',
    'next steps', 'assessment', 'screening', 'resume', 'cv',
    'intro call', 'schedule a call', 'schedule time', 'call with'
  ];
  return jobKeywords.some(k => s.includes(k));
}

function classifyStatus(messages, myEmail) {
  const allText = messages.map(m => {
    const subject = getHeader(m.payload.headers, 'subject').toLowerCase();
    const body = getBody(m.payload).toLowerCase().slice(0, 5000);
    return subject + ' ' + body;
  }).join(' ');

  // Many "application received" auto-replies contain boilerplate about what
  // *might* happen later — e.g. "if you are among the qualified candidates,
  // you will receive an email to schedule a first interview" or "if you are
  // not selected, keep an eye on our jobs page". These mention "interview" /
  // "not selected" but describe a hypothetical future, not an actual status
  // change. Strip out "if ..." sentences before keyword-matching so this
  // boilerplate doesn't produce false "interview" or "rejected" results —
  // only concrete, already-happened next steps should flip the status.
  let decisiveText = allText.replace(/[^.!?]*\bif\b[^.!?]*[.!?]/gi, ' ');

  // Some "application received" auto-replies include a candidate-safety /
  // anti-fraud notice that warns recruiting fraud is "unfortunately" common.
  // That sentence (and its surrounding paragraph) trips the bare
  // "unfortunately" rejection keyword below even though it has nothing to do
  // with the actual application status — strip it out first.
  decisiveText = decisiveText.replace(/[^.!?]*\b(?:fraud|impersonat|phishing|scam)\w*[^.!?]*[.!?]/gi, ' ');

  if (/offer letter|extend an offer|formal offer|pleased to offer|compensation package/i.test(decisiveText)) return 'offer';
  // Require a concrete interview/scheduling signal — not just the bare word
  // "interview", which often shows up in unrelated boilerplate (e.g. "we use
  // Metaview to streamline interviews by recording and summarizing")
  if (/schedule(?:d| a| an| your)? (?:interview|call|chat)|interview invit|invite you (?:for|to) (?:an? )?interview|like to interview you|(?:your|an) (?:upcoming|first) interview|intro call|select a time|book a (?:call|time)|choose a time|pick a time|phone screen|technical assessment|next steps? (?:in|with|of) (?:the|your|our) (?:hiring|interview)/i.test(decisiveText)) return 'interview';
  if (/unfortunately|not moving forward|not selected|other candidates|decided (not to proceed|to move)|not a fit|position has been filled|not proceed|decided not to|chosen to continue the selection|will not be moving|not be progressing|won't be moving|not shortlisted|regret to inform/i.test(decisiveText)) return 'rejected';
  // "Applied" is folded into "pending" — both mean "waiting to hear back"
  return 'pending';
}

// Extract a clean plain-text excerpt from the last company email body
function extractBodyExcerpt(payload, maxChars = 600) {
  let raw = getBody(payload);
  // Strip HTML tags
  raw = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  // Collapse whitespace
  raw = raw.replace(/\s+/g, ' ').trim();
  return raw.slice(0, maxChars);
}

// Extract rejection reason — find sentence(s) with rejection keywords
function extractRejectionReason(bodyText) {
  if (!bodyText) return null;
  const sentences = bodyText.split(/(?<=[.!?])\s+/);
  const rejectionPatterns = /not proceed|not moving forward|decided not|chosen to continue|other applicants|not be moving|not shortlisted|not a fit|not selected|regret|unfortunately/i;
  const found = sentences.filter(s => rejectionPatterns.test(s));
  return found.length > 0 ? found.slice(0, 3).join(' ').trim() : null;
}

function getBody(payload) {
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64').toString('utf8');
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = getBody(part);
      if (text) return text;
    }
  }
  return '';
}

// Find the HTML part of a message (links live in <a href> tags, which the
// plain-text part doesn't have)
function getHtmlBody(payload) {
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const html = getHtmlBody(part);
      if (html) return html;
    }
  }
  return '';
}

// Domains/keywords that show up in nearly every marketing email footer and
// aren't useful "reading material" for a job application
const LINK_BLOCKLIST = /unsubscribe|privacy|preferences|view.?(this|in).?browser|terms.?of.?service|opt.?out|facebook\.com|twitter\.com|x\.com|instagram\.com|tiktok\.com|youtube\.com|mailto:|\.gif|\.png|\.jpg|click\.|track|sentry|wix\.com|cdn\./i;

// Extract a small set of meaningful links (job posting, careers page,
// scheduling links, company site, etc.) from a message's HTML body
function extractLinks(payload, maxLinks = 4) {
  const html = getHtmlBody(payload);
  if (!html) return [];

  const links = [];
  const seen = new Set();
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < maxLinks * 3) {
    let url = m[1].trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (LINK_BLOCKLIST.test(url)) continue;

    let text = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (LINK_BLOCKLIST.test(text)) continue;

    // Dedupe by URL (ignoring trailing query/hash noise)
    const key = url.split(/[?#]/)[0];
    if (seen.has(key)) continue;
    seen.add(key);

    // Build a friendly label
    let label = text;
    if (!label || label.length < 2 || label.length > 60) {
      try {
        label = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        label = url.slice(0, 40);
      }
    }

    links.push({ url, label });
  }
  return links.slice(0, maxLinks);
}

function formatDate(ms) {
  return new Date(Number(ms)).toISOString().split('T')[0];
}

// ── Main ──────────────────────────────────────────────────────────────────────
const isFirstSync = !fs.existsSync(OUTPUT_PATH);
const lookbackDays = process.env.LOOKBACK_DAYS ? Number(process.env.LOOKBACK_DAYS) : (isFirstSync ? 30 : 7);
console.log(`🔍 Searching Gmail for job applications (last ${lookbackDays} days${isFirstSync ? ', first sync' : ''})...`);

const profile = await gmail.users.getProfile({ userId: 'me' });
const myEmail = profile.data.emailAddress;
console.log(`📧 Signed in as: ${myEmail}\n`);

const since = new Date();
since.setDate(since.getDate() - lookbackDays);
const afterDate = `${since.getFullYear()}/${String(since.getMonth()+1).padStart(2,'0')}/${String(since.getDate()).padStart(2,'0')}`;

// Search both sent (applications you sent) and inbox (replies from companies).
// Gmail's search API can silently drop matches — especially very recent
// messages — when an OR group has too many clauses, so each query below is
// kept short (2-3 terms) rather than one big OR group.
const queries = [
  // Sent applications
  `in:sent after:${afterDate} (application OR "applying for" OR "cover letter" OR "I am applying" OR "senior product designer")`,
  // Company replies / confirmations
  `in:inbox after:${afterDate} (application received OR "thank you for applying")`,
  `in:inbox after:${afterDate} ("thanks for applying" OR "your application")`,
  `in:inbox after:${afterDate} ("not moving forward" OR "unfortunately")`,
  `in:inbox after:${afterDate} ("next steps")`,
  // Interview / scheduling emails (separate query — Gmail's OR grouping above can miss these)
  `in:inbox after:${afterDate} (interview OR "intro call")`,
  `in:inbox after:${afterDate} ("schedule a call" OR "select a time" OR "phone screen")`,
];

const allThreadIds = new Set();
for (const q of queries) {
  const res = await gmail.users.threads.list({ userId: 'me', q, maxResults: 30 });
  (res.data.threads || []).forEach(t => allThreadIds.add(t.id));
}

console.log(`📨 Found ${allThreadIds.size} candidate threads\n`);

const applications = [];
const seen = new Set();

for (const threadId of allThreadIds) {
  const threadData = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const messages = threadData.data.messages;
  if (!messages?.length) continue;

  // Get the earliest message in thread
  const firstMsg = messages[0];
  const subject = stripReplyPrefix(getHeader(firstMsg.payload.headers, 'subject'));
  const from = getHeader(firstMsg.payload.headers, 'from');
  const to = getHeader(firstMsg.payload.headers, 'to');
  const date = formatDate(firstMsg.internalDate);

  // The first message is usually Ron's own application email (sender:
  // himself), which is useless for company extraction. Use the first reply
  // from the company instead, falling back to the thread's first message.
  const myHandle = config.handle.replace('@', '').toLowerCase();
  const companyMsg = messages.find(m => {
    const f = getHeader(m.payload.headers, 'from').toLowerCase();
    return !f.includes(myEmail.split('@')[0].toLowerCase()) && !f.includes(myHandle);
  }) || firstMsg;
  const companyFrom = getHeader(companyMsg.payload.headers, 'from');

  // Extract company + role
  const fromEmail = companyFrom.match(/<(.+?)>/)?.[1] || companyFrom;

  // Skip senders that are never job applications (newsletters, account notices, etc.)
  if (NON_JOB_DOMAINS.some(d => fromEmail.toLowerCase().includes(d))) {
    console.log(`  ⏭  Skipping (non-job sender domain): "${subject.slice(0,60)}"`);
    continue;
  }

  // Skip if subject/body doesn't look like a job email
  const threadBodyText = messages.map(m => getBody(m.payload)).join(' ').slice(0, 2000);
  if (!isJobEmail(subject, threadBodyText)) {
    console.log(`  ⏭  Skipping: "${subject.slice(0,60)}"`);
    continue;
  }
  console.log(`  📩 Subject: "${subject}" | From: ${companyFrom.slice(0,50)}`);

  // For ATS emails, try the display name (e.g. "Guardio <no-reply@comeet...>")
  const fromDisplayName = companyFrom.match(/^([^<@]+?)\s*</)?.[1]?.trim();
  const isATS = ATS_DOMAINS.some(ats => fromEmail.includes(ats));
  // A sender display name like "Noy Kazaz - Eitan" is a recruiter's personal
  // name, not the company — fall back to parsing the subject in that case
  const looksLikePersonName = fromDisplayName && /^[A-Za-z]+(\s+[A-Za-z]+)*\s*-\s*[A-Za-z]+$/.test(fromDisplayName);
  const fromCompany = isATS
    ? (extractCompanyFromATSSubdomain(fromEmail)
      || (fromDisplayName && !looksLikePersonName && !/(greenhouse|lever|ashby|noreply|no.reply|team|hiring|recruit)/i.test(fromDisplayName) ? fromDisplayName : null))
    : extractCompanyFromEmail(fromEmail);
  const parsed = parseSubject(subject);
  if (parsed.company && /^(re|fwd?)$/i.test(parsed.company)) parsed.company = null;

  // If there's no reply yet (companyMsg is Ron's own sent message), try the
  // recipient address of the application email as a last resort
  const toEmail = to.match(/<(.+?)>/)?.[1] || to;
  const toCompany = companyMsg === firstMsg ? extractCompanyFromEmail(toEmail) : null;

  let company = fromCompany || parsed.company || toCompany || 'Unknown';
  let role = parsed.role || extractRoleFromBody(threadBodyText) || config.defaultRole;

  // Clean up role — if it looks like a company name (no design keywords), use as company
  const designKeywords = /designer|design|product|ux|ui|lead|head|creative|visual/i;
  if (!designKeywords.test(role) && role.length < 30 && !company || company === 'Unknown') {
    if (!designKeywords.test(role)) company = role, role = config.defaultRole;
  }

  if (seen.has(threadId)) continue;
  seen.add(threadId);

  const status = classifyStatus(messages, myEmail);

  // Last reply from company (not from me)
  const replies = messages.filter(m => {
    const f = getHeader(m.payload.headers, 'from').toLowerCase();
    const myHandle = config.handle.replace('@', '').toLowerCase();
    return !f.includes(myEmail.split('@')[0].toLowerCase()) && !f.includes(myHandle);
  });
  // Use the last message in thread overall (company or mine) for body
  const lastMsg = messages[messages.length - 1];
  const lastReplyMsg = replies[replies.length - 1] || lastMsg;
  const lastReplyDate = lastReplyMsg ? formatDate(lastReplyMsg.internalDate) : null;
  const lastReplySubject = lastReplyMsg ? getHeader(lastReplyMsg.payload.headers, 'subject') : null;
  const bodyExcerpt = lastReplyMsg ? extractBodyExcerpt(lastReplyMsg.payload) : null;
  const rejectionReason = status === 'rejected' && bodyExcerpt ? extractRejectionReason(bodyExcerpt) : null;

  // Pull useful links (job posting, scheduling links, careers page, etc.)
  // from the last reply, falling back to the most recent message overall
  const links = lastReplyMsg ? extractLinks(lastReplyMsg.payload) : [];

  const entry = {
    company,
    role,
    dateApplied: date,
    status,
    lastReply: lastReplyDate,
    lastReplySubject,
    bodyExcerpt,
    rejectionReason,
    links,
    threadId,
  };

  applications.push(entry);
  console.log(`  ✓ ${company} — "${role}" — ${status} (${date})`);
}

// Deduplicate by company — keep the most recent thread per application
// (a single application to a company may span multiple threads, e.g. an
// "application received" auto-reply followed by a separate "intro call" invite)
// Status priority used as tiebreaker when dates are identical
const STATUS_PRIORITY = { offer: 5, rejected: 4, interview: 3, applied: 2, pending: 1 };
const DEFAULT_ROLE = config.defaultRole;
const deduped = new Map();
for (const app of applications) {
  const key = app.company.toLowerCase();
  const existing = deduped.get(key);
  if (!existing) {
    deduped.set(key, app);
  } else {
    // Prefer the one with the latest lastReply (or dateApplied as fallback)
    const appDate = app.lastReply || app.dateApplied;
    const exDate = existing.lastReply || existing.dateApplied;
    let winner;
    if (appDate > exDate) {
      console.log(`  🔄 Merged duplicate: ${app.company} — keeping ${app.status} (${appDate}) over ${existing.status} (${exDate})`);
      winner = app;
    } else if (appDate === exDate && STATUS_PRIORITY[app.status] > STATUS_PRIORITY[existing.status]) {
      console.log(`  🔄 Merged duplicate: ${app.company} — status upgrade ${existing.status} → ${app.status}`);
      winner = app;
    } else {
      console.log(`  🔄 Merged duplicate: ${app.company} — keeping ${existing.status} (${exDate}) over ${app.status} (${appDate})`);
      winner = existing;
    }
    // Keep a more specific role if the winner only has the generic default
    const loser = winner === app ? existing : app;
    if (winner.role === DEFAULT_ROLE && loser.role !== DEFAULT_ROLE) {
      winner = { ...winner, role: loser.role };
    }
    deduped.set(key, winner);
  }
}

let merged = Array.from(deduped.values());
let removedCompanies = [];

// Preserve manually-overridden statuses, and carry forward applications that
// weren't found in this scan's lookback window (e.g. older threads), so a
// re-sync never silently drops or overwrites them.
if (fs.existsSync(OUTPUT_PATH)) {
  const previous = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  removedCompanies = previous.removedCompanies || [];
  const removedSet = new Set(removedCompanies);
  const previousByCompany = new Map(
    (previous.applications || []).map((a) => [a.company.toLowerCase(), a])
  );

  // Drop anything matching a permanently-removed company before re-adding it
  merged = merged.filter((app) => {
    if (removedSet.has(app.company.toLowerCase())) {
      console.log(`  🚫 Skipping ${app.company} (permanently removed)`);
      return false;
    }
    return true;
  });

  merged = merged.map((app) => {
    const prev = previousByCompany.get(app.company.toLowerCase());
    let result = app;
    if (prev?.statusOverride) {
      console.log(`  📌 Keeping manual status for ${app.company}: ${prev.status}`);
      result = { ...result, status: prev.status, statusOverride: true };
    }
    if (prev?.notes) {
      result = { ...result, notes: prev.notes };
    }
    return result;
  });

  const seenCompanies = new Set(merged.map((a) => a.company.toLowerCase()));
  const seenThreadIds = new Set(merged.map((a) => a.threadId));
  for (const prev of previousByCompany.values()) {
    // Skip a previous entry if its thread was already (re)classified this run
    // under a different company name — avoids stale duplicates (e.g. an old
    // "Unknown" entry for a thread now correctly identified as "Bettercharge")
    if (!seenCompanies.has(prev.company.toLowerCase()) && !seenThreadIds.has(prev.threadId)) {
      merged.push(prev);
    }
  }
}

// Sort newest first
merged.sort((a, b) => b.dateApplied.localeCompare(a.dateApplied));

const output = { lastFetched: new Date().toISOString(), applications: merged, removedCompanies };
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
console.log(`\n✅ Saved ${merged.length} applications (from ${applications.length} threads) to ${OUTPUT_PATH}`);
