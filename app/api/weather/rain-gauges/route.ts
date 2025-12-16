import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Gauge = {
  sensorId: string;
  name: string;
  lat: number;
  lon: number;
  mm: number | null;
};

function toNumText(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x !== 'string') return null;
  const t = x.trim();
  if (!t || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

async function fetchJson(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Fetch failed (${resp.status})`);
    return (await resp.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const minLat = Number(searchParams.get('minLat'));
    const maxLat = Number(searchParams.get('maxLat'));
    const minLon = Number(searchParams.get('minLon'));
    const maxLon = Number(searchParams.get('maxLon'));
    const max = clamp(Number(searchParams.get('max') ?? 60), 1, 120);

    if (![minLat, maxLat, minLon, maxLon].every((v) => Number.isFinite(v))) {
      return NextResponse.json({ error: 'Missing/invalid bbox params: minLat,maxLat,minLon,maxLon' }, { status: 400 });
    }

    const n = Math.max(minLat, maxLat);
    const s = Math.min(minLat, maxLat);
    const e = Math.max(minLon, maxLon);
    const w = Math.min(minLon, maxLon);

    const where = [
      `sensor_type = "Rainfall"`,
      `latitude >= ${s}`,
      `latitude <= ${n}`,
      `longitude >= ${w}`,
      `longitude <= ${e}`,
    ].join(' and ');

    const metaQs = new URLSearchParams({
      where,
      limit: String(max),
    });

    const metaUrl =
      `https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/telemetry-sensors-rainfall-and-stream-heights-metadata/records?` +
      metaQs.toString();

    const metaJson = (await fetchJson(metaUrl, 12_000)) as any;
    const metaResults: any[] = Array.isArray(metaJson?.results) ? metaJson.results : [];

    const sensors = metaResults
      .map((r) => {
        const sensorId = typeof r?.sensor_id === 'string' ? r.sensor_id.trim() : null;
        const name = typeof r?.location_name === 'string' ? r.location_name.trim() : null;
        const lat = typeof r?.latitude === 'number' ? r.latitude : null;
        const lon = typeof r?.longitude === 'number' ? r.longitude : null;
        if (!sensorId || !name || lat === null || lon === null) return null;
        return { sensorId, name, lat, lon };
      })
      .filter((x): x is { sensorId: string; name: string; lat: number; lon: number } => !!x);

    if (sensors.length === 0) {
      return NextResponse.json({ fetchedAt: Date.now(), measuredAt: null, gauges: [], source: 'bcc' });
    }

    const cols = sensors.map((s) => s.sensorId.toLowerCase());
    const select = ['measured', ...cols].join(',');
    const latestQs = new URLSearchParams({
      select,
      order_by: 'measured desc',
      limit: '1',
    });
    const latestUrl =
      `https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/telemetry-sensors-rainfall-and-stream-heights/records?` +
      latestQs.toString();

    const latestJson = (await fetchJson(latestUrl, 12_000)) as any;
    const latestRow = Array.isArray(latestJson?.results) ? latestJson.results[0] : null;
    const measuredAt = typeof latestRow?.measured === 'string' ? latestRow.measured : null;

    const gauges = sensors.map((s) => {
      const key = s.sensorId.toLowerCase();
      const mm = latestRow ? toNumText(latestRow[key]) : null;
      return {
        sensorId: s.sensorId,
        locationName: s.name,
        lat: s.lat,
        lon: s.lon,
        rainfall: mm ?? 0,
      };
    });

    return NextResponse.json({ fetchedAt: Date.now(), measuredAt, gauges, source: 'bcc' });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch rain gauges' },
      { status: 500 }
    );
  }
}


