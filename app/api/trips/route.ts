import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 86400; // Cache for 24 hours

let routeToShapeCache: Map<string, string> | null = null;
let tripToShapeCache: Map<string, string> | null = null;
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

async function fetchRouteToShapeMapping(): Promise<Map<string, string>> {
  const now = Date.now();
  
  // Return cached data if still valid
  if (routeToShapeCache && (now - cacheTimestamp) < CACHE_DURATION) {
    return routeToShapeCache;
  }

  const routeToShapeMap = new Map<string, string>();
  const tripToShapeMap = new Map<string, string>();

  // Try to fetch trips.txt directly
  const tripsTxtUrls = [
    'https://gtfsrt.api.translink.com.au/GTFS/SEQ/trips.txt',
    'https://transitfeeds.com/p/translink/21/latest/download/trips.txt',
  ];

  for (const url of tripsTxtUrls) {
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'text/csv, text/plain, */*',
        },
        next: { revalidate: 86400 },
      });

      if (response.ok) {
        const text = await response.text();
        const lines = text.split('\n').filter(line => line.trim());
        
        if (lines.length === 0) continue;
        
        const headers = parseCSVLine(lines[0]);
        const routeIdIndex = headers.indexOf('route_id');
        const tripIdIndex = headers.indexOf('trip_id');
        const shapeIdIndex = headers.indexOf('shape_id');

        if (routeIdIndex !== -1 && shapeIdIndex !== -1) {
          let routesWithShapes = 0;
          let routesWithoutShapes = 0;
          let tripsWithShapes = 0;
          
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const values = parseCSVLine(line);
            const maxIndex = Math.max(
              routeIdIndex, 
              shapeIdIndex, 
              tripIdIndex !== -1 ? tripIdIndex : 0
            );
            
            if (values.length > maxIndex) {
              const routeId = values[routeIdIndex].replace(/^"|"$/g, '').trim();
              const tripId = tripIdIndex !== -1 ? values[tripIdIndex].replace(/^"|"$/g, '').trim() : '';
              const shapeId = values[shapeIdIndex].replace(/^"|"$/g, '').trim();
              
              if (!routeId) continue;
              
              if (shapeId) {
                routesWithShapes++;
                
                // Store trip_id -> shape_id mapping if trip_id is available
                if (tripId) {
                  tripsWithShapes++;
                  tripToShapeMap.set(tripId, shapeId);
                }
                
                // Store both original and normalized versions for route_id
                const normalizedRouteId = routeId;
                if (!routeToShapeMap.has(normalizedRouteId)) {
                  routeToShapeMap.set(normalizedRouteId, shapeId);
                }
                
                // Also store base route ID (without suffixes) if different
                const baseRouteId = normalizedRouteId.split(/[-_]/)[0];
                if (baseRouteId !== normalizedRouteId && !routeToShapeMap.has(baseRouteId)) {
                  routeToShapeMap.set(baseRouteId, shapeId);
                }
                
                // Store uppercase version too
                const upperRouteId = normalizedRouteId.toUpperCase();
                if (upperRouteId !== normalizedRouteId && !routeToShapeMap.has(upperRouteId)) {
                  routeToShapeMap.set(upperRouteId, shapeId);
                }
              } else {
                routesWithoutShapes++;
              }
            }
          }
          
          console.log('Trips.txt parsing stats:', {
            routesWithShapes,
            routesWithoutShapes,
            totalRoutesMapped: routeToShapeMap.size,
          });
          
          if (routeToShapeMap.size > 0) {
            console.log('✅ Successfully loaded trips.txt:', {
              totalRoutes: routeToShapeMap.size,
              source: url,
            });
            
            routeToShapeCache = routeToShapeMap;
            cacheTimestamp = now;
            return routeToShapeMap;
          }
        }
      }
    } catch (err) {
      console.error(`Failed to fetch trips.txt from ${url}:`, err);
      continue;
    }
  }

  // Fallback: Return empty map if we can't fetch
  console.warn('⚠️ Could not load trips.txt from any source.');
  routeToShapeCache = routeToShapeMap;
  cacheTimestamp = now;
  return routeToShapeMap;
}

export async function GET() {
  try {
    const routeToShape = await fetchRouteToShapeMapping();
    const routeToShapeObject = Object.fromEntries(routeToShape);
    
    return NextResponse.json({
      routeToShape: routeToShapeObject,
      count: routeToShape.size,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error fetching route to shape mapping:', error);
    return NextResponse.json(
      { error: 'Failed to fetch route to shape mapping', routeToShape: {}, count: 0 },
      { status: 500 }
    );
  }
}

// Export the fetch function for use in other modules
export { fetchRouteToShapeMapping };

