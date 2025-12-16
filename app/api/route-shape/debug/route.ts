import { NextResponse } from 'next/server';
import { fetchRouteToShapeMapping } from '../../trips/route';
import { fetchShapes } from '../../shapes/route';
import { fetchRouteTypes } from '../../routes/route';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const routeToShape = await fetchRouteToShapeMapping();
    const shapes = await fetchShapes();
    const routeTypes = await fetchRouteTypes();
    
    // Get sample route IDs from each source
    const sampleRouteIds = Array.from(routeToShape.keys()).slice(0, 20);
    const sampleShapeIds = Array.from(shapes.keys()).slice(0, 20);
    const sampleRouteTypes = Array.from(routeTypes.keys()).slice(0, 20);
    
    // Check for common patterns
    const routeIdPatterns = {
      withDash: Array.from(routeToShape.keys()).filter(id => id.includes('-')).slice(0, 10),
      withUnderscore: Array.from(routeToShape.keys()).filter(id => id.includes('_')).slice(0, 10),
      uppercase: Array.from(routeToShape.keys()).filter(id => id === id.toUpperCase()).slice(0, 10),
      lowercase: Array.from(routeToShape.keys()).filter(id => id === id.toLowerCase()).slice(0, 10),
      numericOnly: Array.from(routeToShape.keys()).filter(id => /^\d+$/.test(id)).slice(0, 10),
      alphanumeric: Array.from(routeToShape.keys()).filter(id => /^[A-Z]+\d+/.test(id)).slice(0, 10),
    };
    
    return NextResponse.json({
      summary: {
        totalRoutesInTrips: routeToShape.size,
        totalShapes: shapes.size,
        totalRouteTypes: routeTypes.size,
      },
      samples: {
        routeIds: sampleRouteIds,
        shapeIds: sampleShapeIds,
        routeTypes: sampleRouteTypes,
      },
      patterns: routeIdPatterns,
      routeToShapeSample: Object.fromEntries(
        Array.from(routeToShape.entries()).slice(0, 20)
      ),
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch debug info',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

