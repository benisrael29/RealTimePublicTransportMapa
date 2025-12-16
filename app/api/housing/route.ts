import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

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

type SuburbBoundaryProps = {
  suburb_name?: string;
} & Record<string, unknown>;

type HousingMedian = {
  suburb_name: string;
  median_weekly_rent: number | null;
  median_monthly_mortgage: number | null;
};

const SUBURB_BOUNDARIES_URL =
  'https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/suburb-boundaries/exports/geojson?limit=-1';

const normalizeSuburb = (s: string) =>
  s
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[’'`]/g, '')
    .replace(/[^A-Z0-9 ]+/g, '');

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

async function loadHousingMedians(): Promise<Record<string, HousingMedian>> {
  const filePath = path.join(
    process.cwd(),
    'public',
    'data',
    'housing',
    'abs_2021_brisbane_suburb_medians.json'
  );
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as Record<string, HousingMedian>;
}

export async function GET() {
  const startedAt = Date.now();
  try {
    const [boundaries, medians] = await Promise.all([
      fetchJsonWithTimeout<GeoJsonFeatureCollection<SuburbBoundaryProps>>(SUBURB_BOUNDARIES_URL, 12_000),
      loadHousingMedians(),
    ]);

    const features: Array<GeoJsonFeature<Record<string, unknown>>> = [];
    for (const f of boundaries.features ?? []) {
      const name = (f.properties?.suburb_name ?? '').toString().trim();
      if (!name) continue;
      const key = normalizeSuburb(name);
      const m = medians[key];
      features.push({
        type: 'Feature',
        geometry: f.geometry ?? null,
        properties: {
          source: 'abs_2021',
          suburb: name.toUpperCase(),
          median_weekly_rent: m?.median_weekly_rent ?? null,
          median_monthly_mortgage: m?.median_monthly_mortgage ?? null,
        },
      });
    }

    const out: GeoJsonFeatureCollection<Record<string, unknown>> & {
      meta: { fetchedAt: number; durationMs: number; source: string; missingCount: number };
    } = {
      type: 'FeatureCollection',
      features,
      meta: {
        fetchedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        source: 'abs_2021_quickstats + bcc_suburb_boundaries',
        missingCount: features.reduce(
          (acc, f) =>
            acc +
            ((f.properties?.median_weekly_rent ?? null) === null &&
            (f.properties?.median_monthly_mortgage ?? null) === null
              ? 1
              : 0),
          0
        ),
      },
    };

    const res = NextResponse.json(out);
    res.headers.set('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res;
  } catch (error) {
    return NextResponse.json(
      {
        error: 'Failed to build housing overlay',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}



