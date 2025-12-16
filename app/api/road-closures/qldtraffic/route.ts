import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type QldTrafficEventFeature = {
  type: 'Feature';
  geometry: {
    type: string;
    coordinates: unknown;
  } | null;
  properties?: Record<string, unknown>;
};

type QldTrafficEventCollection = {
  type: 'FeatureCollection';
  features: QldTrafficEventFeature[];
};

const EVENTS_URL = 'https://data.qldtraffic.qld.gov.au/events_v2.geojson';

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/geo+json,application/json;q=0.9,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0',
      },
      next: { revalidate: 0 },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

const pickImpactType = (p: Record<string, unknown> | undefined) => {
  const impact = p?.impact as Record<string, unknown> | undefined;
  const impactType = typeof impact?.impact_type === 'string' ? impact.impact_type : '';
  const impactSubtype = typeof impact?.impact_subtype === 'string' ? impact.impact_subtype : '';
  return { impactType, impactSubtype };
};

const pickEventType = (p: Record<string, unknown> | undefined) =>
  typeof p?.event_type === 'string' ? p.event_type : '';

const includeFeature = (f: QldTrafficEventFeature) => {
  const p = f.properties ?? {};
  const eventType = pickEventType(p);
  const { impactType } = pickImpactType(p);
  if (eventType === 'Roadworks' || eventType === 'Special events') return true;
  if (impactType === 'Closures') return true;
  return false;
};

export async function GET() {
  try {
    const raw = await fetchJsonWithTimeout<QldTrafficEventCollection>(EVENTS_URL, 12000);
    const features = Array.isArray(raw?.features) ? raw.features : [];

    const filtered = features
      .filter((f) => f && typeof f === 'object')
      .filter((f) => includeFeature(f))
      .map((f) => ({
        ...f,
        properties: {
          ...(f.properties ?? {}),
          source: 'qldtraffic',
        },
      }));

    const out: QldTrafficEventCollection = {
      type: 'FeatureCollection',
      features: filtered,
    };

    return NextResponse.json({ source: 'qldtraffic', geojson: out, timestamp: Date.now() });
  } catch (error) {
    console.error('Error fetching QLDTraffic events:', error);
    return NextResponse.json(
      {
        error: 'Failed to fetch QLDTraffic events',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}


