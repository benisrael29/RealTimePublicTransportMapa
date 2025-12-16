import { NextResponse } from 'next/server';
import { getGtfsZip } from '../_gtfsZip';

export const dynamic = 'force-dynamic';
export const revalidate = 86400; // Cache for 24 hours

interface Stop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
}

let stopsCache: Map<string, Stop> | null = null;
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

async function fetchStops(): Promise<Map<string, Stop>> {
  const now = Date.now();
  
  // Return cached data if still valid
  if (stopsCache && (now - cacheTimestamp) < CACHE_DURATION) {
    return stopsCache;
  }

  const stopsMap = new Map<string, Stop>();

  try {
    const zip = await getGtfsZip(86400);
      // Extract stops.txt from the ZIP
      const stopsEntry = zip.getEntry('stops.txt');
      if (stopsEntry) {
        const text = stopsEntry.getData().toString('utf8');
        const lines = text.split('\n').filter(line => line.trim());
        
        if (lines.length > 0) {
          const headers = parseCSVLine(lines[0]);
          const stopIdIndex = headers.indexOf('stop_id');
          const stopNameIndex = headers.indexOf('stop_name');
          const stopLatIndex = headers.indexOf('stop_lat');
          const stopLonIndex = headers.indexOf('stop_lon');

          if (stopIdIndex !== -1 && stopNameIndex !== -1 && stopLatIndex !== -1 && stopLonIndex !== -1) {
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;
              
              const values = parseCSVLine(line);
              if (values.length > Math.max(stopIdIndex, stopNameIndex, stopLatIndex, stopLonIndex)) {
                const stopId = values[stopIdIndex].replace(/^"|"$/g, '');
                const stopName = values[stopNameIndex].replace(/^"|"$/g, '');
                const stopLatStr = values[stopLatIndex].replace(/^"|"$/g, '');
                const stopLonStr = values[stopLonIndex].replace(/^"|"$/g, '');
                
                const stopLat = parseFloat(stopLatStr);
                const stopLon = parseFloat(stopLonStr);
                
                if (stopId && stopName && !isNaN(stopLat) && !isNaN(stopLon)) {
                  stopsMap.set(stopId, {
                    stop_id: stopId,
                    stop_name: stopName,
                    stop_lat: stopLat,
                    stop_lon: stopLon,
                  });
                }
              }
            }
            
            if (stopsMap.size > 0) {
              console.log('Successfully loaded stops.txt:', {
                totalStops: stopsMap.size,
              });
              
              stopsCache = stopsMap;
              cacheTimestamp = now;
              return stopsMap;
            }
          }
        }
      } else {
        console.warn('stops.txt not found in GTFS ZIP file');
      }
  } catch (err) {
    console.error(`Failed to fetch and extract GTFS ZIP:`, err);
  }

  // Fallback: Return empty map if we can't fetch
  console.warn('Could not load stops.txt from any source.');
  stopsCache = stopsMap;
  cacheTimestamp = now;
  return stopsMap;
}

export async function GET() {
  try {
    const stops = await fetchStops();
    const stopsObject = Object.fromEntries(stops);
    
    return NextResponse.json({
      stops: stopsObject,
      count: stops.size,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error fetching stops:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stops', stops: {}, count: 0 },
      { status: 500 }
    );
  }
}

// Export the fetch function for use in other modules
export { fetchStops };


