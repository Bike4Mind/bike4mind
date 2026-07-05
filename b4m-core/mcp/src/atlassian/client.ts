/**
 * Atlassian MCP Server - API Client Accessors
 *
 * Lazy-loading API client accessors that reinitialize when env vars change.
 */

import { JiraApi, ConfluenceApi } from '@bike4mind/common';
import { getConfig, getEnvSignature } from './config.js';

let jiraApi: JiraApi | null = null;
let confluenceApi: ConfluenceApi | null = null;
let lastEnvSignature: string | null = null;

function ensureFreshClients(): void {
  const signature = getEnvSignature();
  if (lastEnvSignature !== signature) {
    jiraApi = null;
    confluenceApi = null;
    lastEnvSignature = signature;
  }
}

export function getJiraApi(): JiraApi {
  ensureFreshClients();
  if (!jiraApi) {
    const config = getConfig();
    jiraApi = new JiraApi(config.jira);
  }
  return jiraApi;
}

export function getConfluenceApi(): ConfluenceApi {
  ensureFreshClients();
  if (!confluenceApi) {
    const config = getConfig();
    confluenceApi = new ConfluenceApi(config.confluence);
  }
  return confluenceApi;
}
