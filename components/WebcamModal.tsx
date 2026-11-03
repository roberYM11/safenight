
import React, { useState, useEffect } from 'react';
import { useSettings } from '../context/SettingsContext';

interface WebcamModalProps {
    cam: {
        id: string;
        name: string;
        lat: number;
        lng: number;
    } | null;
    onClose: () => void;
}

const WebcamModal: React.FC<WebcamModalProps> = ({ cam, onClose }) => {
    const { language } = useSettings();
    const [isScanning, setIsScanning] = useState(true);
    const [isFullScreen, setIsFullScreen] = useState(false);

    useEffect(() => {
        if (cam) {
            setIsScanning(true);
            setIsFullScreen(false); // 초기화 시 항상 팝업 형태로 시작
            const timer = setTimeout(() => setIsScanning(false), 1200);
            return () => clearTimeout(timer);
        }
    }, [cam]);

    if (!cam) return null;

    // 모드에 따른 스타일 정의
    const containerClasses = isFullScreen
        ? "fixed inset-0 z-[9000] bg-black flex flex-col animate-fade-in"
        : "fixed bottom-24 right-4 w-[75vw] max-w-[320px] aspect-video z-[9000] bg-night-900 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] border-2 border-white/10 overflow-hidden flex flex-col animate-fade-in-up";

    return (
        <div className={containerClasses}>
            {/* Header */}
            <div className={`p-3 flex items-center justify-between border-b border-white/10 ${isFullScreen ? 'bg-night-900' : 'bg-night-800'}`}>
                <div className="flex items-center gap-2 overflow-hidden">
                    <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0"></div>
                    <span className="text-white font-black text-[10px] uppercase tracking-tighter truncate">
                        {cam.name} {isFullScreen && "(LIVE BETA)"}
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    {/* Maximize/Minimize Toggle */}
                    <button 
                        onClick={() => setIsFullScreen(!isFullScreen)}
                        className="p-1.5 text-white/70 hover:text-white bg-white/5 rounded-lg active:scale-90 transition-all"
                    >
                        {isFullScreen ? (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 9L4 4m0 0l5 0m-5 0l0 5m11 11l5 5m0 0l-5 0m5 0l0-5" />
                            </svg>
                        ) : (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                            </svg>
                        )}
                    </button>
                    <button 
                        onClick={onClose}
                        className="p-1.5 text-white/70 hover:text-white bg-white/5 rounded-lg active:scale-90 transition-all"
                    >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            </div>

            {/* Video Area */}
            <div className="flex-1 bg-black relative flex items-center justify-center overflow-hidden">
                {isScanning ? (
                    <div className="flex flex-col items-center">
                        <div className={`border-night-accent border-t-transparent rounded-full animate-spin mb-2 ${isFullScreen ? 'w-12 h-12 border-4' : 'w-6 h-6 border-2'}`}></div>
                        {isFullScreen && <p className="text-night-accent text-[10px] font-black animate-pulse uppercase">Establishing Stream...</p>}
                    </div>
                ) : (
                    <div className="w-full h-full relative flex items-center justify-center">
                        <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: 'url("https://media.giphy.com/media/oEI9uWUicM3pS/giphy.gif")', backgroundSize: 'cover' }}></div>
                        
                        <div className={`text-center z-10 ${isFullScreen ? 'px-8' : 'px-2'}`}>
                            <div className={`${isFullScreen ? 'text-4xl mb-4' : 'text-xl mb-1'} opacity-20 filter grayscale invert`}>📷</div>
                            <h3 className={`text-white font-black opacity-80 uppercase ${isFullScreen ? 'text-xl mb-2' : 'text-[10px]'}`}>Standby</h3>
                            {isFullScreen && (
                                <p className="text-gray-500 text-[10px] font-bold leading-relaxed mb-6">
                                    {language === 'KO' 
                                        ? '공공 데이터 포털 CCTV 통합 관리 시스템 대기 중...\n보안 정책에 따라 관리자 승인 후 송출됩니다.' 
                                        : 'Waiting for Public Data Portal CCTV integration.\nSubject to local security protocol approval.'}
                                </p>
                            )}
                        </div>

                        {/* Overlay Effects */}
                        <div className={`absolute top-2 left-2 font-mono text-emerald-500 font-bold flex flex-col gap-0.5 ${isFullScreen ? 'text-[10px]' : 'text-[7px]'}`}>
                            <span className="flex items-center gap-1"><div className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse"></div> REC</span>
                            <span>{cam.id}</span>
                            {isFullScreen && <span>{new Date().toISOString()}</span>}
                        </div>
                        
                        {isFullScreen && (
                            <div className="absolute bottom-4 right-4 font-mono text-[9px] text-white opacity-40 uppercase">
                                Signal Linked / 24fps
                            </div>
                        )}

                        {/* Scanline CRT Effect */}
                        <div className="absolute inset-0 pointer-events-none opacity-30" style={{ background: 'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06))', backgroundSize: '100% 2px, 3px 100%' }}></div>
                    </div>
                )}
            </div>
            
            {/* Small Footer Only in Full Screen Mode for Metadata */}
            {isFullScreen && (
                <div className="p-4 bg-night-900 border-t border-white/5 flex justify-center">
                    <div className="inline-flex gap-4 p-2 px-4 rounded-full bg-white/5 border border-white/10">
                        <span className="text-[9px] text-gray-500 font-mono tracking-tighter">LAT: {cam.lat.toFixed(6)}</span>
                        <span className="text-[9px] text-gray-500 font-mono tracking-tighter">LNG: {cam.lng.toFixed(6)}</span>
                    </div>
                </div>
            )}
        </div>
    );
};

export default WebcamModal;
