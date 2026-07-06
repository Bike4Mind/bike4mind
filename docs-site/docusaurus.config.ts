import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'Bike4Mind Documentation',
  tagline: 'Your bicycle for the mind in the age of AI',
  favicon: 'img/favicon.ico',

  // Use DOCS_URL from environment (set by SST) or fallback to production
  url: process.env.DOCS_URL || 'https://docs.bike4mind.com',
  baseUrl: '/',

  organizationName: 'bike4mind',
  projectName: 'docs',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/', // Serve docs at the root
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        language: ['en'],
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
      },
    ],
  ],

  themeConfig: {
    image: 'img/b4m-wordmark-light.png',
    navbar: {
      title: 'Bike4Mind Docs',
      logo: {
        alt: 'Bike4Mind Logo',
        src: 'img/b4m-logo.png',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Documentation',
          to: '/',
        },
        {
          to: '/features/overview',
          label: 'Features',
          position: 'left',
        },
        {
          to: '/self-host',
          label: 'Self-Hosting',
          position: 'left',
        },
        {
          href: 'https://github.com/bike4mind/bike4mind',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      logo: {
        alt: 'Bike4Mind',
        src: 'img/b4m-wordmark-dark.png',
        href: 'https://bike4mind.com',
        width: 220,
      },
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Getting Started',
              to: '/getting-started',
            },
            {
              label: 'Features',
              to: '/features/overview',
            },
            {
              label: 'Self-Hosting',
              to: '/self-host',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub Discussions',
              href: 'https://github.com/bike4mind/bike4mind/discussions',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'App',
              href: 'https://app.bike4mind.com',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/bike4mind/bike4mind',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Bike4Mind, Inc. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'diff', 'json'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
