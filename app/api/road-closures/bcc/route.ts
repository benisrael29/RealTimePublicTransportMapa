import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type BccOccupancyRecord = {
  start_date?: string | null;
  end_date?: string | null;
  road_primary?: string | null;
  '1st_cross_street'?: string | null;
  '2nd_cross_street'?: string | null;
  suburb?: string | null;
  ward?: string | null;
  closure_type?: string | null;
  direction?: string | null;
  job_description?: string | null;
  period?: string | null;
  start_time?: string | null;
  finish_time?: string | null;
  contact?: string | null;
  certificate?: string | null;
};

type BccSuburbFeatureProperties = {
  suburb_name?: string;
} & Record<string, unknown>;

type GeoJsonGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] }
  | { type: string; coordinates: unknown };

type GeoJsonFeature<P = Record<string, unknown>> = {
  type: 'Feature';
  geometry: GeoJsonGeometry | null;
  properties: P;
};

type GeoJsonFeatureCollection<P = Record<string, unknown>> = {
  type: 'FeatureCollection';
  features: Array<GeoJsonFeature<P>>;
};

const OCCUPANCIES_BASE_URL =
  'https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/planned-temporary-road-occupancies/records';
const SUBURB_BOUNDARIES_URL =
  'https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/suburb-boundaries/exports/geojson?limit=-1';

const isFullClosure = (closureType: string | null | undefined) =>
  typeof closureType === 'string' && closureType.toLowerCase().includes('full');

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
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

export async function GET() {
  try {
    const suburbBoundariesPromise = fetchJsonWithTimeout<GeoJsonFeatureCollection<BccSuburbFeatureProperties>>(
      SUBURB_BOUNDARIES_URL,
      10000
    );

    const occupancies: BccOccupancyRecord[] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const url = new URL(OCCUPANCIES_BASE_URL);
      url.searchParams.set('limit', '100');
      url.searchParams.set('offset', String(offset));
      const page = await fetchJsonWithTimeout<{ results: BccOccupancyRecord[] }>(url.toString(), 10000);
      const pageResults = Array.isArray(page?.results) ? page.results : [];
      if (pageResults.length === 0) break;
      occupancies.push(...pageResults);
      if (pageResults.length < 100) break;
    }

    const suburbBoundaries = await suburbBoundariesPromise;

    const bySuburb = new Map<string, BccOccupancyRecord[]>();
    for (const occ of occupancies) {
      const suburb = (occ.suburb ?? '').trim();
      if (!suburb) continue;
      const key = suburb.toUpperCase();
      const existing = bySuburb.get(key);
      if (existing) existing.push(occ);
      else bySuburb.set(key, [occ]);
    }

    const features: GeoJsonFeature<Record<string, unknown>>[] = [];
    for (const feature of suburbBoundaries.features ?? []) {
      const suburbName = (feature.properties?.suburb_name ?? '').toString().trim().toUpperCase();
      if (!suburbName) continue;
      const items = bySuburb.get(suburbName);
      if (!items || items.length === 0) continue;

      const fullCount = items.reduce((acc, it) => acc + (isFullClosure(it.closure_type) ? 1 : 0), 0);

      features.push({
        type: 'Feature',
        geometry: feature.geometry,
        properties: {
          source: 'bcc',
          suburb: suburbName,
          total: items.length,
          full_closure_count: fullCount,
          partial_closure_count: items.length - fullCount,
          items: items.map((it) => ({
            start_date: it.start_date ?? null,
            end_date: it.end_date ?? null,
            road_primary: it.road_primary ?? null,
            first_cross_street: it['1st_cross_street'] ?? null,
            second_cross_street: it['2nd_cross_street'] ?? null,
            ward: it.ward ?? null,
            closure_type: it.closure_type ?? null,
            direction: it.direction ?? null,
            job_description: it.job_description ?? null,
            period: it.period ?? null,
            start_time: it.start_time ?? null,
            finish_time: it.finish_time ?? null,
            certificate: it.certificate ?? null,
          })),
        },
      });
    }

    const out: GeoJsonFeatureCollection<Record<string, unknown>> = {
      type: 'FeatureCollection',
      features,
    };

    return NextResponse.json({ source: 'bcc', geojson: out, timestamp: Date.now() });
  } catch (error) {
    console.error('Error fetching BCC road occupancies:', error);
    return NextResponse.json(
      {
        error: 'Failed to fetch BCC road occupancies',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}


