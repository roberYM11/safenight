import type { Metadata } from "next";
import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "SafeNight | 실험용 환경 안전도",
  description: "주변 관측 지점의 실험용 환경 안전도와 조도·소음을 확인하는 지도",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
