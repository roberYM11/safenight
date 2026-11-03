
import React, { createContext, useContext, useState, useEffect } from 'react';
import { EmergencyContact } from '../types';

type Language = 'KO' | 'EN';

interface SettingsContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  emergencyContacts: EmergencyContact[];
  saveContacts: (contacts: EmergencyContact[]) => void;
}

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

// 쿠키 헬퍼 (CEO 지시: 쿠키 저장 명시)
const setCookie = (name: string, value: string, days: number) => {
  let expires = "";
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    expires = "; expires=" + date.toUTCString();
  }
  // samesite=lax 및 path=/ 설정으로 안정성 확보
  document.cookie = `${name}=${value || ""}${expires}; path=/; SameSite=Lax`;
};

const getCookie = (name: string) => {
  const nameEQ = name + "=";
  const ca = document.cookie.split(';');
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
};

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguage] = useState<Language>(() => {
    return (localStorage.getItem('app_lang') as Language) || 'KO';
  });

  const [emergencyContacts, setEmergencyContacts] = useState<EmergencyContact[]>([]);

  useEffect(() => {
    localStorage.setItem('app_lang', language);
  }, [language]);

  // 초기 로드: 쿠키에서 연락처 불러오기
  useEffect(() => {
    const savedCookie = getCookie('emergency_contacts');
    if (savedCookie) {
      try {
        const parsed = JSON.parse(decodeURIComponent(savedCookie));
        setEmergencyContacts(parsed);
      } catch (e) {
        console.error("Cookie parse error, attempting localStorage fallback");
        // 폴백: 쿠키가 깨졌을 경우 로컬스토리지 확인
        const fallback = localStorage.getItem('emergency_contacts_fallback');
        if (fallback) setEmergencyContacts(JSON.parse(fallback));
      }
    }
  }, []);

  const saveContacts = (contacts: EmergencyContact[]) => {
    setEmergencyContacts(contacts);
    const serialized = encodeURIComponent(JSON.stringify(contacts));
    
    // 1. 쿠키 저장 (요청 사항)
    setCookie('emergency_contacts', serialized, 365);
    
    // 2. 로컬스토리지 이중 백업 (안정성 확보)
    localStorage.setItem('emergency_contacts_fallback', JSON.stringify(contacts));
    
    console.log("Contacts saved to Cookie & Storage:", contacts);
  };

  return (
    <SettingsContext.Provider value={{ language, setLanguage, emergencyContacts, saveContacts }}>
      {children}
    </SettingsContext.Provider>
  );
};

export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
};
