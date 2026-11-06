export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json({mode: 'hosted', nativeApiVersion: 2, now: new Date().toISOString()}, {headers: {'Cache-Control': 'no-store'}});
}
