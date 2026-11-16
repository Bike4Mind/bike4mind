import { expect, it, vi } from 'vitest';
import { inheritancePolicy } from '@shared/orchestration';
import { IPC_CHANNELS } from '@shared/ipc';
import { registerOrchestrationIpc } from './orchestrationIpc';

it('validates policy and task actions at the renderer boundary and keeps model reports out of IPC', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const service = {
    getRolePolicy: vi.fn(async () => inheritancePolicy()),
    setRolePolicy: vi.fn(async () => inheritancePolicy()),
    actOnTask: vi.fn(),
    listTaskDecisions: vi.fn(async () => []),
    answerTaskDecision: vi.fn(async () => undefined),
  };
  registerOrchestrationIpc(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener as (...args: unknown[]) => unknown);
      },
    },
    service
  );
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  const policy = inheritancePolicy();
  await call(IPC_CHANNELS.chatSetRolePolicy, policy);
  expect(service.setRolePolicy).toHaveBeenLastCalledWith(policy);
  expect(() => call(IPC_CHANNELS.chatSetRolePolicy, { ...policy, version: 2 })).toThrow();
  expect(service.setRolePolicy).toHaveBeenCalledTimes(1);
  const id = 'f3708bc5-9424-4d0c-8a18-41f166cb43a1';
  await call(IPC_CHANNELS.chatTaskAction, id, { kind: 'cancel', reason: 'Canceled' });
  expect(service.actOnTask).toHaveBeenLastCalledWith(null, id, { kind: 'cancel', reason: 'Canceled' });
  expect(() => call(IPC_CHANNELS.chatTaskAction, '../other', { kind: 'cancel', reason: 'Invalid' })).toThrow();
  expect(() =>
    call(IPC_CHANNELS.chatTaskAction, id, {
      kind: 'report',
      report: { status: 'blocked', reason: 'Forged', evidence: ['Model text'] },
    })
  ).toThrow(/worker/);
  expect(service.actOnTask).toHaveBeenCalledTimes(1);
});

it('bounds decision answers at the renderer boundary', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const service = {
    getRolePolicy: vi.fn(async () => inheritancePolicy()),
    setRolePolicy: vi.fn(async () => inheritancePolicy()),
    actOnTask: vi.fn(),
    listTaskDecisions: vi.fn(async () => []),
    answerTaskDecision: vi.fn(async () => undefined),
  };
  registerOrchestrationIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as (...args: unknown[]) => unknown) },
    service
  );
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  const id = 'f3708bc5-9424-4d0c-8a18-41f166cb43a1';
  await call(IPC_CHANNELS.chatAnswerTaskDecision, id, 'd1', { status: 'answered', answers: [{ selected: ['Stack'] }] });
  expect(service.answerTaskDecision).toHaveBeenLastCalledWith(id, 'd1', {
    status: 'answered',
    answers: [{ selected: ['Stack'] }],
  });
  await call(IPC_CHANNELS.chatAnswerTaskDecision, id, 'd1', { status: 'skipped' });
  expect(service.answerTaskDecision).toHaveBeenLastCalledWith(id, 'd1', { status: 'skipped' });
  expect(() => call(IPC_CHANNELS.chatAnswerTaskDecision, id, 'd1', { status: 'cancelled' })).toThrow();
  expect(() => call(IPC_CHANNELS.chatAnswerTaskDecision, '../x', 'd1', { status: 'skipped' })).toThrow();
  expect(service.answerTaskDecision).toHaveBeenCalledTimes(2);
});
