import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";

type Props = {
  readonly url: string;
  readonly type: "hls" | "mp4";
  readonly name: string;
  readonly sourceUrl: string | null;
};

export function NearbyVideoPlayer({ url, type, name, sourceUrl }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let hls: Hls | null = null;
    setError(null);

    async function connect() {
      if (!video) return;
      if (type === "mp4" || video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        return;
      }
      try {
        const { default: HlsClient } = await import("hls.js");
        if (cancelled) return;
        if (!HlsClient.isSupported()) {
          setError("이 브라우저는 이 영상 형식을 지원하지 않습니다. 영상 제공처에서 확인해 주세요.");
          return;
        }
        hls = new HlsClient({ maxBufferLength: 10, maxMaxBufferLength: 20 });
        hls.on(HlsClient.Events.ERROR, (_event, data) => {
          if (data.fatal && !cancelled) {
            hls?.destroy();
            hls = null;
            setError("영상을 연결하지 못했습니다. 제공처의 공개 상태나 브라우저 재생 제한을 확인해 주세요.");
          }
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } catch (cause) {
        if (cause instanceof Error) {
          if (!cancelled) setError("영상 재생기를 불러오지 못했습니다. 조회를 닫고 다시 시도해 주세요.");
          return;
        }
        throw cause;
      }
    }

    void connect();
    return () => {
      cancelled = true;
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, type]);

  return <div className="nearby-video">
    <p><strong>{name}</strong> · 실시간 여부 미확인</p>
    <video ref={videoRef} controls playsInline preload="none" aria-label={`${name} 주변 영상`}
      onError={() => setError("이 영상은 현재 재생할 수 없습니다. 영상 제공처에서 확인해 주세요.")} />
    {error ? <p role="alert">{error}</p> : <p className="muted">재생 버튼을 누르면 영상이 시작됩니다. 제공처 지연과 촬영 범위에 따라 현재 현장과 다를 수 있습니다.</p>}
    {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">영상 제공처 열기</a>}
    <p className="muted">통행 인원 분석은 아직 연결되지 않았습니다.</p>
  </div>;
}
