// Run once: bun auth.js
// Opens browser for Google OAuth, saves token.json
import { google } from 'googleapis';
import fs from 'fs';
import http from 'http';
import { exec } from 'child_process';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = './token.json';
const CREDS_PATH = './credentials.json';
const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

if (!fs.existsSync(CREDS_PATH)) {
  console.error('❌ credentials.json not found.');
  process.exit(1);
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));

// Support both "installed" (Desktop app) and "web" credential types
const keys = creds.installed || creds.web;
if (!keys) {
  console.error('❌ Unrecognized credentials format.');
  process.exit(1);
}

const { client_secret, client_id } = keys;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n🚀 Starting local auth server on port 3000...');
console.log('📋 Opening browser for Google login...\n');

// Start local server to capture the redirect
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font-family:monospace;padding:40px"><h2>❌ Auth failed: ${error}</h2></body></html>`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font-family:monospace;padding:40px;background:#f9f8f5">
      <h2>✅ Authorized!</h2>
      <p>token.json saved. You can close this tab and go back to the terminal.</p>
      <p>Now run: <code>bun gmail_fetcher.js</code></p>
    </body></html>`);

    console.log('\n✅ token.json saved!');
    console.log('Now run: bun gmail_fetcher.js\n');
    server.close();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font-family:monospace;padding:40px"><h2>❌ Error: ${err.message}</h2></body></html>`);
    server.close();
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, () => {
  // Open browser
  exec(`open "${authUrl}"`);
  console.log('If the browser did not open, paste this URL manually:\n');
  console.log(authUrl);
  console.log('\nWaiting for Google to redirect back...');
});
