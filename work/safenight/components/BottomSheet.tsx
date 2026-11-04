
import React, { useState, useRef } from 'react';
import { useTheme } from '../context/ThemeContext';

interface BottomSheetProps {
  children: React.ReactNode;
  initialHeight?: string;
  className?: string;
  isOpen?: boolean;
}

type SnapState = 'min' | 'mid' | 'max';

const BottomSheet: React.FC<BottomSheetProps> = ({ children, initialHeight = '40%', className = '', isOpen = true }) => {
  const [snapState, setSnapState] = useState<SnapState>('mid');
  const sheetRef = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();

  if (!isOpen) return null;

  // Calculate height based on state
  let height = initialHeight;
  if (snapState === 'max') height = '85vh';
  if (snapState === 'min') height = '36px'; // Very slim, just enough for the handle

  // Enhanced Glassmorphism styles
  // The user requested the bar to be transparent.
  const bgStyles = theme === 'dark' 
    ? 'bg-gradient-to-b from-night-900/40 via-night-900/80 to-night-900/95 backdrop-blur-md border-t border-white/10 shadow-[0_-4px_30px_rgba(0,0,0,0.5)]' 
    : 'bg-gradient-to-b from-white/40 via-white/80 to-white/95 backdrop-blur-md border-t border-white/30 shadow-[0_-4px_30px_rgba(0,0,0,0.1)]';
  
  return (
    <div 
      ref={sheetRef}
      className={`fixed bottom-0 left-0 right-0 rounded-t-3xl z-[2000] transition-all duration-500 cubic-bezier(0.32, 0.72, 0, 1) ${bgStyles} ${className}`}
      style={{ 
        height: height,
        touchAction: 'none',
        overflow: 'hidden'
      }}
    >
      {/* Drag Handle Area */}
      <div 
        className="w-full h-[36px] flex items-start justify-center cursor-pointer pt-3 absolute top-0 left-0 right-0 z-20 group"
        onClick={() => {
            // Logic: Toggle between Mid (Default) and Min (Hidden).
            // This satisfies "pull down to hide, pull up to show" logic via click.
            setSnapState(prev => prev === 'mid' ? 'min' : 'mid');
        }}
      >
        <div className="flex flex-col items-center w-full h-full">
            {/* Handle bar */}
            <div className={`w-12 h-1.5 rounded-full transition-colors mb-1 ${theme === 'dark' ? 'bg-gray-400/50 group-hover:bg-gray-400/80' : 'bg-gray-500/40 group-hover:bg-gray-500/60'}`}></div>
            
            {/* Optional indicator text or icon could go here, but keeping it clean for transparency */}
        </div>

        {/* Maximize Button (Top Right) - Optional way to reach full screen */}
        {snapState === 'mid' && (
            <button 
                onClick={(e) => {
                    e.stopPropagation();
                    setSnapState('max');
                }}
                className="absolute right-4 top-2 p-1 opacity-50 hover:opacity-100 transition-opacity"
            >
                <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                </svg>
            </button>
        )}
        {snapState === 'max' && (
            <button 
                onClick={(e) => {
                    e.stopPropagation();
                    setSnapState('mid');
                }}
                className="absolute right-4 top-2 p-1 opacity-50 hover:opacity-100 transition-opacity"
            >
                <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
            </button>
        )}
      </div>
      
      {/* Content Area */}
      <div 
        className={`h-full overflow-y-auto px-4 pb-12 pt-[40px] no-scrollbar transition-opacity duration-300 ${snapState === 'min' ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
      >
        {children}
      </div>
    </div>
  );
};

export default BottomSheet;
