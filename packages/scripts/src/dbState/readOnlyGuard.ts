import type { mongo } from 'mongoose';

/**
 * Every command the snapshot is allowed to send. Handshake and auth commands are listed because
 * the driver reports them too; anything else observed is a bug in the snapshot.
 */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'hello',
  'isMaster',
  'ismaster',
  'ping',
  'buildInfo',
  'listCollections',
  'listIndexes',
  'count',
  'aggregate',
  'find',
  'getMore',
  'killCursors',
  'endSessions',
  'saslStart',
  'saslContinue',
  'authenticate',
]);

const WRITE_STAGES = new Set(['$out', '$merge']);

const hasWriteStage = (command: mongo.Document): boolean => {
  const pipeline: unknown = command.pipeline;
  if (!Array.isArray(pipeline)) return false;
  return pipeline.some(
    stage => typeof stage === 'object' && stage !== null && Object.keys(stage).some(key => WRITE_STAGES.has(key))
  );
};

export const isReadOnlyCommand = (event: Pick<mongo.CommandStartedEvent, 'commandName' | 'command'>): boolean => {
  if (!READ_ONLY_COMMANDS.has(event.commandName)) return false;
  return !(event.commandName === 'aggregate' && hasWriteStage(event.command));
};

export type CommandRecorder = {
  readonly commands: string[];
  readonly violations: string[];
  stop: () => void;
};

/** Records every command the client sends. The client must be created with `monitorCommands: true`. */
export const recordCommands = (client: mongo.MongoClient): CommandRecorder => {
  const commands: string[] = [];
  const violations: string[] = [];
  const listener = (event: mongo.CommandStartedEvent) => {
    commands.push(event.commandName);
    if (!isReadOnlyCommand(event)) violations.push(event.commandName);
  };
  client.on('commandStarted', listener);
  return { commands, violations, stop: () => client.off('commandStarted', listener) };
};
