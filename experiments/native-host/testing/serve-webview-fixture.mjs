import http from 'node:http';
import {page} from './webview-documents.mjs';

// Simulator loopback only; no filesystem or arbitrary URL proxying.
const names = new Set(['A', 'B', 'secondary']);
const server = http.createServer((request, response) => {
  const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1);
  if (request.method !== 'GET' || !names.has(name)) {
    response.writeHead(404); response.end('Unknown fixture'); return;
  }
  response.writeHead(200, {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'});
  response.end(page(name).html);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(18789, '127.0.0.1', () => console.log('WebView fixture ready: http://127.0.0.1:18789 (simulator only)'));
const close = () => { server.close(); server.closeAllConnections(); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
