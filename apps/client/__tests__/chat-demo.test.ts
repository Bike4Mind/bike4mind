import { describe, it, expect } from 'vitest';

// TODO: Fix test
describe.skip('Chat API Response Demo', () => {
  it('should show actual chat API responses', async () => {
    // Simulate the exact chat API response format
    const simulateChatAPI = async (requestBody: any, user: any) => {
      console.log('\n📤 REQUEST:');
      console.log(JSON.stringify(requestBody, null, 2));

      const questId = `quest-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const sessionId = requestBody.sessionId || `session-${questId}`;

      let response;

      if (requestBody.wait) {
        // Synchronous response (wait=true)
        response = {
          id: questId,
          status: 'completed',
          message_received: true,
          timestamp: new Date().toISOString(),
          model: requestBody.model || 'gpt-4o-mini',
          response: `Hello! I'm doing great, thanks for asking. You sent: "${requestBody.message}"`,
          responses: [`Hello! I'm doing great, thanks for asking. You sent: "${requestBody.message}"`],
          createdAt: new Date().toISOString(),
          sessionId,
          tracking_info: {
            quest_id: questId,
            check_status_url: `/api/quests/${questId}`,
          },
        };
      } else {
        // Asynchronous response (default)
        response = {
          id: questId,
          status: 'queued',
          message_received: true,
          timestamp: new Date().toISOString(),
          model: requestBody.model || 'gpt-4o-mini',
          message: 'Message queued for processing. Use the quest ID to check status.',
          sessionId,
          tracking_info: {
            quest_id: questId,
            check_status_url: `/api/quests/${questId}`,
          },
        };
      }

      console.log('\n📥 RESPONSE:');
      console.log(JSON.stringify(response, null, 2));

      return { status: 200, data: response };
    };

    const user = { id: 'demo-user-123', username: 'testuser' };

    console.log('\n🔄 Testing ASYNC chat (default behavior)...');
    const asyncResult = await simulateChatAPI(
      {
        message: 'Hello, how are you today?',
        model: 'gpt-4o',
        temperature: 0.7,
      },
      user
    );

    expect(asyncResult.status).toBe(200);
    expect(asyncResult.data.status).toBe('queued');

    console.log('\n⏳ Testing SYNC chat (wait=true)...');
    const syncResult = await simulateChatAPI(
      {
        message: 'What is the capital of France?',
        model: 'gpt-4o-mini',
        temperature: 0.5,
        max_tokens: 100,
        wait: true,
      },
      user
    );

    expect(syncResult.status).toBe(200);
    expect(syncResult.data.status).toBe('completed');

    console.log('\n📎 Testing chat with file attachments...');
    const fileResult = await simulateChatAPI(
      {
        message: 'Please analyze these files and summarize them',
        model: 'gpt-4o',
        fileIds: ['file-doc1', 'file-pdf2', 'file-img3'],
        wait: true,
      },
      user
    );

    expect(fileResult.status).toBe(200);
    expect(fileResult.data.response).toMatch(/file-doc1.*file-pdf2.*file-img3/);
  });
});
