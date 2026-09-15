import React, { useEffect } from 'react';

type HighlanderFocusProps = {
  targetId: string;
};

const HighlanderFocus: React.FC<HighlanderFocusProps> = ({ targetId }) => {
  useEffect(() => {
    const handleKeyPressGlobal = (e: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement;
      if (activeElement.tagName !== 'INPUT' && activeElement.tagName !== 'TEXTAREA') {
        const target = document.getElementById(targetId) as HTMLInputElement;
        if (target) {
          target.focus();
          target.value += e.key; // Or handle input value in a more React-friendly way
        }
      }
    };
    window.addEventListener('keypress', handleKeyPressGlobal);
    return () => {
      window.removeEventListener('keypress', handleKeyPressGlobal);
    };
  }, [targetId]);

  return null;
};

export default HighlanderFocus;
