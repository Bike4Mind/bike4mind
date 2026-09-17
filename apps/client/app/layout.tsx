import '@/app/globals.css';
import Script from 'next/script';
import { ReactNode } from 'react';
import { Source_Serif_4, Libre_Franklin, JetBrains_Mono } from 'next/font/google';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter';
import { ClientProviders } from './providers';
import { ColorSchemeScript } from './ColorSchemeScript';
import { SerwistProvider } from './serwist';
import { Metadata } from 'next';

// Pins the GA cookie to an apex instead of gtag's 'auto' default; unset is a
// deliberate no-op. See infra/web.ts for why a wrong value is worse than unset.
const GA_COOKIE_DOMAIN = process.env.NEXT_PUBLIC_GA_COOKIE_DOMAIN;

// The app's UI face, applied to <html>. A Franklin Gothic revival, and a text
// face first: it sets reply prose as well as interface chrome, so it has to hold
// up in a paragraph and in a 12px sidebar label alike.
//
// It replaces Poppins, a geometric display face. Poppins is built on near-perfect
// circles with a uniform stroke, which is why it reads well large and poorly
// small: b/d/p/q/o become the same silhouette, and word-shape recognition is what
// fluent reading runs on. A grotesque varies its letterforms by design, so those
// silhouettes stay distinct - and being a grotesque rather than a geometric, it
// sits under the serif that sets reply headings instead of arguing with it.
//
// A variable font: omitting `weight` ships the whole axis in one file, so a
// weight the UI asks for is always a real cut rather than a synthesised one.
//
// Also exposed as a variable: observatory.css reads the UI face through
// `--joy-fontFamily-body`, but tests and any surface rendering that stylesheet
// without the root layout fall back to the variable.
const uiSans = Libre_Franklin({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  display: 'swap',
  preload: true,
  variable: '--font-reading-sans',
});

// Reading faces for long-form rendered markdown. Exposed as CSS variables
// rather than applied to <html>, so they reach only the surfaces that opt in.
// Both are variable fonts: omitting `weight` ships the whole range in one file,
// and the serif carries an optical size axis that the browser applies
// automatically from font-size.
const sourceSerif = Source_Serif_4({
  subsets: ['latin'],
  style: ['normal', 'italic'],
  axes: ['opsz'],
  display: 'swap',
  preload: true,
  variable: '--font-reading-serif',
});

// Not preloaded: mono only appears once a reply contains code, a table or a
// figure, so it should not compete with the serif on first paint.
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  variable: '--font-reading-mono',
});

export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const dynamic = 'force-static';

export const metadata: Metadata = {
  other: {
    'link rel="stylesheet"': 'https://fonts.googleapis.com/icon?family=Material+Icons',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${uiSans.className} ${sourceSerif.variable} ${uiSans.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ColorSchemeScript />
        {process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}`}
              strategy="afterInteractive"
            />
            <Script id="google-analytics" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('consent', 'default', { analytics_storage: 'denied' });
                gtag('js', new Date());
                gtag('config', '${process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}'${
                  GA_COOKIE_DOMAIN ? `, { cookie_domain: '${GA_COOKIE_DOMAIN}' }` : ''
                });
              `}
            </Script>
          </>
        )}
        <Script id="mailerlite" strategy="afterInteractive">
          {`
            // Load mailerlite script
            (function(m,l,s,c){m[l]=m[l]||function(){(m[l].q=m[l].q||[]).push(arguments)};
            m[l].s=Date.now();c=s.createElement('script');c.async=1;c.src='/scripts/ml.js';
            s.getElementsByTagName('head')[0].appendChild(c);})(window,'ml',document);
          `}
        </Script>
        <AppRouterCacheProvider options={{ key: 'joy' }}>
          <SerwistProvider swUrl="/serwist/sw.js">
            <ClientProviders>{children}</ClientProviders>
          </SerwistProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}
