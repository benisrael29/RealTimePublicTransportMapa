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

export async function GET() {
  try {
    // Fetch route type mapping
    const routeTypes = await fetchRouteTypes();
    
    const endpoints = [
      'https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions',
      'https://gtfsrt.api.translink.com.au/Feed/SEQ/VehiclePositions',
      'https://gtfsrt.api.translink.com.au/GTFS/SEQ/VehiclePositions.pb',
    ];

    let lastError: Error | null = null;

    for (const endpoint of endpoints) {
      try {
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
          let trainCount = 0;
          let busCount = 0;
          let ferryCount = 0;
          
          for (const entity of feed.entity) {
            if (entity.vehicle?.position && entity.vehicle.vehicle?.id) {
              const position = entity.vehicle.position;
              const routeId = entity.vehicle.trip?.routeId ?? undefined;
              const routeType = routeId ? routeTypes.get(routeId) : undefined;
              
              // Count by route type for debugging
              if (routeType === 2) trainCount++;
              else if (routeType === 3) busCount++;
              else if (routeType === 4) ferryCount++;
              
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
          
          // Debug logging
          console.log('Vehicle counts by routeType:', {
            trains: trainCount,
            buses: busCount,
            ferries: ferryCount,
            total: vehicles.length,
            routeTypesMapSize: routeTypes.size,
          });
        }

        return NextResponse.json({ vehicles, timestamp: Date.now() });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
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

