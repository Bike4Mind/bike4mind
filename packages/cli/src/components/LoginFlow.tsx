import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import jwt from 'jsonwebtoken';
import open from 'open';
import axios from 'axios';
import { OAuthClient, type DeviceFlowResponse } from '../auth/OAuthClient';
import { ApiClient } from '../auth/ApiClient';
import type { ConfigStore } from '../storage/ConfigStore';

interface JwtPayload {
  id: string;
  [key: string]: unknown;
}

interface LoginFlowProps {
  apiUrl?: string;
  configStore: ConfigStore;
  onSuccess: () => void;
  onError: (error: Error) => void;
}

/**
 * Only https URLs (and http on localhost for dev) may be handed to the OS opener.
 * The device-flow response is server-controlled, so a hostile/compromised server
 * could return `file:///...`, `javascript:...` or similar and have the OS launch
 * it. Reject anything that isn't a plain web URL.
 */
export function isBrowserOpenableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/**
 * The device-flow response is server-controlled, so a compromised server could point the
 * verification page at a phishing origin. Only auto-open URLs on the configured API origin.
 * Strict compare: no subdomain aliasing and no localhost/127.0.0.1 equivalence.
 */
export function isOnApiOrigin(raw: string, apiUrl: string): boolean {
  try {
    return new URL(raw).origin === new URL(apiUrl).origin;
  } catch {
    return false;
  }
}

function originOf(raw: string): string {
  try {
    const { origin } = new URL(raw);
    // Non-web schemes (file:, javascript:, data:) have an opaque "null" origin.
    return origin === 'null' ? raw : origin;
  } catch {
    return raw;
  }
}

/** Strips C0/C1 control chars so a server-supplied string can't inject terminal escape sequences. */
function stripControlChars<T extends string | undefined>(raw: T): T {
  // eslint-disable-next-line no-control-regex -- intentional: removing control chars
  return (raw === undefined ? raw : raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')) as T;
}

function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    // Server responded with an error status
    if (err.response?.data) {
      const data = err.response.data;
      const serverMsg = data.error_description || data.error || data.message;
      if (serverMsg) {
        return `${serverMsg} (HTTP ${err.response.status})`;
      }
      return `Server returned HTTP ${err.response.status}`;
    }
    // Network-level error (connection refused, timeout, DNS, etc.)
    if (err.code === 'ECONNREFUSED') {
      const url = err.config?.baseURL || 'server';
      return `Could not connect to ${url} - is the server running?`;
    }
    if (err.code === 'ENOTFOUND') {
      return `Could not resolve hostname: ${err.config?.baseURL || 'unknown'}`;
    }
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
      return 'Connection timed out - server may be unreachable';
    }
    return err.message || `Network error (${err.code || 'unknown'})`;
  }
  if (err instanceof Error) {
    return err.message || 'Unknown error occurred';
  }
  return 'Unknown error occurred';
}

export function LoginFlow({ apiUrl = 'http://localhost:3000', configStore, onSuccess, onError }: LoginFlowProps) {
  const [status, setStatus] = useState<'initiating' | 'waiting' | 'success' | 'error'>('initiating');
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowResponse | null>(null);
  const [statusMessage, setStatusMessage] = useState('Initiating device authorization...');
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<{ userId: string; email?: string; username?: string } | null>(null);

  useEffect(() => {
    const runLoginFlow = async () => {
      const oauth = new OAuthClient(apiUrl);

      try {
        // Step 1: Initiate device flow
        setStatus('initiating');
        const deviceFlowResponse = await oauth.initiateDeviceFlow();
        // Sanitized at intake so the trust check, the opener and the screen all see the same string.
        setDeviceFlow({
          ...deviceFlowResponse,
          verification_uri: stripControlChars(deviceFlowResponse.verification_uri),
          verification_uri_complete: stripControlChars(deviceFlowResponse.verification_uri_complete),
          user_code: stripControlChars(deviceFlowResponse.user_code),
        });
        setStatus('waiting');
        setStatusMessage('Waiting for authorization...');

        // Step 2: Wait for user to authorize
        const tokens = await oauth.waitForAuthorization(
          deviceFlowResponse.device_code,
          deviceFlowResponse.interval,
          message => setStatusMessage(message)
        );

        // Step 3: Decode access token to get userId
        const decoded = jwt.decode(tokens.access_token) as JwtPayload | null;
        const userId = decoded?.id || '';

        // Step 4: Calculate expiry time
        const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

        // Step 5: Store tokens
        await configStore.setAuthTokens({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt,
          userId,
        });

        setAccount({ userId });
        setStatus('success');
        setStatusMessage('Successfully authenticated!');

        // Wait a moment before calling success callback
        setTimeout(() => onSuccess(), 1500);

        // Best-effort and not awaited, so a slow or failed identify never delays onSuccess;
        // the success screen falls back to the user ID until (unless) this resolves.
        new ApiClient(apiUrl, configStore)
          .get<{ user?: { email?: string; username?: string } }>('/api/identify')
          .then(res =>
            setAccount({
              userId,
              email: stripControlChars(res?.user?.email),
              username: stripControlChars(res?.user?.username),
            })
          )
          .catch(() => {});
      } catch (err) {
        setStatus('error');
        const errorMessage = stripControlChars(extractErrorMessage(err));
        setError(errorMessage);
        onError(new Error(errorMessage));
      }
    };

    runLoginFlow();
  }, [apiUrl, configStore, onSuccess, onError]);

  // Both URIs are checked: the CLI opens _complete, but the screen tells the user to visit verification_uri.
  // `every`, not `find() === undefined`: a server that omits a URI would otherwise read as trusted.
  const uris = deviceFlow ? [deviceFlow.verification_uri, deviceFlow.verification_uri_complete] : [];
  const isTrustedUri = (u: string) => isBrowserOpenableUrl(u) && isOnApiOrigin(u, apiUrl);
  const untrustedUri = uris.find(u => !isTrustedUri(u));
  const trusted = uris.length > 0 && uris.every(isTrustedUri);

  // Auto-open browser when device flow is initiated
  useEffect(() => {
    // Use verification_uri_complete which includes the user code pre-filled.
    // An untrusted URL is never handed to the OS opener; the waiting screen shows the warning.
    if (deviceFlow && status === 'waiting' && trusted) {
      open(deviceFlow.verification_uri_complete).catch(err => {
        // Silent fail - user can still manually visit the URL
        console.error('Failed to auto-open browser:', err);
      });
    }
  }, [deviceFlow, status, trusted]);

  if (status === 'initiating') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box>
          <Text color="cyan">
            <Spinner type="dots" /> Initiating device authorization...
          </Text>
        </Box>
      </Box>
    );
  }

  if (status === 'error') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text color="red" bold>
            ✖ Authentication Failed
          </Text>
        </Box>
        <Box>
          <Text color="red">{error}</Text>
        </Box>
      </Box>
    );
  }

  if (status === 'success') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text color="green" bold>
            ✔ Successfully authenticated!
          </Text>
        </Box>
        <Box>
          <Text>
            Logged in as {account?.email || account?.username || `user ${account?.userId}`} on {hostOf(apiUrl)}
          </Text>
        </Box>
      </Box>
    );
  }

  // Status === 'waiting'
  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan">
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          🔐 Device Authorization
        </Text>
      </Box>

      {trusted ? (
        <Box marginBottom={1}>
          <Text>Opening browser automatically... If it doesn't open, please visit:</Text>
        </Box>
      ) : (
        <>
          <Box marginBottom={1}>
            <Text color="red" bold>
              {!untrustedUri
                ? 'Not opening browser: the server did not return a verification URL.'
                : isOnApiOrigin(untrustedUri, apiUrl)
                  ? `Not opening browser: verification URL ${originOf(untrustedUri)} is not https (plain http is only auto-opened on localhost). Only continue if you trust it.`
                  : `Not opening browser: verification URL origin ${originOf(untrustedUri)} does not match the configured server ${originOf(apiUrl)}. Only continue if you trust it.`}
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text>Please visit:</Text>
          </Box>
        </>
      )}

      <Box marginBottom={1} paddingLeft={2}>
        <Text color="blue" bold>
          {deviceFlow?.verification_uri}
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text>And enter this code when prompted:</Text>
      </Box>

      <Box marginBottom={1} paddingLeft={2}>
        <Text color="yellow" bold>
          {deviceFlow?.user_code}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color="cyan">
          <Spinner type="dots" /> {statusMessage}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>Expires in {deviceFlow ? Math.floor(deviceFlow.expires_in / 60) : 0} minutes</Text>
      </Box>
    </Box>
  );
}
