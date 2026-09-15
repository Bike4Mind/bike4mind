import { SlackClient } from '@bike4mind/slack';
import * as readline from 'readline';

// Simple logger mock
const logger = {
  info: (msg: string, meta?: any) => console.log(`[INFO] ${msg}`, meta ? JSON.stringify(meta) : ''),
  error: (msg: string, meta?: any) => console.error(`[ERROR] ${msg}`, meta ? JSON.stringify(meta) : ''),
  warn: (msg: string, meta?: any) => console.warn(`[WARN] ${msg}`, meta ? JSON.stringify(meta) : ''),
  debug: (msg: string, meta?: any) => console.debug(`[DEBUG] ${msg}`, meta ? JSON.stringify(meta) : ''),
} as any;

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (query: string): Promise<string> => {
    return new Promise(resolve => {
      rl.question(query, answer => {
        resolve(answer);
      });
    });
  };

  console.log('--- Slack Message Search Manual Test ---');
  console.log('Note: You need a Slack User Token (starts with xoxp-) with "search:read" scope.');

  const token = process.env.SLACK_USER_TOKEN || (await question('Enter Slack User Token (xoxp-...): '));

  if (!token) {
    console.error('Token is required.');
    process.exit(1);
  }

  if (!token.startsWith('xoxp-')) {
    console.warn('Warning: Token does not start with "xoxp-". Search API typically requires a User Token.');
  }

  const client = new SlackClient(token, logger);

  while (true) {
    const query = await question('\nEnter search query (or "exit" to quit): ');
    if (query.toLowerCase() === 'exit') break;
    if (!query.trim()) continue;

    try {
      console.log(`Searching for: "${query}"...`);
      const results = await client.searchMessages(query);

      if (results && results.matches) {
        console.log(`\nFound ${results.total} results. Showing top ${results.matches.length}:`);
        results.matches.forEach((msg: any, index: number) => {
          console.log(`\n[${index + 1}] Channel: ${msg.channel.name} | User: ${msg.username}`);
          console.log(`    Date: ${new Date(parseFloat(msg.ts) * 1000).toLocaleString()}`);
          console.log(`    Text: ${msg.text.substring(0, 150)}${msg.text.length > 150 ? '...' : ''}`);
          console.log(`    Link: ${msg.permalink}`);
        });
      } else {
        console.log('No results found or error occurred.');
      }
    } catch (error: any) {
      console.error('Search failed:', error.message);
      if (error.data) {
        console.error('API Error:', JSON.stringify(error.data, null, 2));
      }
    }
  }

  rl.close();
}

main().catch(console.error);
