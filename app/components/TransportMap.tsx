'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline, useMapEvents, Rectangle } from 'react-leaflet';
import type {
  LatLngLiteral,
  Map as LeafletMap,
  Polyline as LeafletPolyline,
  LeafletEventHandlerFnMap,
  Marker as LeafletMarker,
} from 'leaflet';
import L from 'leaflet';

type VehicleType = 'bus' | 'train' | 'ferry' | 'unknown';

type OutageType = 'unplanned' | 'planned_current' | 'planned_future';

type PowerOutageFeature = {
  type: 'Feature';
  geometry: unknown;
  properties?: {
    outageType?: OutageType;
    source?: string;
    energex?: Record<string, unknown> | null;
  };
};

type PowerOutageCollection = {
  type: 'FeatureCollection';
  features: PowerOutageFeature[];
  meta?: {
    fetchedAt?: number;
    errors?: Array<{ feed: string; error: string }>;
  };
};

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

interface Stop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
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

function MapUpdater({ mapRef }: { mapRef: React.MutableRefObject<LeafletMap | null> }) {
  const map = useMap();

  useEffect(() => {
    mapRef.current = map;
    return () => {
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [map, mapRef]);

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

type StopPoint = { x: number; y: number; id: string };

const mercatorProjectMeters = (lat: number, lon: number) => {
  const R = 6378137;
  const rad = Math.PI / 180;
  const x = R * lon * rad;
  const clampedLat = Math.max(-85, Math.min(85, lat));
  const y = R * Math.log(Math.tan(Math.PI / 4 + (clampedLat * rad) / 2));
  return { x, y };
};

class StopSpatialIndex {
  private binSizeMeters: number;
  private bins: Map<string, StopPoint[]>;

  constructor(stops: Stop[], binSizeMeters: number = 900) {
    this.binSizeMeters = binSizeMeters;
    this.bins = new Map();
    for (const s of stops) {
      const { x, y } = mercatorProjectMeters(s.stop_lat, s.stop_lon);
      const ix = Math.floor(x / this.binSizeMeters);
      const iy = Math.floor(y / this.binSizeMeters);
      const key = `${ix},${iy}`;
      const arr = this.bins.get(key);
      const pt: StopPoint = { x, y, id: s.stop_id };
      if (arr) arr.push(pt);
      else this.bins.set(key, [pt]);
    }
  }

  nearestDistanceMeters(lat: number, lon: number): number | null {
    if (this.bins.size === 0) return null;
    const { x, y } = mercatorProjectMeters(lat, lon);
    const ix0 = Math.floor(x / this.binSizeMeters);
    const iy0 = Math.floor(y / this.binSizeMeters);

    let bestSq = Number.POSITIVE_INFINITY;
    let foundAny = false;

    for (let r = 0; r <= 24; r++) {
      const minPossible = Math.max(0, r * this.binSizeMeters);
      if (foundAny && minPossible * minPossible > bestSq) break;

      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const key = `${ix0 + dx},${iy0 + dy}`;
          const bucket = this.bins.get(key);
          if (!bucket) continue;
          foundAny = true;
          for (const pt of bucket) {
            const ddx = pt.x - x;
            const ddy = pt.y - y;
            const sq = ddx * ddx + ddy * ddy;
            if (sq < bestSq) bestSq = sq;
          }
        }
      }
    }

    if (!foundAny || !Number.isFinite(bestSq)) return null;
    return Math.sqrt(bestSq);
  }
}

const heatColorForDistance = (meters: number, maxMeters: number) => {
  const t = Math.max(0, Math.min(1, meters / maxMeters));
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.5) {
    const u = t / 0.5;
    r = Math.round(40 + (255 - 40) * u);
    g = Math.round(200 + (220 - 200) * u);
    b = Math.round(60 + (60 - 60) * u);
  } else {
    const u = (t - 0.5) / 0.5;
    r = Math.round(255 + (220 - 255) * u);
    g = Math.round(220 + (40 - 220) * u);
    b = Math.round(60 + (40 - 60) * u);
  }
  return { r, g, b };
};

function AccessibilityHeatmapLayer({
  enabled,
  stops,
}: {
  enabled: boolean;
  stops: Stop[];
}) {
  const map = useMap();
  const [, setUpdateCounter] = useState(0);
  
  const index = useMemo(() => {
    if (!enabled || stops.length === 0) return null;
    console.log('Building spatial index with', stops.length, 'stops');
    return new StopSpatialIndex(stops, 900);
  }, [enabled, stops]);

  useEffect(() => {
    if (!enabled || !index) return;

    console.log('Adding heatmap layer to map');

    const update = () => {
      setUpdateCounter(c => c + 1);
    };

    map.on('moveend', update);
    map.on('zoomend', update);
    
    return () => {
      console.log('Removing heatmap layer from map');
      map.off('moveend', update);
      map.off('zoomend', update);
    };
  }, [enabled, index, map]);

  if (!enabled || !index) return null;

  const bounds = map.getBounds();
  const nw = bounds.getNorthWest();
  const se = bounds.getSouthEast();

  const gridSize = 100;
  const cells = [];
  const maxMeters = 3000;

  const latStep = (se.lat - nw.lat) / gridSize;
  const lngStep = (se.lng - nw.lng) / gridSize;

  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const lat = nw.lat + (i + 0.5) * latStep;
      const lng = nw.lng + (j + 0.5) * lngStep;
      
      const d0 = index.nearestDistanceMeters(lat, lng);
      const d = d0 === null ? maxMeters : Math.min(d0, maxMeters);
      const { r, g, b } = heatColorForDistance(d, maxMeters);

      const swLat = nw.lat + i * latStep;
      const swLng = nw.lng + j * lngStep;
      const neLat = nw.lat + (i + 1) * latStep;
      const neLng = nw.lng + (j + 1) * lngStep;

      cells.push(
        <Rectangle
          key={`cell-${i}-${j}`}
          bounds={[[swLat, swLng], [neLat, neLng]]}
          pathOptions={{
            fillColor: `rgb(${r},${g},${b})`,
            fillOpacity: 0.35,
            stroke: false,
            interactive: false,
          }}
        />
      );
    }
  }

  console.log('Rendering', cells.length, 'heat cells');

  return <>{cells}</>;
}

function PowerOutageLayer({ enabled }: { enabled: boolean }) {
  const map = useMap();
  const layerRef = useRef<L.GeoJSON | null>(null);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }
      return;
    }

    const toText = (v: unknown) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'string') return v.trim() || null;
      if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
      return null;
    };

    const pickAny = (obj: Record<string, unknown> | null | undefined, keys: string[]) => {
      if (!obj) return null;
      for (const k of keys) {
        const t = toText(obj[k]);
        if (t) return t;
      }
      return null;
    };

    const styleFor = (outageType: OutageType | undefined): L.PathOptions => {
      switch (outageType) {
        case 'unplanned':
          return { color: '#B91C1C', weight: 2, fillColor: '#EF4444', fillOpacity: 0.22 };
        case 'planned_current':
          return { color: '#A16207', weight: 2, fillColor: '#F59E0B', fillOpacity: 0.18 };
        case 'planned_future':
          return { color: '#92400E', weight: 1.5, fillColor: '#FBBF24', fillOpacity: 0.14 };
        default:
          return { color: '#6B7280', weight: 1.5, fillColor: '#9CA3AF', fillOpacity: 0.12 };
      }
    };

    const buildPopupHtml = (energex: Record<string, unknown> | null | undefined, outageType?: OutageType) => {
      const title =
        outageType === 'unplanned'
          ? 'Unplanned outage'
          : outageType === 'planned_current'
            ? 'Planned outage'
            : outageType === 'planned_future'
              ? 'Future planned outage'
              : 'Power outage';

      const suburb = pickAny(energex, ['suburb', 'locality', 'area', 'location']);
      const status = pickAny(energex, ['status', 'outage_status', 'state']);
      const customers = pickAny(energex, ['customers', 'customers_affected', 'affected_customers', 'cust', 'count']);
      const start = pickAny(energex, ['start', 'start_time', 'startTime', 'start_date', 'outage_start']);
      const etr = pickAny(energex, ['etr', 'estimated_restore', 'estimated_restoration', 'restoration', 'restore_time']);

      const rows: Array<{ label: string; value: string }> = [];
      if (suburb) rows.push({ label: 'Area', value: suburb });
      if (status) rows.push({ label: 'Status', value: status });
      if (customers) rows.push({ label: 'Customers', value: customers });
      if (start) rows.push({ label: 'Start', value: start });
      if (etr) rows.push({ label: 'ETR', value: etr });

      const rowHtml = rows
        .map(
          (r) => `
            <div style="display:flex;justify-content:space-between;gap:12px;">
              <div style="color:#6B7280;font-size:12px;">${r.label}</div>
              <div style="color:#111827;font-size:12px;font-weight:600;text-align:right;max-width:260px;overflow:hidden;text-overflow:ellipsis;">${r.value}</div>
            </div>
          `
        )
        .join('');

      return `
        <div style="padding:10px;min-width:240px;">
          <div style="font-weight:700;font-size:14px;color:#111827;margin-bottom:8px;">${title}</div>
          <div style="display:flex;flex-direction:column;gap:6px;">${rowHtml || '<div style="color:#6B7280;font-size:12px;">No details available</div>'}</div>
          <div style="margin-top:10px;color:#9CA3AF;font-size:11px;">Source: Energex</div>
        </div>
      `;
    };

    const applyData = (geojson: PowerOutageCollection) => {
      if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) return;

      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }

      const layer = L.geoJSON(geojson as unknown as any, {
        pane: 'overlayPane',
        style: (feature) => {
          const props = (feature as unknown as PowerOutageFeature)?.properties;
          return styleFor(props?.outageType);
        },
        onEachFeature: (feature, l) => {
          const props = (feature as unknown as PowerOutageFeature)?.properties;
          const html = buildPopupHtml(props?.energex ?? null, props?.outageType);
          l.bindPopup(html, { className: 'ios-popup' });
        },
      });

      layer.addTo(map);
      layerRef.current = layer;
    };

    const fetchAndRender = async () => {
      try {
        const resp = await fetch('/api/power-outages');
        const json = (await resp.json()) as PowerOutageCollection;
        applyData(json);
      } catch {
        // ignore
      }
    };

    void fetchAndRender();
    intervalRef.current = window.setInterval(() => {
      void fetchAndRender();
    }, 5 * 60 * 1000);

    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }
    };
  }, [enabled, map]);

  return null;
}

function QldTrafficClosuresLayer({ enabled }: { enabled: boolean }) {
  const map = useMap();
  const layerRef = useRef<L.GeoJSON | null>(null);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }
      return;
    }

    const styleFor = (props: any): L.PathOptions => {
      const impactSubtype = typeof props?.impact?.impact_subtype === 'string' ? props.impact.impact_subtype : '';
      const impactType = typeof props?.impact?.impact_type === 'string' ? props.impact.impact_type : '';
      const full =
        impactSubtype.toLowerCase().includes('closed') &&
        (impactSubtype.toLowerCase().includes('all') || impactSubtype.toLowerCase().includes('to all'));
      const color = full ? '#FF3B30' : impactType === 'Closures' ? '#FF9F0A' : '#8E8E93';
      return { color, weight: 5, opacity: 0.85, dashArray: full ? undefined : '8 8' };
    };

    const buildPopupHtml = (props: any) => {
      const rs = props?.road_summary ?? {};
      const impact = props?.impact ?? {};
      const titleParts: string[] = [];
      if (rs?.road_name) titleParts.push(String(rs.road_name));
      if (rs?.locality) titleParts.push(String(rs.locality));
      const title = titleParts.join(' — ') || 'QLDTraffic';

      return `
        <div style="padding:10px;min-width:240px;">
          <div style="font-weight:700;font-size:14px;color:#111827;margin-bottom:8px;">${title}</div>
          <div style="color:#374151;font-size:12px;margin-bottom:8px;">${props?.event_type ?? ''}${props?.event_subtype ? ` — ${props.event_subtype}` : ''}</div>
          <div style="color:#111827;font-size:12px;font-weight:600;margin-bottom:8px;">${impact?.impact_subtype ?? impact?.impact_type ?? ''}</div>
          ${props?.description ? `<div style="color:#374151;font-size:12px;margin-bottom:8px;">${String(props.description)}</div>` : ''}
          ${props?.advice ? `<div style="color:#6B7280;font-size:12px;">${String(props.advice)}</div>` : ''}
          <div style="margin-top:10px;color:#9CA3AF;font-size:11px;">Source: QLDTraffic</div>
        </div>
      `;
    };

    const applyData = (geojson: any) => {
      if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) return;

      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }

      const layer = L.geoJSON(geojson, {
        pane: 'overlayPane',
        style: (feature) => styleFor((feature as any)?.properties ?? {}),
        onEachFeature: (feature, l) => {
          const props = (feature as any)?.properties ?? {};
          l.bindPopup(buildPopupHtml(props), { className: 'ios-popup' });
        },
      });

      layer.addTo(map);
      layerRef.current = layer;
    };

    const fetchAndRender = async () => {
      try {
        const resp = await fetch('/api/road-closures/qldtraffic');
        const json = (await resp.json()) as { geojson?: unknown };
        if (!json?.geojson) return;
        applyData(json.geojson);
      } catch {
        // ignore
      }
    };

    void fetchAndRender();
    intervalRef.current = window.setInterval(() => {
      void fetchAndRender();
    }, 60 * 1000);

    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }
    };
  }, [enabled, map]);

  return null;
}

function BccRoadOccupanciesLayer({ enabled }: { enabled: boolean }) {
  const map = useMap();
  const layerRef = useRef<L.GeoJSON | null>(null);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }
      return;
    }

    const styleFor = (props: any): L.PathOptions => {
      const total = typeof props?.total === 'number' ? props.total : 0;
      const full = typeof props?.full_closure_count === 'number' ? props.full_closure_count : 0;
      const color = full > 0 ? '#FF3B30' : total > 0 ? '#FF9F0A' : '#8E8E93';
      return { color, weight: 2, opacity: total > 0 ? 0.8 : 0, fillColor: color, fillOpacity: total > 0 ? 0.12 : 0 };
    };

    const buildPopupHtml = (props: any) => {
      const suburb = props?.suburb ?? 'Suburb';
      const total = props?.total ?? 0;
      const items: any[] = Array.isArray(props?.items) ? props.items : [];
      const rows = items.slice(0, 12).map((it) => {
        const road = it?.road_primary ?? '';
        const c1 = it?.first_cross_street ? ` / ${it.first_cross_street}` : '';
        const c2 = it?.second_cross_street ? ` / ${it.second_cross_street}` : '';
        const when = it?.start_date || it?.end_date ? `${it?.start_date ?? ''} → ${it?.end_date ?? ''}` : '';
        return `
          <div style="margin-bottom:8px;">
            <div style="font-weight:600;font-size:12px;color:#111827;">${it?.closure_type ?? 'Occupancy'}</div>
            <div style="font-size:12px;color:#374151;">${road}${c1}${c2}</div>
            ${when ? `<div style="font-size:11px;color:#6B7280;">${when}</div>` : ''}
          </div>
        `;
      });
      const more = items.length > 12 ? `<div style="font-size:11px;color:#6B7280;">+${items.length - 12} more</div>` : '';
      return `
        <div style="padding:10px;min-width:260px;">
          <div style="font-weight:700;font-size:14px;color:#111827;margin-bottom:8px;">${suburb} — ${total}</div>
          ${rows.join('')}
          ${more}
          <div style="margin-top:10px;color:#9CA3AF;font-size:11px;">Source: Brisbane City Council</div>
        </div>
      `;
    };

    const applyData = (geojson: any) => {
      if (geojson?.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) return;

      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }

      const layer = L.geoJSON(geojson, {
        pane: 'overlayPane',
        style: (feature) => styleFor((feature as any)?.properties ?? {}),
        onEachFeature: (feature, l) => {
          const props = (feature as any)?.properties ?? {};
          l.bindPopup(buildPopupHtml(props), { className: 'ios-popup' });
        },
      });

      layer.addTo(map);
      layerRef.current = layer;
    };

    const fetchAndRender = async () => {
      try {
        const resp = await fetch('/api/road-closures/bcc');
        const json = (await resp.json()) as { geojson?: unknown };
        if (!json?.geojson) return;
        applyData(json.geojson);
      } catch {
        // ignore
      }
    };

    void fetchAndRender();
    intervalRef.current = window.setInterval(() => {
      void fetchAndRender();
    }, 60 * 1000);

    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }
    };
  }, [enabled, map]);

  return null;
}


export default function TransportMap() {
  const [vehicles, setVehicles] = useState<VehiclePosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [showAccessibility, setShowAccessibility] = useState(false);
  const [showPowerOutages, setShowPowerOutages] = useState(false);
  const [showRoadClosuresPanel, setShowRoadClosuresPanel] = useState(false);
  const [showBccRoadClosures, setShowBccRoadClosures] = useState(false);
  const [showQldTrafficClosures, setShowQldTrafficClosures] = useState(false);
  const [stops, setStops] = useState<Stop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [stopsError, setStopsError] = useState<string | null>(null);
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

  const ensureStopsLoaded = useCallback(async () => {
    if (stopsLoading) return;
    if (stops.length > 0) return;
    setStopsLoading(true);
    setStopsError(null);
    try {
      const resp = await fetch('/api/stops');
      const data = await resp.json();
      if (data?.error) throw new Error(data.error);
      const obj = data?.stops as Record<string, Stop> | undefined;
      const arr = obj ? Object.values(obj) : [];
      setStops(arr);
    } catch (e) {
      setStopsError(e instanceof Error ? e.message : 'Failed to load stops');
    } finally {
      setStopsLoading(false);
    }
  }, [stops.length, stopsLoading]);

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
    if (showAccessibility) {
      void ensureStopsLoaded();
    }
  }, [showAccessibility, ensureStopsLoaded]);

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
        <MapUpdater mapRef={mapRef} />
        <AccessibilityHeatmapLayer enabled={showAccessibility && !loadingRoute} stops={stops} />
        <PowerOutageLayer enabled={showPowerOutages} />
        <QldTrafficClosuresLayer enabled={showQldTrafficClosures} />
        <BccRoadOccupanciesLayer enabled={showBccRoadClosures} />
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
                  restoreMapViewAfterRoute();
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

      {showAccessibility && (stopsLoading || stopsError) && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur-xl px-4 py-2 rounded-xl shadow-lg z-[1000] border border-gray-200/50 max-w-sm">
          <div className="flex items-center gap-2">
            {stopsLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                <p className="text-xs font-medium text-gray-800">Loading stops for accessibility map…</p>
              </>
            ) : (
              <>
                <div className="text-red-500 text-sm">!</div>
                <p className="text-xs text-red-700">{stopsError}</p>
              </>
            )}
          </div>
        </div>
      )}

      {showAccessibility && !stopsLoading && !stopsError && stops.length > 0 && (
        <div
          className="absolute left-6 bg-white/90 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 w-[240px]"
          style={{ bottom: showPowerOutages ? 170 : 24 }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-gray-800">Accessibility (nearest stop)</div>
            <div className="text-[11px] text-gray-500">Stops: {stops.length}</div>
          </div>
          <div
            className="h-3 w-full rounded-full"
            style={{
              background:
                'linear-gradient(90deg, rgba(40,200,60,0.9) 0%, rgba(255,220,60,0.9) 50%, rgba(220,40,40,0.9) 100%)',
            }}
          />
          <div className="mt-2 flex justify-between text-[11px] text-gray-600">
            <span>0 m</span>
            <span>2.5 km</span>
            <span>5 km+</span>
          </div>
        </div>
      )}

      {showRoadClosuresPanel && (
        <div
          className="absolute left-6 bg-white/90 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 w-[280px]"
          style={{ bottom: showPowerOutages ? 170 : 24 }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-gray-800">Road closures</div>
            <div className="text-[11px] text-gray-500">Overlays</div>
          </div>
          <div className="space-y-2 text-[11px] text-gray-700">
            <label className="flex items-center justify-between gap-3">
              <span>QLDTraffic (statewide)</span>
              <input
                type="checkbox"
                checked={showQldTrafficClosures}
                onChange={(e) => setShowQldTrafficClosures(e.target.checked)}
              />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span>BCC planned occupancies (by suburb)</span>
              <input
                type="checkbox"
                checked={showBccRoadClosures}
                onChange={(e) => setShowBccRoadClosures(e.target.checked)}
              />
            </label>
          </div>
          <div className="mt-3 pt-2 border-t border-gray-200 space-y-2 text-[11px] text-gray-700">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(255,59,48,0.25)', border: '1px solid rgba(255,59,48,0.7)' }} />
              <span>Full closure</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: 'rgba(255,159,10,0.22)', border: '1px solid rgba(255,159,10,0.7)' }} />
              <span>Partial / lane restrictions</span>
            </div>
          </div>
        </div>
      )}

      {showPowerOutages && (
        <div className="absolute bottom-6 left-6 bg-white/90 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 w-[260px]">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-gray-800">Power outages</div>
            <div className="text-[11px] text-gray-500">Energex</div>
          </div>
          <div className="space-y-2 text-[11px] text-gray-700">
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-sm"
                style={{ backgroundColor: 'rgba(239,68,68,0.35)', border: '1px solid rgba(185,28,28,0.7)' }}
              />
              <span>Unplanned</span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-sm"
                style={{ backgroundColor: 'rgba(245,158,11,0.28)', border: '1px solid rgba(161,98,7,0.7)' }}
              />
              <span>Planned (current)</span>
            </div>
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-sm"
                style={{ backgroundColor: 'rgba(251,191,36,0.22)', border: '1px solid rgba(146,64,14,0.7)' }}
              />
              <span>Planned (future)</span>
            </div>
          </div>
          <div className="mt-3 pt-2 border-t border-gray-200">
            <div className="text-[11px] text-gray-500">
              Data: Energex. Use subject to{' '}
              <a
                className="underline"
                href="https://www.energex.com.au/contact-us/terms-of-use"
                target="_blank"
                rel="noreferrer"
              >
                terms
              </a>
              .
            </div>
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

      <button
        onClick={() => setShowRoadClosuresPanel((v) => !v)}
        className="absolute top-6 right-52 bg-white/90 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 hover:bg-white transition-colors"
        aria-label="Toggle road closures overlays"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 24 24" fill={showRoadClosuresPanel ? '#FF3B30' : 'none'} stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 20h16M6 20V9a2 2 0 012-2h8a2 2 0 012 2v11M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
        </svg>
      </button>

      <button
        onClick={() => setShowAccessibility((v) => !v)}
        className="absolute top-6 right-20 bg-white/90 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 hover:bg-white transition-colors"
        aria-label="Toggle accessibility heatmap"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 24 24" fill={showAccessibility ? '#007AFF' : 'none'} stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4l2-6 4 12 2-6h4" />
        </svg>
      </button>

      <button
        onClick={() => setShowPowerOutages((v) => !v)}
        className="absolute top-6 right-36 bg-white/90 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 hover:bg-white transition-colors"
        aria-label="Toggle power outages"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 24 24" fill={showPowerOutages ? '#F59E0B' : 'none'} stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 2L3 14h7l-1 8 12-14h-7l-1-6z" />
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

