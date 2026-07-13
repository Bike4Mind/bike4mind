/**
 * Chess artifact handler.
 *
 * Chess is special: inter-message state tracking (latestChessStateMap), FEN
 * validation via chess.js, and it bypasses async ID resolution for instant
 * display during streaming. NOT registered in the artifact registry - used
 * directly by ReplyContainer. Also exports utilities for the markdown `code`
 * renderer's chess code blocks.
 */

import React, { useState } from 'react';
import { Box, Chip, Typography, Button } from '@mui/joy';
import type { ChessArtifact } from '@bike4mind/common';
import { Chess } from 'chess.js';
import ChessBoard from '../../../Chess/ChessBoard';
import { appendSessionMoves, resetSessionMoves } from '../../../Chess/chessSessionState';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import useChatActions from '@client/app/hooks/useChatActions';

// Inter-message chess state (module-level singleton, keyed by sessionId)

export interface LatestChessState {
  fen: string;
  jsonStr: string;
  turn?: 'w' | 'b';
  move?: { from: string; to: string };
  isCheck?: boolean;
  isCheckmate?: boolean;
  isDraw?: boolean;
  isStalemate?: boolean;
  isGameOver?: boolean;
  moveNumber?: number;
}

const MAX_CHESS_STATE_ENTRIES = 50;

export const latestChessStateMap = new Map<string, LatestChessState>();

function evictOldestChessStates(): void {
  if (latestChessStateMap.size <= MAX_CHESS_STATE_ENTRIES) return;
  const excess = latestChessStateMap.size - MAX_CHESS_STATE_ENTRIES;
  const keys = latestChessStateMap.keys();
  for (let i = 0; i < excess; i++) {
    const { value } = keys.next();
    if (value !== undefined) latestChessStateMap.delete(value);
  }
}

/** Extract JSON from a chess artifact content string */
export function extractChessJson(raw: string): string | null {
  const trimmed = raw.trim();
  const braceStart = trimmed.indexOf('{');
  if (braceStart < 0) return null;
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < trimmed.length; i++) {
    if (trimmed[i] === '{') depth++;
    else if (trimmed[i] === '}') {
      depth--;
      if (depth === 0) {
        braceEnd = i;
        break;
      }
    }
  }
  return braceEnd > braceStart ? trimmed.slice(braceStart, braceEnd + 1) : null;
}

export interface ChessFenResult {
  fen: string;
  illegalAiMove?: string;
  legalMoves?: string[];
  correctedFen?: string;
}

/**
 * Validate and reconstruct a chess FEN from actual moves using chess.js.
 * The LLM often regenerates artifact XML with hand-computed FEN strings
 * that are incorrect (e.g., confusing pawn and knight moves to the same square).
 * This function recomputes the FEN deterministically from the previous position
 * and the move data, ensuring the board always shows the correct state.
 */
export function validateChessFen(
  sessionId: string,
  llmFen: string,
  chessData: Record<string, unknown>
): ChessFenResult {
  const playerMove = chessData.playerMove as { san?: string } | undefined;
  const aiMove = (chessData.aiMove || chessData.move) as { san?: string } | undefined;
  if (!playerMove?.san || !aiMove?.san) return { fen: llmFen };

  const prevState = latestChessStateMap.get(sessionId);
  if (!prevState?.fen) return { fen: llmFen };

  try {
    const game = new Chess(prevState.fen);

    // Step 1: Apply player's move
    try {
      game.move(playerMove.san);
    } catch {
      console.warn('[Chess] Player move illegal, falling back to LLM FEN', {
        playerMove: playerMove.san,
        previousFen: prevState.fen,
      });
      return { fen: llmFen };
    }

    const fenAfterPlayerMove = game.fen();

    // Step 2: Apply AI's move
    try {
      game.move(aiMove.san);
    } catch {
      const legalMoves = game.moves();
      console.warn('[Chess] AI move illegal — LLM fabricated an impossible move, board corrected', {
        aiMove: aiMove.san,
        fenAfterPlayerMove,
        legalMoves: legalMoves.slice(0, 10),
        llmFen,
        previousFen: prevState.fen,
      });
      return {
        fen: fenAfterPlayerMove,
        illegalAiMove: aiMove.san,
        legalMoves,
        correctedFen: fenAfterPlayerMove,
      };
    }

    const reconstructedFen = game.fen();
    if (reconstructedFen !== llmFen) {
      console.warn('[Chess] FEN mismatch — LLM produced wrong FEN, using reconstructed', {
        llmFen,
        reconstructedFen,
        playerMove: playerMove.san,
        aiMove: aiMove.san,
        previousFen: prevState.fen,
      });
    }
    return { fen: reconstructedFen };
  } catch {
    return { fen: llmFen };
  }
}

/**
 * Safely extract a move object with `from`/`to` from untyped chess data.
 * Returns undefined if the move is missing or lacks required fields.
 */
function extractMove(data: Record<string, unknown>): { from: string; to: string } | undefined {
  const move = (data.aiMove || data.move) as Record<string, unknown> | undefined;
  if (move && typeof move.from === 'string' && typeof move.to === 'string') {
    return { from: move.from, to: move.to };
  }
  return undefined;
}

/**
 * Track chess state for a session. Called from ReplyContainer's useEffect.
 */
export function trackChessState(
  sessionId: string,
  chessData: Record<string, unknown>,
  fen: string,
  jsonStr: string
): void {
  const prevFen = latestChessStateMap.get(sessionId)?.fen;
  if (fen !== prevFen) {
    const playerSan = (chessData.playerMove as { san?: string } | undefined)?.san;
    const aiSan = ((chessData.aiMove || chessData.move) as { san?: string } | undefined)?.san;
    if (playerSan || aiSan) {
      appendSessionMoves(
        sessionId,
        [playerSan, aiSan].filter((s): s is string => Boolean(s))
      );
    } else {
      resetSessionMoves(sessionId);
    }
  }

  latestChessStateMap.set(sessionId, {
    fen,
    jsonStr,
    turn: chessData.turn === 'w' || chessData.turn === 'b' ? chessData.turn : undefined,
    move: extractMove(chessData),
    isCheck: typeof chessData.isCheck === 'boolean' ? chessData.isCheck : undefined,
    isCheckmate: typeof chessData.isCheckmate === 'boolean' ? chessData.isCheckmate : undefined,
    isDraw: typeof chessData.isDraw === 'boolean' ? chessData.isDraw : undefined,
    isStalemate: typeof chessData.isStalemate === 'boolean' ? chessData.isStalemate : undefined,
    isGameOver:
      Boolean(chessData.isCheckmate || chessData.isStalemate || chessData.isDraw || chessData.isGameOver) || undefined,
    moveNumber: typeof chessData.moveNumber === 'number' ? chessData.moveNumber : undefined,
  });
  evictOldestChessStates();
}

/**
 * Push the latest chess state to the side panel.
 * Called when a message completes with a chess artifact.
 */
export function pushChessToSidePanel(
  sessionId: string,
  fen: string,
  jsonStr: string,
  chessData: Record<string, unknown>
): void {
  const latestState = latestChessStateMap.get(sessionId);
  if (latestState && latestState.fen !== fen) return;

  console.log('[Chess auto-update] Updating side panel with FEN:', fen);
  const now = new Date();
  const lastMove = extractMove(chessData);
  const chessArtifactObj: ChessArtifact = {
    id: `chess-${fen.replace(/\s+/g, '-').slice(0, 20)}-${Date.now()}`,
    type: 'chess',
    title: 'Chess Game',
    content: jsonStr,
    createdAt: now,
    updatedAt: now,
    metadata: {
      fen,
      turn: chessData.turn === 'w' || chessData.turn === 'b' ? chessData.turn : undefined,
      lastMove,
      isCheck: typeof chessData.isCheck === 'boolean' ? chessData.isCheck : undefined,
      isCheckmate: typeof chessData.isCheckmate === 'boolean' ? chessData.isCheckmate : undefined,
      isDraw: typeof chessData.isDraw === 'boolean' ? chessData.isDraw : undefined,
      isGameOver:
        Boolean(chessData.isCheckmate || chessData.isStalemate || chessData.isDraw || chessData.isGameOver) ||
        undefined,
      moveNumber: typeof chessData.moveNumber === 'number' ? chessData.moveNumber : undefined,
    },
  };
  setSessionLayout({
    layout: 'vertical',
    artifactData: {
      type: 'chess',
      content: chessArtifactObj,
      mimeType: 'application/vnd.ant.chess',
      id: chessArtifactObj.id,
    },
  });
}

/**
 * Build a ChessArtifact object and open it in the side panel.
 */
export function openChessInSidePanel(
  fen: string,
  jsonStr: string,
  chessData: Record<string, unknown>,
  currentSessionId?: string
): void {
  // Use the latest chess state from the session, not a stale message
  const latest = currentSessionId ? latestChessStateMap.get(currentSessionId) : null;
  const useFen = latest?.fen || fen;
  const useJsonStr = latest?.jsonStr || jsonStr;
  const useChessData = latest || chessData;
  const now = new Date();
  const lastMove = latest?.move ?? extractMove(chessData);
  const chessArtifactObj: ChessArtifact = {
    id: `chess-${useFen.replace(/\s+/g, '-').slice(0, 20)}-${Date.now()}`,
    type: 'chess',
    title: 'Chess Game',
    content: useJsonStr,
    createdAt: now,
    updatedAt: now,
    metadata: {
      fen: useFen,
      turn: useChessData.turn === 'w' || useChessData.turn === 'b' ? useChessData.turn : undefined,
      lastMove,
      isCheck: typeof useChessData.isCheck === 'boolean' ? useChessData.isCheck : undefined,
      isCheckmate: typeof useChessData.isCheckmate === 'boolean' ? useChessData.isCheckmate : undefined,
      isDraw: typeof useChessData.isDraw === 'boolean' ? useChessData.isDraw : undefined,
      isGameOver: typeof useChessData.isGameOver === 'boolean' ? useChessData.isGameOver : undefined,
      moveNumber: typeof useChessData.moveNumber === 'number' ? useChessData.moveNumber : undefined,
    },
  };
  setSessionLayout({
    layout: 'vertical',
    artifactData: {
      type: 'chess',
      content: chessArtifactObj,
      mimeType: 'application/vnd.ant.chess',
      id: chessArtifactObj.id,
    },
  });
}

/**
 * Warning banner shown when the AI attempts an illegal chess move.
 */
export const IllegalMoveWarning: React.FC<{ illegalMove: string; correctedFen: string }> = ({
  illegalMove,
  correctedFen,
}) => {
  const sendPrompt = useChatActions(state => state.sendPrompt);
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!sendPrompt || retrying) return;
    setRetrying(true);
    try {
      await sendPrompt(
        `Your last attempted move "${illegalMove}" was illegal. ` +
          `The board now shows the correct position after my last valid move: [FEN: ${correctedFen}]. ` +
          `From this exact position, use play_turn with this FEN as the current game state to select and play your next move. ` +
          `Do not replay any previous moves or modify the board state in any other way.`
      );
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Box
      data-testid="chess-illegal-move-warning"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.75,
        mt: 0.5,
      }}
    >
      <Chip size="sm" variant="soft" color="warning">
        Illegal move: {illegalMove}
      </Chip>
      <Typography level="body-xs" sx={{ color: 'text.secondary', textAlign: 'center' }}>
        The AI attempted an illegal move. The board shows the correct position.
      </Typography>
      {sendPrompt && (
        <Button
          size="sm"
          variant="soft"
          color="warning"
          loading={retrying}
          onClick={handleRetry}
          data-testid="chess-retry-illegal-move"
        >
          Ask AI to try a different move
        </Button>
      )}
    </Box>
  );
};

/**
 * Inline chess board rendered in ReplyContainer (not via the registry).
 * Chess bypasses the ArtifactRenderer's async ID resolution for instant display.
 */
export const InlineChessBoard: React.FC<{
  fen: string;
  chessData: Record<string, unknown>;
  fenResult: ChessFenResult;
  onOpenPanel: () => void;
}> = ({ fen, chessData, fenResult, onOpenPanel }) => {
  const turnLabel = chessData.turn === 'w' ? 'White' : 'Black';
  let statusText = `${turnLabel} to move`;
  if (fenResult.illegalAiMove) statusText = 'Illegal move — board corrected';
  else if (chessData.isCheckmate) statusText = `Checkmate! ${chessData.turn === 'w' ? 'Black' : 'White'} wins`;
  else if (chessData.isStalemate) statusText = 'Stalemate — draw';
  else if (chessData.isDraw) statusText = 'Draw';
  else if (chessData.isCheck) statusText = `${turnLabel} to move — Check!`;

  const lastMove = !fenResult.illegalAiMove ? extractMove(chessData) : undefined;

  return (
    <Box
      key={`chess-board-${fen}`}
      data-testid="artifact-preview-chess"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        p: 2,
      }}
    >
      <Box
        data-testid="chess-board-click-target"
        onClick={onOpenPanel}
        sx={{ cursor: 'pointer', '&:hover': { opacity: 0.85 } }}
      >
        <ChessBoard fen={fen} lastMove={lastMove} />
      </Box>
      <Typography level="body-sm" sx={{ fontWeight: 500 }}>
        {statusText}
        {!fenResult.illegalAiMove && chessData.moveNumber ? ` — Move ${chessData.moveNumber}` : ''}
      </Typography>
      {fenResult.illegalAiMove && fenResult.correctedFen && (
        <IllegalMoveWarning illegalMove={fenResult.illegalAiMove} correctedFen={fenResult.correctedFen} />
      )}
      {!fenResult.illegalAiMove && (
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          Click to open interactive board
        </Typography>
      )}
    </Box>
  );
};
