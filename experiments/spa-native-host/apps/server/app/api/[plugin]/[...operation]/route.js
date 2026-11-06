import {handlePlugin} from '../../../../lib/plugins.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request, context) {
  const {plugin, operation} = await context.params;
  return handlePlugin(request, plugin, operation);
}
export async function POST(request, context) {
  const {plugin, operation} = await context.params;
  return handlePlugin(request, plugin, operation);
}
