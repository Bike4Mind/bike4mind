export {};

declare global {
  interface Window {
    /**
     * The analytics_storage state GA had when it recorded this page: set by the inline tag
     * before the landing page_view, and moved to 'granted' once a later grant has recorded
     * the page again (see CookieConsentBanner).
     */
    __b4mGaConsentDefault?: 'granted' | 'denied';
  }
}
