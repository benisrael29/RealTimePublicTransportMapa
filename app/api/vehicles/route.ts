import { NextResponse } from 'next/server';
import { transit_realtime } from 'gtfs-realtime-bindings';
import { fetchRouteTypes } from '../routes/route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface VehiclePosition {
  id: string;
  latitude: number;
  longitude: number;
  bearing?: number;
  speed?: number;
  tripId?: string;
  routeId?: string;
  routeType?: number;
}

async function fetchVehiclePositionsFromEndpoint(
  endpoint: string,
  routeTypes: Map<string, number>
): Promise<VehiclePosition[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: {
        'Accept': 'application/x-protobuf, application/protobuf, */*',
        'User-Agent': 'Mozilla/5.0',
      },
      next: { revalidate: 0 },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const feed = transit_realtime.FeedMessage.decode(new Uint8Array(arrayBuffer));

  const vehicles: VehiclePosition[] = [];
  
  if (feed.entity) {
    for (const entity of feed.entity) {
      if (entity.vehicle?.position && entity.vehicle.vehicle?.id) {
        const position = entity.vehicle.position;
        const routeId = entity.vehicle.trip?.routeId ?? undefined;
        const routeType = routeId ? routeTypes.get(routeId) : undefined;
        
        vehicles.push({
          id: entity.vehicle.vehicle.id,
          latitude: position.latitude || 0,
          longitude: position.longitude || 0,
          bearing: position.bearing ?? undefined,
          speed: position.speed ?? undefined,
          tripId: entity.vehicle.trip?.tripId ?? undefined,
          routeId: routeId,
          routeType: routeType,
        });
      }
    }
  }
  
  return vehicles;
}

export async function GET() {
  try {
    // Fetch route type mapping
    const routeTypes = await fetchRouteTypes();
    
    // Try main VehiclePositions endpoint
    const mainEndpoints = [
      'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions',
      'https://gtfsrt.api.translink.com.au/Feed/SEQ/VehiclePositions',
      'https://gtfsrt.api.translink.com.au/GTFS/SEQ/VehiclePositions.pb',
    ];
    
    // Also try separate feeds for different vehicle types
    const railEndpoints = [
      'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Rail',
      'https://gtfsrt.api.translink.com.au/Feed/SEQ/VehiclePositions/Rail',
      'https://gtfsrt.api.translink.com.au/GTFS/SEQ/VehiclePositions_Rail.pb',
      'https://gtfsrt.api.translink.com.au/GTFS/SEQ/VehiclePositions_Rail.pb',
    ];
    
    const busEndpoints = [
      'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus',
      'https://gtfsrt.api.translink.com.au/Feed/SEQ/VehiclePositions/Bus',
      'https://gtfsrt.api.translink.com.au/GTFS/SEQ/VehiclePositions_Bus.pb',
    ];
    
    const ferryEndpoints = [
      'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Ferry',
      'https://gtfsrt.api.translink.com.au/Feed/SEQ/VehiclePositions/Ferry',
      'https://gtfsrt.api.translink.com.au/GTFS/SEQ/VehiclePositions_Ferry.pb',
    ];

    let allVehicles: VehiclePosition[] = [];
    let lastError: Error | null = null;
    
    // Try main endpoint first
    for (const endpoint of mainEndpoints) {
      try {
        const vehicles = await fetchVehiclePositionsFromEndpoint(endpoint, routeTypes);
        if (vehicles.length > 0) {
          allVehicles = vehicles;
          break;
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
    }
    
    // If main endpoint worked, try to supplement with separate feeds
    // Try rail endpoint
    for (const endpoint of railEndpoints) {
      try {
        const vehicles = await fetchVehiclePositionsFromEndpoint(endpoint, routeTypes);
        if (vehicles.length > 0) {
          // Merge with existing vehicles (avoid duplicates by ID)
          const existingIds = new Set(allVehicles.map(v => v.id));
          const newVehicles = vehicles.filter(v => !existingIds.has(v.id));
          allVehicles = [...allVehicles, ...newVehicles];
        }
      } catch (err) {
        // Silently fail for separate endpoints - they may not exist
        continue;
      }
    }

    if (allVehicles.length > 0) {
      return NextResponse.json({ vehicles: allVehicles, timestamp: Date.now() });
    }

    throw lastError || new Error('All API endpoints failed');
  } catch (error) {
    console.error('Error fetching vehicle positions:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch vehicle positions', 
        details: error instanceof Error ? error.message : 'Unknown error',
        vehicles: []
      },
      { status: 500 }
    );
  }
}

