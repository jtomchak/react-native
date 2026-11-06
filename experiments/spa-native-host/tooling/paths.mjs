import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const webRoot = path.join(root, 'apps/web');
export const serverRoot = path.join(root, 'apps/server');
export const bundleRoot = path.join(root, 'build/web');

export function assetPath(base, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (!decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return null;
  if (decoded.split('/').some(part => part === '.' || part === '..')) return null;
  const relative = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const candidate = path.resolve(base, `.${relative}`);
  return candidate.startsWith(`${path.resolve(base)}${path.sep}`) ? candidate : null;
}

export const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.rsc': 'text/x-component',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};
