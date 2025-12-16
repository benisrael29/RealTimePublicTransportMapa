import { NextResponse } from 'next/server';
import { getGtfsZip, GTFS_ZIP_URL } from '../_gtfsZip';

export const dynamic = 'force-dynamic';
export const revalidate = 3600; // Cache for 1 hour

let routeTypeCache: Map<string, number> | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION = 3600000; // 1 hour in milliseconds

async function fetchRouteTypes(): Promise<Map<string, number>> {
  const now = Date.now();
  
  // Return cached data if still valid
  if (routeTypeCache && (now - cacheTimestamp) < CACHE_DURATION) {
    return routeTypeCache;
  }

  const routeMap = new Map<string, number>();

  try {
    const zip = await getGtfsZip(3600);
      // Extract routes.txt from the ZIP
      const routesEntry = zip.getEntry('routes.txt');
      if (routesEntry) {
        const text = routesEntry.getData().toString('utf8');
        const lines = text.split('\n').filter(line => line.trim());
        
        if (lines.length > 0) {
        
        // Parse CSV header - handle quoted fields
        const parseCSVLine = (line: string): string[] => {
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
        };
        
        const headers = parseCSVLine(lines[0]);
        const routeIdIndex = headers.indexOf('route_id');
        const routeTypeIndex = headers.indexOf('route_type');

        if (routeIdIndex !== -1 && routeTypeIndex !== -1) {
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const values = parseCSVLine(line);
            if (values.length > Math.max(routeIdIndex, routeTypeIndex)) {
              const routeId = values[routeIdIndex].replace(/^"|"$/g, '');
              const routeTypeStr = values[routeTypeIndex].replace(/^"|"$/g, '');
              const routeType = parseInt(routeTypeStr, 10);
              
              if (routeId && !isNaN(routeType)) {
                routeMap.set(routeId, routeType);
              }
            }
          }
          
          if (routeMap.size > 0) {
            // Log statistics
            const typeCounts = {
              train: 0,
              bus: 0,
              ferry: 0,
              other: 0,
            };
            routeMap.forEach((type) => {
              if (type === 2) typeCounts.train++;
              else if (type === 3) typeCounts.bus++;
              else if (type === 4) typeCounts.ferry++;
              else typeCounts.other++;
            });
            
            console.log('Successfully loaded routes.txt:', {
              totalRoutes: routeMap.size,
              trains: typeCounts.train,
              buses: typeCounts.bus,
              ferries: typeCounts.ferry,
              other: typeCounts.other,
              source: GTFS_ZIP_URL,
            });
            
            routeTypeCache = routeMap;
            cacheTimestamp = now;
            return routeMap;
          }
        }
        }
      } else {
        console.warn('routes.txt not found in GTFS ZIP file');
      }
  } catch (err) {
    console.error(`Failed to fetch and extract GTFS ZIP:`, err);
  }

  // Fallback: Return empty map if we can't fetch
  console.warn('Could not load routes.txt from any source. Route type classification will use fallback patterns.');
  routeTypeCache = routeMap;
  cacheTimestamp = now;
  return routeMap;
}

export async function GET() {
  try {
    const routeTypes = await fetchRouteTypes();
    const routeTypeObject = Object.fromEntries(routeTypes);
    
    return NextResponse.json({
      routes: routeTypeObject,
      count: routeTypes.size,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error fetching route types:', error);
    return NextResponse.json(
      { error: 'Failed to fetch route types', routes: {}, count: 0 },
      { status: 500 }
    );
  }
}

// Export the fetch function for use in other modules
export { fetchRouteTypes };

