import React, { useEffect, useState, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, useMap, Marker, useMapEvents, Polyline } from 'react-leaflet';
import { Coordinate, RouteData } from '../types';
import { getSafetyColor, SEOUL_CENTER } from '../utils/mockData';
import { getSafetyData, getNearestSafetyPoint, SafetyPoint } from '../utils/safetyData';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import L from 'leaflet';

interface MapVisualizerProps {
  userLocation?: Coordinate;      
  centerLocation?: Coordinate;    
  searchedLocation?: Coordinate;  
  showHeatmap?: boolean;
  className?: string;
  currentLocation?: Coordinate; 
  onCenterChange?: (c: Coordinate) => void;
  forceMoveTick?: number; 
  selectedRoute?: RouteData;
  routes?: RouteData[];
  onViewWebcam?: (lat: number, lng: number, name: string) => void; 
}

interface TappedPointData {
  lat: number;
  lng: number;
  address: string;
  safetyScore: number | null;
  isLoading: boolean;
}

const isValidCoordinate = (coord: any): boolean => {
  if (!coord) return false;
  const lat = typeof coord.lat === 'number' ? coord.lat : parseFloat(coord.lat);
  const lng = typeof coord.lng === 'number' ? coord.lng : parseFloat(coord.lng);
  return (
    !isNaN(lat) && isFinite(lat) && Math.abs(lat) <= 90 &&
    !isNaN(lng) && isFinite(lng) && Math.abs(lng) <= 180
  );
};

const MapStateWatcher: React.FC<{ 
    onMovingChange: (moving: boolean) => void, 
    onCenterChange?: (c: Coordinate) => void,
    center: Coordinate,
    forceMoveTick?: number,
    mapRef?: React.MutableRefObject<L.Map | null>
}> = ({ onMovingChange, onCenterChange, center, forceMoveTick, mapRef }) => {
  const map = useMap();
  
  useEffect(() => {
    if (mapRef) {
      mapRef.current = map;
    }
  }, [map, mapRef]);

  useMapEvents({
      movestart: () => onMovingChange(true),
      moveend: () => {
          onMovingChange(false);
          const c = map.getCenter();
          onCenterChange?.({ lat: c.lat, lng: c.lng });
      }
  });

  useEffect(() => {
    if (!isValidCoordinate(center)) return;
    map.invalidateSize();
    try {
        map.flyTo([center.lat, center.lng], map.getZoom(), {
            animate: true,
            duration: 0.8
        });
    } catch (e) { 
        console.warn("Map move error:", e); 
    }
  }, [center.lat, center.lng, forceMoveTick, map]);

  return null;
};

const MapClickHandler: React.FC<{ onMapClick: (data: TappedPointData) => void, onAddressUpdate: (data: TappedPointData) => void }> = ({ onMapClick, onAddressUpdate }) => {
  const abortControllerRef = useRef<AbortController | null>(null);
  const { language } = useSettings();

  useMapEvents({
    click: (e) => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      const { lat, lng } = e.latlng;
      if (isNaN(lat) || isNaN(lng)) return;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const nearest = getNearestSafetyPoint(lat, lng);
      const score = nearest ? nearest.score : null;
      
      const initialData: TappedPointData = {
        lat, lng, address: String(language === 'KO' ? "위치 확인 중..." : "Locating..."), safetyScore: score, isLoading: true
      };
      onMapClick(initialData);

      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=${language === 'KO' ? 'ko' : 'en'}`, { signal: controller.signal })
      .then(res => res.json())
      .then(data => {
        let address = "";
        if (data && data.address) {
            const addr = data.address;
            const road = addr.road || '';
            const suburb = addr.suburb || addr.neighbourhood || '';
            const district = addr.city_district || addr.borough || '';
            const city = addr.city || '';
            const parts = [city, district, suburb, road].filter(p => p && typeof p === 'string');
            address = parts.length > 0 ? parts.join(' ') : (typeof data.display_name === 'string' ? data.display_name.split(',')[0] : "");
        }
        onAddressUpdate({ ...initialData, address: String(address || "N/A"), isLoading: false });
      })
      .catch(() => onAddressUpdate({ ...initialData, address: "N/A", isLoading: false }));
    },
  });
  return null;
};

const TappedMarker: React.FC<{ data: TappedPointData, icon: L.DivIcon, theme: string, language: string, onViewWebcam?: (lat: number, lng: number, name: string) => void }> = ({ data, icon, theme, language, onViewWebcam }) => {
    const markerRef = useRef<L.Marker>(null);
    useEffect(() => { if (markerRef.current) markerRef.current.openPopup(); }, [data.lat, data.lng]);
    if (!isValidCoordinate(data)) return null;
    
    return (
        <Marker ref={markerRef} position={[data.lat, data.lng]} icon={icon}>
            <Popup offset={[0, -20]} minWidth={180} autoPan={false} closeButton={false}>
                <div className="text-center p-1">
                    <div className={`text-xs font-black mb-2 break-keep leading-tight ${theme === 'dark' ? 'text-gray-200' : 'text-gray-700'} ${data.isLoading ? 'animate-pulse opacity-50' : ''}`}>
                        {data.address === "N/A" 
                          ? (language === 'KO' ? "위치 정보 없음" : "No Address Info") 
                          : data.address}
                    </div>
                    <div className="flex flex-col items-center border-t border-gray-500/20 pt-2 mb-3">
                        <span className={`text-[10px] font-bold mb-0.5 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>{language === 'KO' ? '구역 안전 점수' : 'Area Safety Score'}</span>
                        {data.safetyScore !== null ? (
                            <span className="text-xl font-black" style={{ color: getSafetyColor(data.safetyScore) }}>{Math.round(data.safetyScore)}{language === 'KO' ? '점' : 'pts'}</span>
                        ) : <span className={`text-sm font-bold ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>N/A</span>}
                    </div>
                    
                    <button 
                        onClick={(e) => {
                            e.stopPropagation();
                            onViewWebcam?.(data.lat, data.lng, data.address);
                        }}
                        className="w-full py-2 bg-night-accent text-white rounded-lg text-[10px] font-black flex items-center justify-center gap-1.5 shadow-lg active:scale-95 transition-transform"
                    >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                        {language === 'KO' ? '근처 웹캠 보기' : 'VIEW NEAR WEBCAM'}
                    </button>
                </div>
            </Popup>
        </Marker>
    );
};

const MapVisualizer: React.FC<MapVisualizerProps> = ({ 
  userLocation, 
  centerLocation, 
  searchedLocation, 
  currentLocation, 
  showHeatmap, 
  className, 
  onCenterChange, 
  forceMoveTick,
  selectedRoute,
  routes,
  onViewWebcam
}) => {
  const [safetyPoints, setSafetyPoints] = useState<SafetyPoint[]>([]);
  const [tappedPoint, setTappedPoint] = useState<TappedPointData | null>(null);
  const [userAddress, setUserAddress] = useState<string>("");
  const [isUserAddressLoading, setIsUserAddressLoading] = useState<boolean>(false);
  const [isMoving, setIsMoving] = useState<boolean>(false);
  const userMarkerRef = useRef<L.Marker | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { theme } = useTheme();
  const { language } = useSettings();

  // React StrictMode 및 재렌더링 시 map.remove() 실행 및 DOM 컨테이너 _leaflet_id 정리
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        try {
          mapRef.current.remove();
        } catch (e) {
          console.warn("Map remove error:", e);
        }
        mapRef.current = null;
      }
      if (containerRef.current) {
        const leafletElements = containerRef.current.querySelectorAll('.leaflet-container');
        leafletElements.forEach((el: any) => {
          if (el && el._leaflet_id) {
            delete el._leaflet_id;
          }
        });
        if ((containerRef.current as any)._leaflet_id) {
          delete (containerRef.current as any)._leaflet_id;
        }
      }
    };
  }, []);

  const handleContainerRef = (node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) {
      if ((node as any)._leaflet_id && !mapRef.current) {
        delete (node as any)._leaflet_id;
      }
      const existing = node.querySelectorAll('.leaflet-container');
      existing.forEach((el: any) => {
        if (el && el._leaflet_id && !mapRef.current) {
          delete el._leaflet_id;
        }
      });
    }
  };

  const effectiveUserLocation = isValidCoordinate(userLocation) ? userLocation : (isValidCoordinate(currentLocation) ? currentLocation : undefined);
  const effectiveCenter = useMemo(() => {
    if (isValidCoordinate(centerLocation)) return centerLocation!;
    if (isValidCoordinate(currentLocation)) return currentLocation!;
    if (isValidCoordinate(userLocation)) return userLocation!;
    return SEOUL_CENTER;
  }, [centerLocation, currentLocation, userLocation]);

  // 방향 정보를 마커에 직접 업데이트 (DOM 레벨에서 처리하여 펄스 끊김 방지)
  useEffect(() => {
    if (userMarkerRef.current && effectiveUserLocation?.heading !== undefined) {
        const el = userMarkerRef.current.getElement();
        if (el) {
            el.style.setProperty('--user-heading', `${effectiveUserLocation.heading}deg`);
        }
    }
  }, [effectiveUserLocation?.heading]);

  useEffect(() => {
    if (!effectiveUserLocation) return;
    const fetchUserAddress = async () => {
        setIsUserAddressLoading(true);
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${effectiveUserLocation.lat}&lon=${effectiveUserLocation.lng}&zoom=18&addressdetails=1&accept-language=${language === 'KO' ? 'ko' : 'en'}`);
            const data = await res.json();
            if (data && data.address) {
                const addr = data.address;
                const parts = [addr.city || '', addr.city_district || addr.borough || '', addr.suburb || addr.neighbourhood || '', addr.road || ''].filter(p => p && typeof p === 'string');
                setUserAddress(parts.length > 0 ? parts.join(' ') : (data.display_name ? data.display_name.split(',')[0] : ""));
            }
        } catch (e) {
            console.error("User address fetch failed", e);
        } finally {
            setIsUserAddressLoading(false);
        }
    };
    const timer = setTimeout(fetchUserAddress, 1500); 
    return () => clearTimeout(timer);
  }, [effectiveUserLocation?.lat, effectiveUserLocation?.lng, language]);

  useEffect(() => {
    const updateData = () => { if (showHeatmap) setSafetyPoints(getSafetyData()); };
    updateData();
    window.addEventListener('safety-data-updated', updateData);
    return () => window.removeEventListener('safety-data-updated', updateData);
  }, [showHeatmap]);

  const destinationIcon = useMemo(() => L.divIcon({
    className: 'custom-icon',
    html: `<div class="relative flex flex-col items-center justify-center -translate-x-1/2 -translate-y-full"><div class="w-8 h-8 rounded-full bg-red-500 border-2 border-white shadow-lg flex items-center justify-center animate-bounce"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-white" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z" clip-rule="evenodd" /></svg></div><div class="w-2 h-2 bg-black/50 rounded-full blur-sm mt-1"></div></div>`,
    iconSize: [0, 0], iconAnchor: [0, 0]
  }), []);

  // 개선된 사용자 위치 아이콘 (Heading이 빠진 구조 - Heading은 CSS 변수로 처리)
  const userIcon = useMemo(() => {
    return L.divIcon({
      className: 'custom-user-icon-static',
      html: `
        <div class="relative flex items-center justify-center w-14 h-14" style="perspective: 1000px;">
            <!-- 1. 회전하는 부채꼴 (Heading) - CSS 변수로 제어됨 -->
            <div class="user-marker-heading-container absolute inset-0 flex items-center justify-center pointer-events-none">
                <div class="absolute top-0 w-10 h-10 bg-blue-500/20" style="clip-path: polygon(50% 50%, 20% 0%, 80% 0%); filter: blur(2px);"></div>
                <div class="absolute top-0.5 w-0 h-0 border-l-[5px] border-l-transparent border-r-[5px] border-r-transparent border-b-[8px] border-b-blue-600 shadow-xl"></div>
            </div>
            
            <!-- 2. 고정된 깜박임 (Pulsing) - DOM 재성성 없이 영구 재생 -->
            <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div class="w-8 h-8 rounded-full bg-blue-400/40 animate-ping" style="animation-duration: 2.5s;"></div>
            </div>
            
            <!-- 3. 고정된 중앙 파란색 점 (Center Dot) - z-index 최상단 -->
            <div class="relative flex items-center justify-center z-[9999]">
                <div class="w-4 h-4 bg-blue-600 border-2 border-white rounded-full shadow-[0_0_15px_rgba(37,99,235,0.8)]"></div>
            </div>
        </div>
      `,
      iconSize: [56, 56], iconAnchor: [28, 28]
    });
  }, []);

  const tappedIcon = useMemo(() => L.divIcon({
    className: 'custom-tap-icon',
    html: `<div class="relative flex flex-col items-center justify-center -translate-x-1/2 -translate-y-full"><div class="w-6 h-6 rounded-full bg-white border-4 border-night-accent shadow-lg flex items-center justify-center"><div class="w-1.5 h-1.5 rounded-full bg-night-accent"></div></div><div class="w-0.5 h-3 bg-night-accent"></div></div>`,
    iconSize: [0, 0], iconAnchor: [0, 0]
  }), []);

  const searchedSafety = useMemo(() => isValidCoordinate(searchedLocation) ? getNearestSafetyPoint(searchedLocation!.lat, searchedLocation!.lng) : null, [searchedLocation]);
  const userSafety = useMemo(() => effectiveUserLocation ? getNearestSafetyPoint(effectiveUserLocation.lat, effectiveUserLocation.lng) : null, [effectiveUserLocation]);

  return (
    <div ref={handleContainerRef} className={`relative w-full h-full overflow-hidden ${className} ${theme === 'dark' ? 'bg-gray-800' : 'bg-gray-200'} ${isMoving ? 'map-is-moving' : ''}`}>
      <MapContainer ref={mapRef} center={[effectiveCenter.lat, effectiveCenter.lng]} zoom={15} minZoom={13} style={{ width: '100%', height: '100%' }} zoomControl={false} preferCanvas={true}>
        <TileLayer url={theme === 'dark' ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"} keepBuffer={8} />
        <MapStateWatcher mapRef={mapRef} onMovingChange={setIsMoving} onCenterChange={onCenterChange} center={effectiveCenter} forceMoveTick={forceMoveTick} />
        <MapClickHandler onMapClick={setTappedPoint} onAddressUpdate={setTappedPoint} />
        
        {routes && routes.map(route => (
          <Polyline key={route.id} positions={route.path.map(p => [p.lat, p.lng] as [number, number])} color={selectedRoute?.id === route.id ? '#6366F1' : '#94A3B8'} weight={selectedRoute?.id === route.id ? 6 : 4} opacity={selectedRoute?.id === route.id ? 0.8 : 0.3} />
        ))}

        {showHeatmap && safetyPoints.map((point, idx) => isValidCoordinate(point) && (
            <CircleMarker key={idx} center={[point.lat, point.lng]} radius={8} fillColor={getSafetyColor(point.score)} color={getSafetyColor(point.score)} weight={0} fillOpacity={0.4}>
              <Popup><div className="flex flex-col items-center justify-center p-2 min-w-[100px]"><span className={`text-[10px] font-bold mb-1 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>{language === 'KO' ? '구역 안전 지수' : 'Area Safety'}</span><span className="text-2xl font-black" style={{ color: getSafetyColor(point.score) }}>{Math.round(point.score)}</span></div></Popup>
            </CircleMarker>
        ))}

        {effectiveUserLocation && (
          <Marker ref={userMarkerRef} position={[effectiveUserLocation.lat, effectiveUserLocation.lng]} icon={userIcon} zIndexOffset={10000}>
             <Popup offset={[0, -5]} minWidth={180} autoPan={false} closeButton={false}>
                <div className="text-center p-1">
                    <div className={`text-[10px] font-black mb-0.5 px-2 py-0.5 rounded-full inline-block ${theme === 'dark' ? 'bg-blue-500/20 text-blue-400' : 'bg-blue-100 text-blue-600'}`}>{language === 'KO' ? '내 위치' : 'MY LOCATION'}</div>
                    <div className={`text-xs font-black mt-2 mb-3 break-keep leading-tight ${theme === 'dark' ? 'text-gray-200' : 'text-gray-700'} ${isUserAddressLoading ? 'animate-pulse opacity-60' : ''}`}>{isUserAddressLoading ? (language === 'KO' ? "위치 확인 중..." : "Locating...") : (userAddress || "Location Signal Ready")}</div>
                    <div className="flex flex-col items-center border-t border-gray-500/20 pt-2 mb-3">
                        <span className={`text-[10px] font-bold mb-0.5 ${theme === 'dark' ? 'text-gray-400' : 'text-gray-500'}`}>{language === 'KO' ? '현재 구역 안전 점수' : 'Live Safety Score'}</span>
                        {userSafety ? (<span className="text-xl font-black" style={{ color: getSafetyColor(userSafety.score) }}>{Math.round(userSafety.score)}{language === 'KO' ? '점' : 'pts'}</span>) : <span className={`text-sm font-bold ${theme === 'dark' ? 'text-gray-500' : 'text-gray-400'}`}>N/A</span>}
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); onViewWebcam?.(effectiveUserLocation.lat, effectiveUserLocation.lng, language === 'KO' ? '내 위치 주변' : 'Near My Location'); }} className="w-full py-2 bg-blue-600 text-white rounded-lg text-[10px] font-black flex items-center justify-center gap-1.5 shadow-lg active:scale-95 transition-transform">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                        {language === 'KO' ? '주변 실시간 웹캠' : 'LIVE NEAR WEBCAMS'}
                    </button>
                </div>
             </Popup>
          </Marker>
        )}
        {isValidCoordinate(searchedLocation) && <Marker position={[searchedLocation!.lat, searchedLocation!.lng]} icon={destinationIcon} />}
        {tappedPoint && tappedPoint.address !== "N/A" && <TappedMarker data={tappedPoint} icon={tappedIcon} theme={theme} language={language} onViewWebcam={onViewWebcam} />}
      </MapContainer>
      <div className="absolute bottom-1 right-1 text-[8px] text-gray-500 opacity-30 z-[1000] pointer-events-none select-none uppercase tracking-tighter">© OpenStreetMap contributors</div>
    </div>
  );
};
export default React.memo(MapVisualizer);
