import { NextResponse } from 'next/server';
import { fetchStops } from '../stops/route';
import { fetchStopTimes } from '../stop-times/route';
import { fetchServiceToTripsMapping } from '../trips/route';
import { getActiveServiceIdsForDate, getFeedTimeZone, getLocalDateParts } from '../_gtfsCalendar';

export const dynamic = 'force-dynamic';

type StopPoint = { x: number; y: number; id: string; lat: number; lon: number };

const mercatorProjectMeters = (lat: number, lon: number) => {
  const R = 6378137;
  const rad = Math.PI / 180;
  const x = R * lon * rad;
  const clampedLat = Math.max(-85, Math.min(85, lat));
  const y = R * Math.log(Math.tan(Math.PI / 4 + (clampedLat * rad) / 2));
  return { x, y };
};

class StopSpatialIndex {
  private binSizeMeters: number;
  private bins: Map<string, StopPoint[]>;

  constructor(points: StopPoint[], binSizeMeters: number) {
    this.binSizeMeters = binSizeMeters;
    this.bins = new Map();
    for (const p of points) {
      const ix = Math.floor(p.x / this.binSizeMeters);
      const iy = Math.floor(p.y / this.binSizeMeters);
      const key = `${ix},${iy}`;
      const arr = this.bins.get(key);
      if (arr) arr.push(p);
      else this.bins.set(key, [p]);
    }
  }

  withinRadiusMeters(lat: number, lon: number, radiusMeters: number): Array<{ id: string; meters: number }> {
    if (this.bins.size === 0) return [];
    const { x, y } = mercatorProjectMeters(lat, lon);
    const ix0 = Math.floor(x / this.binSizeMeters);
    const iy0 = Math.floor(y / this.binSizeMeters);
    const rBins = Math.max(0, Math.ceil(radiusMeters / this.binSizeMeters));
    const r2 = radiusMeters * radiusMeters;

    const out: Array<{ id: string; meters: number }> = [];
    for (let dx = -rBins; dx <= rBins; dx++) {
      for (let dy = -rBins; dy <= rBins; dy++) {
        const key = `${ix0 + dx},${iy0 + dy}`;
        const bucket = this.bins.get(key);
        if (!bucket) continue;
        for (const pt of bucket) {
          const ddx = pt.x - x;
          const ddy = pt.y - y;
          const sq = ddx * ddx + ddy * ddy;
          if (sq <= r2) out.push({ id: pt.id, meters: Math.sqrt(sq) });
        }
      }
    }
    out.sort((a, b) => a.meters - b.meters);
    return out;
  }
}

let stopIndexCache: { key: string; index: StopSpatialIndex } | null = null;

async function getStopIndex(): Promise<{ index: StopSpatialIndex; count: number }> {
  const stopsMap = await fetchStops();
  const count = stopsMap.size;
  const cacheKey = String(count);
  if (stopIndexCache && stopIndexCache.key === cacheKey) {
    return { index: stopIndexCache.index, count };
  }

  const pts: StopPoint[] = [];
  for (const s of stopsMap.values()) {
    const { x, y } = mercatorProjectMeters(s.stop_lat, s.stop_lon);
    pts.push({ id: s.stop_id, lat: s.stop_lat, lon: s.stop_lon, x, y });
  }

  const index = new StopSpatialIndex(pts, 800);
  stopIndexCache = { key: cacheKey, index };
  return { index, count };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return NextResponse.json({ error: 'lat and lon are required numbers' }, { status: 400 });
    }

    const departMsRaw = url.searchParams.get('departMs');
    const departMs = departMsRaw ? Number(departMsRaw) : Date.now();
    const budgetMinRaw = url.searchParams.get('budgetMin');
    const budgetMin = budgetMinRaw ? Number(budgetMinRaw) : 45;
    const maxWalkMetersRaw = url.searchParams.get('maxWalkMeters');
    const maxWalkMeters = maxWalkMetersRaw ? Number(maxWalkMetersRaw) : 1200;
    const maxTransfersRaw = url.searchParams.get('maxTransfers');
    const maxTransfers = maxTransfersRaw ? Number(maxTransfersRaw) : 2;

    const budgetMinClamped = Math.max(5, Math.min(300, Number.isFinite(budgetMin) ? budgetMin : 45));
    const maxWalkMetersClamped = Math.max(200, Math.min(5000, Number.isFinite(maxWalkMeters) ? maxWalkMeters : 1200));
    const maxTransfersClamped = Math.max(0, Math.min(4, Math.floor(Number.isFinite(maxTransfers) ? maxTransfers : 2)));
    const budgetSec = Math.floor(budgetMinClamped * 60);

    const timeZone = await getFeedTimeZone();
    const local = getLocalDateParts(departMs, timeZone);
    const activeServices = await getActiveServiceIdsForDate(local.dateNumber, local.weekdayKey);
    const departSec = local.secondsSinceMidnight;

    const serviceToTrips = await fetchServiceToTripsMapping();
    const activeTripIds = new Set<string>();
    for (const sid of activeServices.values()) {
      const trips = serviceToTrips.get(sid);
      if (!trips) continue;
      for (const t of trips) activeTripIds.add(t);
    }

    const { index: stopIndex, count: stopCount } = await getStopIndex();
    const nearbyStops = stopIndex.withinRadiusMeters(lat, lon, maxWalkMetersClamped);

    const walkSpeedMps = 1.33;
    const initialArrivals = new Map<string, number>();
    for (const s of nearbyStops) {
      const walkSec = Math.ceil(s.meters / walkSpeedMps);
      const t = departSec + walkSec;
      const cur = initialArrivals.get(s.id);
      if (cur === undefined || t < cur) initialArrivals.set(s.id, t);
    }

    if (initialArrivals.size === 0 || activeTripIds.size === 0) {
      return NextResponse.json({
        stopEtaSecById: {},
        meta: {
          departMs,
          timeZone,
          dateNumber: local.dateNumber,
          weekday: local.weekdayKey,
          departSec,
          budgetMin: budgetMinClamped,
          maxWalkMeters: maxWalkMetersClamped,
          maxTransfers: maxTransfersClamped,
          activeServices: activeServices.size,
          activeTrips: activeTripIds.size,
          stopCount,
          nearbyStops: nearbyStops.length,
        },
      });
    }

    const stopTimesByTrip = await fetchStopTimes();

    let prev = initialArrivals;
    let best = initialArrivals;
    const transferPenaltySec = 120;
    const cutoffSec = departSec + budgetSec;

    for (let round = 0; round <= maxTransfersClamped; round++) {
      const next = new Map(best);
      const penalty = round === 0 ? 0 : transferPenaltySec;
      let improved = 0;

      for (const tripId of activeTripIds.values()) {
        const st = stopTimesByTrip.get(tripId);
        if (!st || st.length < 2) continue;

        const firstDep = st[0].departure_time;
        const lastArr = st[st.length - 1].arrival_time;
        if (lastArr < departSec) continue;
        if (firstDep > cutoffSec) continue;

        let boardIndex = -1;
        for (let i = 0; i < st.length; i++) {
          const a = prev.get(st[i].stop_id);
          if (a === undefined) continue;
          const canBoardAt = a + penalty;
          const dep = st[i].departure_time;
          if (dep > cutoffSec) break;
          if (canBoardAt <= dep) {
            boardIndex = i;
            break;
          }
        }
        if (boardIndex === -1) continue;

        for (let j = boardIndex + 1; j < st.length; j++) {
          const arr = st[j].arrival_time;
          if (arr > cutoffSec) break;
          const stopId = st[j].stop_id;
          const cur = next.get(stopId);
          if (cur === undefined || arr < cur) {
            next.set(stopId, arr);
            improved++;
          }
        }
      }

      if (improved === 0) break;
      best = next;
      prev = next;
    }

    const stopEtaSecById: Record<string, number> = {};
    for (const [stopId, arrSec] of best.entries()) {
      const eta = Math.max(0, Math.round(arrSec - departSec));
      if (eta <= budgetSec) stopEtaSecById[stopId] = eta;
    }

    return NextResponse.json({
      stopEtaSecById,
      meta: {
        departMs,
        timeZone,
        dateNumber: local.dateNumber,
        weekday: local.weekdayKey,
        departSec,
        budgetMin: budgetMinClamped,
        maxWalkMeters: maxWalkMetersClamped,
        maxTransfers: maxTransfersClamped,
        activeServices: activeServices.size,
        activeTrips: activeTripIds.size,
        stopCount,
        nearbyStops: nearbyStops.length,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to compute reachability' },
      { status: 500 }
    );
  }
}



