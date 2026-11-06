import {enabled, currentPolicy, readBatch, collector, headers} from '../../../../lib/analytics.mjs';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request) {
  if (!enabled(request)) return Response.json({error: 'Local analytics collector is not configured'}, {status: 503, headers});
  try {
    const body = await readBatch(request);
    const selection = await currentPolicy();
    return Response.json(await collector().accept(body, selection), {headers});
  } catch { return Response.json({error: 'Batch rejected; retained events may be retried after refresh'}, {status: 409, headers}); }
}
