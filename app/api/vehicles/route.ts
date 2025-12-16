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
  
  const response = await fetch(endpoint, {
    headers: {
      'Accept': 'application/x-protobuf, application/protobuf, */*',
      'User-Agent': 'Mozilla/5.0',
    },
    next: { revalidate: 0 },
    signal: controller.signal,
  });
  
  clearTimeout(timeoutId);

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
          console.log(`✅ Successfully fetched ${vehicles.length} vehicles from main endpoint: ${endpoint}`);
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
          console.log(`✅ Found ${vehicles.length} rail vehicles from: ${endpoint}`);
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

    // Analyze the collected vehicles
    if (allVehicles.length > 0) {
      let trainCount = 0;
      let busCount = 0;
      let ferryCount = 0;
      let unknownCount = 0;
      const routeIdSamples = new Set<string>();
      const routeIdToType = new Map<string, number>();
      const routeIdSamplesByType = {
        train: [] as string[],
        bus: [] as string[],
        ferry: [] as string[],
        unknown: [] as string[],
      };
      
      for (const vehicle of allVehicles) {
        const routeId = vehicle.routeId;
        const routeType = vehicle.routeType;
        
        // Collect samples
        if (routeId) {
          routeIdSamples.add(routeId);
          routeIdToType.set(routeId, routeType ?? -1);
          
          // Collect samples by type
          if (routeType === 2 && routeIdSamplesByType.train.length < 10) {
            routeIdSamplesByType.train.push(routeId);
          } else if (routeType === 3 && routeIdSamplesByType.bus.length < 10) {
            routeIdSamplesByType.bus.push(routeId);
          } else if (routeType === 4 && routeIdSamplesByType.ferry.length < 10) {
            routeIdSamplesByType.ferry.push(routeId);
          } else if (routeType === undefined && routeIdSamplesByType.unknown.length < 20) {
            routeIdSamplesByType.unknown.push(routeId);
          }
        }
        
        // Count by route type for debugging
        if (routeType === 2) trainCount++;
        else if (routeType === 3) busCount++;
        else if (routeType === 4) ferryCount++;
        else unknownCount++;
      }
      
      // Detailed debug logging
      console.log('=== Vehicle Feed Analysis ===');
      console.log('Vehicle counts by routeType:', {
        trains: trainCount,
        buses: busCount,
        ferries: ferryCount,
        unknown: unknownCount,
        total: allVehicles.length,
        routeTypesMapSize: routeTypes.size,
      });
      console.log('Unique route IDs found:', routeIdSamples.size);
      console.log('Route ID samples by type:', routeIdSamplesByType);
      console.log('Sample route IDs (first 30):', Array.from(routeIdSamples).slice(0, 30));
      
      // Check if any route IDs look like trains but aren't classified
      const potentialTrainRoutes = Array.from(routeIdSamples).filter(rid => {
        const upper = rid.toUpperCase();
        return (upper.match(/^(FG|BG|CL|IP|RB|SH|EX|GY|DO|CA|NA|RO|SP|VL|BE|KI|SPR|AIR|VLO|NGR|BRI|CAB|CLE|GOL|GYM|IPS|NOR|RED|SHO|SUN|WIL|CR|AR|GC|SC|TS|BN)/) ||
               upper.match(/^[A-Z]{2,3}$/)) && routeIdToType.get(rid) !== 2;
      });
      
      if (potentialTrainRoutes.length > 0) {
        console.log('⚠️ Potential train routes not classified as type 2:', potentialTrainRoutes.slice(0, 20));
      }
      
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

