/**
 * Classifies a pdf.js load failure into user-facing copy.
 *
 * pdf.js's `wrapReason` re-creates its named exception classes on the main thread, but anything
 * else thrown in the worker (including the API/worker version-mismatch Error) arrives wrapped as
 * `UnknownErrorException`; classifying by `.name` and message (not `instanceof`) handles that and
 * also works with PdfViewer.test.tsx's mocked pdfjs-dist.
 */

export type PdfLoadErrorDescription = {
  title: string;
  detail: string;
  technical: string;
};

function getStringField(err: unknown, field: string): string {
  if (err && typeof err === 'object' && field in err) {
    const value = (err as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
  }
  return '';
}

function getNumberField(err: unknown, field: string): number | undefined {
  if (err && typeof err === 'object' && field in err) {
    const value = (err as Record<string, unknown>)[field];
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

function getBooleanField(err: unknown, field: string): boolean {
  if (err && typeof err === 'object' && field in err) {
    return Boolean((err as Record<string, unknown>)[field]);
  }
  return false;
}

// pdf.js's ResponseException message embeds the full request URL, which for S3-backed files is a
// signed URL carrying credentials (X-Amz-Signature, X-Amz-Credential) in the query string. This
// string is rendered on screen as "Technical details:", so strip the query/hash and keep only
// origin + pathname before it ever reaches the UI.
function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/g, match => {
    try {
      const url = new URL(match);
      return `${url.origin}${url.pathname}`;
    } catch {
      return '<url>';
    }
  });
}

function describeTechnical(err: unknown): string {
  const name = getStringField(err, 'name');
  const message = getStringField(err, 'message');
  if (name || message) {
    return redactUrls(`${name || 'Error'}: ${message}`);
  }
  try {
    return redactUrls(String(err));
  } catch {
    return 'Unknown error';
  }
}

const VERSION_MISMATCH_TITLE = 'PDF viewer is out of date';
const INVALID_PDF_TITLE = 'This file is not a valid PDF';
const PASSWORD_TITLE = 'This PDF is password-protected';
const ACCESS_EXPIRED_TITLE = 'Access to this file has expired';
const NOT_FOUND_TITLE = 'File not found';
const SERVER_ERROR_TITLE = 'The file server returned an error';
const NETWORK_ERROR_TITLE = 'Could not download the file';
const WORKER_START_TITLE = 'PDF viewer failed to start';
const DEFAULT_TITLE = 'Unable to load PDF document';

/** Classifies a pdf.js load failure (or any thrown value) into a title, a verbose plain-language detail, and a technical string for support. */
export function describePdfLoadError(err: unknown): PdfLoadErrorDescription {
  const name = getStringField(err, 'name');
  const message = getStringField(err, 'message');
  const technical = describeTechnical(err);

  if (/setting up fake worker failed/i.test(message)) {
    return {
      title: WORKER_START_TITLE,
      detail:
        "The PDF viewer's background component failed to start in this browser. This is usually " +
        'a transient problem with the page rather than the file itself. Reload the page to try ' +
        'again; the Download button lets you open the file in another app meanwhile.',
      technical,
    };
  }

  if (name === 'UnknownErrorException' && /does not match|worker version/i.test(message)) {
    return {
      title: VERSION_MISMATCH_TITLE,
      detail:
        'The browser is running an outdated copy of the in-app PDF viewer left over from an ' +
        'earlier version of this app, and it no longer matches the rest of the page. Reload ' +
        'the page to fetch the current version. If it still happens after a reload, clear this ' +
        "site's data in your browser settings and reload again. The Download button opens the " +
        'file meanwhile.',
      technical,
    };
  }

  if (name === 'InvalidPDFException') {
    return {
      title: INVALID_PDF_TITLE,
      detail:
        "The file doesn't appear to be a valid PDF. It may be damaged, incomplete, or saved with " +
        'the wrong file type. Try downloading it and opening it in another application; if that ' +
        'also fails, re-uploading a fresh copy of the file may help.',
      technical,
    };
  }

  if (name === 'PasswordException') {
    return {
      title: PASSWORD_TITLE,
      detail:
        'This PDF is protected with a password, and the in-app viewer cannot open password-' +
        'protected PDFs. Download the file and open it in a PDF application that can prompt you ' +
        'for the password.',
      technical,
    };
  }

  if (name === 'ResponseException') {
    const status = getNumberField(err, 'status');
    const missing = getBooleanField(err, 'missing');

    if (status === 401 || status === 403) {
      return {
        title: ACCESS_EXPIRED_TITLE,
        detail:
          'The secure link used to fetch this file has expired, or access to it was revoked. ' +
          'Close and reopen the file to request a fresh link. If this keeps happening, the file ' +
          'owner may have changed who it is shared with.',
        technical,
      };
    }

    if (missing || status === 404) {
      return {
        title: NOT_FOUND_TITLE,
        detail:
          'The file could not be found in storage. It may have been deleted or moved since this ' + 'link was created.',
        technical,
      };
    }

    return {
      title: SERVER_ERROR_TITLE,
      detail:
        `The file server returned an error (status ${status ?? 'unknown'}) while retrieving this ` +
        'PDF. This is usually temporary - try again in a little while, and if it keeps happening ' +
        'let support know the status above.',
      technical,
    };
  }

  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message)) {
    return {
      title: NETWORK_ERROR_TITLE,
      detail:
        'The file could not be downloaded, which usually points to a network problem rather than ' +
        'the file itself. Check your internet connection, and make sure a VPN, firewall, or ' +
        'content blocker is not blocking the request. Try again once the connection is stable.',
      technical,
    };
  }

  return {
    title: DEFAULT_TITLE,
    detail:
      'Something unexpected went wrong while loading this file. Reload the page to try again, or ' +
      'use the Download button to open the file in another application.',
    technical,
  };
}
