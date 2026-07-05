import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ensureTavernAccess } from '@server/utils/errors';
import { OperationsModelService } from '@client/services/operationsModelService';
import { agentRepository } from '@bike4mind/database';
import { agentMemoryService } from '@bike4mind/services';

/**
 * /api/ai/tavern-conversation - Two-mode endpoint for live NPC conversations.
 *
 * Mode 1 (Generate Cast): POST { topic? }
 *   -> Returns { characters: [...] } with 4 NPCs including Grimbold
 *
 * Mode 2 (Next Turn): POST { characters, history, userMessage? }
 *   -> Returns { speaker, text, style } - one line of dialogue
 *
 * The client drives the conversation loop, calling Mode 2 repeatedly.
 * When the user types a message, it's included via userMessage and
 * the next NPC will respond to it.
 */

const AVAILABLE_SPRITES = [
  'knight',
  'dancer',
  'drinker1',
  'drinker3',
  'drinker5',
  'drinker7',
  'lute_player',
  'watcher',
  'think_guy',
  'eater',
  'orc_player',
  'drow_player',
  'dwarf_player',
];

// Mode 1: Generate Cast
const CAST_PROMPT = `You are the Dungeon Master for a medieval tavern called The Gilded Flagon.
Generate 4 tavern characters for an improvised conversation scene.

RULES:
- One character MUST be Grimbold the barkeep (id: "grimbold", sprite: "host").
  He is warm, gruff, knows everyone, and keeps the peace.
- Pick 3 more from these sprites: ${AVAILABLE_SPRITES.join(', ')}
- Do NOT pick similar sprites (e.g. don't use drinker1 AND drinker3)
- Each character needs: a snake_case id, a memorable fantasy name, and a 1-sentence personality
- Make personalities CONTRAST: one loud, one quiet, one mysterious, one funny, etc.
- Give each a distinct speech pattern or verbal quirk

Return ONLY valid JSON (no markdown fences):
{
  "characters": [
    { "id": "grimbold", "name": "Grimbold", "sprite": "host", "personality": "Warm gruff barkeep who keeps the peace" },
    { "id": "snake_case", "name": "Display Name", "sprite": "sprite_id", "personality": "One sentence" },
    { "id": "snake_case", "name": "Display Name", "sprite": "sprite_id", "personality": "One sentence" },
    { "id": "snake_case", "name": "Display Name", "sprite": "sprite_id", "personality": "One sentence" }
  ]
}`;

// Mode 2: Next Turn
function buildTurnPrompt(
  characters: { id: string; name: string; personality: string }[],
  history: { speaker: string; text: string }[],
  userMessage?: string,
  agentMemories?: Record<string, string>
): string {
  const charBlock = characters
    .map(c => {
      let line = `- ${c.name} (id: "${c.id}"): ${c.personality}`;
      if (agentMemories?.[c.id]) {
        line += `\n  ${agentMemories[c.id]}`;
      }
      return line;
    })
    .join('\n');

  const historyBlock =
    history.length > 0
      ? history.map(h => `${h.speaker}: "${h.text}"`).join('\n')
      : '(The conversation is just starting)';

  // Detect targeted speech: "[Speaking to CharName] actual message"
  const targetMatch = userMessage?.match(/^\[Speaking to (.+?)\]\s*(.*)/s);
  const targetName = targetMatch?.[1];
  const cleanUserMessage = targetMatch ? targetMatch[2] : userMessage;

  const userBlock = cleanUserMessage
    ? `\nA stranger at the bar just spoke up: "${cleanUserMessage}"${
        targetName
          ? `\nThe stranger is speaking DIRECTLY to ${targetName}. ${targetName} MUST be the one to respond.`
          : "\nOne of the characters MUST respond to the stranger's comment."
      }`
    : '';

  return `You are improvising a medieval tavern conversation. Stay in character.

THE CHARACTERS:
${charBlock}

CONVERSATION SO FAR:
${historyBlock}
${userBlock}

Generate the NEXT single line of dialogue. Pick whichever character would most naturally speak next.
- Do NOT repeat what was just said. Build on the conversation naturally.
- Keep the line UNDER 80 characters. Punchier is better.
- Use "speech" for normal talk, "shout" for rare loud moments, "thought" for rare inner monologue.
- Never break character. No AI references. Stay medieval.
${userMessage ? '- You MUST respond to what the stranger said.' : ''}

Return ONLY valid JSON (no markdown fences):
{ "speaker": "character_id", "text": "The dialogue line", "style": "speech" }`;
}

// Handler
const handler = baseApi()
  .use(
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 60 : 30,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req: any, res) => {
    ensureTavernAccess(req.user);

    const { characters, history, userMessage, topic, agentIds } = req.body || {};
    // agentIds: optional Record<string, string> mapping character id to agent database id

    try {
      const { modelId, llm } = await OperationsModelService.getOperationsModel();

      // Mode 1: Generate Cast (no characters provided)
      if (!characters) {
        const messages = [
          { role: 'system' as const, content: CAST_PROMPT },
          {
            role: 'user' as const,
            content: topic
              ? `Theme hint: ${topic}. Generate the cast.`
              : 'Generate an interesting cast of tavern characters.',
          },
        ];

        let reply = '';
        await llm.complete(
          modelId,
          messages,
          { maxTokens: 800, temperature: 0.9 },
          async (chunks: (string | null | undefined)[]) => {
            reply += chunks.filter(Boolean).join('');
          }
        );

        const trimmed = (reply || '').trim();
        if (!trimmed) throw new Error('Empty response from LLM');

        const jsonStr = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(jsonStr);

        // Validate sprite IDs
        const validSprites = new Set([...AVAILABLE_SPRITES, 'host']);
        for (const char of parsed.characters || []) {
          if (!validSprites.has(char.sprite)) {
            char.sprite = 'drinker1';
          }
        }

        return res.json(parsed);
      }

      // Mode 2: Next Turn (characters provided)
      const recentHistory = (history || []).slice(-20); // keep context window manageable

      // Fetch memories for agent characters (if any)
      let memorySections: Record<string, string> | undefined;
      if (agentIds && typeof agentIds === 'object' && Object.keys(agentIds).length > 0) {
        memorySections = {};
        for (const [charId, agentId] of Object.entries(agentIds)) {
          try {
            const memories = await agentRepository.getMemoryJournal(agentId as string, 20);
            if (memories.length > 0) {
              memorySections[charId] = agentMemoryService.buildMemoryPromptSection(memories);
            }
          } catch {
            // Non-fatal: skip memories for this agent
          }
        }
      }

      const turnPrompt = buildTurnPrompt(characters, recentHistory, userMessage, memorySections);

      const messages = [{ role: 'user' as const, content: turnPrompt }];

      let reply = '';
      await llm.complete(
        modelId,
        messages,
        { maxTokens: 150, temperature: 0.85 },
        async (chunks: (string | null | undefined)[]) => {
          reply += chunks.filter(Boolean).join('');
        }
      );

      const trimmed = (reply || '').trim();
      if (!trimmed) throw new Error('Empty response from LLM');

      const jsonStr = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const parsed = JSON.parse(jsonStr);

      // Validate the speaker exists in the cast
      const charIds = new Set((characters as { id: string }[]).map(c => c.id));
      if (!charIds.has(parsed.speaker)) {
        parsed.speaker = characters[0].id;
      }

      // Validate style
      if (!['speech', 'shout', 'thought'].includes(parsed.style)) {
        parsed.style = 'speech';
      }

      // Send response first
      res.json(parsed);

      // Fire-and-forget: extract memories for agent characters
      if (agentIds && typeof agentIds === 'object' && Object.keys(agentIds).length > 0) {
        (async () => {
          const { modelId: memModelId, llm: memLlm } = await OperationsModelService.getOperationsModel();

          const llmComplete: agentMemoryService.LlmCompleteFn = async (msgs, opts) => {
            let result = '';
            await memLlm.complete(memModelId, msgs, opts, async (chunks: (string | null | undefined)[]) => {
              result += chunks.filter(Boolean).join('');
            });
            return result;
          };

          for (const [charId, agentId] of Object.entries(agentIds)) {
            try {
              const char = (characters as { id: string; name: string; personality: string }[]).find(
                c => c.id === charId
              );
              if (!char) continue;

              const newMemories = await agentMemoryService.extractMemoriesFromConversation(
                char.name,
                char.personality,
                recentHistory || [],
                llmComplete
              );

              for (const mem of newMemories) {
                await agentRepository.appendMemory(agentId as string, mem);
              }
            } catch {
              // Memory extraction is non-fatal
            }
          }
        })().catch(err => req.logger?.warn?.('Memory extraction failed (non-fatal):', err));
      }

      return;
    } catch (error) {
      req.logger?.error?.('Tavern conversation error:', error);

      // Fallback for cast generation
      if (!characters) {
        return res.json({
          characters: [
            { id: 'grimbold', name: 'Grimbold', sprite: 'host', personality: 'The gruff but warm barkeep' },
            {
              id: 'roderick',
              name: 'Roderick',
              sprite: 'knight',
              personality: 'A boastful knight who never stops bragging',
            },
            { id: 'mira', name: 'Mira', sprite: 'watcher', personality: 'A quiet observer who sees everything' },
            {
              id: 'bram',
              name: 'Bram',
              sprite: 'think_guy',
              personality: 'A nervous scholar always expecting the worst',
            },
          ],
        });
      }

      // Fallback for turn generation - pick a random character
      const fallbackChar = characters[Math.floor(Math.random() * characters.length)];
      return res.json({
        speaker: fallbackChar.id,
        text: '*wipes glass silently*',
        style: 'thought',
      });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
