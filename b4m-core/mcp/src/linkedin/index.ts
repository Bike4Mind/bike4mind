#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LinkedInApi } from '@bike4mind/common';
import { createStderrLogger } from '../shared/stderrLog.js';

const log = createStderrLogger('linkedin');

const server = new McpServer({
  name: 'Demo',
  version: '1.0.0',
});

if (!process.env.LINKEDIN_ACCESS_TOKEN) {
  log.error('LINKEDIN_ACCESS_TOKEN environment variable is not set');
  process.exit(1);
}

if (!process.env.COMPANY_NAME) {
  log.error('COMPANY_NAME environment variable is not set');
  process.exit(1);
}

const linkedinApi = new LinkedInApi(process.env.LINKEDIN_ACCESS_TOKEN);
const company = await linkedinApi.getCompany(process.env.COMPANY_NAME);

server.tool('get_posts', {}, async () => {
  if (!company) return { content: [{ type: 'text', text: 'Company not found' }] };
  const urn = `urn:li:company:${company.id}`;
  return {
    content: [{ type: 'text', text: JSON.stringify(await linkedinApi.getPosts(urn), null, 2) }],
  };
});

server.tool('get_company', { vanityName: z.string() }, async ({ vanityName }: { vanityName: string }) => {
  return {
    content: [{ type: 'text', text: JSON.stringify(await linkedinApi.getCompany(vanityName), null, 2) }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('running on stdio');
}

main().catch(error => {
  log.error('fatal error in main', { error });
  process.exit(1);
});
