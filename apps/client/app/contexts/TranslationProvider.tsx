import { PropsWithChildren, createContext, useEffect } from 'react';
import { I18nextProvider } from 'react-i18next';
import HttpBackend from 'i18next-http-backend';
import LanguageDetector from 'i18next-browser-languagedetector';
import i18next from 'i18next';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import enTranslations from '@client/app/locales/en.json';

export type LanguageContextType = {
  selectedLanguage: string;
  setSelectedLanguage: (locale: string) => void;
};

export const useLanguage = create<{
  language: string;
  setLanguage: (language: string) => void;
}>()(
  persist(
    set => ({
      language: 'en',
      setLanguage: language => set({ language }),
    }),
    {
      name: 'language',
    }
  )
);

export const LanguageContext = createContext<LanguageContextType | null>({
  selectedLanguage: 'en',
  setSelectedLanguage: () => {},
});

// Initialize i18next synchronously at module load time WITHOUT React bindings
// This prevents "change in hook order" errors when useTranslation() is called
// React bindings are provided via I18nextProvider in the component tree
const getStoredLanguage = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return JSON.parse(localStorage.getItem('language') || '{}')?.state?.language || null;
  } catch {
    return null;
  }
};

const storedLanguage = getStoredLanguage();

// Initialize WITHOUT initReactI18next - use I18nextProvider instead to avoid
// useInsertionEffect scheduling updates during MUI/Emotion style injection
i18next
  .use(HttpBackend)
  .use(LanguageDetector)
  .init({
    // Bundle English translations inline to eliminate HTTP request delay
    resources: {
      en: {
        translation: enTranslations,
      },
    },
    supportedLngs: [
      'ar',
      'bn',
      'ceb',
      'da',
      'de',
      'en',
      'es',
      'fil',
      'fr',
      'hi',
      'id',
      'it',
      'ja',
      'ko',
      'nl',
      'pl',
      'pt',
      'ru',
      'sv',
      'th',
      'tl',
      'tr',
      'uk',
      'ur',
      'vi',
      'zh-TW',
      'zh-CN',
    ],
    lng: storedLanguage || 'en',
    fallbackLng: {
      default: ['en'],
      'en-US': ['en'],
    },
    load: 'currentOnly',
    // Allow mixing bundled English with backend-loaded languages
    partialBundledLanguages: true,
    backend: {
      loadPath: `/locales/{{lng}}.json`,
    },
    // Make initialization truly synchronous (initAsync replaced initImmediate in i18next v26)
    initAsync: false,
  });

export const TranslationProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [selectedLanguage, setSelectedLanguage] = useLanguage(useShallow(state => [state.language, state.setLanguage]));

  // Update i18next language when user changes language preference
  useEffect(() => {
    if (i18next.language !== selectedLanguage) {
      i18next.changeLanguage(selectedLanguage);
    }
  }, [selectedLanguage]);

  return (
    <I18nextProvider i18n={i18next}>
      <LanguageContext.Provider value={{ selectedLanguage, setSelectedLanguage }}>{children}</LanguageContext.Provider>
    </I18nextProvider>
  );
};

export default TranslationProvider;
