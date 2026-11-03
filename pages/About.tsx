
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';

const Icons = {
  Monocle: () => (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="none" stroke="#667eea" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  CCTV: ({ isDark }: { isDark: boolean }) => (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="none" stroke={isDark ? "#E5E7EB" : "#374151"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>
    </svg>
  ),
  Light: ({ isDark }: { isDark: boolean }) => (
    <svg className="w-full h-full" viewBox="0 0 24 24" fill="none" stroke={isDark ? "#FDE047" : "#EAB308"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {/* Fix: Removed duplicate y1 attribute on line element */}
      <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" x2="3" y1="12" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  )
};

const About: React.FC = () => {
  const navigate = useNavigate();
  const { theme } = useTheme();
  const { language } = useSettings();
  const isDark = theme === 'dark';

  return (
    <div className={`min-h-screen ${isDark ? 'bg-night-900 text-white' : 'bg-gray-50 text-gray-900'} pb-12 transition-colors`}>
      <div className={`p-4 flex items-center border-b ${isDark ? 'border-gray-800 bg-night-900/90' : 'border-gray-200 bg-white/90'} sticky top-0 backdrop-blur-md z-10`}>
        <button onClick={() => navigate(-1)} className="p-2 -ml-2">
            <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
        </button>
        <h1 className="text-lg font-bold ml-2">SafeNight [BETA]</h1>
      </div>

      <div className="p-6">
        <div className="mb-6 flex items-center gap-2">
             <span className="bg-yellow-500 text-night-900 text-[10px] font-black px-2 py-0.5 rounded tracking-widest">BETA VERSION</span>
        </div>
        
        <h2 className="text-2xl font-bold mb-6 text-night-accent">
            {language === 'KO' ? '데이터로 증명하는 야간 안전' : 'Auditing Night Safety with Data'}
        </h2>

        <div className="space-y-8">
            <section className={`${isDark ? 'bg-night-800 border-gray-700' : 'bg-white border-gray-200 shadow-sm'} p-5 rounded-2xl border`}>
                <h3 className="font-bold text-lg mb-3 flex items-center gap-3">
                    <div className="w-7 h-7"><Icons.Monocle /></div>
                    {language === 'KO' ? '베타 서비스 안내' : 'Beta Service Info'}
                </h3>
                <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'} leading-relaxed text-sm`}>
                    {language === 'KO' 
                        ? 'SafeNight은 현재 베타 버전으로 운영 중입니다. 실시간 공공 데이터를 분석하여 특정 구역의 CCTV 밀도와 조도 상태를 기반으로 정밀한 안전 보고서를 제공하며, 긴급 상황 시 이 데이터를 공유할 수 있습니다.'
                        : 'SafeNight is currently in Beta. We provide precise safety reports by analyzing public data on CCTV density and lighting levels in real-time, allowing you to share this data during emergencies.'}
                </p>
            </section>

            <section>
                 <h3 className="font-bold text-lg mb-4">{language === 'KO' ? '분석 기준' : 'Audit Criteria'}</h3>
                 <div className="grid gap-4">
                    <div className="flex items-start gap-4">
                        <div className={`${isDark ? 'bg-night-700' : 'bg-gray-200'} p-2.5 rounded-lg w-12 h-12 flex items-center justify-center shrink-0`}>
                            <Icons.CCTV isDark={isDark} />
                        </div>
                        <div>
                            <div className={`font-bold ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>{language === 'KO' ? 'CCTV 밀도 분석' : 'CCTV Density'}</div>
                            <p className="text-xs text-gray-400 mt-1">{language === 'KO' ? '서울시 전역 CCTV 위치 데이터를 분석하여 보안 수준을 측정합니다.' : 'Measures security levels based on Seoul-wide CCTV location data.'}</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-4">
                        <div className={`${isDark ? 'bg-night-700' : 'bg-gray-200'} p-2.5 rounded-lg w-12 h-12 flex items-center justify-center shrink-0`}>
                            <Icons.Light isDark={isDark} />
                        </div>
                        <div>
                            <div className={`font-bold ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>{language === 'KO' ? '야간 조도 정밀 측정' : 'Light Level Audit'}</div>
                            <p className="text-xs text-gray-400 mt-1">{language === 'KO' ? '가로등 위치와 스마트 조도 센서 데이터를 매칭하여 시인성을 분석합니다.' : 'Analyzes visibility by matching light sensors with streetlight data.'}</p>
                        </div>
                    </div>
                 </div>
            </section>

            <section className={`${isDark ? 'bg-gray-800/50 border-gray-700/50' : 'bg-gray-100 border-gray-200'} p-4 rounded-xl text-center border`}>
                <p className="text-[10px] text-gray-500 mb-2">Version 0.9.5-beta (Stable)</p>
                <p className={`font-bold text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>© 2024 SafeNight Dev Team. All rights reserved.</p>
            </section>
        </div>
      </div>
    </div>
  );
};
export default About;
