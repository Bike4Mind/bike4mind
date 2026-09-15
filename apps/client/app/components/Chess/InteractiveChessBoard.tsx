import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Box, Typography, CircularProgress, IconButton, Tooltip } from '@mui/joy';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import { Chess } from 'chess.js';
import ChessBoard from './ChessBoard';
import { useChessSounds } from './useChessSounds';
import { getOpeningName } from './openings';
import { getSessionMoves } from './chessSessionState';
import { countPieces, summarizeCaptures, PIECE_GLYPH, type PieceType } from './chessBoardUtils';
import useChatActions from '@client/app/hooks/useChatActions';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import type { ChessArtifact } from '@bike4mind/common';

interface CapturedStripProps {
  pieces: PieceType[];
  advantage: number; // shown only when this side is ahead
}

const CapturedStrip: React.FC<CapturedStripProps> = ({ pieces, advantage }) => {
  if (pieces.length === 0 && advantage <= 0) {
    // Render an empty placeholder so the layout doesn't jump
    return <Box sx={{ minHeight: 22 }} />;
  }
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.25,
        minHeight: 22,
        flexWrap: 'wrap',
      }}
      data-testid="chess-captured-strip"
    >
      {pieces.map((p, i) => (
        <Typography
          key={`${p}-${i}`}
          sx={{ fontSize: '1.1rem', lineHeight: 1, color: 'text.secondary' }}
        >
          {PIECE_GLYPH[p]}
        </Typography>
      ))}
      {advantage > 0 && (
        <Typography level="body-xs" sx={{ ml: 0.5, color: 'text.tertiary', fontWeight: 600 }}>
          +{advantage}
        </Typography>
      )}
    </Box>
  );
};

interface ChessData {
  fen: string;
  turn?: 'w' | 'b';
  lastMove?: { from: string; to: string };
  isCheck?: boolean;
  isCheckmate?: boolean;
  isDraw?: boolean;
  isStalemate?: boolean;
  isGameOver?: boolean;
  moveNumber?: number;
}

interface InteractiveChessBoardProps {
  chessData: ChessData;
  sessionId: string;
  playerColor?: 'w' | 'b';
  size?: number;
}

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const InteractiveChessBoard: React.FC<InteractiveChessBoardProps> = ({
  chessData,
  sessionId,
  playerColor = 'w',
  size = 480,
}) => {
  const sendPrompt = useChatActions(state => state.sendPrompt);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoveSquares, setLegalMoveSquares] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const gameRef = useRef<Chess | null>(null);
  const { playMove, playCapture, playCheck, playCheckmate, playGameStart, toggleSound, isSoundOn } = useChessSounds();
  // Tracks the previous displayed FEN so we can fire the right sound on change.
  // Starts null so first mount can detect "fresh game" correctly.
  const prevDisplayFenRef = useRef<string | null>(null);

  // Optimistic local state: shows the board after the player's move before server responds
  const [optimisticFen, setOptimisticFen] = useState<string | null>(null);
  const [optimisticLastMove, setOptimisticLastMove] = useState<{ from: string; to: string } | null>(null);

  // Store-updated FEN: when Zustand store updates before props, use this
  const [storeFen, setStoreFen] = useState<string | null>(null);
  const [storeLastMove, setStoreLastMove] = useState<{ from: string; to: string } | null>(null);

  const fen = chessData.fen || DEFAULT_FEN;
  const isGameOver = chessData.isCheckmate || chessData.isDraw || chessData.isStalemate || chessData.isGameOver;

  // Display FEN priority: optimistic (player just moved) > store (AI responded) > props
  const displayFen = optimisticFen || storeFen || fen;
  const displayLastMove = optimisticLastMove || storeLastMove || chessData.lastMove;

  // Recreate chess.js instance when FEN changes (AI responded with new position)
  const [gameTurn, setGameTurn] = useState<'w' | 'b'>('w');
  useEffect(() => {
    try {
      const game = new Chess(fen);
      gameRef.current = game;
      setGameTurn(game.turn());
    } catch {
      const game = new Chess(DEFAULT_FEN);
      gameRef.current = game;
      setGameTurn(game.turn());
    }
    // Reset selection and local state on server FEN change (props synced with store)
    setSelectedSquare(null);
    setLegalMoveSquares([]);
    setIsSubmitting(false);
    setOptimisticFen(null);
    setOptimisticLastMove(null);
    setStoreFen(null);
    setStoreLastMove(null);
  }, [fen]);

  // Sound-on-change effect: detects FEN transitions and plays the appropriate
  // sound for AI responses + store-driven updates. Optimistic player moves
  // bypass this - they fire sounds inline at click time so the audio is
  // instant.
  //
  // Note: we deliberately do NOT play playGameStart here. Browsers (especially
  // Safari) block AudioContext.resume() outside of a user gesture, and useEffect
  // is not a gesture. The game-start chime is fired from a user gesture in
  // handleSquareClick the first time the player interacts with the board (see
  // gameStartChimedRef below).
  useEffect(() => {
    const newFen = displayFen;
    const prev = prevDisplayFenRef.current;
    prevDisplayFenRef.current = newFen;

    if (prev === null) return; // first mount — initialize ref only
    if (prev === newFen) return;

    // Skip the audio cue if the FEN change came from our own optimistic update -
    // we already played a sound at click time.
    if (optimisticFen && newFen === optimisticFen) return;

    if (chessData.isCheckmate) {
      playCheckmate();
    } else if (chessData.isCheck) {
      playCheck();
    } else if (countPieces(newFen) < countPieces(prev)) {
      playCapture();
    } else {
      playMove();
    }
  }, [
    displayFen,
    chessData.isCheck,
    chessData.isCheckmate,
    optimisticFen,
    playCheckmate,
    playCheck,
    playCapture,
    playMove,
  ]);

  // One-shot game-start chime, fired from a user gesture (the first piece
  // click) so the AudioContext can actually unlock. Falls silent if the player
  // joins mid-game.
  const gameStartChimedRef = useRef(false);
  const playGameStartIfFresh = useCallback(() => {
    if (gameStartChimedRef.current) return;
    gameStartChimedRef.current = true;
    if (displayFen === DEFAULT_FEN) playGameStart();
  }, [displayFen, playGameStart]);

  // Captured pieces strip + material balance, derived from the displayed FEN.
  const captures = useMemo(() => summarizeCaptures(displayFen), [displayFen]);

  // Opening name from the per-session SAN move history (populated in PromptReplies).
  // We re-read on every render - the underlying map is module-level so this is
  // cheap and always current.
  const openingName = useMemo(() => {
    const moves = getSessionMoves(sessionId);
    return getOpeningName(moves);
    // displayFen is in deps so the opening label refreshes when the board does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, displayFen]);

  // Direct Zustand subscription: when the layout store's chess artifact changes,
  // update our board even if props haven't propagated yet
  useEffect(() => {
    return useSessionLayout.subscribe(state => {
      if (state.artifactData?.type !== 'chess') return;
      const artifact = state.artifactData.content as ChessArtifact;
      const newFen = artifact?.metadata?.fen;
      if (!newFen) return;
      // Only update if the store has a newer FEN than our current prop
      const currentFen = chessData.fen || DEFAULT_FEN;
      if (newFen === currentFen) return;

      console.log('[InteractiveChessBoard] Store FEN changed, updating board:', newFen);
      try {
        const game = new Chess(newFen);
        gameRef.current = game;
        setGameTurn(game.turn());
      } catch {
        return;
      }
      // Update displayed board with store FEN
      setStoreFen(newFen);
      setStoreLastMove(artifact?.metadata?.lastMove || null);
      // Reset interaction state
      setSelectedSquare(null);
      setLegalMoveSquares([]);
      setIsSubmitting(false);
      setOptimisticFen(null);
      setOptimisticLastMove(null);
    });
  }, [chessData.fen]);

  const isOwnPiece = useCallback(
    (square: string): boolean => {
      const game = gameRef.current;
      if (!game) return false;
      const piece = game.get(square as 'a1');
      if (!piece) return false;
      return piece.color === playerColor;
    },
    [playerColor]
  );

  const handleSquareClick = useCallback(
    async (square: string) => {
      const game = gameRef.current;
      if (!game || isSubmitting || isGameOver) return;

      // First user gesture is our chance to unlock audio + play the game-start
      // chime. No-op after the first call.
      playGameStartIfFresh();

      // Check if it's the player's turn
      if (game.turn() !== playerColor) return;

      if (selectedSquare === null) {
        // No selection: click own piece to select
        if (isOwnPiece(square)) {
          const moves = game.moves({ square: square as 'a1', verbose: true });
          if (moves.length > 0) {
            setSelectedSquare(square);
            setLegalMoveSquares(moves.map(m => m.to));
          }
        }
      } else if (square === selectedSquare) {
        // Click same piece: deselect
        setSelectedSquare(null);
        setLegalMoveSquares([]);
      } else if (isOwnPiece(square)) {
        // Click different own piece: reselect
        const moves = game.moves({ square: square as 'a1', verbose: true });
        if (moves.length > 0) {
          setSelectedSquare(square);
          setLegalMoveSquares(moves.map(m => m.to));
        } else {
          setSelectedSquare(null);
          setLegalMoveSquares([]);
        }
      } else if (legalMoveSquares.includes(square)) {
        // Click legal destination: submit move
        const moves = game.moves({ square: selectedSquare as 'a1', verbose: true });
        const move = moves.find(m => m.to === square);
        if (!move) return;

        // Use SAN notation (e.g., "e4", "Nf3", "Bxc6")
        // Auto-queen for pawn promotion
        const san = move.promotion ? move.san.replace(/=[QRBN]/, '=Q') : move.san;

        // Apply the move on chess.js for optimistic display
        try {
          const moveOptions = move.promotion
            ? { from: selectedSquare as 'a1', to: square as 'a1', promotion: 'q' as const }
            : { from: selectedSquare as 'a1', to: square as 'a1' };
          const applied = game.move(moveOptions);
          setOptimisticFen(game.fen());
          setOptimisticLastMove({ from: selectedSquare, to: square });
          // Fire instant audio feedback for the player's own move. Captures get
          // a thud, regular moves get a tap. (AI responses are handled by the
          // FEN-change effect.)
          if (applied?.captured) playCapture();
          else playMove();
        } catch {
          // If chess.js rejects, just proceed without optimistic update
        }

        setSelectedSquare(null);
        setLegalMoveSquares([]);
        setIsSubmitting(true);

        try {
          if (sendPrompt) {
            // Include FEN so the LLM can call play_turn with the correct position
            await sendPrompt(`I play ${san} [FEN: ${fen}]`);
          } else {
            console.error('[InteractiveChessBoard] sendPrompt not available — SessionBottom not mounted?');
            // Revert optimistic state and reset game to pre-move FEN
            setOptimisticFen(null);
            setOptimisticLastMove(null);
            gameRef.current = new Chess(fen);
            setIsSubmitting(false);
          }
        } catch (err) {
          console.error('[InteractiveChessBoard] Failed to submit move:', err);
          // Revert optimistic state and reset game to pre-move FEN
          setOptimisticFen(null);
          setOptimisticLastMove(null);
          gameRef.current = new Chess(fen);
          setIsSubmitting(false);
        }
      } else {
        // Click illegal square: deselect
        setSelectedSquare(null);
        setLegalMoveSquares([]);
      }
    },
    [
      selectedSquare,
      legalMoveSquares,
      isSubmitting,
      isGameOver,
      playerColor,
      isOwnPiece,
      sendPrompt,
      fen,
      playCapture,
      playMove,
      playGameStartIfFresh,
    ]
  );

  // Derive turn from chess.js (authoritative) with metadata fallback
  const effectiveTurn = gameTurn;
  const turnLabel = effectiveTurn === 'w' ? 'White' : 'Black';
  let statusText = `${turnLabel} to move`;
  if (chessData.isCheckmate) {
    statusText = `Checkmate! ${effectiveTurn === 'w' ? 'Black' : 'White'} wins`;
  } else if (chessData.isStalemate) {
    statusText = 'Stalemate \u2014 draw';
  } else if (chessData.isDraw) {
    statusText = 'Draw';
  } else if (chessData.isCheck) {
    statusText = `${turnLabel} to move \u2014 Check!`;
  }

  const isPlayerTurn = effectiveTurn === playerColor && !isGameOver;

  // The strip "above" the board shows pieces the OPPONENT has captured (your
  // losses). The strip "below" shows pieces YOU have captured. Orientation
  // flips when playing as black so "above" always means opponent.
  const oppCaptures = playerColor === 'w' ? captures.capturedByBlack : captures.capturedByWhite;
  const oppAdvantage = playerColor === 'w' ? -captures.materialAdvantage : captures.materialAdvantage;
  const myCaptures = playerColor === 'w' ? captures.capturedByWhite : captures.capturedByBlack;
  const myAdvantage = playerColor === 'w' ? captures.materialAdvantage : -captures.materialAdvantage;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      {/* Header: opening name + sound toggle */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: size,
          gap: 1,
        }}
      >
        <Typography
          level="body-sm"
          sx={{ fontWeight: 600, color: 'text.secondary', fontStyle: 'italic' }}
          data-testid="chess-opening-name"
        >
          {openingName}
        </Typography>
        <Tooltip title={isSoundOn ? 'Mute' : 'Unmute'} variant="soft">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={toggleSound}
            data-testid="chess-sound-toggle"
            aria-label={isSoundOn ? 'Mute chess sounds' : 'Unmute chess sounds'}
          >
            {isSoundOn ? <VolumeUpIcon fontSize="small" /> : <VolumeOffIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Box>

      {/* Captures taken from you (opponent's pile) */}
      <Box sx={{ width: size, display: 'flex', justifyContent: 'flex-start' }}>
        <CapturedStrip pieces={oppCaptures} advantage={oppAdvantage} />
      </Box>

      <ChessBoard
        fen={displayFen}
        lastMove={displayLastMove}
        orientation={playerColor}
        size={size}
        selectedSquare={selectedSquare}
        legalMoveSquares={legalMoveSquares}
        onSquareClick={handleSquareClick}
        interactive={isPlayerTurn && !isSubmitting}
      />

      {/* Captures you've taken */}
      <Box sx={{ width: size, display: 'flex', justifyContent: 'flex-start' }}>
        <CapturedStrip pieces={myCaptures} advantage={myAdvantage} />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography level="body-sm" sx={{ fontWeight: 500 }}>
          {statusText}
          {chessData.moveNumber ? ` \u2014 Move ${chessData.moveNumber}` : ''}
        </Typography>
        {isSubmitting && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <CircularProgress size="sm" sx={{ '--CircularProgress-size': '14px' }} />
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              Waiting for opponent...
            </Typography>
          </Box>
        )}
      </Box>
      {isPlayerTurn && !isSubmitting && !isGameOver && (
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          Click a piece to see legal moves, then click a destination
        </Typography>
      )}
    </Box>
  );
};

export default InteractiveChessBoard;
