
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmergencyContact } from '../types';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';

const Settings: React.FC = () => {
  const navigate = useNavigate();
  const { theme } = useTheme();
  // Use global settings context for contacts
  const { language, setLanguage, emergencyContacts, saveContacts } = useSettings();

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');

  const handleOpenModal = () => {
      setNewName('');
      setNewPhone('');
      setIsModalOpen(true);
  };

  const handleSaveContact = () => {
    if (!newName.trim() || !newPhone.trim()) {
        return; 
    }

    const newContact: EmergencyContact = {
      id: Date.now().toString(),
      name: newName,
      phone: newPhone
    };
    saveContacts([...emergencyContacts, newContact]);
    setIsModalOpen(false);
  };

  const deleteContact = (id: string) => {
    if(window.confirm(language === 'KO' ? '삭제하시겠습니까?' : 'Delete this contact?')) {
        saveContacts(emergencyContacts.filter(c => c.id !== id));
    }
  };

  const isDark = theme === 'dark';
  const bgColor = isDark ? 'bg-night-900' : 'bg-gray-50';
  const textColor = isDark ? 'text-white' : 'text-gray-900';
  const cardBg = isDark ? 'bg-night-800' : 'bg-white';
  const modalBg = isDark ? 'bg-night-800' : 'bg-white';
  const borderColor = isDark ? 'border-gray-700' : 'border-gray-200';
  const subText = isDark ? 'text-gray-400' : 'text-gray-500';
  const inputBg = isDark ? 'bg-gray-700/50' : 'bg-gray-100';

  return (
    <div className={`min-h-screen ${bgColor} ${textColor}`}>
      {/* Header with explicit navigation to /home */}
      <div className={`p-4 flex items-center border-b ${borderColor} sticky top-0 ${bgColor} z-20`}>
        <button 
          onClick={() => navigate('/home')} 
          className="p-2 -ml-2 active:scale-90 transition-transform"
          aria-label="Go back to home"
        >
            <svg className="w-6 h-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
        </button>
        <h1 className="text-lg font-bold ml-2">{language === 'KO' ? '설정' : 'Settings'}</h1>
      </div>

      <div className="p-4 space-y-8">
        
        {/* Language */}
        <section>
             <h2 className={`text-sm font-medium mb-3 ml-1 ${subText}`}>언어 설정 (Language)</h2>
             <div className={`${cardBg} rounded-xl p-4 flex items-center justify-between border ${borderColor}`}>
                <span className="font-bold">Language</span>
                <div className="flex bg-gray-700 rounded-lg p-1">
                    <button 
                        onClick={() => setLanguage('KO')}
                        className={`px-3 py-1 rounded-md text-sm font-bold transition-all ${language === 'KO' ? 'bg-white text-night-900 shadow' : 'text-gray-400'}`}
                    >
                        KO
                    </button>
                    <button 
                        onClick={() => setLanguage('EN')}
                        className={`px-3 py-1 rounded-md text-sm font-bold transition-all ${language === 'EN' ? 'bg-white text-night-900 shadow' : 'text-gray-400'}`}
                    >
                        EN
                    </button>
                </div>
             </div>
        </section>

        {/* Emergency Contacts */}
        <section>
            <div className="flex justify-between items-center mb-3 px-1">
                 <h2 className={`text-sm font-medium ${subText}`}>
                    {language === 'KO' ? '긴급 연락처' : 'Emergency Contacts'}
                 </h2>
                 <button onClick={handleOpenModal} className="text-night-accent text-sm font-bold flex items-center gap-1 hover:opacity-80 active:scale-95 transition-transform">
                     <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                     </svg>
                     {language === 'KO' ? '추가' : 'Add'}
                 </button>
            </div>
            
            <div className={`${cardBg} rounded-xl border ${borderColor} overflow-hidden divide-y ${isDark ? 'divide-gray-700' : 'divide-gray-100'}`}>
                {emergencyContacts.length === 0 ? (
                    <div className={`p-6 text-center text-sm ${subText}`}>
                        {language === 'KO' ? '등록된 연락처가 없습니다.' : 'No contacts added.'}
                    </div>
                ) : (
                    emergencyContacts.map(contact => (
                        <div key={contact.id} className="p-4 flex justify-between items-center">
                            <div>
                                <div className="font-bold">{contact.name}</div>
                                <div className={`text-sm ${subText}`}>{contact.phone}</div>
                            </div>
                            <button 
                                onClick={() => deleteContact(contact.id)}
                                className="text-red-400 p-2 hover:bg-red-500/10 rounded-full transition-colors active:scale-90"
                            >
                                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                            </button>
                        </div>
                    ))
                )}
            </div>
        </section>

        {/* Alerts (Reduced) */}
        <section>
            <h2 className={`text-sm font-medium mb-3 ml-1 ${subText}`}>
                {language === 'KO' ? '알림 설정' : 'Notifications'}
            </h2>
            <div className={`${cardBg} rounded-xl border ${borderColor} divide-y ${isDark ? 'divide-gray-700' : 'divide-gray-100'}`}>
                <div className="p-4 flex justify-between items-center">
                    <span>{language === 'KO' ? '위험 구간 진입 알림' : 'Danger Zone Alert'}</span>
                    <div className="w-10 h-6 bg-night-safe rounded-full relative cursor-pointer shadow-inner">
                        <div className="w-4 h-4 bg-white rounded-full absolute right-1 top-1 shadow-sm"></div>
                    </div>
                </div>
            </div>
        </section>
      </div>

      {/* Add Contact Modal */}
      {isModalOpen && (
        <div 
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={() => setIsModalOpen(false)} // Close on backdrop click
        >
            <div 
                className={`${modalBg} w-full max-w-sm rounded-2xl p-6 border ${borderColor} shadow-2xl transform transition-all scale-100`}
                onClick={(e) => e.stopPropagation()} // Prevent closing when clicking inside modal
            >
                <div className="flex justify-between items-center mb-6">
                    <h3 className={`text-lg font-bold ${textColor}`}>
                        {language === 'KO' ? '연락처 추가' : 'Add Contact'}
                    </h3>
                    <button onClick={() => setIsModalOpen(false)} className="text-gray-400 hover:text-white p-1">
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                
                <div className="space-y-4">
                    <div>
                        <label className={`block text-xs font-bold mb-1.5 ${subText}`}>
                            {language === 'KO' ? '이름' : 'Name'}
                        </label>
                        <input 
                            type="text" 
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            className={`w-full p-3.5 rounded-xl ${inputBg} border border-gray-500/20 focus:border-night-accent outline-none transition-all ${textColor} placeholder-gray-500`}
                            placeholder={language === 'KO' ? '예: 엄마' : 'e.g. Mom'}
                            autoFocus
                        />
                    </div>
                    <div>
                        <label className={`block text-xs font-bold mb-1.5 ${subText}`}>
                            {language === 'KO' ? '전화번호' : 'Phone'}
                        </label>
                        <input 
                            type="tel" 
                            value={newPhone}
                            onChange={(e) => setNewPhone(e.target.value)}
                            className={`w-full p-3.5 rounded-xl ${inputBg} border border-gray-500/20 focus:border-night-accent outline-none transition-all ${textColor} placeholder-gray-500`}
                            placeholder="010-1234-5678"
                        />
                    </div>
                </div>

                <div className="flex gap-3 mt-8">
                    <button 
                        onClick={() => setIsModalOpen(false)}
                        className={`flex-1 py-3.5 rounded-xl font-bold text-sm bg-gray-500/10 hover:bg-gray-500/20 transition-colors ${textColor}`}
                    >
                        {language === 'KO' ? '취소' : 'Cancel'}
                    </button>
                    <button 
                        onClick={handleSaveContact}
                        disabled={!newName || !newPhone}
                        className={`flex-1 py-3.5 rounded-xl font-bold text-sm shadow-lg transition-all ${
                            !newName || !newPhone 
                            ? 'bg-gray-700 text-gray-400 cursor-not-allowed' 
                            : 'bg-night-accent text-white hover:bg-indigo-600 active:scale-[0.98]'
                        }`}
                    >
                        {language === 'KO' ? '저장' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};

export default Settings;
