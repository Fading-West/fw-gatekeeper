export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import convex from '@/lib/convex';
import { api } from '../../../../../convex/_generated/api';

export async function GET() {
  try {
    const summary = await convex.query(api.kiosks.publicHealthSummary, { checkedAtMs: Date.now() });
    return NextResponse.json(summary, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('Public kiosk health error:', error);
    return NextResponse.json(
      { status: 'unavailable', timestamp: new Date().toISOString() },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
