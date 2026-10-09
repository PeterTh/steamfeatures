import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.gz': 'application/gzip', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8' };
const port = Number(process.env.PORT || 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');

createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400).end('Invalid path'); return; }
    if (pathname.includes('\0') || pathname.includes('\\')) { response.writeHead(400).end('Invalid path'); return; }
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(`${root}${sep}`)) { response.writeHead(403).end('Forbidden'); return; }
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const actual = await realpath(file);
    if (!actual.startsWith(`${await realpath(root)}${sep}`)) { response.writeHead(403).end('Forbidden'); return; }
    const bytes = await readFile(actual);
    response.writeHead(200, { 'Content-Type': mime[extname(actual)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': /catalog\.[a-f0-9]{16}\.json(?:\.gz)?$/.test(actual) ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500).end('File unavailable');
  }
}).listen(port, '127.0.0.1', () => console.log(`Steam Feature Atlas: http://127.0.0.1:${port}/`));
