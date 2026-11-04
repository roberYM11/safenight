"use client";

import dynamic from "next/dynamic";

const SafetyMap = dynamic(
  () => import("./pages/SafetyMap").then(module => module.SafetyMap),
  {
    ssr: false,
    loading: () => <main className="safety-app" aria-busy="true"><p className="empty-state" role="status">지도를 불러오고 있습니다.</p></main>,
  },
);

export function SafeNightClient() {
  return <SafetyMap />;
}
