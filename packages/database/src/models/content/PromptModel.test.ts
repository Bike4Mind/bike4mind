import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import { Prompt, promptRepository } from './PromptModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('PromptRepository finders', () => {
  it.each([
    ['findAllByName', () => promptRepository.findAllByName('greeting')],
    ['findAllByType', () => promptRepository.findAllByType('system')],
    ['findAllWithTags', () => promptRepository.findAllWithTags(['hello'])],
  ])('%s returns plain objects with the id virtual, not hydrated documents', async (_name, find) => {
    await Prompt.create({ type: 'system', name: 'greeting', promptText: 'hi', tags: ['hello'] });
    await Prompt.create({ type: 'other', name: 'farewell', promptText: 'bye', tags: ['bye'] });

    const found = await find();

    expect(found).toHaveLength(1);
    expect(found[0] instanceof mongoose.Document).toBe(false);
    expect(found[0].id).toEqual(expect.any(String));
    expect(found[0]).toMatchObject({ name: 'greeting', promptText: 'hi', tags: ['hello'] });
    expect(found[0]).toHaveProperty('lastUpdated');
  });
});
