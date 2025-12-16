import { NextResponse } from 'next/server';
import AdmZip from 'adm-zip';
import { getGtfsZip as getGtfsZipShared } from '../../_gtfsZip';

export const dynamic = 'force-dynamic';
export const revalidate = 86400; // Cache for 24 hours

interface RouteStop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  stop_sequence: number;
}

let routeStopsCache: Map<string, RouteStop[]> | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION = 86400000; // 24 hours in milliseconds

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function normalizeRouteIdVariations(routeId: string): string[] {
  const base = routeId.split(/[-_]/)[0];
  const vars = new Set<string>([
    routeId,
    routeId.toUpperCase(),
    base,
    base.toUpperCase(),
  ]);
  return Array.from(vars);
}

async function getGtfsZipCached(): Promise<AdmZip | null> {
  try {
    return await getGtfsZipShared(86400);
  } catch (err) {
    console.error('Failed to fetch GTFS ZIP:', err);
  }

  return null;
}

function getEntryLines(zip: AdmZip, entryName: string): string[] | null {
  const entry = zip.getEntry(entryName);
  if (!entry) return null;
  const text = entry.getData().toString('utf8');
  const lines = text.split('\n').filter(line => line.trim());
  return lines.length > 0 ? lines : null;
}

function findFirstTripIdForRoute(zip: AdmZip, routeId: string): string | null {
  const lines = getEntryLines(zip, 'trips.txt');
  if (!lines) return null;

  const headers = parseCSVLine(lines[0]);
  const routeIdIndex = headers.indexOf('route_id');
  const tripIdIndex = headers.indexOf('trip_id');
  if (routeIdIndex === -1 || tripIdIndex === -1) return null;

  const routeVars = new Set(normalizeRouteIdVariations(routeId));

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    if (values.length <= Math.max(routeIdIndex, tripIdIndex)) continue;

    const fileRouteId = values[routeIdIndex].replace(/^"|"$/g, '').trim();
    const tripId = values[tripIdIndex].replace(/^"|"$/g, '').trim();

    if (tripId && routeVars.has(fileRouteId)) {
      return tripId;
    }
  }

  return null;
}

function getStopTimesForTrip(zip: AdmZip, tripId: string): Array<{ stop_id: string; stop_sequence: number }> {
  const lines = getEntryLines(zip, 'stop_times.txt');
  if (!lines) return [];

  const headers = parseCSVLine(lines[0]);
  const tripIdIndex = headers.indexOf('trip_id');
  const stopIdIndex = headers.indexOf('stop_id');
  const stopSequenceIndex = headers.indexOf('stop_sequence');
  if (tripIdIndex === -1 || stopIdIndex === -1 || stopSequenceIndex === -1) return [];

  const stopTimes: Array<{ stop_id: string; stop_sequence: number }> = [];
  let collecting = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    if (values.length <= Math.max(tripIdIndex, stopIdIndex, stopSequenceIndex)) continue;

    const fileTripId = values[tripIdIndex].replace(/^"|"$/g, '').trim();
    if (!collecting) {
      if (fileTripId !== tripId) continue;
      collecting = true;
    } else {
      if (fileTripId !== tripId) break;
    }

    const stopId = values[stopIdIndex].replace(/^"|"$/g, '').trim();
    const stopSequenceStr = values[stopSequenceIndex].replace(/^"|"$/g, '').trim();
    const stopSequence = parseInt(stopSequenceStr, 10);

    if (stopId && !Number.isNaN(stopSequence)) {
      stopTimes.push({ stop_id: stopId, stop_sequence: stopSequence });
    }
  }

  stopTimes.sort((a, b) => a.stop_sequence - b.stop_sequence);
  return stopTimes;
}

function getStopsById(
  zip: AdmZip,
  neededStopIds: Set<string>
): Map<string, { stop_name: string; stop_lat: number; stop_lon: number }> {
  const lines = getEntryLines(zip, 'stops.txt');
  if (!lines) return new Map();

  const headers = parseCSVLine(lines[0]);
  const stopIdIndex = headers.indexOf('stop_id');
  const stopNameIndex = headers.indexOf('stop_name');
  const stopLatIndex = headers.indexOf('stop_lat');
  const stopLonIndex = headers.indexOf('stop_lon');
  if (stopIdIndex === -1 || stopNameIndex === -1 || stopLatIndex === -1 || stopLonIndex === -1) return new Map();

  const stops = new Map<string, { stop_name: string; stop_lat: number; stop_lon: number }>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    if (values.length <= Math.max(stopIdIndex, stopNameIndex, stopLatIndex, stopLonIndex)) continue;

    const stopId = values[stopIdIndex].replace(/^"|"$/g, '').trim();
    if (!neededStopIds.has(stopId)) continue;

    const stopName = values[stopNameIndex].replace(/^"|"$/g, '').trim();
    const stopLatStr = values[stopLatIndex].replace(/^"|"$/g, '').trim();
    const stopLonStr = values[stopLonIndex].replace(/^"|"$/g, '').trim();

    const stopLat = parseFloat(stopLatStr);
    const stopLon = parseFloat(stopLonStr);

    if (stopId && stopName && !Number.isNaN(stopLat) && !Number.isNaN(stopLon)) {
      stops.set(stopId, { stop_name: stopName, stop_lat: stopLat, stop_lon: stopLon });
    }

    if (stops.size >= neededStopIds.size) {
      break;
    }
  }

  return stops;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ routeId: string }> | { routeId: string } }
) {
  try {
    const resolvedParams = await Promise.resolve(params);
    const routeId = resolvedParams.routeId;
    
    if (!routeId) {
      return NextResponse.json(
        { error: 'Route ID is required' },
        { status: 400 }
      );
    }

    const now = Date.now();
    if (routeStopsCache && (now - cacheTimestamp) < CACHE_DURATION) {
      const cached = routeStopsCache.get(routeId);
      if (cached) {
        return NextResponse.json({
          routeId,
          stops: cached,
          count: cached.length,
          timestamp: now,
          cached: true,
        });
      }
    }

    const zip = await getGtfsZipCached();
    if (!zip) {
      return NextResponse.json(
        { error: 'Failed to load GTFS data', routeId },
        { status: 502 }
      );
    }

    const tripId = findFirstTripIdForRoute(zip, routeId);
    if (!tripId) {
      return NextResponse.json(
        { error: 'No trips found for this route', routeId },
        { status: 404 }
      );
    }

    const stopTimes = getStopTimesForTrip(zip, tripId);
    if (stopTimes.length === 0) {
      return NextResponse.json(
        { error: 'No stop times found for this route', routeId, tripId },
        { status: 404 }
      );
    }

    const neededStopIds = new Set(stopTimes.map(st => st.stop_id));
    const stopsById = getStopsById(zip, neededStopIds);

    const stops: RouteStop[] = stopTimes
      .map(st => {
        const stop = stopsById.get(st.stop_id);
        if (!stop) return null;
        return {
          stop_id: st.stop_id,
          stop_name: stop.stop_name,
          stop_lat: stop.stop_lat,
          stop_lon: stop.stop_lon,
          stop_sequence: st.stop_sequence,
        };
      })
      .filter((s): s is RouteStop => s !== null);

    if (stops.length === 0) {
      return NextResponse.json(
        { 
          error: 'No stops found for this route',
          routeId,
        },
        { status: 404 }
      );
    }

    if (!routeStopsCache || (now - cacheTimestamp) >= CACHE_DURATION) {
      routeStopsCache = new Map();
      cacheTimestamp = now;
    }
    routeStopsCache.set(routeId, stops);

    return NextResponse.json({
      routeId,
      stops,
      count: stops.length,
      timestamp: now,
    });
  } catch (error) {
    console.error('Error fetching route stops:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch route stops',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}


