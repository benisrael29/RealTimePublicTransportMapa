import { NextResponse } from 'next/server';
import { fetchShapes } from '../../shapes/route';
import { fetchRouteToShapeMapping } from '../../trips/route';
import { fetchRouteTypes } from '../../routes/route';

export const dynamic = 'force-dynamic';
export const revalidate = 86400; // Cache for 24 hours

interface RouteShape {
  routeId: string;
  coordinates: [number, number][];
  routeType: number;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ routeId: string }> | { routeId: string } }
) {
  try {
    const resolvedParams = await Promise.resolve(params);
    const routeId = resolvedParams.routeId;
    
    if (!routeId) {
      return NextResponse.json(
        { error: 'Route ID is required' },
        { status: 400 }
      );
    }

    // Fetch route types to get routeType for the route
    const routeTypes = await fetchRouteTypes();
    const routeType = routeTypes.get(routeId);

    // Fetch route to shape mapping
    const routeToShape = await fetchRouteToShapeMapping();
    
    // Try exact match first
    let shapeId = routeToShape.get(routeId);
    
    // If not found, try variations of the route ID
    if (!shapeId) {
      // Try uppercase version
      shapeId = routeToShape.get(routeId.toUpperCase());
    }
    
    if (!shapeId) {
      // Try removing suffixes (e.g., "FG-123" -> "FG", "FG_123" -> "FG")
      const baseRouteId = routeId.split(/[-_]/)[0];
      shapeId = routeToShape.get(baseRouteId);
    }
    
    if (!shapeId) {
      // Try uppercase base route ID
      const baseRouteId = routeId.split(/[-_]/)[0].toUpperCase();
      shapeId = routeToShape.get(baseRouteId);
    }
    
    // Debug logging
    if (!shapeId) {
      console.log('Route shape lookup failed:', {
        requestedRouteId: routeId,
        routeType: routeType ?? null,
        totalRoutesInMapping: routeToShape.size,
        sampleRouteIds: Array.from(routeToShape.keys()).slice(0, 10),
        routeIdVariations: [
          routeId,
          routeId.toUpperCase(),
          routeId.split(/[-_]/)[0],
          routeId.split(/[-_]/)[0].toUpperCase(),
        ],
      });
    }

    if (!shapeId) {
      return NextResponse.json(
        { 
          error: 'No shape found for this route',
          routeId,
          routeType: routeType ?? null,
          debug: {
            totalRoutesInMapping: routeToShape.size,
            triedVariations: [
              routeId,
              routeId.toUpperCase(),
              routeId.split(/[-_]/)[0],
              routeId.split(/[-_]/)[0].toUpperCase(),
            ],
          },
        },
        { status: 404 }
      );
    }

    // Fetch shapes
    const shapes = await fetchShapes();
    const coordinates = shapes.get(shapeId);

    if (!coordinates || coordinates.length === 0) {
      return NextResponse.json(
        { 
          error: 'Shape coordinates not found',
          routeId,
          shapeId,
          routeType: routeType ?? null,
        },
        { status: 404 }
      );
    }

    const routeShape: RouteShape = {
      routeId,
      coordinates,
      routeType: routeType ?? 0,
    };

    return NextResponse.json(routeShape);
  } catch (error) {
    console.error('Error fetching route shape:', error);
    return NextResponse.json(
      { 
        error: 'Failed to fetch route shape',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

