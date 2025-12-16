import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SamplePoint = {
  lat: number;
  lon: number;
  tempC: number | null;
  windKmh: number | null;
  windDirDeg: number | null;
  precipMm: number | null;
};

function toNum(x: unknown): number | null {
  if (typeof x !== 'number') return null;
  return Number.isFinite(x) ? x : null;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const north = Number(searchParams.get('north'));
    const south = Number(searchParams.get('south'));
    const east = Number(searchParams.get('east'));
    const west = Number(searchParams.get('west'));
    const grid = clamp(Number(searchParams.get('grid') ?? 5), 2, 9);

    if (![north, south, east, west].every((v) => Number.isFinite(v))) {
      return NextResponse.json({ error: 'Missing/invalid bbox params: north,south,east,west' }, { status: 400 });
    }

    const n = Math.max(north, south);
    const s = Math.min(north, south);
    const e = Math.max(east, west);
    const w = Math.min(east, west);

    const lats: number[] = [];
    const lons: number[] = [];
    for (let iy = 0; iy < grid; iy++) {
      const t = grid === 1 ? 0.5 : iy / (grid - 1);
      const lat = s + (n - s) * t;
      for (let ix = 0; ix < grid; ix++) {
        const u = grid === 1 ? 0.5 : ix / (grid - 1);
        const lon = w + (e - w) * u;
        lats.push(lat);
        lons.push(lon);
      }
    }

    const qs = new URLSearchParams({
      latitude: lats.map((x) => x.toFixed(5)).join(','),
      longitude: lons.map((x) => x.toFixed(5)).join(','),
      current: 'temperature_2m,wind_speed_10m,wind_direction_10m,precipitation',
      timezone: 'UTC',
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    let resp: Response;
    try {
      resp = await fetch(`https://api.open-meteo.com/v1/forecast?${qs.toString()}`, {
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      return NextResponse.json({ error: `Upstream fetch failed (${resp.status})` }, { status: 502 });
    }

    const json = (await resp.json()) as unknown;
    const arr = Array.isArray(json) ? json : [json];

    const points: SamplePoint[] = arr
      .map((row) => {
        const obj = row as any;
        const lat = toNum(obj?.latitude);
        const lon = toNum(obj?.longitude);
        const cur = obj?.current ?? null;
        if (lat === null || lon === null || !cur || typeof cur !== 'object') return null;
        return {
          lat,
          lon,
          tempC: toNum(cur.temperature_2m),
          windKmh: toNum(cur.wind_speed_10m),
          windDirDeg: toNum(cur.wind_direction_10m),
          precipMm: toNum(cur.precipitation),
        };
      })
      .filter((p): p is SamplePoint => !!p);

    return NextResponse.json({ fetchedAt: Date.now(), points, source: 'open-meteo' });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to fetch stations' },
      { status: 500 }
    );
  }
}


