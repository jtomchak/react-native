import {enabled, currentPolicy, headers} from '../../../../lib/analytics.mjs';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request) {
  if (!enabled(request)) return Response.json({error: 'Local analytics collector is not configured'}, {status: 503, headers});
  try { return Response.json(await currentPolicy(), {headers}); }
  catch { return Response.json({error: 'Analytics policy is unavailable'}, {status: 503, headers}); }
}
