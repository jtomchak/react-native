import http from 'node:http';
import path from 'node:path';
import {readFile, lstat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {assetPath, bundleRoot, mimeTypes} from './paths.mjs';

export function createAssetServer(base = bundleRoot) {
  return http.createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      // Resolve raw pathname before URL normalization could hide traversal.
      const pathname = request.url.split('?')[0];
      const file = assetPath(base, pathname);
      if (!file) { response.writeHead(400).end(); return; }
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) { response.writeHead(404).end(); return; }
      const data = await readFile(file);
      response.writeHead(200, {'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch { response.writeHead(404).end(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.SPA_PORT || 18795);
  const server = createAssetServer();
  server.listen(port, '127.0.0.1', () => console.log(`Packaged web assets: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
