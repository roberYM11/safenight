
import React, { createContext, useContext, useState, useEffect } from 'react';

type Theme = 'dark' | 'light';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setTheme] = useState<Theme>(() => {
    // 1. Check Local Storage
    const saved = localStorage.getItem('app_theme');
    if (saved) {
      return saved as Theme;
    }
    // 2. Check System Preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    // 3. Default
    return 'light'; 
  });

  useEffect(() => {
    localStorage.setItem('app_theme', theme);
    // Update body background to match theme to avoid flickering
    document.body.style.backgroundColor = theme === 'dark' ? '#111827' : '#F3F4F6';
    document.body.style.color = theme === 'dark' ? 'white' : '#1F2937';
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
