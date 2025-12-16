'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline, useMapEvents } from 'react-leaflet';
import type {
  LatLngLiteral,
  Map as LeafletMap,
  Polyline as LeafletPolyline,
  LeafletEventHandlerFnMap,
  Marker as LeafletMarker,
} from 'leaflet';
import L from 'leaflet';

type VehicleType = 'bus' | 'train' | 'ferry' | 'unknown';

interface VehiclePosition {
  id: string;
  latitude: number;
  longitude: number;
  bearing?: number;
  speed?: number;
  tripId?: string;
  routeId?: string;
  routeType?: number;
  vehicleType?: VehicleType;
}

interface VehicleData {
  vehicles: VehiclePosition[];
  timestamp: number;
  error?: string;
}

interface RouteShape {
  routeId: string;
  coordinates: [number, number][];
  routeType: number;
  vehicleType?: VehicleType;
}

interface RouteStop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
  stop_sequence: number;
}

const VEHICLE_COLORS = {
  bus: '#D4B000',      // Darker Yellow
  train: '#34C759',    // Green
  ferry: '#007AFF',    // Blue
  unknown: '#8E8E93',  // Gray
} as const;

const getVehicleTypeFromRouteType = (routeType?: number): VehicleType => {
  // GTFS route_type values:
  // 0: Tram, Streetcar, Light rail
  // 1: Subway, Metro
  // 2: Rail (Train)
  // 3: Bus
  // 4: Ferry
  // 5-7: Other (cable car, gondola, funicular)
  
  if (routeType === undefined || routeType === null) {
    return 'unknown';
  }
  
  switch (routeType) {
    case 2:
      return 'train';
    case 3:
      return 'bus';
    case 4:
      return 'ferry';
    default:
      // For other types (0, 1, 5-7), default to unknown or bus
      return 'unknown';
  }
};

// Fallback function for when routeType is not available
const getVehicleTypeFallback = (routeId?: string, tripId?: string, vehicleId?: string): VehicleType => {
  // Check vehicle ID first for ferry indicators
  if (vehicleId) {
    const idUpper = vehicleId.toUpperCase();
    if (idUpper.includes('CITYCAT') || idUpper.includes('FERRY') || idUpper.match(/_F\d+/)) {
      return 'ferry';
    }
  }
  
  if (!routeId) {
    // If no route ID but we have a vehicle ID, default to bus (most common)
    return vehicleId ? 'bus' : 'unknown';
  }
  
  const routeUpper = routeId.toUpperCase();
  const routeClean = routeUpper.replace(/[-_]/g, ''); // Remove dashes/underscores
  
  // Ferry: Routes starting with F followed by number (e.g., F1, F1-4055)
  if (routeClean.match(/^F\d+/) || routeUpper.includes('CITYCAT') || routeUpper.includes('FERRY')) {
    return 'ferry';
  }
  
  // Train: TransLink uses 2-4 letter codes for train lines
  // Examples: FG, BG-123, FGBN-4596, SHCL-4596, IPCA-4596, CLSH-4596, GCR1-3585
  // Pattern: 2-4 uppercase letters, optionally followed by dash/underscore and numbers
  const trainPatterns = [
    // 2-3 letter codes (original patterns)
    /^(FG|BG|CL|IP|RB|SH|EX|GY|DO|CA|NA|RO|SP|VL|BE|KI|SPR|AIR|VLO|NGR|BRI|CAB|CLE|GOL|GYM|IPS|NOR|RED|SHO|SUN|WIL|CR|AR|GC|SC|TS|BN)$/i,
    /^(FG|BG|CL|IP|RB|SH|EX|GY|DO|CA|NA|RO|SP|VL|BE|KI|SPR|AIR|VLO|NGR|BRI|CAB|CLE|GOL|GYM|IPS|NOR|RED|SHO|SUN|WIL|CR|AR|GC|SC|TS|BN)[-_]/i,
    /^(FG|BG|CL|IP|RB|SH|EX|GY|DO|CA|NA|RO|SP|VL|BE|KI|SPR|AIR|VLO|NGR|BRI|CAB|CLE|GOL|GYM|IPS|NOR|RED|SHO|SUN|WIL|CR|AR|GC|SC|TS|BN)\d/i,
    // 4-letter train route codes (e.g., FGBN, SHCL, IPCA, CLSH, etc.)
    /^(FGBN|SHCL|IPCA|CLSH|BGFG|CLCB|IPDO|GCRL|GCR\d|EXIP|SHBE|CLBE|FGCL|IPSH|BGSH|CABG|GYIP|DOFG|ROCL|SPBN|VLSH|BEFG|KICL|AIRF|NGRT)[-_]?\d*/i,
    // Generic 4-letter uppercase pattern for trains (but not if it looks like a bus code)
    /^[A-Z]{4}[-_]\d{4}$/,
  ];
  
  // Check if route matches any train pattern
  const isTrain = trainPatterns.some(pattern => 
    pattern.test(routeUpper) || pattern.test(routeClean)
  ) || (routeUpper.match(/^[A-Z]{2,3}$/) && !routeUpper.startsWith('F'));
  
  if (isTrain) {
    return 'train';
  }
  
  // Default to bus if route has numbers (buses are most common)
  // But only if it's not already identified as train or ferry
  if (routeId.match(/\d+/)) {
    return 'bus';
  }
  
  // If route ID exists but has no numbers and doesn't match patterns, could be train
  // But be conservative - if it's just letters and short, might be train
  if (routeId.length > 0 && routeId.length <= 4 && !routeId.match(/\d+/)) {
    // Short alphanumeric codes without numbers might be train codes we missed
    // But default to bus to be safe
    return 'bus';
  }
  
  // Only return unknown if we truly have no information
  return 'unknown';
};

const isInQueensland = (latitude: number, longitude: number): boolean => {
  // Queensland boundaries:
  // Northernmost: approximately -9.0°S (Cape York)
  // Southernmost: approximately -29.0°S (border with NSW)
  // Westernmost: approximately 138.0°E (border with NT/SA)
  // Easternmost: approximately 153.5°E (coastline)
  return (
    latitude >= -29.0 &&
    latitude <= -9.0 &&
    longitude >= 138.0 &&
    longitude <= 153.5
  );
};

const getVehicleColor = (type: VehicleType): string => {
  return VEHICLE_COLORS[type];
};

// Small dot icon for default state
const createSmallDotIcon = (color: string = '#007AFF', opacity: number = 0.75) => {
  const size = 8;
  return L.divIcon({
    className: 'vehicle-marker-dot',
    html: `
      <svg width="${size}" height="${size}" viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg">
        <circle cx="4" cy="4" r="3.5" fill="${color}" stroke="white" stroke-width="1" opacity="${opacity}"/>
      </svg>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
};

// Stop marker icon
const createStopIcon = (color: string = '#007AFF') => {
  const size = 12;
  return L.divIcon({
    className: 'stop-marker',
    html: `
      <svg width="${size}" height="${size}" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg">
        <circle cx="6" cy="6" r="5" fill="${color}" stroke="white" stroke-width="2" opacity="0.9"/>
        <circle cx="6" cy="6" r="2.5" fill="white"/>
      </svg>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
};

// Large detailed icon for active/clicked state
const createLargeVehicleIcon = (color: string = '#007AFF', type: VehicleType = 'unknown', opacity: number = 0.9) => {
  const size = 40;
  
  const icons = {
    bus: `
      <svg width="${size}" height="${size}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" style="opacity:${opacity}">
        <defs>
          <filter id="shadow-bus-${color}" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
            <feOffset dx="0" dy="2" result="offsetblur"/>
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.4"/>
            </feComponentTransfer>
            <feMerge>
              <feMergeNode/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#shadow-bus-${color})">
          <rect x="8" y="9" width="24" height="22" rx="4" fill="${color}" stroke="white" stroke-width="2.5"/>
          <rect x="12" y="13" width="7" height="6" rx="1.5" fill="white" opacity="0.95"/>
          <rect x="21" y="13" width="7" height="6" rx="1.5" fill="white" opacity="0.95"/>
          <circle cx="14" cy="30" r="2.5" fill="white"/>
          <circle cx="26" cy="30" r="2.5" fill="white"/>
        </g>
      </svg>
    `,
    train: `
      <svg width="${size}" height="${size}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" style="opacity:${opacity}">
        <defs>
          <filter id="shadow-train-${color}" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
            <feOffset dx="0" dy="2" result="offsetblur"/>
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.4"/>
            </feComponentTransfer>
            <feMerge>
              <feMergeNode/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#shadow-train-${color})">
          <rect x="10" y="8" width="20" height="24" rx="2.5" fill="${color}" stroke="white" stroke-width="2.5"/>
          <rect x="12" y="12" width="16" height="10" rx="1.5" fill="white" opacity="0.95"/>
          <circle cx="15" cy="30" r="2" fill="white"/>
          <circle cx="25" cy="30" r="2" fill="white"/>
          <line x1="13.5" y1="32" x2="11" y2="35" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
          <line x1="26.5" y1="32" x2="29" y2="35" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
        </g>
      </svg>
    `,
    ferry: `
      <svg width="${size}" height="${size}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" style="opacity:${opacity}">
        <defs>
          <filter id="shadow-ferry-${color}" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
            <feOffset dx="0" dy="2" result="offsetblur"/>
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.4"/>
            </feComponentTransfer>
            <feMerge>
              <feMergeNode/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>
        <g filter="url(#shadow-ferry-${color})">
          <path d="M 10 22 L 15 14 L 25 14 L 30 22 L 28 28 L 12 28 Z" fill="${color}" stroke="white" stroke-width="2.5"/>
          <rect x="17" y="9" width="6" height="5" fill="${color}" stroke="white" stroke-width="2"/>
          <ellipse cx="20" cy="30" rx="10" ry="2.5" fill="${color}" opacity="0.5" stroke="white" stroke-width="2"/>
        </g>
      </svg>
    `,
    unknown: `
      <svg width="${size}" height="${size}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" style="opacity:${opacity}">
        <circle cx="20" cy="20" r="10" fill="${color}" stroke="white" stroke-width="2.5" filter="drop-shadow(0 2px 6px rgba(0,0,0,0.4))"/>
      </svg>
    `,
  };
  
  return L.divIcon({
    className: 'vehicle-marker-large',
    html: icons[type] || icons.unknown,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
};

function AnimatedMarker({ 
  position, 
  icon, 
  eventHandlers, 
  children 
}: { 
  position: [number, number]; 
  icon: L.Icon | L.DivIcon;
  eventHandlers?: LeafletEventHandlerFnMap;
  children?: React.ReactNode;
}) {
  const map = useMap();
  const markerRef = useRef<LeafletMarker | null>(null);
  const previousPositionRef = useRef<[number, number] | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const startPositionRef = useRef<[number, number] | null>(null);
  const targetPositionRef = useRef<[number, number] | null>(null);
  const currentAnimatedPositionRef = useRef<[number, number] | null>(null);

  useEffect(() => {
    const leafletMarker = markerRef.current;
    if (!leafletMarker) return;

    const currentPos: [number, number] = [position[0], position[1]];
    
    // If this is the first position or position hasn't changed, just set it
    if (!previousPositionRef.current || 
        (previousPositionRef.current[0] === currentPos[0] && 
         previousPositionRef.current[1] === currentPos[1])) {
      leafletMarker.setLatLng(currentPos);
      previousPositionRef.current = currentPos;
      currentAnimatedPositionRef.current = currentPos;
      return;
    }

    // Get the current animated position (where the marker is right now, even if mid-animation)
    let startPos: [number, number];
    if (currentAnimatedPositionRef.current) {
      // Use current animated position for seamless transition
      startPos = currentAnimatedPositionRef.current;
    } else if (previousPositionRef.current) {
      // Fallback to previous position
      startPos = previousPositionRef.current;
    } else {
      startPos = currentPos;
    }

    // Cancel any ongoing animation
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    // Start new animation from current position to new target
    const endPos = currentPos;
    startPositionRef.current = startPos;
    targetPositionRef.current = endPos;
    startTimeRef.current = Date.now();
    const p1 = map.latLngToLayerPoint([startPos[0], startPos[1]]);
    const p2 = map.latLngToLayerPoint([endPos[0], endPos[1]]);
    const pixelDistance = p1.distanceTo(p2);
    const duration = Math.max(6500, Math.min(60000, pixelDistance * 120));

    const animate = () => {
      const leafletMarker = markerRef.current;
      if (!leafletMarker || !startTimeRef.current || !startPositionRef.current || !targetPositionRef.current) return;

      const elapsed = Date.now() - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      
      // Linear easing for constant speed movement
      const eased = progress;

      // Interpolate position
      const lat = startPositionRef.current[0] + (targetPositionRef.current[0] - startPositionRef.current[0]) * eased;
      const lng = startPositionRef.current[1] + (targetPositionRef.current[1] - startPositionRef.current[1]) * eased;

      const currentPos: [number, number] = [lat, lng];
      leafletMarker.setLatLng(currentPos);
      currentAnimatedPositionRef.current = currentPos; // Track current animated position

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        // Animation complete
        previousPositionRef.current = targetPositionRef.current;
        currentAnimatedPositionRef.current = targetPositionRef.current;
        animationFrameRef.current = null;
        startTimeRef.current = null;
        startPositionRef.current = null;
        targetPositionRef.current = null;
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [position, map]);

  return (
    <Marker
      ref={markerRef}
      position={position}
      icon={icon}
      eventHandlers={eventHandlers}
    >
      {children}
    </Marker>
  );
}

function MapUpdater() {
  return null;
}

function MapClickHandler({ onMapClick }: { onMapClick: () => void }) {
  useMapEvents({
    click: onMapClick,
  });
  return null;
}

function RoutePolyline({ route }: { route: RouteShape }) {
  const polylineRef = useRef<LeafletPolyline | null>(null);
  const map = useMap();

  useEffect(() => {
    if (polylineRef.current && route.coordinates) {
      polylineRef.current.setLatLngs(route.coordinates);
      
      // Fit map bounds to show the entire route
      try {
        const bounds = L.latLngBounds(route.coordinates);
        map.fitBounds(bounds, { 
          padding: [50, 50],
          maxZoom: 14
        });
      } catch (err) {
        void err;
      }
    }
  }, [route.coordinates, map]);

  const color = getVehicleColor(
    route.vehicleType ?? getVehicleTypeFromRouteType(route.routeType)
  );
  
  return (
    <Polyline
      ref={polylineRef}
      positions={route.coordinates}
      pathOptions={{
        color: color,
        weight: 6,
        opacity: 0.75,
        lineCap: 'round',
        lineJoin: 'round',
      }}
    />
  );
}


export default function TransportMap() {
  const [vehicles, setVehicles] = useState<VehiclePosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [displayedRoute, setDisplayedRoute] = useState<RouteShape | null>(null);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeStops, setRouteStops] = useState<RouteStop[]>([]);
  const [routeStopsRouteId, setRouteStopsRouteId] = useState<string | null>(null);
  const routeRequestIdRef = useRef(0);
  const routeCacheRef = useRef<Map<string, { route: RouteShape; stops: RouteStop[] }>>(new Map());
  const prefetchInFlightRef = useRef<Set<string>>(new Set());
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const iconCacheRef = useRef<Map<string, L.DivIcon>>(new Map());
  const mapRef = useRef<LeafletMap | null>(null);
  const previousMapViewRef = useRef<{ center: LatLngLiteral; zoom: number } | null>(null);

  const getCachedIcon = useCallback((key: string, factory: () => L.DivIcon) => {
    const existing = iconCacheRef.current.get(key);
    if (existing) return existing;
    const created = factory();
    iconCacheRef.current.set(key, created);
    if (iconCacheRef.current.size > 120) {
      const firstKey = iconCacheRef.current.keys().next().value as string | undefined;
      if (firstKey) iconCacheRef.current.delete(firstKey);
    }
    return created;
  }, []);

  const setRouteCacheEntry = useCallback((routeId: string, entry: { route: RouteShape; stops: RouteStop[] }) => {
    routeCacheRef.current.delete(routeId);
    routeCacheRef.current.set(routeId, entry);
    if (routeCacheRef.current.size > 200) {
      const firstKey = routeCacheRef.current.keys().next().value as string | undefined;
      if (firstKey) routeCacheRef.current.delete(firstKey);
    }
  }, []);

  const captureMapViewBeforeRouteZoom = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    if (previousMapViewRef.current) return;

    const center = map.getCenter();
    previousMapViewRef.current = {
      center: { lat: center.lat, lng: center.lng },
      zoom: map.getZoom(),
    };
  }, []);

  const restoreMapViewAfterRoute = useCallback(() => {
    const map = mapRef.current;
    const prev = previousMapViewRef.current;
    if (!map || !prev) return;

    map.setView(prev.center, prev.zoom, { animate: true });
    previousMapViewRef.current = null;
  }, []);

  const fetchVehicles = useCallback(async () => {
    try {
      const response = await fetch('/api/vehicles');
      const data: VehicleData = await response.json();
      
      if (data.error) {
        throw new Error(data.error);
      }
      
      const vehiclesWithType = (data.vehicles || [])
        .filter(vehicle => 
          isInQueensland(vehicle.latitude, vehicle.longitude)
        )
        .map(vehicle => {
          // Use routeType from API if available (most accurate)
          // Otherwise fall back to pattern matching
          let type: VehicleType;
          
          if (vehicle.routeType !== undefined && vehicle.routeType !== null) {
            type = getVehicleTypeFromRouteType(vehicle.routeType);
            // If routeType exists but maps to unknown (e.g., type 0, 1, 5-7), use fallback
            if (type === 'unknown') {
              type = getVehicleTypeFallback(vehicle.routeId, vehicle.tripId, vehicle.id);
            }
          } else {
            // No routeType available, use fallback pattern matching
            type = getVehicleTypeFallback(vehicle.routeId, vehicle.tripId, vehicle.id);
          }
          
          // Debug logging for trains (remove in production)
          if (type === 'train' && process.env.NODE_ENV === 'development') {
            // no-op
          }
          
          return {
            ...vehicle,
            vehicleType: type,
          };
        });
      setVehicles(vehiclesWithType);
      setError(null);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  }, []);

  const prefetchRouteData = useCallback(async (routeId: string, routeType?: number, vehicleType?: VehicleType) => {
    if (!routeId) return;
    if (routeCacheRef.current.has(routeId)) return;
    if (prefetchInFlightRef.current.has(routeId)) return;

    prefetchInFlightRef.current.add(routeId);
    try {
      const routeUrl = `/api/route-shape/${encodeURIComponent(routeId)}`;
      const stopsUrl = `/api/route-stops/${encodeURIComponent(routeId)}`;

      const [routeResp, stopsResp] = await Promise.all([fetch(routeUrl), fetch(stopsUrl)]);
      const [routeData, stopsData] = await Promise.all([routeResp.json(), stopsResp.json()]);

      if (routeData?.error || stopsData?.error) return;
      const stops: RouteStop[] = Array.isArray(stopsData?.stops) ? stopsData.stops : [];
      if (!routeData?.coordinates || !Array.isArray(routeData.coordinates) || stops.length === 0) return;

      const cachedRoute: RouteShape = {
        ...routeData,
        routeType: routeType ?? routeData.routeType,
        vehicleType: vehicleType ?? routeData.vehicleType,
      };

      setRouteCacheEntry(routeId, { route: cachedRoute, stops });
    } catch {
      // ignore
    } finally {
      prefetchInFlightRef.current.delete(routeId);
    }
  }, [setRouteCacheEntry]);

  const handleVehicleClick = async (vehicle: VehiclePosition) => {
    if (!vehicle.routeId) {
      setRouteError('No route ID available for this vehicle');
      return;
    }
    const effectiveVehicleType =
      vehicle.vehicleType ??
      (vehicle.routeType !== undefined && vehicle.routeType !== null
        ? getVehicleTypeFromRouteType(vehicle.routeType)
        : getVehicleTypeFallback(vehicle.routeId, vehicle.tripId, vehicle.id));

    const cached = routeCacheRef.current.get(vehicle.routeId);
    if (cached) {
      routeCacheRef.current.delete(vehicle.routeId);
      setRouteCacheEntry(vehicle.routeId, cached);
      setRouteError(null);
      captureMapViewBeforeRouteZoom();
      setDisplayedRoute({
        ...cached.route,
        routeType:
          vehicle.routeType !== undefined && vehicle.routeType !== null
            ? vehicle.routeType
            : cached.route.routeType,
        vehicleType: effectiveVehicleType,
      });
      setRouteStops(cached.stops);
      setRouteStopsRouteId(vehicle.routeId);
      setLoadingRoute(false);
      return;
    }

    setLoadingRoute(true);
    setRouteError(null);
    setDisplayedRoute(null);
    setRouteStops([]);
    setRouteStopsRouteId(null);
    const requestId = ++routeRequestIdRef.current;
    
    try {
      const routeUrl = `/api/route-shape/${encodeURIComponent(vehicle.routeId)}`;
      const stopsUrl = `/api/route-stops/${encodeURIComponent(vehicle.routeId)}`;

      const [routeResp, stopsResp] = await Promise.all([fetch(routeUrl), fetch(stopsUrl)]);
      const [routeData, stopsData] = await Promise.all([routeResp.json(), stopsResp.json()]);

      if (routeRequestIdRef.current !== requestId) {
        return;
      }

      if (routeData?.error) {
        setRouteError(routeData.error);
        return;
      }

      if (stopsData?.error) {
        setRouteError(stopsData.error);
        return;
      }

      const stops: RouteStop[] = Array.isArray(stopsData?.stops) ? stopsData.stops : [];
      if (stops.length === 0) {
        setRouteError('No stops found for this route');
        return;
      }

      captureMapViewBeforeRouteZoom();
      setDisplayedRoute({
        ...routeData,
        routeType:
          vehicle.routeType !== undefined && vehicle.routeType !== null
            ? vehicle.routeType
            : routeData.routeType,
        vehicleType: effectiveVehicleType,
      });
      setRouteStops(stops);
      setRouteStopsRouteId(vehicle.routeId);
      setRouteCacheEntry(vehicle.routeId, {
        route: {
          ...routeData,
          routeType:
            vehicle.routeType !== undefined && vehicle.routeType !== null
              ? vehicle.routeType
              : routeData.routeType,
          vehicleType: effectiveVehicleType,
        },
        stops,
      });
    } catch (err) {
      setRouteError(err instanceof Error ? err.message : 'Failed to load route');
      setDisplayedRoute(null);
      setRouteStops([]);
      setRouteStopsRouteId(null);
    } finally {
      setLoadingRoute(false);
    }
  };

  const handleMapClick = () => {
    routeRequestIdRef.current += 1;
    restoreMapViewAfterRoute();
    setDisplayedRoute(null);
    setRouteError(null);
    setSelectedVehicleId(null);
    setRouteStops([]);
    setRouteStopsRouteId(null);
    setLoadingRoute(false);
  };

  useEffect(() => {
    fetchVehicles();

    intervalRef.current = setInterval(() => {
      fetchVehicles();
    }, 5000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [fetchVehicles]);

  useEffect(() => {
    const uniqueRouteIds: string[] = [];
    const seen = new Set<string>();
    for (const v of vehicles) {
      if (!v.routeId) continue;
      if (seen.has(v.routeId)) continue;
      seen.add(v.routeId);
      uniqueRouteIds.push(v.routeId);
      if (uniqueRouteIds.length >= 12) break;
    }

    const schedule = (cb: () => void) => {
      const ric = (window as unknown as { requestIdleCallback?: (fn: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) {
        ric(cb, { timeout: 1500 });
      } else {
        setTimeout(cb, 250);
      }
    };

    schedule(() => {
      for (const routeId of uniqueRouteIds) {
        if (routeCacheRef.current.has(routeId)) continue;
        const vehicle = vehicles.find(v => v.routeId === routeId);
        void prefetchRouteData(routeId, vehicle?.routeType, vehicle?.vehicleType);
      }
    });
  }, [vehicles, prefetchRouteData]);

  return (
    <div className="w-full h-screen relative overflow-hidden">
      <MapContainer
        center={[-27.4698, 153.0251]}
        zoom={12}
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom={true}
        zoomControl={true}
        className="ios-map"
      >
        <MapClickHandler onMapClick={handleMapClick} />
        <TileLayer
          attribution='&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
        />
        <MapUpdater />
        {displayedRoute &&
          routeStopsRouteId === displayedRoute.routeId &&
          routeStops.length > 0 &&
          displayedRoute.coordinates &&
          displayedRoute.coordinates.length > 0 && (
            <>
              <RoutePolyline route={displayedRoute} />
              {routeStops.map((stop) => {
                const routeColor = getVehicleColor(
                  displayedRoute.vehicleType ?? getVehicleTypeFromRouteType(displayedRoute.routeType)
                );
                const stopIcon = getCachedIcon(`stop:${routeColor}`, () => createStopIcon(routeColor));
                
                return (
                  <Marker
                    key={stop.stop_id}
                    position={[stop.stop_lat, stop.stop_lon]}
                    icon={stopIcon}
                  >
                    <Popup className="ios-popup">
                      <div className="p-3 min-w-[200px]">
                        <div className="font-semibold text-base leading-tight mb-1">
                          {stop.stop_name}
                        </div>
                        <div className="text-xs text-gray-500">
                          Stop {stop.stop_sequence}
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </>
          )}
        {vehicles.map((vehicle) => {
          const vehicleType = vehicle.vehicleType || 
            (vehicle.routeType !== undefined 
              ? getVehicleTypeFromRouteType(vehicle.routeType)
              : getVehicleTypeFallback(vehicle.routeId, vehicle.tripId, vehicle.id)) || 
            'bus';
          const color = getVehicleColor(vehicleType);
          const typeLabel = vehicleType.charAt(0).toUpperCase() + vehicleType.slice(1);
          const isSelected = selectedVehicleId === vehicle.id;
          const isRouteDisplayed = !!displayedRoute;
          
          const markerIcon = isSelected
            ? getCachedIcon(`veh:large:${vehicleType}`, () => createLargeVehicleIcon(color, vehicleType, 0.9))
            : getCachedIcon(
                `veh:dot:${vehicleType}:${isRouteDisplayed ? 'dim' : 'norm'}`,
                () => createSmallDotIcon(color, isRouteDisplayed ? 0.25 : 0.75)
              );
          
          return (
            <AnimatedMarker
              key={vehicle.id}
              position={[vehicle.latitude, vehicle.longitude]}
              icon={markerIcon}
              eventHandlers={{
                click: () => {
                  setSelectedVehicleId(vehicle.id);
                  handleVehicleClick(vehicle);
                },
                mouseover: () => {
                  if (vehicle.routeId) {
                    void prefetchRouteData(vehicle.routeId, vehicle.routeType, vehicle.vehicleType);
                  }
                },
              }}
            >
              <Popup 
              className="ios-popup"
              eventHandlers={{
                remove: () => {
                  routeRequestIdRef.current += 1;
                  setSelectedVehicleId(null);
                  setDisplayedRoute(null);
                  setRouteError(null);
                  setRouteStops([]);
                  setRouteStopsRouteId(null);
                  setLoadingRoute(false);
                },
              }}
            >
                <div className="p-3 min-w-[200px]">
                  <div className="flex items-center gap-2 mb-3">
                    <div 
                      className="w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: color }}
                    ></div>
                    <div>
                      <div className="font-semibold text-base leading-tight">
                        {(() => {
                          const idParts = vehicle.id.split('_');
                          return idParts.length > 1 ? idParts.slice(1).join(' ') : `${typeLabel} ${vehicle.id.slice(0, 8)}`;
                        })()}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">{typeLabel}</div>
                    </div>
                  </div>
                  
                  {vehicle.routeId && (
                    <div className="mb-2 pb-2 border-b border-gray-200">
                      <div className="text-xs text-gray-500 mb-0.5">Route</div>
                      <div className="text-sm font-medium text-gray-800">
                        {(() => {
                          const route = vehicle.routeId;
                          if (route.match(/^F\d+/)) {
                            return `Ferry Route ${route.replace(/^F/, '')}`;
                          }
                          if (route.match(/^[A-Z]{2,3}$/)) {
                            return `Train Line ${route}`;
                          }
                          return `Route ${route}`;
                        })()}
                      </div>
                    </div>
                  )}
                  
                  <div className="space-y-1.5">
                    {vehicle.bearing !== undefined && vehicle.bearing > 0 && vehicle.speed !== undefined && vehicle.speed > 0.05 && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">Direction</span>
                        <span className="text-sm font-medium text-gray-800">
                          {(() => {
                            const dir = vehicle.bearing!;
                            if (dir >= 337.5 || dir < 22.5) return 'North';
                            if (dir >= 22.5 && dir < 67.5) return 'Northeast';
                            if (dir >= 67.5 && dir < 112.5) return 'East';
                            if (dir >= 112.5 && dir < 157.5) return 'Southeast';
                            if (dir >= 157.5 && dir < 202.5) return 'South';
                            if (dir >= 202.5 && dir < 247.5) return 'Southwest';
                            if (dir >= 247.5 && dir < 292.5) return 'West';
                            return 'Northwest';
                          })()}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </Popup>
            </AnimatedMarker>
          );
        })}
      </MapContainer>
      
      {loading && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur-xl px-6 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-sm font-medium text-gray-800">Loading vehicles...</p>
          </div>
        </div>
      )}
      
      {error && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 bg-red-50/95 backdrop-blur-xl px-6 py-3 rounded-2xl shadow-2xl z-[1000] border border-red-200/50 max-w-sm">
          <div className="flex items-start gap-3">
            <div className="text-red-500 text-xl">!</div>
            <div>
              <p className="text-sm font-semibold text-red-800 mb-1">Connection Error</p>
              <p className="text-xs text-red-600">{error}</p>
            </div>
          </div>
        </div>
      )}

      {loadingRoute && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur-xl px-4 py-2 rounded-xl shadow-lg z-[1000] border border-gray-200/50">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-xs font-medium text-gray-800">Loading route...</p>
          </div>
        </div>
      )}

      {routeError && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-yellow-50/95 backdrop-blur-xl px-4 py-2 rounded-xl shadow-lg z-[1000] border border-yellow-200/50 max-w-sm">
          <div className="flex items-start gap-2">
            <div className="text-yellow-600 text-sm">i</div>
            <p className="text-xs text-yellow-800">{routeError}</p>
          </div>
        </div>
      )}
      
      <button
        onClick={() => setShowInfo(!showInfo)}
        className="absolute top-6 right-6 bg-white/90 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 hover:bg-white transition-colors"
        aria-label="More information"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-6 w-6 text-gray-700"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </button>

      {showInfo && (
        <div className="absolute top-20 right-6 bg-white/95 backdrop-blur-xl px-6 py-5 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 max-w-sm">
          <div className="flex items-start justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800">About This Map</h3>
            <button
              onClick={() => setShowInfo(false)}
              className="text-gray-500 hover:text-gray-700 transition-colors"
              aria-label="Close"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
          <div className="space-y-3 text-sm text-gray-700">
            <div>
              <p className="font-semibold mb-1">Real-time Transit Map</p>
              <p className="text-gray-600">
                This map shows live vehicle positions for buses, trains, and ferries in the SEQ region.
              </p>
            </div>
            <div>
              <p className="font-semibold mb-1">Vehicle Types</p>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: VEHICLE_COLORS.bus }}></div>
                  <span>Bus - {vehicles.filter(v => v.vehicleType === 'bus').length} active</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: VEHICLE_COLORS.train }}></div>
                  <span>Train - {vehicles.filter(v => v.vehicleType === 'train').length} active</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: VEHICLE_COLORS.ferry }}></div>
                  <span>Ferry - {vehicles.filter(v => v.vehicleType === 'ferry').length} active</span>
                </div>
              </div>
            </div>
            <div>
              <p className="font-semibold mb-1">Updates</p>
              <p className="text-gray-600">
                Data refreshes every 3 seconds automatically. Click on any vehicle marker to see more details.
              </p>
            </div>
            <div className="pt-2 border-t border-gray-200">
              <p className="text-xs text-gray-500">
                Total vehicles: <span className="font-semibold text-gray-700">{vehicles.length}</span>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

