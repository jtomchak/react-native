import {serverPlugins} from '../../../build/plugins/server.mjs';

export async function handlePlugin(request, id, operation) {
  const plugin = Object.prototype.hasOwnProperty.call(serverPlugins, id) ? serverPlugins[id] : null;
  if (!plugin || typeof plugin.handleRequest !== 'function') {
    return Response.json({error: {code: 'UNSUPPORTED', message: 'Native plug-in is not installed'}}, {status: 404, headers: {'Cache-Control': 'no-store, private'}});
  }
  return plugin.handleRequest(request, operation);
}
