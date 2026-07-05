/**
 * VoiceSessionModal barrel file.
 *
 * The original full-screen modal has been replaced by:
 *  - useVoiceSessionEngine (headless hook)
 *  - VoiceInlineButton + VoiceControlsStrip (inline UI)
 *  - VoiceDebugDrawer (side-panel debug UI)
 *
 * This file re-exports shared types for backward compatibility.
 */

export type { TranscriptItem } from './types';
export { useVoiceSessionStore } from './voiceSessionStore';
export { useVoiceSessionEngine } from './useVoiceSessionEngine';
export type { UseVoiceSessionEngine, UseVoiceSessionEngineOptions } from './useVoiceSessionEngine';
