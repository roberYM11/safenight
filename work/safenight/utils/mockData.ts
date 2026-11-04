import { RouteData, Coordinate } from '../types';

// Seoul coordinates
export const SEOUL_CENTER: Coordinate = { lat: 37.5665, lng: 126.9780 };

// Helper to generate path points
const generatePath = (start: Coordinate, end: Coordinate, deviation: number): Coordinate[] => {
  const points: Coordinate[] = [start];
  const steps = 10;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    points.push({
      lat: start.lat + (end.lat - start.lat) * t + (Math.random() - 0.5) * deviation,
      lng: start.lng + (end.lng - start.lng) * t + (Math.random() - 0.5) * deviation
    });
  }
  points.push(end);
  return points;
};

export const MOCK_ROUTES: RouteData[] = [
  {
    id: 'route_1',
    type: 'RECOMMEND',
    label: '추천 경로 (가장 안전)',
    safety_score: 85,
    distance: 1200,
    duration: 900,
    path: generatePath(SEOUL_CENTER, { lat: 37.5547, lng: 126.9707 }, 0.005),
    stats: {
      total_cctv: 12,
      avg_brightness: 250,
      avg_noise: 45,
      dark_segments: 0
    },
    tags: ['CCTV 많음', '큰 도로 위주']
  },
  {
    id: 'route_2',
    type: 'FASTEST',
    label: '빠른 경로',
    safety_score: 68,
    distance: 900,
    duration: 660,
    path: generatePath(SEOUL_CENTER, { lat: 37.5547, lng: 126.9707 }, 0.002),
    stats: {
      total_cctv: 6,
      avg_brightness: 180,
      avg_noise: 55,
      dark_segments: 1
    },
    tags: ['일부 골목길']
  },
  {
    id: 'route_3',
    type: 'SHORTEST',
    label: '최단 경로 (비추천)',
    safety_score: 42,
    distance: 700,
    duration: 540,
    path: generatePath(SEOUL_CENTER, { lat: 37.5547, lng: 126.9707 }, 0.001),
    stats: {
      total_cctv: 2,
      avg_brightness: 50,
      avg_noise: 30,
      dark_segments: 3
    },
    tags: ['어두운 골목', '인적 드뭄']
  }
];

export const getSafetyColor = (score: number) => {
  if (score >= 80) return '#10B981'; // Safe
  if (score >= 60) return '#F59E0B'; // Caution
  return '#EF4444'; // Danger
};

export const getSafetyGradient = (score: number) => {
  if (score >= 80) return 'linear-gradient(90deg, #10B981, #34D399)';
  if (score >= 60) return 'linear-gradient(90deg, #F59E0B, #FBBF24)';
  return 'linear-gradient(90deg, #EF4444, #F87171)';
};
