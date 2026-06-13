// Usage: bun server.js
// Serves the dashboard + applications.json, and exposes POST /api/sync
// which runs gmail_fetcher.js on demand and streams the result back.
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const PORT = 4343;
const ROOT = import.meta.dir;
const APPLICATIONS_PATH = path.join(ROOT, 'applications.json');
const VALID_STATUSES = ['pending', 'interview', 'rejected', 'offer'];

let syncing = false;

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    // ── Sync endpoint ────────────────────────────────────────────────────
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      if (syncing) {
        return Response.json({ error: 'Sync already in progress' }, { status: 409 });
      }
      syncing = true;
      const start = Date.now();
      let days;
      try {
        const body = await req.json();
        days = body?.days;
      } catch {}
      try {
        const result = await runFetcher(days);
        const duration = ((Date.now() - start) / 1000).toFixed(1);
        return Response.json({ ok: true, duration, ...result });
      } catch (err) {
        console.error('Sync failed:', err);
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      } finally {
        syncing = false;
      }
    }

    if (url.pathname === '/api/sync/status') {
      return Response.json({ syncing });
    }

    // ── Manual status override ──────────────────────────────────────────
    if (url.pathname === '/api/status' && req.method === 'POST') {
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }

      const { threadId, status } = body;
      if (!threadId || !VALID_STATUSES.includes(status)) {
        return Response.json({ error: 'Invalid threadId or status' }, { status: 400 });
      }

      const data = JSON.parse(fs.readFileSync(APPLICATIONS_PATH, 'utf8'));
      const entry = data.applications.find((a) => a.threadId === threadId);
      if (!entry) {
        return Response.json({ error: 'Application not found' }, { status: 404 });
      }

      entry.status = status;
      entry.statusOverride = true;
      fs.writeFileSync(APPLICATIONS_PATH, JSON.stringify(data, null, 2));

      return Response.json({ ok: true });
    }

    // ── Permanent removal ────────────────────────────────────────────────
    if (url.pathname === '/api/remove' && req.method === 'POST') {
      let body;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }

      const { threadId } = body;
      if (!threadId) {
        return Response.json({ error: 'Invalid threadId' }, { status: 400 });
      }

      const data = JSON.parse(fs.readFileSync(APPLICATIONS_PATH, 'utf8'));
      const idx = data.applications.findIndex((a) => a.threadId === threadId);
      if (idx === -1) {
        return Response.json({ error: 'Application not found' }, { status: 404 });
      }

      const [removed] = data.applications.splice(idx, 1);

      data.removedCompanies = data.removedCompanies || [];
      const key = removed.company.toLowerCase();
      if (!data.removedCompanies.includes(key)) {
        data.removedCompanies.push(key);
      }

      fs.writeFileSync(APPLICATIONS_PATH, JSON.stringify(data, null, 2));

      return Response.json({ ok: true });
    }

    // ── Reset all manual changes ────────────────────────────────────────
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      const data = JSON.parse(fs.readFileSync(APPLICATIONS_PATH, 'utf8'));

      for (const app of data.applications) {
        delete app.statusOverride;
      }
      data.removedCompanies = [];

      fs.writeFileSync(APPLICATIONS_PATH, JSON.stringify(data, null, 2));

      return Response.json({ ok: true });
    }

    if (url.pathname === '/api/config') {
      const configPath = path.join(ROOT, 'config.json');
      const examplePath = path.join(ROOT, 'config.example.json');
      const file = Bun.file(await Bun.file(configPath).exists() ? configPath : examplePath);
      return new Response(file, { headers: { 'Content-Type': 'application/json' } });
    }

    // ── Static files ─────────────────────────────────────────────────────
    let filePath = url.pathname === '/' ? '/website/index.html' : url.pathname;
    const fullPath = path.join(ROOT, filePath);

    // Prevent path traversal outside ROOT
    if (!fullPath.startsWith(ROOT)) {
      return new Response('Forbidden', { status: 403 });
    }

    const file = Bun.file(fullPath);
    if (await file.exists()) {
      return new Response(file);
    }

    return new Response('Not found', { status: 404 });
  },
});

const FETCH_TIMEOUT_MS = 60_000;

function runFetcher(days) {
  return new Promise((resolve, reject) => {
    const env = days ? { ...process.env, LOOKBACK_DAYS: String(days) } : process.env;
    const proc = spawn('bun', ['gmail_fetcher.js'], { cwd: ROOT, env });
    let output = '';
    proc.stdout.on('data', (d) => (output += d.toString()));
    proc.stderr.on('data', (d) => (output += d.toString()));

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`gmail_fetcher.js timed out after ${FETCH_TIMEOUT_MS / 1000}s\n${output}`));
    }, FETCH_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        const match = output.match(/Saved (\d+) applications/);
        resolve({ count: match ? Number(match[1]) : null, log: output });
      } else {
        reject(new Error(`gmail_fetcher.js exited with code ${code}\n${output}`));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

console.log(`🚀 Tracker server running at http://localhost:${PORT}`);
