
import React, { useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Onboarding from './pages/Onboarding';
import Settings from './pages/Settings';
import About from './pages/About';
import EmergencyView from './pages/EmergencyView';
import { ThemeProvider } from './context/ThemeContext';
import { SettingsProvider } from './context/SettingsContext';
import { loadSafetyData } from './utils/safetyData';

const RootRedirect = () => {
  const completed = localStorage.getItem('onboarding_completed');
  return completed ? <Navigate to="/home" replace /> : <Navigate to="/onboarding" replace />;
};

const App: React.FC = () => {
  // 앱 구동 시 안전 데이터베이스 로드
  useEffect(() => {
    loadSafetyData();
  }, []);

  return (
    <ThemeProvider>
      <SettingsProvider>
        <HashRouter>
          <Routes>
            <Route path="/" element={<RootRedirect />} />
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/home" element={<Home />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/about" element={<About />} />
            <Route path="/emergency-view" element={<EmergencyView />} />
            {/* 경로 안내(RouteResult) 라우트 삭제됨 */}
          </Routes>
        </HashRouter>
      </SettingsProvider>
    </ThemeProvider>
  );
};

export default App;
