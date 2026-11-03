
import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import MapVisualizer from '../components/MapVisualizer';
import WebcamModal from '../components/WebcamModal';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { Coordinate } from '../types';

// Base64 디코딩 유틸리티
const decodeBase64 = (base64: string) => decodeURIComponent(escape(atob(base64)));

// 가상 CCTV 데이터 생성 (위치 주변 3~4개)
const generateMockCCTVs = (center: Coordinate) => {
    return [
        { id: 'cam-01', name: '영역 감시 01', lat: center.lat + 0.0012, lng: center.lng + 0.0008, status: 'STANDBY' },
        { id: 'cam-02', name: '교차로 채널 04', lat: center.lat - 0.0009, lng: center.lng + 0.0015, status: 'STANDBY' },
        { id: 'cam-03', name: '공공 웹캠 B-3', lat: center.lat + 0.0015, lng: center.lng - 0.0012, status: 'STANDBY' },
    ];
};

const EmergencyView: React.FC = () => {
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const { theme } = useTheme();
    const { language } = useSettings();
    
    const [currentLoc, setCurrentLoc] = useState<Coordinate | null>(null);
    const [lastSyncTime, setLastSyncTime] = useState<number | null>(null);
    const [selectedCam, setSelectedCam] = useState<any | null>(null);
    
    const token = searchParams.get('token');
    const isDark = theme === 'dark';

    // 가상 CCTV 목록
    const nearbyCams = useMemo(() => {
        return currentLoc ? generateMockCCTVs(currentLoc) : [];
    }, [currentLoc]);

    useEffect(() => {
        if (!token) return;

        const fetchLatestLocation = () => {
            const rawData = localStorage.getItem(`emergency_loc_${token}`);
            if (rawData) {
                try {
                    const decoded = JSON.parse(decodeBase64(rawData));
                    setCurrentLoc({ lat: decoded.lat, lng: decoded.lng });
                    setLastSyncTime(decoded.lastUpdated);
                } catch (e) {
                    console.error("Failed to decode emergency payload", e);
                }
            }
        };

        fetchLatestLocation();
        const intervalId = setInterval(fetchLatestLocation, 3000);
        return () => clearInterval(intervalId);
    }, [token]);

    const handleOpenCam = (cam: any) => {
        setSelectedCam(cam);
    };

    const handleViewWebcamFromMap = (lat: number, lng: number, address: string) => {
        setSelectedCam({
            id: `cam-${Math.random().toString(36).substr(2, 5)}`,
            name: `${address.split(' ').slice(-1)[0] || '지정 구역'} 감시 채널`,
            lat,
            lng
        });
    };

    if (!token) {
        return (
            <div className="h-screen bg-red-950 text-white flex flex-col items-center justify-center p-8 text-center">
                <div className="text-6xl mb-6 text-red-500 animate-bounce">⚠️</div>
                <h1 className="text-xl font-black mb-2">{language === 'KO' ? '접근 권한 없음' : 'Access Denied'}</h1>
                <p className="opacity-60 text-sm">{language === 'KO' ? '유효하지 않은 링크입니다.' : 'Invalid link.'}</p>
                <button onClick={() => navigate('/')} className="mt-8 px-6 py-3 bg-white/10 rounded-xl font-bold border border-white/20">
                    {language === 'KO' ? '홈으로' : 'Home'}
                </button>
            </div>
        );
    }

    const shareTimeStr = useMemo(() => {
        if (!lastSyncTime) return language === 'KO' ? '데이터 대기 중...' : 'Syncing...';
        return new Date(lastSyncTime).toLocaleTimeString();
    }, [lastSyncTime, language]);

    return (
        <div className={`h-screen flex flex-col ${isDark ? 'bg-night-900 text-white' : 'bg-gray-50 text-gray-900'} overflow-hidden`}>
            {/* 긴급 상단 헤더 */}
            <div className="p-4 bg-red-600 text-white shadow-2xl z-50 flex flex-col border-b border-white/10">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-white animate-ping"></span>
                        <h1 className="font-black text-lg tracking-tighter text-white uppercase">
                            BETA EMERGENCY FEED
                        </h1>
                    </div>
                    <div className="text-[10px] font-black bg-white/20 px-2 py-1 rounded-md border border-white/30">
                        TRACKING v0.95
                    </div>
                </div>
                <p className="text-[10px] font-bold opacity-80 mt-1 uppercase tracking-wider">
                    {language === 'KO' ? '마지막 위치 동기화' : 'Last sync'}: {shareTimeStr}
                </p>
            </div>

            {/* 지도 영역 */}
            <div className="flex-1 relative z-10">
                {currentLoc ? (
                    <>
                        <MapVisualizer 
                            centerLocation={currentLoc} 
                            searchedLocation={currentLoc}
                            showHeatmap={false}
                            onViewWebcam={handleViewWebcamFromMap} // Pass callback
                        />
                        {/* 주변 CCTV 마커 레이어 (가상) */}
                        <div className="absolute top-4 left-4 z-[1000] flex flex-col gap-2">
                            {nearbyCams.map(cam => (
                                <button 
                                    key={cam.id}
                                    onClick={() => handleOpenCam(cam)}
                                    className="bg-white/90 backdrop-blur-md p-2 rounded-lg shadow-lg border border-red-500/30 flex items-center gap-2 active:scale-95 transition-transform"
                                >
                                    <div className="w-6 h-6 bg-red-600 rounded flex items-center justify-center text-white">
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                    </div>
                                    <span className="text-[10px] font-black text-gray-900">{cam.name}</span>
                                </button>
                            ))}
                        </div>
                    </>
                ) : (
                    <div className="h-full flex flex-col items-center justify-center bg-gray-900">
                        <div className="w-12 h-12 border-4 border-red-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                        <p className="text-xs font-black text-red-500 animate-pulse tracking-widest uppercase">INITIALIZING SECURE LINK...</p>
                    </div>
                )}
            </div>

            {/* 하단 제어 센터 */}
            <div className={`p-6 ${isDark ? 'bg-night-800' : 'bg-white'} border-t-2 border-red-500/30 shadow-[0_-10px_40px_rgba(220,38,38,0.15)] relative z-20`}>
                <div className="flex items-start gap-4 mb-6">
                    <div className="w-14 h-14 bg-red-600/10 rounded-2xl flex items-center justify-center text-red-600 shrink-0 border-2 border-red-600/20 shadow-inner">
                        <svg className="w-8 h-8 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    </div>
                    <div>
                        <h2 className="font-black text-sm mb-1 text-red-600 uppercase tracking-tight">
                            {language === 'KO' ? '정밀 위치 및 구역 감시 시스템' : 'LIVE PATH MONITORING'}
                        </h2>
                        <div className="flex items-center gap-2">
                             <span className="text-[10px] bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 rounded font-bold">SIGNAL OK</span>
                             <p className={`text-[9px] ${isDark ? 'text-gray-400' : 'text-gray-500'} font-bold uppercase`}>
                                AES-B64-SECURE-CHANNEL-V2
                             </p>
                        </div>
                    </div>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                    <a href="tel:112" className="bg-red-600 hover:bg-red-700 text-white py-4 rounded-2xl font-black text-xs text-center flex items-center justify-center gap-2 shadow-xl shadow-red-900/20 active:scale-95 transition-all">
                        🚨 {language === 'KO' ? '경찰 긴급 신고' : 'POLICE SOS'}
                    </a>
                    <button 
                        onClick={() => {
                             if(nearbyCams.length > 0) handleOpenCam(nearbyCams[0]);
                        }} 
                        className={`py-4 rounded-2xl font-black text-xs text-center border-2 active:scale-95 transition-all flex items-center justify-center gap-2 ${isDark ? 'bg-white/5 border-white/10 text-white hover:bg-white/10' : 'bg-gray-100 border-gray-200 text-gray-700 hover:bg-gray-200'}`}
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                        {language === 'KO' ? '주변 CCTV 확인' : 'SCAN NEAR CAMS'}
                    </button>
                </div>
            </div>

            {/* Webcam Modal Componentized */}
            <WebcamModal cam={selectedCam} onClose={() => setSelectedCam(null)} />
        </div>
    );
};

export default EmergencyView;
