export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function statusText(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    SCORED: "계산 완료", MODEL_UNAVAILABLE: "점수 서비스 준비 중", DATA_UNAVAILABLE: "관측값 부족",
    STALE: "최신 관측값 없음", SCHEMA_MISMATCH: "점수 산출 불가",
    UNSUPPORTED: "점수 제공 범위 밖", MODEL_ERROR: "점수 조회 실패",
  };
  return labels[status] ?? "산출 불가";
}

export function scoreTone(score: number | null): string {
  if (score === null) return "missing";
  if (score >= 80) return "high";
  if (score >= 50) return "mid";
  return "low";
}

export function formatDistance(value: number): string {
  return value < 1000 ? `${Math.round(value)}m` : `${(value / 1000).toFixed(1)}km`;
}
