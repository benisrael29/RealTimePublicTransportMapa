import { NextResponse } from 'next/server';

type GeoJsonGeometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'MultiPoint'; coordinates: [number, number][] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] }
  | { type: 'GeometryCollection'; geometries: GeoJsonGeometry[] };

type GeoJsonFeature = {
  type: 'Feature';
  geometry: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
  id?: string | number;
};

type GeoJsonFeatureCollection = {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
};

const FEEDS = {
  unplanned: 'https://www.energex.com.au/static/Energex/energex_po_current_unplanned.geojson',
  planned_current: 'https://www.energex.com.au/static/Energex/energex_po_current_planned.geojson',
  planned_future: 'https://www.energex.com.au/static/Energex/energex_po_future_planned.geojson',
} as const;

type OutageType = keyof typeof FEEDS;

async function fetchJsonWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/geo+json,application/json;q=0.9,*/*;q=0.8' },
      cache: 'no-store',
    });
    if (!resp.ok) {
      throw new Error(`Fetch failed (${resp.status})`);
    }
    return (await resp.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function isFeatureCollection(x: unknown): x is GeoJsonFeatureCollection {
  if (!x || typeof x !== 'object') return false;
  const obj = x as Record<string, unknown>;
  return obj.type === 'FeatureCollection' && Array.isArray(obj.features);
}

export async function GET() {
  const startedAt = Date.now();
  const timeoutMs = 12_000;

  const keys = Object.keys(FEEDS) as OutageType[];
  const results = await Promise.all(
    keys.map(async (k) => {
      try {
        const json = await fetchJsonWithTimeout(FEEDS[k], timeoutMs);
        if (!isFeatureCollection(json)) {
          throw new Error('Invalid GeoJSON');
        }
        return { key: k, ok: true as const, data: json };
      } catch (err) {
        return {
          key: k,
          ok: false as const,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    })
  );

  const merged: GeoJsonFeature[] = [];
  const errors: Array<{ feed: OutageType; error: string }> = [];

  for (const r of results) {
    if (!r.ok) {
      errors.push({ feed: r.key, error: r.error });
      continue;
    }
    for (const f of r.data.features ?? []) {
      if (!f || typeof f !== 'object') continue;
      const feat = f as GeoJsonFeature;
      merged.push({
        type: 'Feature',
        id: feat.id,
        geometry: feat.geometry ?? null,
        properties: {
          outageType: r.key,
          source: 'energex',
          energex: (feat.properties ?? null) as Record<string, unknown> | null,
        },
      });
    }
  }

  if (merged.length === 0) {
    return NextResponse.json(
      {
        error: 'Failed to fetch outage feeds',
        source: 'energex',
        errors,
      },
      { status: 502 }
    );
  }

  const body: GeoJsonFeatureCollection & {
    meta: { fetchedAt: number; durationMs: number; feeds: typeof FEEDS; errors: typeof errors };
  } = {
    type: 'FeatureCollection',
    features: merged,
    meta: {
      fetchedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      feeds: FEEDS,
      errors,
    },
  };

  const res = NextResponse.json(body);
  res.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  return res;
}


