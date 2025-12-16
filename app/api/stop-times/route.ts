import { NextResponse } from 'next/server';
import { getGtfsZip } from '../_gtfsZip';

export const dynamic = 'force-dynamic';
export const revalidate = 86400; // Cache for 24 hours

interface StopTime {
  trip_id: string;
  stop_id: string;
  stop_sequence: number;
}

let stopTimesCache: Map<string, StopTime[]> | null = null;
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

async function fetchStopTimes(): Promise<Map<string, StopTime[]>> {
  const now = Date.now();
  
  // Return cached data if still valid
  if (stopTimesCache && (now - cacheTimestamp) < CACHE_DURATION) {
    return stopTimesCache;
  }

  const stopTimesMap = new Map<string, StopTime[]>();

  try {
    const zip = await getGtfsZip(86400);
      // Extract stop_times.txt from the ZIP
      const stopTimesEntry = zip.getEntry('stop_times.txt');
      if (stopTimesEntry) {
        const text = stopTimesEntry.getData().toString('utf8');
        const lines = text.split('\n').filter(line => line.trim());
        
        if (lines.length > 0) {
          const headers = parseCSVLine(lines[0]);
          const tripIdIndex = headers.indexOf('trip_id');
          const stopIdIndex = headers.indexOf('stop_id');
          const stopSequenceIndex = headers.indexOf('stop_sequence');

          if (tripIdIndex !== -1 && stopIdIndex !== -1 && stopSequenceIndex !== -1) {
            for (let i = 1; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;
              
              const values = parseCSVLine(line);
              if (values.length > Math.max(tripIdIndex, stopIdIndex, stopSequenceIndex)) {
                const tripId = values[tripIdIndex].replace(/^"|"$/g, '');
                const stopId = values[stopIdIndex].replace(/^"|"$/g, '');
                const stopSequenceStr = values[stopSequenceIndex].replace(/^"|"$/g, '');
                
                const stopSequence = parseInt(stopSequenceStr, 10);
                
                if (tripId && stopId && !isNaN(stopSequence)) {
                  if (!stopTimesMap.has(tripId)) {
                    stopTimesMap.set(tripId, []);
                  }
                  stopTimesMap.get(tripId)!.push({
                    trip_id: tripId,
                    stop_id: stopId,
                    stop_sequence: stopSequence,
                  });
                }
              }
            }
            
            // Sort by stop_sequence for each trip
            for (const [tripId, stopTimes] of stopTimesMap.entries()) {
              stopTimes.sort((a, b) => a.stop_sequence - b.stop_sequence);
            }
            
            if (stopTimesMap.size > 0) {
              console.log('Successfully loaded stop_times.txt:', {
                totalTrips: stopTimesMap.size,
                totalStopTimes: Array.from(stopTimesMap.values()).reduce((sum, arr) => sum + arr.length, 0),
              });
              
              stopTimesCache = stopTimesMap;
              cacheTimestamp = now;
              return stopTimesMap;
            }
          }
        }
      } else {
        console.warn('stop_times.txt not found in GTFS ZIP file');
      }
  } catch (err) {
    console.error(`Failed to fetch and extract GTFS ZIP:`, err);
  }

  // Fallback: Return empty map if we can't fetch
  console.warn('Could not load stop_times.txt from any source.');
  stopTimesCache = stopTimesMap;
  cacheTimestamp = now;
  return stopTimesMap;
}

export async function GET() {
  try {
    const stopTimes = await fetchStopTimes();
    const stopTimesObject = Object.fromEntries(
      Array.from(stopTimes.entries()).map(([tripId, stopTimes]) => [tripId, stopTimes])
    );
    
    return NextResponse.json({
      stopTimes: stopTimesObject,
      count: stopTimes.size,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error fetching stop times:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stop times', stopTimes: {}, count: 0 },
      { status: 500 }
    );
  }
}

// Export the fetch function for use in other modules
export { fetchStopTimes };


