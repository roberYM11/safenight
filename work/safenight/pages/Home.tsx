
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import MapVisualizer from '../components/MapVisualizer';
import BottomSheet from '../components/BottomSheet';
import SearchOverlay from '../components/SearchOverlay';
import WebcamModal from '../components/WebcamModal';
import { SEOUL_CENTER, getSafetyColor } from '../utils/mockData';
import { getNearestSafetyPoint, getSafetyData } from '../utils/safetyData';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { Coordinate } from '../types';

const Icons = {
  CCTV: ({ isDark }: { isDark: boolean }) => (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="none" stroke={isDark ? "#E5E7EB" : "#374151"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>
    </svg>
  ),
  Light: ({ isDark }: { isDark: boolean }) => (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="none" stroke={isDark ? "#FDE047" : "#EAB308"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" x2="3" y1="12" y2="12"/><line x1="21" x2="23" y1="12" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  ),
  Safety: ({ isDark }: { isDark: boolean }) => (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="none" stroke={isDark ? "#34D399" : "#059669"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>
    </svg>
  )
};

const Home: React.FC = () => {
  const navigate = useNavigate();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [userLocation, setUserLocation] = useState<Coordinate | undefined>(undefined); 
  const [searchedLocation, setSearchedLocation] = useState<Coordinate | undefined>(undefined); 
  const [viewCenter, setViewCenter] = useState<Coordinate>(SEOUL_CENTER); 
  const [mapCenterForSearch, setMapCenterForSearch] = useState<Coordinate>(SEOUL_CENTER);
  const [locationStatus, setLocationStatus] = useState<'searching' | 'ok' | 'denied' | 'error'>('searching');
  const [forceMoveTick, setForceMoveTick] = useState(0); 

  const [selectedCam, setSelectedCam] = useState<{ id: string; name: string; lat: number; lng: number; } | null>(null);

  const hasInitiallyFocused = useRef(false);
  const currentHeadingRef = useRef(0);
  const safetyDataLoaded = getSafetyData().length > 0;

  const [currentStats, setCurrentStats] = useState({
      cctv: 0,
      brightness: 0,
      score: 82
  });

  const { theme, toggleTheme } = useTheme();
  const { language, emergencyContacts } = useSettings();

  // 기기 방향 센서
  useEffect(() => {
    const handleOrientation = (e: DeviceOrientationEvent) => {
      let heading = 0;
      if ((e as any).webkitCompassHeading !== undefined) {
        heading = (e as any).webkitCompassHeading;
      } else if (e.alpha !== null) {
        heading = 360 - e.alpha;
      }
      currentHeadingRef.current = heading;
      // MapVisualizer에서 DOM 레벨 처리를 위해 heading만 업데이트
      setUserLocation(prev => prev ? { ...prev, heading } : undefined);
    };
    window.addEventListener('deviceorientation', handleOrientation);
    return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, []);

  // 위치 추적 로직
  useEffect(() => {
    if (!navigator.geolocation) {
        setLocationStatus('error');
        return;
    }
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const coords: Coordinate = { 
            lat: pos.coords.latitude, 
            lng: pos.coords.longitude,
            heading: currentHeadingRef.current
        };
        setUserLocation(coords);
        setLocationStatus('ok');
        if (!hasInitiallyFocused.current) {
            setViewCenter({ ...coords });
            setForceMoveTick(Date.now());
            hasInitiallyFocused.current = true;
        }
      },
      (err) => {
        if (err.code === 1) setLocationStatus('denied');
        else setLocationStatus('error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const handleCenterOnMe = () => {
      if (locationStatus === 'denied') {
          alert(language === 'KO' ? "설정에서 위치 권한을 허용해주세요." : "Enable location in settings.");
          return;
      }
      if (!userLocation) return;
      setViewCenter({ lat: userLocation.lat, lng: userLocation.lng });
      setForceMoveTick(Date.now());
  };

  const handleSOS = () => {
      if (emergencyContacts.length === 0) {
          if (confirm(language === 'KO' ? '등록된 비상 연락처가 없습니다. 설정으로 이동할까요?' : 'No emergency contacts. Go to settings?')) {
              navigate('/settings');
          }
          return;
      }
      const contacts = emergencyContacts.map(c => `${c.name}(${c.phone})`).join(', ');
      if (confirm(language === 'KO' ? `${contacts}님에게 현재 위치를 포함한 SOS 문자를 발송하시겠습니까?` : `Send SOS alert to ${contacts}?`)) {
          alert(language === 'KO' ? '긴급 알림이 전송되었습니다.' : 'SOS Alert Sent.');
      }
  };

  const handleSelectPlace = (lat: number, lng: number) => {
      const target = { lat, lng };
      setSearchedLocation(target);
      setViewCenter(target);
      setForceMoveTick(Date.now());
      setIsSearchOpen(false);
  };

  const handleViewWebcamFromMap = (lat: number, lng: number, address: string) => {
      setSelectedCam({
          id: `cam-${Math.random().toString(36).substr(2, 5)}`,
          name: `${address.split(' ').slice(-1)[0] || '지정 구역'} 감시 채널`,
          lat,
          lng
      });
  };

  useEffect(() => {
      if (!viewCenter || isNaN(viewCenter.lat)) return;
      const nearest = getNearestSafetyPoint(viewCenter.lat, viewCenter.lng);
      if (nearest) {
          setCurrentStats({
              cctv: Math.round(nearest.cctvCount || 0),
              brightness: Math.round(nearest.avgBrightness || 0),
              score: Math.round(nearest.score || 0)
          });
      }
  }, [viewCenter, safetyDataLoaded]);

  const isDark = theme === 'dark';
  const labelColor = isDark ? 'text-gray-400' : 'text-gray-500';
  const cardBorder = isDark ? 'border-gray-700/50' : 'border-gray-200/50';

  return (
    <div className={`relative w-full h-screen ${isDark ? 'bg-night-900' : 'bg-gray-50'} overflow-hidden flex flex-col transition-colors`}>
      <div className={`absolute top-0 left-0 right-0 z-[3000] p-4 bg-gradient-to-b ${isDark ? 'from-night-900/90' : 'from-white/90'} via-transparent to-transparent pointer-events-none`}>
        <div className="flex justify-between items-center mb-4 pointer-events-auto">
            <h1 className={`text-xl font-black flex items-center gap-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                <svg className="w-6 h-6 text-night-safe" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /></svg>
                SafeNight <span className="bg-yellow-500/20 text-yellow-500 text-[9px] px-1.5 py-0.5 rounded border border-yellow-500/30 font-bold tracking-widest">BETA</span>
            </h1>
            <div className="flex gap-2">
                <button onClick={toggleTheme} className={`p-2 ${isDark ? 'bg-night-800/60 text-white' : 'bg-white/60 text-gray-800'} rounded-full backdrop-blur-md border ${cardBorder} shadow-lg active:scale-90 transition-all`}>
                    {isDark ? <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg> : <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>}
                </button>
                <button onClick={() => navigate('/settings')} className={`p-2 ${isDark ? 'bg-night-800/60 text-white' : 'bg-white/60 text-gray-800'} rounded-full backdrop-blur-md border ${cardBorder} shadow-lg active:scale-90 transition-all`}>
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                </button>
            </div>
        </div>
        <div className="relative pointer-events-auto max-w-lg mx-auto">
            <button onClick={() => setIsSearchOpen(true)} className={`w-full flex items-center ${isDark ? 'bg-white/95' : 'bg-white/90 border border-gray-200/50'} backdrop-blur-md rounded-2xl shadow-2xl p-4 active:scale-[0.98] transition-transform`}>
                <div className="text-night-900 mr-3"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg></div>
                <span className="text-gray-400 font-bold">{language === 'KO' ? "장소 또는 주소 정밀 검색" : "Precise Safety Search"}</span>
            </button>
        </div>
      </div>

      <div className="flex-1 relative z-0">
        <MapVisualizer userLocation={userLocation} centerLocation={viewCenter} searchedLocation={searchedLocation} showHeatmap={true} onCenterChange={(c) => setMapCenterForSearch(c)} forceMoveTick={forceMoveTick} onViewWebcam={handleViewWebcamFromMap} />
      </div>

      {isSearchOpen && <SearchOverlay userLocation={userLocation} mapCenter={mapCenterForSearch} onClose={() => setIsSearchOpen(false)} onSelectPlace={handleSelectPlace} />}
      <WebcamModal cam={selectedCam} onClose={() => setSelectedCam(null)} />

      {/* 우측 상단 정보 및 위치 버튼 */}
      <div className="absolute top-44 right-4 z-[1500] pointer-events-auto flex flex-col items-end gap-4">
        <div className={`${isDark ? 'bg-night-800/80' : 'bg-white/80'} rounded-2xl p-4 backdrop-blur-md shadow-lg border ${cardBorder} w-36 text-center`}>
            <div className={`text-[10px] font-black mb-1 uppercase tracking-tighter ${labelColor}`}>{language === 'KO' ? '구역 안전 지수' : 'Safety Index'}</div>
            <div className="flex items-end justify-center gap-1">
                <span className="text-4xl font-black tracking-tighter" style={{ color: getSafetyColor(currentStats.score) }}>{currentStats.score}</span>
                <span className={`text-[10px] font-bold mb-1 ${labelColor}`}>{language === 'KO' ? '점' : 'pts'}</span>
            </div>
        </div>
        <button onClick={handleCenterOnMe} className={`${isDark ? 'bg-night-800/80' : 'bg-white/80'} p-3.5 rounded-full shadow-xl border ${cardBorder} backdrop-blur-md active:scale-90 transition-all`}>
            <svg className={`w-6 h-6 ${isDark ? 'text-gray-300' : 'text-gray-600'} ${locationStatus === 'searching' ? 'animate-pulse' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
        </button>
      </div>

      {/* 우측 하단: 긴급 SOS 버튼 - 최상단 가시성 확보 */}
      <div className="absolute bottom-28 right-4 z-[4500] pointer-events-auto">
        <button onClick={handleSOS} className="group relative flex items-center justify-center w-16 h-16 bg-red-600 rounded-full shadow-[0_8px_30px_rgba(220,38,38,0.6)] active:scale-90 transition-all overflow-hidden border-2 border-white/20">
            <div className="absolute inset-0 bg-red-500 animate-pulse opacity-40"></div>
            <svg className="w-8 h-8 text-white relative z-10 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="absolute -bottom-1 text-[8px] font-black text-white tracking-widest bg-red-900/90 w-full text-center py-1 opacity-0 group-hover:opacity-100">SOS</span>
        </button>
      </div>

      <BottomSheet>
        <div className="space-y-6">
            <h2 className={`text-xs font-black uppercase tracking-widest ${labelColor} flex items-center gap-2`}>
                <span className="w-1.5 h-1.5 rounded-full bg-night-safe animate-pulse"></span>
                {language === 'KO' ? '실시간 구역 안전 분석' : 'Live Safety Audit'}
            </h2>
            <div className="grid grid-cols-3 gap-3 text-center">
                <div className={`${isDark ? 'bg-night-700/50' : 'bg-gray-100/50'} p-4 rounded-2xl border ${isDark ? 'border-gray-600/30' : 'border-gray-200/50'} shadow-sm`}>
                    <div className="mb-2 w-8 h-8 mx-auto"><Icons.CCTV isDark={isDark} /></div>
                    <div className={`text-[10px] font-medium ${labelColor}`}>CCTV</div>
                    <div className={`text-sm font-bold mt-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>{currentStats.cctv}{language === 'KO' ? '대' : ''}</div>
                </div>
                <div className={`${isDark ? 'bg-night-700/50' : 'bg-gray-100/50'} p-4 rounded-2xl border ${isDark ? 'border-gray-600/30' : 'border-gray-200/50'} shadow-sm`}>
                    <div className="mb-2 w-8 h-8 mx-auto"><Icons.Light isDark={isDark} /></div>
                    <div className={`text-[10px] font-medium ${labelColor}`}>{language === 'KO' ? '조도' : 'Light'}</div>
                    <div className={`text-sm font-bold mt-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>{currentStats.brightness > 10 ? (language === 'KO' ? '양호' : 'Good') : (language === 'KO' ? '어두움' : 'Dark')}</div>
                </div>
                <div className={`${isDark ? 'bg-night-700/50' : 'bg-gray-100/50'} p-4 rounded-2xl border ${isDark ? 'border-gray-600/30' : 'border-gray-200/50'} shadow-sm`}>
                    <div className="mb-2 w-8 h-8 mx-auto"><Icons.Safety isDark={isDark} /></div>
                    <div className={`text-[10px] font-medium ${labelColor}`}>{language === 'KO' ? '치안등급' : 'Security'}</div>
                    <div className={`text-sm font-bold mt-1 ${isDark ? 'text-white' : 'text-gray-900'}`}>{currentStats.score >= 80 ? (language === 'KO' ? '최우수' : 'Safe') : (language === 'KO' ? '보통' : 'Normal')}</div>
                </div>
            </div>
        </div>
      </BottomSheet>
    </div>
  );
};
export default Home;
