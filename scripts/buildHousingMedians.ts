import fs from 'node:fs/promises';
import path from 'node:path';

type BccGeoJson = {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: string; coordinates: unknown } | null;
    properties?: { suburb_name?: string } & Record<string, unknown>;
  }>;
};

type HousingRow = {
  suburb_name: string;
  median_weekly_rent: number | null;
  median_monthly_mortgage: number | null;
};

const SUBURB_BOUNDARIES_URL =
  'https://data.brisbane.qld.gov.au/api/explore/v2.1/catalog/datasets/suburb-boundaries/exports/geojson?limit=-1';

const ABS_SAL_POINT_QUERY_URL =
  'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SEARCH/MapServer/16/query';

const normalizeSuburb = (s: string) =>
  s
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[’'`]/g, '')
    .replace(/[^A-Z0-9 ]+/g, '');

const parseCurrency = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const raw = s.replace(/\$/g, '').replace(/,/g, '').trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const polygonSignedArea = (ring: Array<[number, number]>) => {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
};

const polygonCentroid = (ring: Array<[number, number]>) => {
  const a = polygonSignedArea(ring);
  if (!a) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    const d = ring.length || 1;
    return { x: sx / d, y: sy / d, areaAbs: 0 };
  }

  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  cx /= 6 * a;
  cy /= 6 * a;
  return { x: cx, y: cy, areaAbs: Math.abs(a) };
};

const pointForGeoJsonGeometry = (geom: { type: string; coordinates: unknown } | null) => {
  if (!geom) return null;
  if (geom.type === 'Polygon') {
    const coords = geom.coordinates as Array<Array<[number, number]>> | undefined;
    const outer = coords?.[0];
    if (!outer || outer.length < 3) return null;
    const { x, y } = polygonCentroid(outer);
    return { lon: x, lat: y };
  }
  if (geom.type === 'MultiPolygon') {
    const coords = geom.coordinates as Array<Array<Array<[number, number]>>> | undefined;
    if (!coords) return null;
    let best: { lon: number; lat: number; areaAbs: number } | null = null;
    for (const poly of coords) {
      const outer = poly?.[0];
      if (!outer || outer.length < 3) continue;
      const c = polygonCentroid(outer);
      if (!best || c.areaAbs > best.areaAbs) best = { lon: c.x, lat: c.y, areaAbs: c.areaAbs };
    }
    return best ? { lon: best.lon, lat: best.lat } : null;
  }
  return null;
};

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, {
    headers: { accept: 'application/json,application/geo+json;q=0.9,*/*;q=0.8' },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return (await resp.json()) as T;
}

async function findSalCensusCodeForPoint(lon: number, lat: number): Promise<string | null> {
  const params = new URLSearchParams({
    f: 'json',
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'SAL_CENSUSCODE_2021,SAL_NAME_2021',
    returnGeometry: 'false',
  });
  const url = `${ABS_SAL_POINT_QUERY_URL}?${params.toString()}`;
  const json = (await fetchJson<any>(url)) as { features?: Array<{ attributes?: any }> };
  const code = json?.features?.[0]?.attributes?.SAL_CENSUSCODE_2021;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

async function fetchQuickStatsMedians(censusCode: string): Promise<{
  median_weekly_rent: number | null;
  median_monthly_mortgage: number | null;
}> {
  const url = `https://www.abs.gov.au/census/find-census-data/quickstats/2021/${encodeURIComponent(censusCode)}`;
  const resp = await fetch(url, { headers: { accept: 'text/html' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const html = await resp.text();

  const mortgageMatch = html.match(
    /<th[^>]*scope="row"[^>]*>\s*Median monthly mortgage repayments\s*<\/th>\s*<td[^>]*>\s*([^<]+)\s*<\/td>/i
  );
  const rentMatch = html.match(
    /<th[^>]*scope="row"[^>]*>\s*Median weekly rent(?:\s*\([^)]*\))?\s*<\/th>\s*<td[^>]*>\s*([^<]+)\s*<\/td>/i
  );

  return {
    median_monthly_mortgage: parseCurrency(mortgageMatch?.[1]),
    median_weekly_rent: parseCurrency(rentMatch?.[1]),
  };
}

function toCsv(rows: HousingRow[]) {
  const header = ['suburb_name', 'median_weekly_rent', 'median_monthly_mortgage'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const vals = [
      JSON.stringify(r.suburb_name),
      r.median_weekly_rent === null ? '' : String(r.median_weekly_rent),
      r.median_monthly_mortgage === null ? '' : String(r.median_monthly_mortgage),
    ];
    lines.push(vals.join(','));
  }
  return lines.join('\n') + '\n';
}

function toJsonMap(rows: HousingRow[]) {
  const out: Record<string, { suburb_name: string; median_weekly_rent: number | null; median_monthly_mortgage: number | null }> =
    {};
  for (const r of rows) {
    out[normalizeSuburb(r.suburb_name)] = {
      suburb_name: r.suburb_name,
      median_weekly_rent: r.median_weekly_rent,
      median_monthly_mortgage: r.median_monthly_mortgage,
    };
  }
  return out;
}

async function main() {
  const root = process.cwd();
  const dataDir = path.join(root, 'data');
  const publicDir = path.join(root, 'public', 'data', 'housing');
  const csvPath = path.join(dataDir, 'abs_2021_brisbane_suburb_medians.csv');
  const jsonPath = path.join(publicDir, 'abs_2021_brisbane_suburb_medians.json');

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(publicDir, { recursive: true });

  const bcc = await fetchJson<BccGeoJson>(SUBURB_BOUNDARIES_URL);
  const suburbs = (bcc.features || [])
    .map((f) => ({
      name: (f.properties?.suburb_name ?? '').toString().trim(),
      point: pointForGeoJsonGeometry(f.geometry),
    }))
    .filter((x) => x.name && x.point);

  const rows: HousingRow[] = [];
  const concurrency = 6;
  let idx = 0;

  const worker = async () => {
    for (;;) {
      const i = idx++;
      const item = suburbs[i];
      if (!item) return;
      const { name, point } = item;
      try {
        const code = await findSalCensusCodeForPoint(point!.lon, point!.lat);
        if (!code) {
          rows.push({ suburb_name: name, median_weekly_rent: null, median_monthly_mortgage: null });
          continue;
        }
        const medians = await fetchQuickStatsMedians(code);
        rows.push({ suburb_name: name, ...medians });
      } catch {
        rows.push({ suburb_name: name, median_weekly_rent: null, median_monthly_mortgage: null });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  rows.sort((a, b) => normalizeSuburb(a.suburb_name).localeCompare(normalizeSuburb(b.suburb_name)));

  await fs.writeFile(csvPath, toCsv(rows), 'utf8');
  await fs.writeFile(jsonPath, JSON.stringify(toJsonMap(rows), null, 2) + '\n', 'utf8');

  const okCount = rows.filter((r) => r.median_weekly_rent !== null || r.median_monthly_mortgage !== null).length;
  process.stdout.write(`Wrote ${rows.length} suburbs (${okCount} with values)\\n`);
}

void main();


