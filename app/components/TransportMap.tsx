'use client';

import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
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

const VEHICLE_COLORS = {
  bus: '#007AFF',
  train: '#34C759',
  ferry: '#AF52DE',
  unknown: '#8E8E93',
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
  
  // Train: 2-3 letter codes at start (e.g., FG, BG, CL, IP)
  // Check multiple patterns - train routes can have various formats
  // Examples: FG, BG-123, CL_456, IP-789, etc.
  const trainPatterns = [
    /^(FG|BG|CL|IP|RB|SH|EX|GY|DO|CA|NA|RO|SP|VL|BE|KI|SPR|AIR|VLO|NGR|BRI|CAB|CLE|GOL|GYM|IPS|NOR|RED|SHO|SUN|WIL|CR|AR|GC|SC|TS|BN)$/i, // Exact match
    /^(FG|BG|CL|IP|RB|SH|EX|GY|DO|CA|NA|RO|SP|VL|BE|KI|SPR|AIR|VLO|NGR|BRI|CAB|CLE|GOL|GYM|IPS|NOR|RED|SHO|SUN|WIL|CR|AR|GC|SC|TS|BN)[-_]/i, // With dash/underscore
    /^(FG|BG|CL|IP|RB|SH|EX|GY|DO|CA|NA|RO|SP|VL|BE|KI|SPR|AIR|VLO|NGR|BRI|CAB|CLE|GOL|GYM|IPS|NOR|RED|SHO|SUN|WIL|CR|AR|GC|SC|TS|BN)\d/i, // With numbers
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

const createVehicleIcon = (color: string = '#007AFF', type: VehicleType = 'unknown') => {
  const size = type === 'ferry' ? 14 : type === 'train' ? 16 : 12;
  return L.divIcon({
    className: 'vehicle-marker',
    html: `
      <div style="
        width: ${size}px;
        height: ${size}px;
        background: ${color};
        border: 2px solid white;
        border-radius: 50%;
        box-shadow: 0 1px 4px rgba(0,0,0,0.25);
        transform: translate(-50%, -50%);
        transition: all 0.3s ease;
      "></div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

function MapUpdater({ vehicles, isInitialLoad }: { vehicles: VehiclePosition[]; isInitialLoad: boolean }) {
  const map = useMap();
  
  useEffect(() => {
    if (vehicles.length > 0 && isInitialLoad) {
      const bounds = L.latLngBounds(
        vehicles.map(v => [v.latitude, v.longitude] as [number, number])
      );
      map.fitBounds(bounds, { 
        padding: [80, 80],
        maxZoom: 15
      });
    }
  }, [vehicles, map, isInitialLoad]);

  return null;
}

export default function TransportMap() {
  const [vehicles, setVehicles] = useState<VehiclePosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [showInfo, setShowInfo] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchVehicles = async () => {
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
          
          // Debug logging for speed (sample first few vehicles)
          if (process.env.NODE_ENV === 'development' && Math.random() < 0.05) {
            console.log('Vehicle speed debug:', {
              id: vehicle.id,
              speed: vehicle.speed,
              speedType: typeof vehicle.speed,
              routeId: vehicle.routeId,
            });
          }
          
          // Debug logging for trains (remove in production)
          if (type === 'train' && process.env.NODE_ENV === 'development') {
            console.log('Train detected:', {
              routeId: vehicle.routeId,
              routeType: vehicle.routeType,
              tripId: vehicle.tripId,
            });
          }
          
          return {
            ...vehicle,
            vehicleType: type,
          };
        });
      setVehicles(vehiclesWithType);
      setError(null);
      setLoading(false);
      if (isInitialLoad) {
        setTimeout(() => setIsInitialLoad(false), 1000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
      if (isInitialLoad) {
        setTimeout(() => setIsInitialLoad(false), 1000);
      }
    }
  };

  useEffect(() => {
    fetchVehicles();

    intervalRef.current = setInterval(() => {
      fetchVehicles();
    }, 30000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  return (
    <div className="w-full h-screen relative overflow-hidden">
      <MapContainer
        center={[-27.4698, 153.0251]}
        zoom={13}
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom={true}
        zoomControl={true}
        className="ios-map"
      >
        <TileLayer
          attribution='&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
        />
        <MapUpdater vehicles={vehicles} isInitialLoad={isInitialLoad} />
        {vehicles.map((vehicle) => {
          const vehicleType = vehicle.vehicleType || 
            (vehicle.routeType !== undefined 
              ? getVehicleTypeFromRouteType(vehicle.routeType)
              : getVehicleTypeFallback(vehicle.routeId, vehicle.tripId, vehicle.id)) || 
            'bus';
          const color = getVehicleColor(vehicleType);
          const typeLabel = vehicleType.charAt(0).toUpperCase() + vehicleType.slice(1);
          
          // Create a unique icon instance for each marker to ensure colors are applied
          const markerIcon = createVehicleIcon(color, vehicleType);
          
          return (
            <Marker
              key={`${vehicle.id}-${vehicleType}-${color}`}
              position={[vehicle.latitude, vehicle.longitude]}
              icon={markerIcon}
            >
              <Popup className="ios-popup">
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
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500">Status</span>
                      <span className="text-sm font-medium text-gray-800">
                        {vehicle.speed === undefined || vehicle.speed === null
                          ? '📍 No speed data'
                          : vehicle.speed === 0 || vehicle.speed < 0.05
                          ? '🛑 Stopped' 
                          : `🚗 ${(vehicle.speed * 3.6).toFixed(0)} km/h`}
                      </span>
                    </div>
                    {vehicle.bearing !== undefined && vehicle.bearing > 0 && vehicle.speed !== undefined && vehicle.speed > 0.05 && (
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">Direction</span>
                        <span className="text-sm font-medium text-gray-800">
                          {(() => {
                            const dir = vehicle.bearing!;
                            if (dir >= 337.5 || dir < 22.5) return '⬆️ North';
                            if (dir >= 22.5 && dir < 67.5) return '↗️ Northeast';
                            if (dir >= 67.5 && dir < 112.5) return '➡️ East';
                            if (dir >= 112.5 && dir < 157.5) return '↘️ Southeast';
                            if (dir >= 157.5 && dir < 202.5) return '⬇️ South';
                            if (dir >= 202.5 && dir < 247.5) return '↙️ Southwest';
                            if (dir >= 247.5 && dir < 292.5) return '⬅️ West';
                            return '↖️ Northwest';
                          })()}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </Popup>
            </Marker>
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
            <div className="text-red-500 text-xl">⚠️</div>
            <div>
              <p className="text-sm font-semibold text-red-800 mb-1">Connection Error</p>
              <p className="text-xs text-red-600">{error}</p>
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

