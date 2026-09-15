import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import jwt from 'jsonwebtoken';
import open from 'open';
import axios from 'axios';
import { OAuthClient, type DeviceFlowResponse } from '../auth/OAuthClient';
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

  useEffect(() => {
    const runLoginFlow = async () => {
      const oauth = new OAuthClient(apiUrl);

      try {
        // Step 1: Initiate device flow
        setStatus('initiating');
        const deviceFlowResponse = await oauth.initiateDeviceFlow();
        setDeviceFlow(deviceFlowResponse);
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

        setStatus('success');
        setStatusMessage('Successfully authenticated!');

        // Wait a moment before calling success callback
        setTimeout(() => onSuccess(), 1500);
      } catch (err) {
        setStatus('error');
        const errorMessage = extractErrorMessage(err);
        setError(errorMessage);
        onError(new Error(errorMessage));
      }
    };

    runLoginFlow();
  }, [apiUrl, configStore, onSuccess, onError]);

  // Auto-open browser when device flow is initiated
  useEffect(() => {
    if (deviceFlow && status === 'waiting') {
      // Use verification_uri_complete which includes the user code pre-filled
      open(deviceFlow.verification_uri_complete).catch(err => {
        // Silent fail - user can still manually visit the URL
        console.error('Failed to auto-open browser:', err);
      });
    }
  }, [deviceFlow, status]);

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
          <Text dimColor>You can now use B4M CLI with your account.</Text>
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

      <Box marginBottom={1}>
        <Text>Opening browser automatically... If it doesn't open, please visit:</Text>
      </Box>

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
