import React, { useState, useEffect, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { Coordinate } from '../types';

interface SearchOverlayProps {
    userLocation?: Coordinate;
    mapCenter: Coordinate;
    onClose: () => void;
    onSelectPlace: (lat: number, lng: number) => void;
}

interface SearchItem {
    name: string;
    address: string;
    lat: number;
    lng: number;
    distance?: string;
    category?: string;
}

const SUGGESTED_KEYWORDS = ['편의점', '경찰서', '지하철역', 'CCTV', '카페', '강남역', '서울역', '병원', '약국', '공원', '개방화장실'];

const calculateDistanceMeters = (lat1: number, lon1: number, lat2: number, lon2: number): string => {
    const R = 6371e3; // meters
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c).toString();
};

const SearchOverlay: React.FC<SearchOverlayProps> = ({ userLocation, mapCenter, onClose, onSelectPlace }) => {
    const { theme } = useTheme();
    const { language } = useSettings();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchItem[]>([]);
    const [keywordSuggestions, setKeywordSuggestions] = useState<string[]>([]);
    const [history, setHistory] = useState<SearchItem[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [searchMode, setSearchMode] = useState<'MY' | 'MAP'>('MY');
    const [hasSearched, setHasSearched] = useState(false); 
    const [shake, setShake] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    const isDark = theme === 'dark';

    useEffect(() => {
        const saved = localStorage.getItem('search_history_kakao');
        if (saved) {
            try {
                setHistory(JSON.parse(saved));
            } catch {
                // ignore parsing error
            }
        }
        setTimeout(() => inputRef.current?.focus(), 300);

        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, []);

    useEffect(() => {
        if (query.trim().length < 1 || hasSearched) {
            setKeywordSuggestions([]);
            return;
        }
        const filtered = SUGGESTED_KEYWORDS.filter(k => k.includes(query)).slice(0, 6);
        setKeywordSuggestions(filtered);
    }, [query, hasSearched]);

    const performSearch = async (keyword: string) => {
        const trimmed = keyword.trim();
        if (!trimmed) return;

        // Cancel previous request if still pending
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        const controller = new AbortController();
        abortControllerRef.current = controller;

        setIsSearching(true);
        setHasSearched(true);
        setKeywordSuggestions([]); 

        try {
            const contextCoord = searchMode === 'MY' && userLocation ? userLocation : mapCenter;
            const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=kr&q=${encodeURIComponent(trimmed)}`;
            
            const response = await fetch(url, {
                headers: {
                    'Accept-Language': 'ko'
                },
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                const mapped: SearchItem[] = data.slice(0, 5).map((item: any) => {
                    const displayName = typeof item.display_name === 'string' ? item.display_name : '';
                    const nameCandidate = (typeof item.name === 'string' && item.name.trim().length > 0)
                        ? item.name.trim()
                        : (displayName.split(',')[0]?.trim() || displayName);
                    const latNum = parseFloat(item.lat);
                    const lngNum = parseFloat(item.lon);

                    const distanceStr = contextCoord && !isNaN(latNum) && !isNaN(lngNum)
                        ? calculateDistanceMeters(contextCoord.lat, contextCoord.lng, latNum, lngNum)
                        : undefined;

                    return {
                        name: nameCandidate || displayName,
                        address: displayName,
                        lat: latNum,
                        lng: lngNum,
                        distance: distanceStr,
                        category: item.type || item.category
                    };
                });
                setResults(mapped);
            } else {
                setResults([]);
                setShake(true);
                setTimeout(() => setShake(false), 500);
            }
        } catch (e: any) {
            if (e && e.name === 'AbortError') {
                return;
            }
            setResults([]);
            setShake(true);
            setTimeout(() => setShake(false), 500);
        } finally {
            if (abortControllerRef.current === controller) {
                setIsSearching(false);
            }
        }
    };

    const handleSearchModeChange = (mode: 'MY' | 'MAP') => {
        setSearchMode(mode);
        const contextCoord = mode === 'MY' && userLocation ? userLocation : mapCenter;
        if (contextCoord) {
            setResults(prev => prev.map(item => ({
                ...item,
                distance: !isNaN(item.lat) && !isNaN(item.lng)
                    ? calculateDistanceMeters(contextCoord.lat, contextCoord.lng, item.lat, item.lng)
                    : item.distance
            })));
        }
    };

    const handleSelectPlace = (item: SearchItem) => {
        const newHistory = [item, ...history.filter(h => h.name !== item.name)].slice(0, 5);
        setHistory(newHistory);
        localStorage.setItem('search_history_kakao', JSON.stringify(newHistory));
        onSelectPlace(item.lat, item.lng);
    };

    return (
        <div className={`fixed inset-0 z-[5000] flex flex-col ${isDark ? 'bg-night-900 text-white' : 'bg-white text-gray-900'} animate-fade-in`}>
            <div className={`p-4 flex items-center gap-3 border-b ${isDark ? 'border-gray-800' : 'border-gray-100'}`}>
                <button onClick={onClose} className="p-2 -ml-2 active:scale-90 transition-transform">
                    <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                </button>
                <form onSubmit={(e) => { e.preventDefault(); performSearch(query); }} className={`flex-1 flex items-center rounded-2xl overflow-hidden px-3 transition-all ${isDark ? 'bg-gray-800' : 'bg-gray-100'} ${shake ? 'animate-shake border border-red-500/50' : 'border border-transparent'}`}>
                    <input ref={inputRef} type="text" value={query} onChange={(e) => { setQuery(e.target.value); if (!e.target.value) { setResults([]); setHasSearched(false); } }} placeholder={language === 'KO' ? "장소, 브랜드, 카테고리 검색" : "Search places"} className="w-full p-3 bg-transparent outline-none font-bold text-sm" />
                    {query && <button type="button" onClick={() => { setQuery(''); setResults([]); setHasSearched(false); }} className="p-1 text-gray-400"><svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg></button>}
                </form>
                <button onClick={() => performSearch(query)} className="bg-night-accent text-white p-3 rounded-2xl active:scale-90 shadow-lg shadow-night-accent/20"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg></button>
            </div>

            {hasSearched && results.length > 0 && (
                <div className={`flex p-2 gap-1 animate-fade-in-up ${isDark ? 'bg-night-800/30' : 'bg-gray-50'}`}>
                    <button onClick={() => handleSearchModeChange('MY')} className={`flex-1 py-3 rounded-xl text-[11px] font-black transition-all flex items-center justify-center gap-2 ${searchMode === 'MY' ? (isDark ? 'bg-night-700 text-night-accent shadow-xl' : 'bg-white shadow-md text-night-accent') : 'text-gray-500 opacity-50'}`}>
                        {language === 'KO' ? "내 주변 거리순" : "NEAR ME"}
                    </button>
                    <button onClick={() => handleSearchModeChange('MAP')} className={`flex-1 py-3 rounded-xl text-[11px] font-black transition-all flex items-center justify-center gap-2 ${searchMode === 'MAP' ? (isDark ? 'bg-night-700 text-night-accent shadow-xl' : 'bg-white shadow-md text-night-accent') : 'text-gray-500 opacity-50'}`}>
                        {language === 'KO' ? "지도 중심 거리순" : "MAP CENTER"}
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto no-scrollbar">
                {keywordSuggestions.length > 0 && !hasSearched && (
                    <div className="p-5 animate-fade-in">
                        <h3 className="text-[10px] font-black text-gray-500 uppercase mb-5 ml-1 tracking-[0.25em] opacity-40">
                            {language === 'KO' ? '추천 검색어' : 'Quick Recommendations'}
                        </h3>
                        <div className="flex flex-wrap gap-2.5">
                            {keywordSuggestions.map((k, i) => (
                                <button key={i} onClick={() => { setQuery(k); performSearch(k); }} className={`px-5 py-3 rounded-2xl text-xs font-bold border transition-all active:scale-95 ${isDark ? 'border-gray-700 bg-night-800 text-gray-300' : 'border-gray-200 bg-gray-50 text-gray-600'}`}>#{k}</button>
                            ))}
                        </div>
                    </div>
                )}

                {results.length > 0 ? (
                    <div className="p-4 space-y-3 animate-fade-in">
                        <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest opacity-50 mb-4 px-1">
                            {searchMode === 'MY' ? (language === 'KO' ? '내 주변 검색 결과' : 'Near Your Loc') : (language === 'KO' ? '지도 중심 검색 결과' : 'Near Map Center')}
                        </h3>
                        {results.map((r, i) => (
                            <div key={i} onClick={() => handleSelectPlace(r)} className={`p-5 rounded-3xl flex flex-col gap-1.5 active:scale-[0.98] transition-transform border ${isDark ? 'bg-night-800/40 border-gray-800' : 'bg-white shadow-sm border-gray-100'}`}>
                                <div className="flex justify-between items-start">
                                    <span className="font-bold text-sm flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-night-accent"></div>{r.name}</span>
                                    {r.distance && <span className="text-[10px] font-black text-night-accent bg-night-accent/10 px-2 py-0.5 rounded-full">{parseInt(r.distance) > 1000 ? `${(parseInt(r.distance)/1000).toFixed(1)}km` : `${r.distance}m`}</span>}
                                </div>
                                <span className="text-[11px] text-gray-500 truncate pl-3.5 leading-relaxed">{r.address}</span>
                                {r.category && <span className="text-[9px] font-bold text-gray-600 opacity-40 uppercase tracking-tighter pl-3.5">{r.category}</span>}
                            </div>
                        ))}
                    </div>
                ) : null}

                {(!hasSearched || (hasSearched && results.length === 0)) && (
                    <div className="p-4 space-y-8">
                        {history.length > 0 && (
                            <section className="animate-fade-in">
                                <h3 className="text-[10px] font-black text-gray-500 uppercase mb-5 ml-1 tracking-[0.25em] opacity-40">
                                    {language === 'KO' ? '최근 검색 기록' : 'Recent History'}
                                </h3>
                                <div className="space-y-3">
                                    {history.map((h, i) => (
                                        <div key={i} onClick={() => handleSelectPlace(h)} className={`p-5 rounded-[2rem] flex items-center justify-between active:bg-night-accent/5 border ${isDark ? 'border-gray-800 bg-night-800/20' : 'border-gray-100 bg-gray-50/50'}`}>
                                            <div className="flex flex-col gap-0.5"><span className="font-bold text-sm">{h.name}</span><span className="text-[10px] text-gray-500">{h.address}</span></div>
                                            <div className="bg-gray-500/10 p-2 rounded-full"><svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg></div>
                                        </div>
                                    ))}
                                </div>
                            </section>
                        )}
                        <section className={`p-10 rounded-[3rem] text-center border-2 border-dashed ${isDark ? 'border-gray-800 bg-night-800/10' : 'border-gray-100 bg-gray-50/30'} transition-all`}>
                            {isSearching ? (
                                <div className="flex flex-col items-center gap-5">
                                    <div className="w-12 h-12 border-4 border-night-accent border-t-transparent rounded-full animate-spin"></div>
                                    <p className="text-[11px] font-black text-night-accent animate-pulse tracking-[0.2em] uppercase">
                                        {language === 'KO' ? '지도 데이터 조회 중...' : 'Connecting API...'}
                                    </p>
                                </div>
                            ) : (
                                <>
                                    <div className="text-5xl mb-6 grayscale opacity-20 filter saturate-0">📍</div>
                                    <p className="text-[11px] text-gray-500 leading-relaxed font-black break-keep uppercase tracking-tighter">
                                        {hasSearched && results.length === 0 
                                            ? (language === 'KO' ? "검색 결과가 없습니다.\n다른 반경이나 키워드를 시도해보세요." : "No results found.")
                                            : (language === 'KO' ? "궁금한 장소나 건물명을 입력해주세요.\n실시간 정밀 안전 지도를 분석해드립니다." : "Enter a place name to start.")}
                                    </p>
                                </>
                            )}
                        </section>
                    </div>
                )}
            </div>
            <div className="p-3 text-center border-t border-gray-500/10 opacity-30 select-none">
                <span className="text-[8px] font-bold tracking-widest uppercase">Powered by OpenStreetMap</span>
            </div>
        </div>
    );
};
export default SearchOverlay;
