# Content Security Policy (CSP) Implementation

## Overview

This document explains the Content Security Policy (CSP) implementation added to address the penetration testing finding: "CSP: Failure to Define Directive with No Fallback".

## What is CSP?

Content Security Policy is a browser security feature that helps prevent Cross-Site Scripting (XSS) attacks and other code injection attacks. It works by specifying which content sources the browser should consider valid for different types of resources.

## Implementation Details

The CSP has been implemented in `middleware.ts` using Next.js middleware, which intercepts HTTP requests and adds security headers to the responses.

### CSP Directives Used

- **default-src 'self'**: Restricts all content to come from the site's origin by default
- **script-src**: Controls JavaScript sources
- **style-src**: Controls CSS sources
- **img-src**: Controls image sources
- **font-src**: Controls font sources
- **connect-src**: Controls fetch/XHR/WebSocket connections
- **frame-src**: Controls iframes
- **object-src 'none'**: Prevents plugins like Flash or Java
- **media-src**: Controls audio/video
- **base-uri 'self'**: Restricts the base URI for relative URLs

### Additional Security Headers

The implementation also adds other security headers:

- **X-Content-Type-Options**: Prevents MIME-type sniffing
- **X-Frame-Options**: Prevents the page from being framed (clickjacking protection)
- **X-XSS-Protection**: Enables the browser's built-in XSS protection
- **Referrer-Policy**: Controls how much referrer information is sent with requests

## Troubleshooting

If you encounter issues after implementing CSP:

1. Check browser console for CSP violation errors
2. Add the required sources to the appropriate directive in `middleware.ts`
3. Restart the development server after changes

### Common CSP Issues

- **Inline scripts/styles blocked**: Add 'unsafe-inline' to script-src/style-src (already added)
- **eval() blocked**: Add 'unsafe-eval' to script-src (already added)
- **External resources blocked**: Add the domain to the appropriate directive

## Testing Your CSP

You can use online tools to evaluate your CSP:
- [CSP Evaluator](https://csp-evaluator.withgoogle.com/)
- [Security Headers](https://securityheaders.com/)

## Modifying the CSP

When adding new external resources, update the middleware.ts file to include the new domains in the appropriate directive. 