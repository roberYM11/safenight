import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { Sensor } from "../utils/api";
import { scoreTone } from "../utils/format";

export type MapFocus = { readonly lat: number; readonly lon: number; readonly key: number };
type Props = {
  readonly sensors: readonly Sensor[];
  readonly selectedId: Sensor["sensor_id"] | null;
  readonly focus: MapFocus | null;
  readonly target: { readonly name: string; readonly lat: number; readonly lon: number } | null;
  readonly onPointSelect: (point: { readonly lat: number; readonly lon: number }) => void;
  readonly onSelect: (sensor: Sensor) => void;
  readonly theme: "dark" | "light";
};

export function SensorMap({ sensors, selectedId, focus, target, onPointSelect, onSelect, theme }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const initializedBounds = useRef(false);
  const pointSelect = useRef(onPointSelect);
  useEffect(() => { pointSelect.current = onPointSelect; }, [onPointSelect]);
  const [tileError, setTileError] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, { zoomControl: false, preferCanvas: true })
      .setView([37.5665, 126.978], 12);
    L.control.zoom({ position: "bottomleft" }).addTo(instance);
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(instance);
    tiles.on("tileerror", () => setTileError(true));
    map.current = instance;
    instance.on("click", (event: L.LeafletMouseEvent) => pointSelect.current({ lat: event.latlng.lat, lon: event.latlng.lng }));
    markers.current = L.layerGroup().addTo(instance);
    const observer = new ResizeObserver(() => instance.invalidateSize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      instance.remove();
      map.current = null;
      markers.current = null;
      initializedBounds.current = false;
    };
  }, []);

  useEffect(() => {
    const group = markers.current;
    if (!group) return;
    group.clearLayers();
    const styles = getComputedStyle(container.current ?? document.documentElement);
    for (const sensor of sensors) {
      const color = styles.getPropertyValue(`--marker-${scoreTone(sensor.score)}`).trim();
      const selected = selectedId === sensor.sensor_id;
      L.circleMarker([sensor.lat, sensor.lon], {
        radius: selected ? 12 : 7,
        fillColor: color,
        fillOpacity: selected ? 1 : 0.75,
        color: selected ? styles.getPropertyValue("--text").trim() : color,
        weight: selected ? 3 : 1,
        bubblingMouseEvents: false,
      }).on("click", () => onSelect(sensor)).addTo(group);
    }
    if (!initializedBounds.current && sensors.length > 0) {
      map.current?.setView([37.5665, 126.978], 11);
      initializedBounds.current = true;
    }
  }, [sensors, selectedId, onSelect, theme]);

  useEffect(() => {
    if (!focus || !map.current) return;
    map.current.setView([focus.lat, focus.lon], 15, {
      animate: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
  }, [focus]);

  useEffect(() => {
    if (!target || !map.current) return;
    const label = document.createElement("span");
    label.textContent = target.name;
    const pin = L.marker([target.lat, target.lon], { icon: L.divIcon({ className: "place-pin", html: '<span aria-hidden="true"></span>', iconSize: [28, 28], iconAnchor: [14, 28] }), zIndexOffset: 1000 }).bindTooltip(label, { direction: "top", offset: [0, -26], permanent: true }).addTo(map.current);
    const radius = L.circle([target.lat, target.lon], { radius: 1500, weight: 1, dashArray: "5 5", color: "#60a5fa", fillOpacity: 0.035, interactive: false }).addTo(map.current);
    return () => { pin.remove(); radius.remove(); };
  }, [target]);

  return <>
    <div ref={container} className="sensor-map" aria-label="서울시 환경 센서 지도" />
    {tileError && <p className="tile-notice" role="status">배경 지도를 불러오지 못했습니다. 센서 목록에서 선택할 수 있습니다.</p>}
  </>;
}
