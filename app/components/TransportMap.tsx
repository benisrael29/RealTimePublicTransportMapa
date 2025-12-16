'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { ReactElement } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, Polyline, useMapEvents, CircleMarker, Rectangle } from 'react-leaflet';
import type {
  LatLngLiteral,
  Map as LeafletMap,
  Polyline as LeafletPolyline,
  LeafletEventHandlerFnMap,
  Marker as LeafletMarker,
  LeafletMouseEvent,
} from 'leaflet';
import L from 'leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: (markerIcon2x as unknown as { src?: string }).src ?? (markerIcon2x as unknown as string),
  iconUrl: (markerIcon as unknown as { src?: string }).src ?? (markerIcon as unknown as string),
  shadowUrl: (markerShadow as unknown as { src?: string }).src ?? (markerShadow as unknown as string),
});

type VehicleType = 'bus' | 'train' | 'ferry' | 'unknown';

type OutageType = 'unplanned' | 'planned_current' | 'planned_future';

type HousingMetric = 'rent' | 'mortgage';

type HousingLegend = {
  metric: HousingMetric;
  breaks: number[];
  colors: string[];
} | null;

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

const getQldTrafficClosureColor = (props: any) => {
  const impactSubtype = typeof props?.impact?.impact_subtype === 'string' ? props.impact.impact_subtype : '';
  const impactType = typeof props?.impact?.impact_type === 'string' ? props.impact.impact_type : '';
  const s = impactSubtype.toLowerCase();
  const full = s.includes('closed') && (s.includes('all') || s.includes('to all'));
  if (full) return '#FF3B30';
  if (impactType === 'Closures') return '#FF9F0A';
  return '#8E8E93';
};

const createIosRoadClosurePinIcon = (color: string) => {
  const size = 34;
  const border = 'rgba(255,255,255,0.95)';
  return L.divIcon({
    className: 'ios-closure-pin',
    html: `
      <svg width="${size}" height="${size}" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <filter id="iosShadow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="2.2" />
            <feOffset dx="0" dy="2" result="off" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="0.28" />
            </feComponentTransfer>
            <feMerge>
              <feMergeNode />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="iosGloss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="rgba(255,255,255,0.75)" />
            <stop offset="0.55" stop-color="rgba(255,255,255,0.15)" />
            <stop offset="1" stop-color="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>
        <g filter="url(#iosShadow)">
          <circle cx="17" cy="17" r="12.5" fill="${color}" stroke="${border}" stroke-width="2.5" />
          <circle cx="17" cy="17" r="12.5" fill="url(#iosGloss)" />
          <path d="M17 8.7c-4.6 0-8.3 3.7-8.3 8.3s3.7 8.3 8.3 8.3 8.3-3.7 8.3-8.3-3.7-8.3-8.3-8.3Zm0 4.3c.7 0 1.2.5 1.2 1.2v4.7c0 .7-.5 1.2-1.2 1.2s-1.2-.5-1.2-1.2v-4.7c0-.7.5-1.2 1.2-1.2Zm0 9.6a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7Z" fill="white" opacity="0.98"/>
        </g>
      </svg>
    `,
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

function MapClickHandler({ onMapClick }: { onMapClick: (latlng: LatLngLiteral) => void }) {
  useMapEvents({
    click: (e: LeafletMouseEvent) => onMapClick(e.latlng),
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

  countWithinRadiusMeters(lat: number, lon: number, radiusMeters: number): number {
    if (this.bins.size === 0) return 0;
    const { x, y } = mercatorProjectMeters(lat, lon);
    const ix0 = Math.floor(x / this.binSizeMeters);
    const iy0 = Math.floor(y / this.binSizeMeters);
    const rBins = Math.max(0, Math.ceil(radiusMeters / this.binSizeMeters));
    const r2 = radiusMeters * radiusMeters;

    let count = 0;
    for (let dx = -rBins; dx <= rBins; dx++) {
      for (let dy = -rBins; dy <= rBins; dy++) {
        const key = `${ix0 + dx},${iy0 + dy}`;
        const bucket = this.bins.get(key);
        if (!bucket) continue;
        for (const pt of bucket) {
          const ddx = pt.x - x;
          const ddy = pt.y - y;
          const sq = ddx * ddx + ddy * ddy;
          if (sq <= r2) count++;
        }
      }
    }
    return count;
  }

  nearestK(lat: number, lon: number, k: number): Array<{ id: string; meters: number }> {
    if (this.bins.size === 0) return [];
    const { x, y } = mercatorProjectMeters(lat, lon);
    const ix0 = Math.floor(x / this.binSizeMeters);
    const iy0 = Math.floor(y / this.binSizeMeters);

    const kk = Math.max(1, Math.min(32, Math.floor(k)));
    const best: Array<{ id: string; sq: number }> = [];
    let bestMaxSq = Number.POSITIVE_INFINITY;

    for (let r = 0; r <= 48; r++) {
      const minPossible = Math.max(0, r * this.binSizeMeters);
      if (best.length >= kk && minPossible * minPossible > bestMaxSq) break;

      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const key = `${ix0 + dx},${iy0 + dy}`;
          const bucket = this.bins.get(key);
          if (!bucket) continue;
          for (const pt of bucket) {
            const ddx = pt.x - x;
            const ddy = pt.y - y;
            const sq = ddx * ddx + ddy * ddy;
            if (best.length < kk) {
              best.push({ id: pt.id, sq });
              if (best.length === kk) {
                bestMaxSq = best.reduce((m, v) => (v.sq > m ? v.sq : m), 0);
              }
            } else if (sq < bestMaxSq) {
              let worstIdx = 0;
              let worstSq = best[0].sq;
              for (let i = 1; i < best.length; i++) {
                if (best[i].sq > worstSq) {
                  worstSq = best[i].sq;
                  worstIdx = i;
                }
              }
              best[worstIdx] = { id: pt.id, sq };
              bestMaxSq = best.reduce((m, v) => (v.sq > m ? v.sq : m), 0);
            }
          }
        }
      }
    }

    if (best.length === 0) return [];
    best.sort((a, b) => a.sq - b.sq);
    return best.map((b) => ({ id: b.id, meters: Math.sqrt(b.sq) }));
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
  userLocation,
}: {
  enabled: boolean;
  stops: Stop[];
  userLocation: LatLngLiteral | null;
}) {
  const index = useMemo(() => {
    if (!enabled || stops.length === 0) return null;
    return new StopSpatialIndex(stops, 900);
  }, [enabled, stops]);

  const cells = useMemo(() => {
    if (!enabled || !index || !userLocation) return null;

    const radiusMeters = 3000;
    const gridSize = 42;
    const maxMeters = radiusMeters;

    const lat = userLocation.lat;
    const lng = userLocation.lng;
    const latDelta = radiusMeters / 111_320;
    const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const lngDelta = radiusMeters / (111_320 * cosLat);

    const latMin = lat - latDelta;
    const latMax = lat + latDelta;
    const lngMin = lng - lngDelta;
    const lngMax = lng + lngDelta;

    const latStep = (latMax - latMin) / gridSize;
    const lngStep = (lngMax - lngMin) / gridSize;

    const out: ReactElement[] = [];
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const cLat = latMin + (i + 0.5) * latStep;
        const cLng = lngMin + (j + 0.5) * lngStep;

        const d0 = index.nearestDistanceMeters(cLat, cLng);
        const d = d0 === null ? maxMeters : Math.min(d0, maxMeters);
        const { r, g, b } = heatColorForDistance(d, maxMeters);

        const swLat = latMin + i * latStep;
        const swLng = lngMin + j * lngStep;
        const neLat = latMin + (i + 1) * latStep;
        const neLng = lngMin + (j + 1) * lngStep;

        out.push(
          <Rectangle
            key={`access-local-${i}-${j}`}
            bounds={[[swLat, swLng], [neLat, neLng]]}
            pathOptions={{
              fillColor: `rgb(${r},${g},${b})`,
              fillOpacity: 0.28,
              stroke: false,
              interactive: false,
            }}
          />
        );
      }
    }
    return out;
  }, [enabled, index, userLocation?.lat, userLocation?.lng]);

  return cells ? <>{cells}</> : null;
}

function AccessibilityUserLocationLayer({
  enabled,
  userLocation,
}: {
  enabled: boolean;
  userLocation: LatLngLiteral | null;
}) {
  if (!enabled || !userLocation) return null;
  return (
    <CircleMarker
      center={userLocation}
      radius={7}
      pathOptions={{ color: '#2563EB', fillColor: '#3B82F6', fillOpacity: 0.65, weight: 2 }}
    />
  );
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
      const s = impactSubtype.toLowerCase();
      const full = s.includes('closed') && (s.includes('all') || s.includes('to all'));
      const color = getQldTrafficClosureColor(props);
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
        pointToLayer: (feature, latlng) => {
          const props = (feature as any)?.properties ?? {};
          const color = getQldTrafficClosureColor(props);
          const icon = createIosRoadClosurePinIcon(color);
          return L.marker(latlng, { icon });
        },
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

function HousingChoroplethLayer({
  enabled,
  metric,
  onLegend,
}: {
  enabled: boolean;
  metric: HousingMetric;
  onLegend: (legend: HousingLegend) => void;
}) {
  const map = useMap();
  const layerRef = useRef<L.GeoJSON | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }
      onLegend(null);
      return;
    }

    let cancelled = false;

    const pickVal = (props: Record<string, unknown> | undefined | null) => {
      const k = metric === 'rent' ? 'median_weekly_rent' : 'median_monthly_mortgage';
      const v = props?.[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };

    const computeLegend = (
      features: Array<{ properties?: Record<string, unknown> | null }>
    ): { metric: HousingMetric; breaks: number[]; colors: string[] } => {
      const values = features
        .map((f) => pickVal(f.properties))
        .filter((v): v is number => v !== null)
        .sort((a, b) => a - b);

      if (values.length === 0) {
        return { metric, breaks: [], colors: [] };
      }

      const quantile = (p: number) => {
        const n = values.length;
        if (n === 1) return values[0];
        const idx = (n - 1) * p;
        const lo = Math.floor(idx);
        const hi = Math.ceil(idx);
        if (lo === hi) return values[lo];
        const t = idx - lo;
        return values[lo] * (1 - t) + values[hi] * t;
      };

      const breaks = [quantile(0.2), quantile(0.4), quantile(0.6), quantile(0.8), quantile(1)];
      const colors = ['#E0F2FE', '#BAE6FD', '#7DD3FC', '#38BDF8', '#0284C7', '#075985'];

      return { metric, breaks, colors };
    };

    const getFillColor = (v: number | null, legend: { breaks: number[]; colors: string[] }) => {
      if (v === null) return '#E5E7EB';
      const [b1, b2, b3, b4, b5] = legend.breaks;
      if (v <= b1) return legend.colors[0];
      if (v <= b2) return legend.colors[1];
      if (v <= b3) return legend.colors[2];
      if (v <= b4) return legend.colors[3];
      if (v <= b5) return legend.colors[4];
      return legend.colors[5];
    };

    const money = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) ? `$${v.toLocaleString('en-AU')}` : '—';

    const fetchAndRender = async () => {
      try {
        const resp = await fetch('/api/housing');
        const geojson = (await resp.json()) as { type?: string; features?: any[] };
        const features = Array.isArray(geojson?.features) ? geojson.features : [];

        const legend = computeLegend(features);
        if (!cancelled) onLegend(legend);

        if (layerRef.current) {
          layerRef.current.removeFrom(map);
          layerRef.current = null;
        }

        const layer = L.geoJSON(geojson as any, {
          pane: 'overlayPane',
          style: (feature) => {
            const props = (feature as any)?.properties as Record<string, unknown> | undefined;
            const v = pickVal(props);
            return {
              color: '#111827',
              weight: 1,
              opacity: 0.35,
              fillColor: getFillColor(v, legend),
              fillOpacity: 0.45,
            } as L.PathOptions;
          },
          onEachFeature: (feature, l) => {
            const props = (feature as any)?.properties as Record<string, unknown> | undefined;
            const suburb = typeof props?.suburb === 'string' ? props.suburb : 'Suburb';
            const rent = money(props?.median_weekly_rent);
            const mortgage = money(props?.median_monthly_mortgage);
            const activeKey = metric === 'rent' ? 'rent' : 'mortgage';

            const html = `
              <div style="padding:10px;min-width:240px;">
                <div style="font-weight:700;font-size:14px;color:#111827;margin-bottom:8px;">${suburb}</div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                  <div style="display:flex;justify-content:space-between;gap:12px;">
                    <div style="color:#6B7280;font-size:12px;">Median weekly rent</div>
                    <div style="color:#111827;font-size:12px;font-weight:${activeKey === 'rent' ? 700 : 600};">${rent}</div>
                  </div>
                  <div style="display:flex;justify-content:space-between;gap:12px;">
                    <div style="color:#6B7280;font-size:12px;">Median monthly mortgage</div>
                    <div style="color:#111827;font-size:12px;font-weight:${activeKey === 'mortgage' ? 700 : 600};">${mortgage}</div>
                  </div>
                </div>
                <div style="margin-top:10px;color:#9CA3AF;font-size:11px;">Source: ABS Census 2021 (QuickStats)</div>
              </div>
            `;

            l.bindPopup(html, { className: 'ios-popup' });

            l.on('mouseover', () => {
              (l as any).setStyle?.({ weight: 2, opacity: 0.7 });
            });
            l.on('mouseout', () => {
              (l as any).setStyle?.({ weight: 1, opacity: 0.35 });
            });
          },
        });

        layer.addTo(map);
        layerRef.current = layer;
      } catch {
        if (!cancelled) onLegend(null);
      }
    };

    void fetchAndRender();

    return () => {
      cancelled = true;
      if (layerRef.current) {
        layerRef.current.removeFrom(map);
        layerRef.current = null;
      }
    };
  }, [enabled, map, metric, onLegend]);

  return null;
}


export default function TransportMap() {
  const [vehicles, setVehicles] = useState<VehiclePosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showLiveTransit, setShowLiveTransit] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const [showLayersMenu, setShowLayersMenu] = useState(false);
  const [showAccessibility, setShowAccessibility] = useState(false);
  const [accessUserLocation, setAccessUserLocation] = useState<LatLngLiteral | null>(null);
  const [accessLocating, setAccessLocating] = useState(false);
  const [accessLocationError, setAccessLocationError] = useState<string | null>(null);
  const [accessNearestStopMeters, setAccessNearestStopMeters] = useState<number | null>(null);
  const [accessStopsWithin, setAccessStopsWithin] = useState<{ m500: number; m1000: number; m2000: number } | null>(
    null
  );
  const [showPowerOutages, setShowPowerOutages] = useState(false);
  const [showBccRoadClosures, setShowBccRoadClosures] = useState(false);
  const [showQldTrafficClosures, setShowQldTrafficClosures] = useState(false);
  const [showWeatherClouds, setShowWeatherClouds] = useState(false);
  const [showWeatherPrecip, setShowWeatherPrecip] = useState(false);
  const [showWeatherWind, setShowWeatherWind] = useState(false);
  const [showWeatherTemp, setShowWeatherTemp] = useState(false);
  const [showHousingOverlay, setShowHousingOverlay] = useState(false);
  const [housingMetric, setHousingMetric] = useState<HousingMetric>('rent');
  const [housingLegend, setHousingLegend] = useState<HousingLegend>(null);
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

  const stopIndexForAccessibility = useMemo(() => {
    if (stops.length === 0) return null;
    return new StopSpatialIndex(stops, 900);
  }, [stops]);

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

  const clearLiveTransitSelection = useCallback(() => {
    routeRequestIdRef.current += 1;
    restoreMapViewAfterRoute();
    setSelectedVehicleId(null);
    setDisplayedRoute(null);
    setRouteError(null);
    setRouteStops([]);
    setRouteStopsRouteId(null);
    setLoadingRoute(false);
  }, [restoreMapViewAfterRoute]);

  const layersMenuRef = useRef<HTMLDivElement | null>(null);
  const [expandRoadClosures, setExpandRoadClosures] = useState(false);
  const [expandHousing, setExpandHousing] = useState(false);

  useEffect(() => {
    if (!showLayersMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowLayersMenu(false);
    };
    const onPointerDown = (e: MouseEvent | PointerEvent) => {
      const el = layersMenuRef.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) setShowLayersMenu(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [showLayersMenu]);

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

  const handleMapClick = (latlng: LatLngLiteral) => {
    routeRequestIdRef.current += 1;
    restoreMapViewAfterRoute();
    setDisplayedRoute(null);
    setRouteError(null);
    setSelectedVehicleId(null);
    setRouteStops([]);
    setRouteStopsRouteId(null);
    setLoadingRoute(false);

    void latlng;
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
    if (!showAccessibility) {
      setAccessUserLocation(null);
      setAccessLocationError(null);
      setAccessLocating(false);
      setAccessNearestStopMeters(null);
      setAccessStopsWithin(null);
      return;
    }

    if (accessUserLocation || accessLocating || accessLocationError) return;
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setAccessLocationError('Geolocation not available');
      return;
    }

    setAccessLocating(true);
    setAccessLocationError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setAccessUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setAccessLocating(false);
      },
      (err) => {
        setAccessLocationError(err?.message || 'Location permission denied');
        setAccessLocating(false);
      },
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 8_000 }
    );
  }, [showAccessibility, accessUserLocation, accessLocating, accessLocationError]);

  useEffect(() => {
    if (!showAccessibility) return;
    if (!accessUserLocation) return;
    if (!stopIndexForAccessibility) return;

    const d = stopIndexForAccessibility.nearestDistanceMeters(accessUserLocation.lat, accessUserLocation.lng);
    setAccessNearestStopMeters(d);
    setAccessStopsWithin({
      m500: stopIndexForAccessibility.countWithinRadiusMeters(accessUserLocation.lat, accessUserLocation.lng, 500),
      m1000: stopIndexForAccessibility.countWithinRadiusMeters(accessUserLocation.lat, accessUserLocation.lng, 1000),
      m2000: stopIndexForAccessibility.countWithinRadiusMeters(accessUserLocation.lat, accessUserLocation.lng, 2000),
    });
  }, [showAccessibility, accessUserLocation, stopIndexForAccessibility]);


  useEffect(() => {
    if (!showLiveTransit) return;
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
  }, [vehicles, prefetchRouteData, showLiveTransit]);

  const gibsDate = useMemo(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }, []);

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
        {showWeatherClouds && (
          <TileLayer
            attribution='&copy; <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>'
            url={`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${gibsDate}/GoogleMapsCompatible/{z}/{y}/{x}.jpg`}
            opacity={0.55}
            maxZoom={11}
          />
        )}
        {showWeatherPrecip && (
          <TileLayer
            attribution='&copy; <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>'
            url={`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate/default/${gibsDate}/GoogleMapsCompatible/{z}/{y}/{x}.png`}
            opacity={0.6}
            maxZoom={11}
          />
        )}
        <MapUpdater mapRef={mapRef} />
        <AccessibilityHeatmapLayer enabled={showAccessibility && !!accessUserLocation} stops={stops} userLocation={accessUserLocation} />
        <AccessibilityUserLocationLayer enabled={showAccessibility} userLocation={accessUserLocation} />
        <PowerOutageLayer enabled={showPowerOutages} />
        <QldTrafficClosuresLayer enabled={showQldTrafficClosures} />
        <BccRoadOccupanciesLayer enabled={showBccRoadClosures} />
        <HousingChoroplethLayer enabled={showHousingOverlay} metric={housingMetric} onLegend={setHousingLegend} />
        {showLiveTransit &&
          displayedRoute &&
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
        {showLiveTransit && vehicles.map((vehicle) => {
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
                  clearLiveTransitSelection();
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
      
      {showLiveTransit && loading && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur-xl px-6 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50">
          <div className="flex items-center gap-3">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-sm font-medium text-gray-800">Loading vehicles...</p>
          </div>
        </div>
      )}
      
      {showLiveTransit && error && (
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

      {showLiveTransit && loadingRoute && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur-xl px-4 py-2 rounded-xl shadow-lg z-[1000] border border-gray-200/50">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-xs font-medium text-gray-800">Loading route...</p>
          </div>
        </div>
      )}

      {showLiveTransit && routeError && (
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
            <div className="text-xs font-semibold text-gray-800">Accessibility (your location)</div>
            <div className="text-[11px] text-gray-500">Stops: {stops.length}</div>
          </div>
          <div className="space-y-1 text-[11px] text-gray-700">
            {accessLocating ? (
              <div className="text-gray-600">Locating…</div>
            ) : accessLocationError ? (
              <div className="text-red-700">{accessLocationError}</div>
            ) : accessUserLocation ? (
              <>
                <div className="text-gray-500">Overlay: nearest-stop distance within ~3 km of you</div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-gray-500">Nearest stop</span>
                  <span className="font-semibold text-gray-800">
                    {accessNearestStopMeters === null ? '—' : `${Math.round(accessNearestStopMeters)} m`}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-gray-500">Stops ≤ 500 m</span>
                  <span className="font-semibold text-gray-800">{accessStopsWithin?.m500 ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-gray-500">Stops ≤ 1 km</span>
                  <span className="font-semibold text-gray-800">{accessStopsWithin?.m1000 ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-gray-500">Stops ≤ 2 km</span>
                  <span className="font-semibold text-gray-800">{accessStopsWithin?.m2000 ?? '—'}</span>
                </div>
              </>
            ) : (
              <div className="text-gray-600">Enable location permissions to compute accessibility.</div>
            )}
          </div>
        </div>
      )}

      {(showQldTrafficClosures || showBccRoadClosures) && (
        <div
          className="absolute left-6 bg-white/90 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 w-[280px]"
          style={{ bottom: showPowerOutages ? 170 : 24 }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-gray-800">Road closures</div>
            <div className="text-[11px] text-gray-500">
              {(showQldTrafficClosures ? 1 : 0) + (showBccRoadClosures ? 1 : 0)} enabled
            </div>
          </div>
          <div className="space-y-2 text-[11px] text-gray-700">
            {showQldTrafficClosures && <div>QLDTraffic: closures/roadworks/events (statewide)</div>}
            {showBccRoadClosures && <div>BCC: planned road occupancies (aggregated by suburb)</div>}
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

      {showHousingOverlay && (
        <div
          className="absolute left-6 bg-white/90 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 w-[300px]"
          style={{ bottom: showPowerOutages ? 170 : 24 }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold text-gray-800">Housing (ABS 2021)</div>
            <div className="text-[11px] text-gray-500">{housingMetric === 'rent' ? 'Rent' : 'Mortgage'}</div>
          </div>

          <div className="space-y-2 text-[11px] text-gray-700">
            <label className="flex items-center justify-between gap-3">
              <span>Median weekly rent</span>
              <input
                type="radio"
                name="housingMetric"
                checked={housingMetric === 'rent'}
                onChange={() => setHousingMetric('rent')}
              />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span>Median monthly mortgage</span>
              <input
                type="radio"
                name="housingMetric"
                checked={housingMetric === 'mortgage'}
                onChange={() => setHousingMetric('mortgage')}
              />
            </label>
          </div>

          <div className="mt-3 pt-2 border-t border-gray-200">
            <div className="text-[11px] text-gray-600 mb-2">Legend</div>
            {housingLegend?.breaks?.length ? (
              <div className="space-y-1 text-[11px] text-gray-700">
                {(() => {
                  const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-AU')}`;
                  const bs = housingLegend.breaks;
                  const cs = housingLegend.colors;
                  const ranges: Array<{ color: string; label: string }> = [
                    { color: cs[0], label: `≤ ${fmt(bs[0])}` },
                    { color: cs[1], label: `≤ ${fmt(bs[1])}` },
                    { color: cs[2], label: `≤ ${fmt(bs[2])}` },
                    { color: cs[3], label: `≤ ${fmt(bs[3])}` },
                    { color: cs[4], label: `≤ ${fmt(bs[4])}` },
                    { color: cs[5], label: `> ${fmt(bs[4])}` },
                  ];
                  return ranges.map((r, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-sm"
                        style={{ backgroundColor: r.color, border: '1px solid rgba(17,24,39,0.25)' }}
                      />
                      <span>{r.label}</span>
                    </div>
                  ));
                })()}
                <div className="flex items-center gap-2 pt-1">
                  <div
                    className="w-3 h-3 rounded-sm"
                    style={{ backgroundColor: '#E5E7EB', border: '1px solid rgba(17,24,39,0.15)' }}
                  />
                  <span>No data</span>
                </div>
              </div>
            ) : (
              <div className="text-[11px] text-gray-500">Loading…</div>
            )}
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
      
      <div ref={layersMenuRef} className="absolute top-6 right-20 z-[1000]">
        <button
          onClick={() => setShowLayersMenu((v) => !v)}
          className="bg-white/90 backdrop-blur-xl px-4 py-3 rounded-2xl shadow-2xl border border-gray-200/50 hover:bg-white transition-colors flex items-center gap-2"
          aria-label="Layers"
          aria-expanded={showLayersMenu}
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3l9 5-9 5-9-5 9-5z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9 5 9-5" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 17l9 5 9-5" />
          </svg>
          <span className="text-sm font-semibold text-gray-800">Layers</span>
        </button>

        {showLayersMenu && (
          <div className="mt-3 w-[320px] bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-gray-200/50 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200/60 flex items-center justify-between">
              <div className="text-sm font-semibold text-gray-800">Map layers</div>
              <button
                onClick={() => setShowLayersMenu(false)}
                className="text-gray-500 hover:text-gray-700 transition-colors"
                aria-label="Close layers menu"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-4 py-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="toggle-live-transit" className="min-w-0 cursor-pointer">
                  <div className="text-sm font-semibold text-gray-800">Live transit</div>
                  <div className="text-[12px] text-gray-500">
                    TransLink GTFS-RT live vehicles (SEQ) + click a vehicle for route shape & stops (updates ~5s)
                  </div>
                </label>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowInfo(true);
                    }}
                    className="text-gray-500 hover:text-gray-700 transition-colors"
                    aria-label="Live transit information"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </button>
                  <input
                    id="toggle-live-transit"
                    type="checkbox"
                    checked={showLiveTransit}
                    onChange={(e) => {
                      const next = e.target.checked;
                      if (!next) clearLiveTransitSelection();
                      setShowLiveTransit(next);
                    }}
                    aria-label="Toggle live public transport"
                  />
                </div>
              </div>

              <label className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-800">Accessibility</div>
                  <div className="text-[12px] text-gray-500">Schedule-based travel time heatmap (GTFS) — not live</div>
                </div>
                <input
                  type="checkbox"
                  checked={showAccessibility}
                  onChange={(e) => setShowAccessibility(e.target.checked)}
                  aria-label="Toggle accessibility heatmap"
                />
              </label>

              <label className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-800">Power outages</div>
                  <div className="text-[12px] text-gray-500">Energex outage areas (planned + unplanned, refresh ~5 min)</div>
                </div>
                <input
                  type="checkbox"
                  checked={showPowerOutages}
                  onChange={(e) => setShowPowerOutages(e.target.checked)}
                  aria-label="Toggle power outages"
                />
              </label>

              <div className="pt-2 border-t border-gray-200/60">
                <div className="text-sm font-semibold text-gray-800 mb-2">Weather</div>
                <div className="space-y-2">
                  <label className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[12px] font-semibold text-gray-800">Clouds</div>
                      <div className="text-[11px] text-gray-500">Satellite tiles (low zoom)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={showWeatherClouds}
                      onChange={(e) => setShowWeatherClouds(e.target.checked)}
                      aria-label="Toggle weather clouds"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[12px] font-semibold text-gray-800">Precip</div>
                      <div className="text-[11px] text-gray-500">Precip tiles + local gauges</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={showWeatherPrecip}
                      onChange={(e) => setShowWeatherPrecip(e.target.checked)}
                      aria-label="Toggle weather precipitation"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[12px] font-semibold text-gray-800">Wind</div>
                      <div className="text-[11px] text-gray-500">Vectors (high zoom)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={showWeatherWind}
                      onChange={(e) => setShowWeatherWind(e.target.checked)}
                      aria-label="Toggle weather wind"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[12px] font-semibold text-gray-800">Temperature</div>
                      <div className="text-[11px] text-gray-500">Isotherms (high zoom)</div>
                    </div>
                    <input
                      type="checkbox"
                      checked={showWeatherTemp}
                      onChange={(e) => setShowWeatherTemp(e.target.checked)}
                      aria-label="Toggle weather temperature"
                    />
                  </label>
                </div>
              </div>

              <div className="pt-2 border-t border-gray-200/60">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-800">Housing</div>
                    <div className="text-[12px] text-gray-500">ABS Census 2021 (median rent + mortgage)</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpandHousing((v) => !v)}
                    className="text-[12px] font-semibold text-gray-700 hover:text-gray-900 transition-colors"
                    aria-label="Toggle housing options"
                    aria-expanded={expandHousing}
                  >
                    {expandHousing ? 'Hide' : 'Show'}
                  </button>
                </div>

                {expandHousing && (
                  <div className="mt-3 space-y-3 text-[12px] text-gray-700">
                    <label className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[12px] font-semibold text-gray-800">Enable overlay</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={showHousingOverlay}
                        onChange={(e) => setShowHousingOverlay(e.target.checked)}
                        aria-label="Toggle housing overlay"
                      />
                    </label>

                    <div className="space-y-2">
                      <label className="flex items-center justify-between gap-3">
                        <span>Median weekly rent</span>
                        <input
                          type="radio"
                          name="housingMetric"
                          checked={housingMetric === 'rent'}
                          onChange={() => setHousingMetric('rent')}
                          aria-label="Housing metric rent"
                        />
                      </label>
                      <label className="flex items-center justify-between gap-3">
                        <span>Median monthly mortgage</span>
                        <input
                          type="radio"
                          name="housingMetric"
                          checked={housingMetric === 'mortgage'}
                          onChange={() => setHousingMetric('mortgage')}
                          aria-label="Housing metric mortgage"
                        />
                      </label>
                    </div>

                    {showHousingOverlay && housingLegend?.breaks?.length ? (
                      <div className="pt-2 border-t border-gray-200/60 space-y-1">
                        <div className="text-[12px] font-semibold text-gray-800">Legend</div>
                        {(() => {
                          const fmt = (n: number) => `$${Math.round(n).toLocaleString('en-AU')}`;
                          const bs = housingLegend.breaks;
                          const cs = housingLegend.colors;
                          const ranges: Array<{ color: string; label: string }> = [
                            { color: cs[0], label: `≤ ${fmt(bs[0])}` },
                            { color: cs[1], label: `≤ ${fmt(bs[1])}` },
                            { color: cs[2], label: `≤ ${fmt(bs[2])}` },
                            { color: cs[3], label: `≤ ${fmt(bs[3])}` },
                            { color: cs[4], label: `≤ ${fmt(bs[4])}` },
                            { color: cs[5], label: `> ${fmt(bs[4])}` },
                          ];
                          return (
                            <div className="space-y-1 text-[12px] text-gray-700">
                              {ranges.map((r, i) => (
                                <div key={i} className="flex items-center gap-2">
                                  <div
                                    className="w-3 h-3 rounded-sm"
                                    style={{ backgroundColor: r.color, border: '1px solid rgba(17,24,39,0.25)' }}
                                  />
                                  <span>{r.label}</span>
                                </div>
                              ))}
                              <div className="flex items-center gap-2 pt-1">
                                <div
                                  className="w-3 h-3 rounded-sm"
                                  style={{ backgroundColor: '#E5E7EB', border: '1px solid rgba(17,24,39,0.15)' }}
                                />
                                <span>No data</span>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    ) : showHousingOverlay ? (
                      <div className="pt-2 border-t border-gray-200/60 text-[12px] text-gray-500">Legend loading…</div>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-gray-200/60">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-800">Road closures</div>
                    <div className="text-[12px] text-gray-500">QLDTraffic events + BCC planned road occupancies (refresh ~60s)</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpandRoadClosures((v) => !v)}
                    className="text-[12px] font-semibold text-gray-700 hover:text-gray-900 transition-colors"
                    aria-label="Toggle road closures options"
                    aria-expanded={expandRoadClosures}
                  >
                    {expandRoadClosures ? 'Hide' : 'Show'}
                  </button>
                </div>

                {expandRoadClosures && (
                  <div className="mt-3 space-y-2 text-[12px] text-gray-700">
                    <label className="flex items-center justify-between gap-3">
                      <span>QLDTraffic (closures/roadworks/events)</span>
                      <input
                        type="checkbox"
                        checked={showQldTrafficClosures}
                        onChange={(e) => setShowQldTrafficClosures(e.target.checked)}
                        aria-label="Toggle QLDTraffic closures"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span>BCC planned occupancies (by suburb)</span>
                      <input
                        type="checkbox"
                        checked={showBccRoadClosures}
                        onChange={(e) => setShowBccRoadClosures(e.target.checked)}
                        aria-label="Toggle BCC planned occupancies"
                      />
                    </label>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {showInfo && (
        <div className="absolute top-20 right-20 bg-white/95 backdrop-blur-xl px-6 py-5 rounded-2xl shadow-2xl z-[1000] border border-gray-200/50 max-w-sm">
          <div className="flex items-start justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-800">Live transit info</h3>
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
              <p className="font-semibold mb-1">TransLink GTFS-RT (SEQ)</p>
              <p className="text-gray-600">
                Shows live vehicle positions for buses, trains, and ferries in the SEQ region from TransLink&apos;s GTFS-realtime feed.
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
                Positions refresh about every 5 seconds. Click a vehicle marker to load its route shape and stops.
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

