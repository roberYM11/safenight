
export interface Coordinate {
  lat: number;
  lng: number;
  heading?: number; // 기기 방향 (0~360도)
}

export interface RouteStats {
  total_cctv: number;
  avg_brightness: number; // lux
  avg_noise: number; // dB
  dark_segments: number;
}

export interface RouteData {
  id: string;
  type: 'RECOMMEND' | 'FASTEST' | 'SHORTEST';
  label: string;
  safety_score: number;
  distance: number; // meters
  duration: number; // seconds
  path: Coordinate[];
  stats: RouteStats;
  tags: string[];
}

export interface EmergencyContact {
  id: string;
  name: string;
  phone: string;
}

export enum SafetyGrade {
  SAFE = 'SAFE',
  CAUTION = 'CAUTION',
  DANGER = 'DANGER',
}

export interface UserLocation {
  coords: Coordinate;
  accuracy?: number;
}
