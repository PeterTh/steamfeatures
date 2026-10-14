import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const online = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

export async function createCatalogServer({ port = 0, instrument = false, slowMbps = 10, slowLatencyMs = 150 } = {}) {
  const requests = [], cache = new Map();
  async function asset(variant, name) {
    const key = variant + ':' + name;
    if (cache.has(key)) return cache.get(key);
    let bytes = await readFile(resolve(online, 'dist', name));
    // Compare identical code and records through the supported full-catalogue path.
    if (variant === 'baseline' && name === 'data/manifest.json') {
      const manifest = JSON.parse(bytes); delete manifest.current.progressive;
      bytes = Buffer.from(JSON.stringify(manifest));
    }
    if (instrument && name === 'filter-worker.js') {
      let source = bytes.toString();
      source = source.replace('prepared = prepareCatalog(catalog);', 'const started = performance.now(); prepared = prepareCatalog(catalog); const benchmark = { prepareMs: performance.now() - started };');
      source = source.replace("type: 'ready', gameCount:", "type: 'ready', benchmark, gameCount:");
      bytes = Buffer.from(source);
    }
    const value = { bytes, etag: '"' + createHash('sha256').update(bytes).digest('hex') + '"' };
    cache.set(key, value);
    return value;
  }
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) return response.writeHead(405).end();
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (path === '/') return response.writeHead(302, { Location: '/local/current/' }).end();
      const [profile, variant, ...parts] = path.split('/').filter(Boolean);
      if (!['local', 'slow'].includes(profile) || !['baseline', 'current'].includes(variant)) return response.writeHead(404).end();
      const name = parts.join('/') || 'index.html';
      if (name.includes('..') || name.includes('\\') || name.includes('\0') || parts.some(part => part.startsWith('.'))) return response.writeHead(400).end();
      const { bytes, etag } = await asset(variant, name);
      if (profile === 'slow') await sleep(slowLatencyMs);
      if (request.headers['if-none-match'] === etag) { requests.push({ profile, variant, name, bytes: 0, status: 304 }); return response.writeHead(304, { ETag: etag }).end(); }
      requests.push({ profile, variant, name, bytes: bytes.length, status: 200 });
      response.writeHead(200, { 'Content-Type': mime[extname(name)] || 'application/octet-stream', 'Content-Length': bytes.length,
        'Cache-Control': name.endsWith('.html') || name.endsWith('manifest.json') ? 'no-cache' : 'public, max-age=600', ETag: etag, 'X-Content-Type-Options': 'nosniff' });
      if (request.method === 'HEAD') return response.end();
      if (profile === 'slow' && /\.bin\.(?:gz|br)$/.test(name)) {
        const chunk = 64 * 1024, milliseconds = chunk * 8 / (slowMbps * 1e6) * 1000;
        for (let offset = 0; offset < bytes.length && !response.destroyed; offset += chunk) { response.write(bytes.subarray(offset, offset + chunk)); await sleep(milliseconds); }
        response.end();
      } else response.end(bytes);
    } catch (error) { if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.message); else response.destroy(error); }
  });
  await new Promise(done => server.listen(port, '127.0.0.1', done));
  return { baseURL: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise(done => server.close(done)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const preview = await createCatalogServer({ port: Number(process.env.PORT || 4179) });
  console.log('Built catalogue: ' + preview.baseURL + '/local/current/');
  console.log('Full-load reference: ' + preview.baseURL + '/local/baseline/');
}
