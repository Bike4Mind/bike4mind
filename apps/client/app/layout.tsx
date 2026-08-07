import '@/app/globals.css';
import Script from 'next/script';
import { ReactNode } from 'react';
import { Poppins } from 'next/font/google';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v16-appRouter';
import { ClientProviders } from './providers';
import { ColorSchemeScript } from './ColorSchemeScript';
import { SerwistProvider } from './serwist';
import { Metadata } from 'next';

/**
 * Apex to pin the GA cookie to, so the marketing site and this app resolve to ONE
 * visitor across the subdomain hop. gtag defaults to `cookie_domain: 'auto'`,
 * which normally resolves to the same apex - but "normally" is doing a lot of work
 * in a funnel that has been hard to diagnose, so it is worth pinning explicitly.
 *
 * Env-only with NO brand fallback (the account-tied-id policy): unset simply
 * leaves gtag on 'auto', i.e. exactly today's behaviour.
 */
const GA_COOKIE_DOMAIN = process.env.NEXT_PUBLIC_GA_COOKIE_DOMAIN;

const poppins = Poppins({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  display: 'swap',
  preload: true,
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
    <html lang="en" className={poppins.className} suppressHydrationWarning>
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
