// Usage: bun server.js
// Serves the dashboard + applications.json, and exposes POST /api/sync
// which runs gmail_fetcher.js on demand and streams the result back.
import { spawn } from 'child_process';
import path from 'path';

const PORT = 4343;
const ROOT = import.meta.dir;

let syncing = false;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // ── Sync endpoint ────────────────────────────────────────────────────
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      if (syncing) {
        return Response.json({ error: 'Sync already in progress' }, { status: 409 });
      }
      syncing = true;
      const start = Date.now();
      try {
        const result = await runFetcher();
        const duration = ((Date.now() - start) / 1000).toFixed(1);
        return Response.json({ ok: true, duration, ...result });
      } catch (err) {
        return Response.json({ ok: false, error: String(err) }, { status: 500 });
      } finally {
        syncing = false;
      }
    }

    if (url.pathname === '/api/sync/status') {
      return Response.json({ syncing });
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

function runFetcher() {
  return new Promise((resolve, reject) => {
    const proc = spawn('bun', ['gmail_fetcher.js'], { cwd: ROOT });
    let output = '';
    proc.stdout.on('data', (d) => (output += d.toString()));
    proc.stderr.on('data', (d) => (output += d.toString()));
    proc.on('close', (code) => {
      if (code === 0) {
        const match = output.match(/Saved (\d+) applications/);
        resolve({ count: match ? Number(match[1]) : null, log: output });
      } else {
        reject(new Error(`gmail_fetcher.js exited with code ${code}\n${output}`));
      }
    });
    proc.on('error', reject);
  });
}

console.log(`🚀 Tracker server running at http://localhost:${PORT}`);
