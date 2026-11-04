
import Papa from 'papaparse';

export interface SafetyPoint {
  lat: number;
  lng: number;
  score: number;
  cctvCount: number;
  avgBrightness: number;
}

let safetyPoints: SafetyPoint[] = [];
let isLoaded = false;

const FALLBACK_POINTS: SafetyPoint[] = [
    { lat: 37.5665, lng: 126.9780, score: 85, cctvCount: 5, avgBrightness: 50 },
    { lat: 37.4979, lng: 127.0276, score: 90, cctvCount: 8, avgBrightness: 70 }
];

export const loadSafetyData = async () => {
    if (isLoaded) return;
    try {
        const response = await fetch('./CSV_FILE/test_SDOT_ALL_averaged.csv.csv');
        if (!response.ok) throw new Error(`DB Fetch failed`);
        const csvText = await response.text();
        updateSafetyData(csvText);
    } catch (error) {
        if (safetyPoints.length === 0) {
             safetyPoints = [...FALLBACK_POINTS];
             window.dispatchEvent(new Event('safety-data-updated'));
        }
    }
};

export const updateSafetyData = (csvText: string) => {
    Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
        complete: (results) => {
            const rawData = results.data as any[];
            
            safetyPoints = rawData
                .map(row => {
                    let lat = row['위도'];
                    let lng = row['경도'];

                    // 지능형 좌표 교정: 위도와 경도가 바뀌어 들어온 경우 자동 스왑
                    // 한국 영토: 위도 33~39 / 경도 124~132
                    if (lat > 100 && lng < 100) {
                        const temp = lat;
                        lat = lng;
                        lng = temp;
                    }

                    return {
                        lat: Number(lat),
                        lng: Number(lng),
                        score: Number(row['safety_index'] || 0),
                        cctvCount: Number(row['CCTV_개수_25m'] || 0),
                        avgBrightness: Number(row['조도 평균(lux)'] || 0)
                    };
                })
                .filter(p => 
                    !isNaN(p.lat) && p.lat >= 33 && p.lat <= 43 &&
                    !isNaN(p.lng) && p.lng >= 124 && p.lng <= 132
                );

            isLoaded = true;
            window.dispatchEvent(new Event('safety-data-updated'));
        }
    });
};

export const getSafetyData = (): SafetyPoint[] => safetyPoints;

export const getNearestSafetyPoint = (lat: number, lng: number): SafetyPoint | null => {
  if (safetyPoints.length === 0) return null;
  let minDist = Infinity;
  let nearest: SafetyPoint | null = null;

  for (const point of safetyPoints) {
    const dLat = point.lat - lat;
    const dLng = point.lng - lng;
    const dist = dLat * dLat + dLng * dLng;
    if (dist < minDist) {
      minDist = dist;
      nearest = point;
    }
  }
  // 약 500m 이내 데이터만 유효한 것으로 간주 (0.005도)
  return minDist < 0.000025 ? nearest : null; 
};
