// Usage: bun gmail_fetcher.js
// Reads Gmail for job application emails (last 7 days), outputs applications.json
import { google } from 'googleapis';
import fs from 'fs';

const TOKEN_PATH = './token.json';
const CREDS_PATH = './credentials.json';
const OUTPUT_PATH = './applications.json';

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

  return { company, role };
}

// Is this subject likely a real job application email?
function isJobEmail(subject, fromEmail) {
  const s = subject.toLowerCase();
  const jobKeywords = [
    'application', 'applying', 'applied', 'interview', 'position', 'role',
    'candidate', 'hiring', 'recruiter', 'opportunity', 'job offer',
    'next steps', 'assessment', 'screening', 'resume', 'cv'
  ];
  return jobKeywords.some(k => s.includes(k));
}

function classifyStatus(messages, myEmail) {
  const allText = messages.map(m => {
    const subject = getHeader(m.payload.headers, 'subject').toLowerCase();
    const body = getBody(m.payload).toLowerCase().slice(0, 5000);
    return subject + ' ' + body;
  }).join(' ');

  if (/offer letter|extend an offer|formal offer|pleased to offer|compensation package/i.test(allText)) return 'offer';
  if (/interview|schedule a call|schedule time|next step|zoom|google meet|availability|phone screen|technical assessment/i.test(allText)) return 'interview';
  if (/unfortunately|not moving forward|not selected|other candidates|decided (not to proceed|to move)|not a fit|position has been filled|not proceed|decided not to|chosen to continue the selection|will not be moving|not be progressing|won't be moving|not shortlisted|regret to inform/i.test(allText)) return 'rejected';
  if (/thank you for apply|received your application|application received|we've received|have received your/i.test(allText)) return 'applied';
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

function formatDate(ms) {
  return new Date(Number(ms)).toISOString().split('T')[0];
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('🔍 Searching Gmail for job applications (last 7 days)...');

const profile = await gmail.users.getProfile({ userId: 'me' });
const myEmail = profile.data.emailAddress;
console.log(`📧 Signed in as: ${myEmail}\n`);

// Last 7 days
const since = new Date();
since.setDate(since.getDate() - 7);
const afterDate = `${since.getFullYear()}/${String(since.getMonth()+1).padStart(2,'0')}/${String(since.getDate()).padStart(2,'0')}`;

// Search both sent (applications you sent) and inbox (replies from companies)
const queries = [
  // Sent applications
  `in:sent after:${afterDate} (application OR "applying for" OR "cover letter" OR "I am applying" OR "senior product designer")`,
  // Company replies / confirmations
  `in:inbox after:${afterDate} (application received OR "thank you for applying" OR "thanks for applying" OR "your application" OR interview OR "next steps" OR "we'd like to" OR "not moving forward" OR "unfortunately")`,
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
  const subject = getHeader(firstMsg.payload.headers, 'subject');
  const from = getHeader(firstMsg.payload.headers, 'from');
  const to = getHeader(firstMsg.payload.headers, 'to');
  const date = formatDate(firstMsg.internalDate);

  // Skip if subject doesn't look like a job email
  if (!isJobEmail(subject, from)) {
    console.log(`  ⏭  Skipping: "${subject.slice(0,60)}"`);
    continue;
  }
  console.log(`  📩 Subject: "${subject}" | From: ${from.slice(0,50)}`);

  // Extract company + role
  const fromEmail = from.match(/<(.+?)>/)?.[1] || from;
  // For ATS emails, try the display name (e.g. "Guardio <no-reply@comeet...>")
  const fromDisplayName = from.match(/^([^<@]+?)\s*</)?.[1]?.trim();
  const isATS = ATS_DOMAINS.some(ats => fromEmail.includes(ats));
  const fromCompany = isATS
    ? (fromDisplayName && !/(greenhouse|lever|ashby|noreply|no.reply|team|hiring|recruit)/i.test(fromDisplayName) ? fromDisplayName : null)
    : extractCompanyFromEmail(fromEmail);
  const parsed = parseSubject(subject);

  let company = fromCompany || parsed.company || 'Unknown';
  let role = parsed.role || 'Senior Product Designer';

  // Clean up role — if it looks like a company name (no design keywords), use as company
  const designKeywords = /designer|design|product|ux|ui|lead|head|creative|visual/i;
  if (!designKeywords.test(role) && role.length < 30 && !company || company === 'Unknown') {
    if (!designKeywords.test(role)) company = role, role = 'Senior Product Designer';
  }

  if (seen.has(threadId)) continue;
  seen.add(threadId);

  const status = classifyStatus(messages, myEmail);

  // Last reply from company (not from me)
  const replies = messages.filter(m => {
    const f = getHeader(m.payload.headers, 'from').toLowerCase();
    return !f.includes(myEmail.split('@')[0].toLowerCase()) && !f.includes('ronkeren');
  });
  // Use the last message in thread overall (company or mine) for body
  const lastMsg = messages[messages.length - 1];
  const lastReplyMsg = replies[replies.length - 1] || lastMsg;
  const lastReplyDate = lastReplyMsg ? formatDate(lastReplyMsg.internalDate) : null;
  const lastReplySubject = lastReplyMsg ? getHeader(lastReplyMsg.payload.headers, 'subject') : null;
  const bodyExcerpt = lastReplyMsg ? extractBodyExcerpt(lastReplyMsg.payload) : null;
  const rejectionReason = status === 'rejected' && bodyExcerpt ? extractRejectionReason(bodyExcerpt) : null;

  const entry = {
    company,
    role,
    dateApplied: date,
    status,
    lastReply: lastReplyDate,
    lastReplySubject,
    bodyExcerpt,
    rejectionReason,
    threadId,
  };

  applications.push(entry);
  console.log(`  ✓ ${company} — "${role}" — ${status} (${date})`);
}

// Deduplicate by company+role — keep the most recent thread per application
// Status priority used as tiebreaker when dates are identical
const STATUS_PRIORITY = { offer: 5, rejected: 4, interview: 3, applied: 2, pending: 1 };
const deduped = new Map();
for (const app of applications) {
  const key = `${app.company.toLowerCase()}||${app.role.toLowerCase()}`;
  const existing = deduped.get(key);
  if (!existing) {
    deduped.set(key, app);
  } else {
    // Prefer the one with the latest lastReply (or dateApplied as fallback)
    const appDate = app.lastReply || app.dateApplied;
    const exDate = existing.lastReply || existing.dateApplied;
    if (appDate > exDate) {
      console.log(`  🔄 Merged duplicate: ${app.company} — keeping ${app.status} (${appDate}) over ${existing.status} (${exDate})`);
      deduped.set(key, app);
    } else if (appDate === exDate && STATUS_PRIORITY[app.status] > STATUS_PRIORITY[existing.status]) {
      console.log(`  🔄 Merged duplicate: ${app.company} — status upgrade ${existing.status} → ${app.status}`);
      deduped.set(key, app);
    } else {
      console.log(`  🔄 Merged duplicate: ${app.company} — keeping ${existing.status} (${exDate}) over ${app.status} (${appDate})`);
    }
  }
}

const merged = Array.from(deduped.values());

// Sort newest first
merged.sort((a, b) => b.dateApplied.localeCompare(a.dateApplied));

const output = { lastFetched: new Date().toISOString(), applications: merged };
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
console.log(`\n✅ Saved ${merged.length} applications (from ${applications.length} threads) to ${OUTPUT_PATH}`);
