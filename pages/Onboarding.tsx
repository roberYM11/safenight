
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../context/SettingsContext';

const Onboarding: React.FC = () => {
  const [currentSlide, setCurrentSlide] = useState(0);
  const navigate = useNavigate();
  const { language } = useSettings();

  const slides = [
    {
      title: language === 'KO' ? "이 지역, 정말 안전할까?" : "Is this area really safe?",
      description: language === 'KO' ? "CCTV 개수와 가로등 조도 데이터를\n실시간으로 분석해 알려드려요." : "We analyze CCTV and streetlight data\nto audit area safety in real-time.",
      icon: (
        <svg className="w-32 h-32 text-night-accent mb-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )
    },
    {
      title: language === 'KO' ? "객관적 데이터 기반 안전 지수" : "Data-Driven Safety Index",
      description: language === 'KO' ? "서울시 전역 25만개 CCTV와 가로등,\n환경 센서 데이터를 종합 분석합니다." : "Analyzes 250k CCTVs, streetlights,\nand S-DoT sensor data across Seoul.",
      icon: (
        <svg className="w-32 h-32 text-night-safe mb-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    },
    {
      title: language === 'KO' ? "위험 구역 데이터 즉시 공유" : "Instant Safety Data Sharing",
      description: language === 'KO' ? "위급 상황 발생 시,\n현재 지역의 안전 진단 결과를 가족에게 보내세요." : "In emergencies, instantly share\narea safety audits with your family.",
      icon: (
        <svg className="w-32 h-32 text-night-danger mb-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      )
    }
  ];

  const handleComplete = () => {
    localStorage.setItem('onboarding_completed', 'true');
    navigate('/home');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-night-900 via-night-800 to-indigo-950 flex flex-col text-white">
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
        <div className="animate-fade-in-up">
            {slides[currentSlide].icon}
        </div>
        <h1 className="text-3xl font-bold mb-4 whitespace-pre-line animate-fade-in">
          {slides[currentSlide].title}
        </h1>
        <p className="text-gray-300 text-lg whitespace-pre-line leading-relaxed mb-8 animate-fade-in">
          {slides[currentSlide].description}
        </p>
        <div className="flex space-x-2 mb-12">
          {slides.map((_, idx) => (
            <div key={idx} className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${idx === currentSlide ? 'bg-night-accent w-6' : 'bg-gray-600'}`} />
          ))}
        </div>
      </div>
      <div className="p-6">
        <button onClick={() => { if (currentSlide < slides.length - 1) setCurrentSlide(curr => curr + 1); else handleComplete(); }} className="w-full bg-white text-night-900 font-bold text-lg py-4 rounded-xl shadow-lg hover:bg-gray-100 transition-colors">
          {currentSlide === slides.length - 1 ? (language === 'KO' ? '시작하기' : 'Start') : (language === 'KO' ? '다음' : 'Next')}
        </button>
        {currentSlide < slides.length - 1 && (
            <button onClick={handleComplete} className="w-full mt-4 text-gray-400 text-sm py-2">{language === 'KO' ? '건너뛰기' : 'Skip'}</button>
        )}
      </div>
    </div>
  );
};
export default Onboarding;
