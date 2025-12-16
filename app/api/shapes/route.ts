import { NextResponse } from 'next/server';
import { getGtfsZip } from '../_gtfsZip';

export const dynamic = 'force-dynamic';
export const revalidate = 86400; // Cache for 24 hours

interface ShapePoint {
  shape_id: string;
  shape_pt_lat: number;
  shape_pt_lon: number;
  shape_pt_sequence: number;
}

let shapesCache: Map<string, [number, number][]> | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION = 86400000; // 24 hours in milliseconds

let shapeCoordinatesCache: Map<string, [number, number][]> | null = null;
let shapeCoordinatesCacheTimestamp: number = 0;

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

async function fetchShapeCoordinates(shapeId: string): Promise<[number, number][] | null> {
  const now = Date.now();
  if (
    shapeCoordinatesCache &&
    (now - shapeCoordinatesCacheTimestamp) < CACHE_DURATION &&
    shapeCoordinatesCache.has(shapeId)
  ) {
    return shapeCoordinatesCache.get(shapeId)!;
  }

  try {
    const zip = await getGtfsZip(86400);
    const shapesEntry = zip.getEntry('shapes.txt');
    if (!shapesEntry) return null;

    const text = shapesEntry.getData().toString('utf8');
    const lines = text.split('\n');
    if (lines.length === 0) return null;

    const headers = parseCSVLine(lines[0]);
    const shapeIdIndex = headers.indexOf('shape_id');
    const latIndex = headers.indexOf('shape_pt_lat');
    const lonIndex = headers.indexOf('shape_pt_lon');
    const sequenceIndex = headers.indexOf('shape_pt_sequence');
    if (shapeIdIndex === -1 || latIndex === -1 || lonIndex === -1 || sequenceIndex === -1) {
      return null;
    }

    const points: ShapePoint[] = [];
    let collecting = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;

      const values = parseCSVLine(line);
      if (values.length <= Math.max(shapeIdIndex, latIndex, lonIndex, sequenceIndex)) continue;

      const thisShapeId = values[shapeIdIndex].replace(/^"|"$/g, '').trim();

      if (!collecting) {
        if (thisShapeId !== shapeId) continue;
        collecting = true;
      } else {
        if (thisShapeId !== shapeId) break;
      }

      const latStr = values[latIndex].replace(/^"|"$/g, '').trim();
      const lonStr = values[lonIndex].replace(/^"|"$/g, '').trim();
      const sequenceStr = values[sequenceIndex].replace(/^"|"$/g, '').trim();

      const lat = parseFloat(latStr);
      const lon = parseFloat(lonStr);
      const sequence = parseInt(sequenceStr, 10);

      if (thisShapeId && !isNaN(lat) && !isNaN(lon) && !isNaN(sequence)) {
        points.push({
          shape_id: thisShapeId,
          shape_pt_lat: lat,
          shape_pt_lon: lon,
          shape_pt_sequence: sequence,
        });
      }
    }

    if (points.length === 0) {
      return null;
    }

    points.sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
    const coordinates: [number, number][] = points.map(p => [p.shape_pt_lat, p.shape_pt_lon]);

    if (!shapeCoordinatesCache || (now - shapeCoordinatesCacheTimestamp) >= CACHE_DURATION) {
      shapeCoordinatesCache = new Map();
      shapeCoordinatesCacheTimestamp = now;
    }
    shapeCoordinatesCache.set(shapeId, coordinates);

    return coordinates;
  } catch (err) {
    console.error('Failed to fetch shape coordinates:', err);
    return null;
  }
}

async function fetchShapes(): Promise<Map<string, [number, number][]>> {
  const now = Date.now();
  
  // Return cached data if still valid
  if (shapesCache && (now - cacheTimestamp) < CACHE_DURATION) {
    return shapesCache;
  }

  const shapesMap = new Map<string, [number, number][]>();

  try {
    const zip = await getGtfsZip(86400);
      // Extract shapes.txt from the ZIP
      const shapesEntry = zip.getEntry('shapes.txt');
      if (shapesEntry) {
        const text = shapesEntry.getData().toString('utf8');
        const lines = text.split('\n').filter(line => line.trim());
        
        if (lines.length > 0) {
        
        const headers = parseCSVLine(lines[0]);
        const shapeIdIndex = headers.indexOf('shape_id');
        const latIndex = headers.indexOf('shape_pt_lat');
        const lonIndex = headers.indexOf('shape_pt_lon');
        const sequenceIndex = headers.indexOf('shape_pt_sequence');

        if (shapeIdIndex !== -1 && latIndex !== -1 && lonIndex !== -1 && sequenceIndex !== -1) {
          const shapePoints: Map<string, ShapePoint[]> = new Map();
          
          // Collect all points for each shape
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const values = parseCSVLine(line);
            if (values.length > Math.max(shapeIdIndex, latIndex, lonIndex, sequenceIndex)) {
              const shapeId = values[shapeIdIndex].replace(/^"|"$/g, '');
              const latStr = values[latIndex].replace(/^"|"$/g, '');
              const lonStr = values[lonIndex].replace(/^"|"$/g, '');
              const sequenceStr = values[sequenceIndex].replace(/^"|"$/g, '');
              
              const lat = parseFloat(latStr);
              const lon = parseFloat(lonStr);
              const sequence = parseInt(sequenceStr, 10);
              
              if (shapeId && !isNaN(lat) && !isNaN(lon) && !isNaN(sequence)) {
                if (!shapePoints.has(shapeId)) {
                  shapePoints.set(shapeId, []);
                }
                shapePoints.get(shapeId)!.push({
                  shape_id: shapeId,
                  shape_pt_lat: lat,
                  shape_pt_lon: lon,
                  shape_pt_sequence: sequence,
                });
              }
            }
          }
          
          // Sort by sequence and convert to coordinate arrays
          for (const [shapeId, points] of shapePoints.entries()) {
            points.sort((a, b) => a.shape_pt_sequence - b.shape_pt_sequence);
            const coordinates: [number, number][] = points.map(p => [p.shape_pt_lat, p.shape_pt_lon]);
            shapesMap.set(shapeId, coordinates);
          }
          
          if (shapesMap.size > 0) {
            console.log('Successfully loaded shapes.txt:', {
              totalShapes: shapesMap.size,
            });
            
            shapesCache = shapesMap;
            cacheTimestamp = now;
            return shapesMap;
          }
        }
        }
      } else {
        console.warn('shapes.txt not found in GTFS ZIP file');
      }
  } catch (err) {
    console.error(`Failed to fetch and extract GTFS ZIP:`, err);
  }

  // Fallback: Return empty map if we can't fetch
  console.warn('Could not load shapes.txt from any source.');
  shapesCache = shapesMap;
  cacheTimestamp = now;
  return shapesMap;
}

export async function GET() {
  try {
    const shapes = await fetchShapes();
    const shapesObject = Object.fromEntries(shapes);
    
    return NextResponse.json({
      shapes: shapesObject,
      count: shapes.size,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('Error fetching shapes:', error);
    return NextResponse.json(
      { error: 'Failed to fetch shapes', shapes: {}, count: 0 },
      { status: 500 }
    );
  }
}

// Export the fetch function for use in other modules
export { fetchShapes, fetchShapeCoordinates };

