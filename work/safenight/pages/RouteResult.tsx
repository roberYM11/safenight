
import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import MapVisualizer from '../components/MapVisualizer';
import { MOCK_ROUTES, getSafetyGradient, SEOUL_CENTER } from '../utils/mockData';
import { RouteData } from '../types';
import { useSettings } from '../context/SettingsContext';

const RouteResult: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [selectedRoute, setSelectedRoute] = useState<RouteData>(MOCK_ROUTES[0]);
  const [loading, setLoading] = useState(true);
  const { language } = useSettings();

  useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(false);
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  const handleStartMonitoring = () => {
    navigate('/navigate', { state: { routeId: selectedRoute.id } });
  };

  if (loading) {
    return (
      <div className="h-screen bg-night-900 flex flex-col items-center justify-center text-white">
        <div className="w-16 h-16 border-4 border-night-700 border-t-night-safe rounded-full animate-spin mb-4"></div>
        <p className="text-lg font-medium animate-pulse">
            {language === 'KO' ? '경로 분석 중...' : 'Analyzing Routes...'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-night-900">
      <div className="p-4 bg-night-900 z-10 flex items-center gap-4 border-b border-gray-800">
        <button onClick={() => navigate(-1)} className="p-2 -ml-2 text-gray-300">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
        </button>
        <div>
            <div className="text-xs text-gray-400">{language === 'KO' ? '목적지' : 'Destination'}</div>
            <div className="font-bold text-lg text-white">{language === 'KO' ? '강남역 2번 출구' : 'Gangnam Stn Exit 2'}</div>
        </div>
      </div>

      <div className="h-[40vh] w-full relative">
        <MapVisualizer 
            selectedRoute={selectedRoute} 
            routes={MOCK_ROUTES}
            centerLocation={SEOUL_CENTER} 
        />
      </div>

      <div className="flex-1 overflow-y-auto bg-night-800 p-4 pb-8 rounded-t-3xl -mt-6 relative z-10 border-t border-gray-700">
        <div className="w-12 h-1 bg-gray-600 rounded-full mx-auto mb-6"></div>
        
        <h2 className="text-gray-300 text-sm mb-4 font-medium">
            {language === 'KO' ? '추천 경로' : 'Recommended Routes'}
        </h2>
        
        <div className="space-y-4">
            {MOCK_ROUTES.map((route) => (
                <div 
                    key={route.id}
                    onClick={() => setSelectedRoute(route)}
                    className={`relative p-5 rounded-2xl border transition-all duration-200 cursor-pointer ${
                        selectedRoute.id === route.id 
                            ? 'bg-night-700 border-night-accent shadow-lg shadow-indigo-900/20' 
                            : 'bg-night-800 border-gray-700 opacity-70 hover:opacity-100'
                    }`}
                >
                    <div className="flex justify-between items-start mb-3">
                        <div className="flex flex-col">
                            <span className={`text-sm font-bold mb-1 ${
                                route.type === 'RECOMMEND' ? 'text-night-safe' : 'text-gray-400'
                            }`}>
                                {route.label}
                            </span>
                            <div className="flex items-center gap-2 text-xs text-gray-400">
                                <span>{Math.ceil(route.duration / 60)} {language === 'KO' ? '분' : 'min'}</span>
                                <span>|</span>
                                <span>{(route.distance / 1000).toFixed(1)}km</span>
                            </div>
                        </div>
                        <div className="text-right">
                             <div className="text-2xl font-bold text-white leading-none">{route.safety_score}</div>
                             <div className="text-[10px] text-gray-500">{language === 'KO' ? '안전점수' : 'Score'}</div>
                        </div>
                    </div>

                    <div className="w-full h-2 bg-gray-700 rounded-full mb-4 overflow-hidden">
                        <div 
                            className="h-full rounded-full transition-all duration-500"
                            style={{ 
                                width: `${route.safety_score}%`,
                                background: getSafetyGradient(route.safety_score)
                            }}
                        ></div>
                    </div>

                    <div className="flex gap-2 flex-wrap mb-2">
                        {route.tags.map(tag => (
                            <span key={tag} className="text-[10px] px-2 py-1 bg-gray-700/50 rounded text-gray-300">
                                {tag}
                            </span>
                        ))}
                    </div>
                </div>
            ))}
        </div>

        <div className="mt-8 pb-4 sticky bottom-0">
             <button 
                onClick={handleStartMonitoring}
                className="w-full bg-night-accent hover:bg-indigo-500 text-white text-lg font-bold py-4 rounded-xl shadow-lg transition-transform active:scale-[0.98] flex items-center justify-center gap-2"
            >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                {language === 'KO' ? '안심 귀가 모니터링 시작' : 'Start Safety Monitoring'}
            </button>
        </div>
      </div>
    </div>
  );
};

export default RouteResult;
