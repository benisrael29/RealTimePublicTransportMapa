import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';

type Sa1Feature = {
  type: 'Feature';
  geometry: unknown;
  properties?: Record<string, unknown>;
};

type Sa1FeatureCollection = {
  type: 'FeatureCollection';
  features: Sa1Feature[];
};

const HOUSING_DATAPACK_URL =
  'https://www.abs.gov.au/census/find-census-data/datapacks/2021-census-datapacks/2021-census-geography-sa1-and-above-for-australia/2021_GCP_SA1_for_AUS_short-header.zip';

const SA1_QUERY_URL = 'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/SA1/MapServer/0/query';

const DEFAULT_SIMPLIFY_OFFSET_DEG = 0.00015;

async function fileExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function downloadToFile(url: string, outPath: string) {
  const resp = await fetch(url, { headers: { accept: '*/*' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const ab = await resp.arrayBuffer();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, Buffer.from(ab));
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function pickColumnIndex(header: string[], predicate: (h: string) => boolean): number {
  const idx = header.findIndex(predicate);
  if (idx >= 0) return idx;
  throw new Error(`Missing required column. Header includes: ${header.slice(0, 20).join(', ')} ...`);
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function loadDwellingsBySa1FromDatapack(zipPath: string): Promise<Map<string, number>> {
  const zip = new (AdmZip as unknown as any)(zipPath);
  const entries = ((zip as any).getEntries?.() ?? []) as any[];
  const csvEntry =
    entries.find((e: any) => /2021_GCP_SA1_for_AUS\.csv$/i.test(String(e.entryName))) ??
    entries.find((e: any) => /GCP.*SA1.*AUS.*\.csv$/i.test(String(e.entryName))) ??
    null;

  if (!csvEntry) {
    const sample = entries
      .slice(0, 25)
      .map((e: any) => String(e.entryName))
      .join('\n');
    throw new Error(`Could not find SA1 GCP CSV in datapack zip. Entries:\n${sample}`);
  }

  const text = (csvEntry as any).getData().toString('utf8');
  const lines = text.split(/\r?\n/).filter((l: string) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('Unexpected CSV content (too few rows)');

  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const sa1Idx = pickColumnIndex(header, (h) => /SA1_CODE/i.test(h));
  const dwIdx = pickColumnIndex(header, (h) => /TOT[_ ]?DWELL/i.test(h));

  const out = new Map<string, number>();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const code = (cols[sa1Idx] ?? '').trim();
    if (!code) continue;
    const dwellingsRaw = cols[dwIdx];
    const dwellings = toNumber(dwellingsRaw);
    if (dwellings === null) continue;
    out.set(code, dwellings);
  }
  return out;
}

async function fetchGeoJsonPage(params: Record<string, string>): Promise<Sa1FeatureCollection> {
  const qs = new URLSearchParams(params);
  const url = `${SA1_QUERY_URL}?${qs.toString()}`;
  const resp = await fetch(url, { headers: { accept: 'application/geo+json,application/json;q=0.9,*/*;q=0.8' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return (await resp.json()) as Sa1FeatureCollection;
}

async function fetchGreaterBrisbaneSa1GeoJson(): Promise<Sa1FeatureCollection> {
  const where = "gccsa_name_2021='Greater Brisbane'";
  const pageSize = 2000;
  const simplifyDeg = (() => {
    const raw = process.env.SA1_SIMPLIFY_OFFSET_DEG;
    if (!raw) return DEFAULT_SIMPLIFY_OFFSET_DEG;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_SIMPLIFY_OFFSET_DEG;
  })();

  const features: Sa1Feature[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchGeoJsonPage({
      f: 'geojson',
      where,
      outFields: 'sa1_code_2021,gccsa_name_2021,area_albers_sqkm',
      returnGeometry: 'true',
      outSR: '4326',
      orderByFields: 'sa1_code_2021',
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      geometryPrecision: '6',
      maxAllowableOffset: String(simplifyDeg),
    });
    const batch = Array.isArray(page.features) ? page.features : [];
    if (batch.length === 0) break;
    features.push(...batch);
    if (batch.length < pageSize) break;
  }
  return { type: 'FeatureCollection', features };
}

async function main() {
  const root = process.cwd();
  const cacheDir = path.join(root, 'data', 'abs_cache');
  const outDir = path.join(root, 'public', 'overlays');
  const datapackZipPath = path.join(cacheDir, '2021_GCP_SA1_for_AUS_short-header.zip');
  const outPath = path.join(outDir, 'abs_2021_sa1_housing_density_greater_brisbane.geojson');

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  if (!(await fileExists(datapackZipPath))) {
    process.stdout.write(`Downloading ABS datapack…\n`);
    await downloadToFile(HOUSING_DATAPACK_URL, datapackZipPath);
  }

  process.stdout.write(`Loading dwellings table…\n`);
  const dwellingsBySa1 = await loadDwellingsBySa1FromDatapack(datapackZipPath);

  process.stdout.write(`Fetching SA1 boundaries (Greater Brisbane)…\n`);
  const sa1 = await fetchGreaterBrisbaneSa1GeoJson();

  const outFeatures: Sa1Feature[] = [];
  let missing = 0;
  for (const f of sa1.features) {
    const p = f.properties ?? {};
    const sa1Code = typeof p.sa1_code_2021 === 'string' ? p.sa1_code_2021 : null;
    const areaSqkm = toNumber(p.area_albers_sqkm) ?? null;
    if (!sa1Code || !areaSqkm || areaSqkm <= 0) continue;

    const dwellings = dwellingsBySa1.get(sa1Code) ?? null;
    if (dwellings === null) missing++;
    const density = dwellings === null ? null : dwellings / areaSqkm;

    outFeatures.push({
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        sa1_code_2021: sa1Code,
        gccsa_name_2021: 'Greater Brisbane',
        area_sqkm: areaSqkm,
        dwellings: dwellings,
        dwellings_per_sqkm: density,
        source: 'abs_census_2021_gcp_sa1 + abs_asgs_2021_sa1',
      },
    });
  }

  const out: Sa1FeatureCollection & {
    meta: { generatedAt: number; featureCount: number; missingDwellingsCount: number; simplifyOffsetDeg: number };
  } = {
    type: 'FeatureCollection',
    features: outFeatures,
    meta: {
      generatedAt: Date.now(),
      featureCount: outFeatures.length,
      missingDwellingsCount: missing,
      simplifyOffsetDeg: (() => {
        const raw = process.env.SA1_SIMPLIFY_OFFSET_DEG;
        const n = raw ? Number(raw) : DEFAULT_SIMPLIFY_OFFSET_DEG;
        return Number.isFinite(n) ? n : DEFAULT_SIMPLIFY_OFFSET_DEG;
      })(),
    },
  };

  await fs.writeFile(outPath, JSON.stringify(out) + '\n', 'utf8');
  process.stdout.write(`Wrote ${outFeatures.length} features to ${path.relative(root, outPath)} (${missing} missing dwellings)\n`);
}

void main();


