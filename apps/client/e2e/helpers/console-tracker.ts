import { type Page, type ConsoleMessage } from '@playwright/test';

const IGNORED_PATTERNS = [
  'ResizeObserver loop',
  'ServiceWorker',
  'service-worker',
  'workbox',
  'sw.js',
  'swe-worker',
  '[HMR]',
  'Fast Refresh',
  'Download the React DevTools',
];

interface ConsoleError {
  type: string;
  text: string;
  url: string;
  timestamp: number;
}

export class ConsoleTracker {
  private errors: ConsoleError[] = [];
  private page: Page;

  constructor(page: Page) {
    this.page = page;
    this.attach();
  }

  private attach() {
    this.page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (this.isIgnored(text)) return;

        this.errors.push({
          type: 'console.error',
          text,
          url: this.page.url(),
          timestamp: Date.now(),
        });
      }
    });

    this.page.on('pageerror', (error: Error) => {
      const text = error.message;
      if (this.isIgnored(text)) return;

      this.errors.push({
        type: 'pageerror',
        text,
        url: this.page.url(),
        timestamp: Date.now(),
      });
    });
  }

  private isIgnored(text: string): boolean {
    return IGNORED_PATTERNS.some(pattern => text.includes(pattern));
  }

  getErrors(): ConsoleError[] {
    return [...this.errors];
  }

  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  clear() {
    this.errors = [];
  }
}
