// Run once: bun setup.js
// Configures your name/handle/role and writes config.json
import fs from 'fs';
import readline from 'readline';

const CONFIG_PATH = './config.json';
const EXAMPLE_PATH = './config.example.json';

const defaults = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
const existing = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : {};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question, fallback) => new Promise((resolve) => {
  rl.question(`${question} (${fallback}): `, (answer) => resolve(answer.trim() || fallback));
});

console.log('🚀 Job Tracker setup\n');

const displayName = await ask('Your name', existing.displayName || defaults.displayName);
const handle = await ask('Terminal handle (shown as "handle:~/job-search $")', existing.handle || defaults.handle);
const defaultRole = await ask('Default job role', existing.defaultRole || defaults.defaultRole);

const existingKeywords = (existing.roleKeywords || defaults.roleKeywords || []).join(', ');
console.log('\nRole keywords are used to find your sent application emails in Gmail.');
console.log('Examples: "Product Designer, UX Designer" | "Software Engineer, Frontend Engineer" | "Product Manager, PM"\n');
const roleKeywordsRaw = await ask('Role keywords (comma-separated)', existingKeywords || defaultRole);
const roleKeywords = roleKeywordsRaw.split(',').map(s => s.trim()).filter(Boolean);

rl.close();

const config = { displayName, handle, defaultRole, roleKeywords };
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

console.log('\n✅ Saved config.json\n');
console.log('Next steps:');
console.log('  1. Add credentials.json (see README for Google Cloud setup)');
console.log('  2. Run: bun auth.js');
console.log('  3. Run: bun gmail_fetcher.js');
console.log('  4. Run: bun server.js');
