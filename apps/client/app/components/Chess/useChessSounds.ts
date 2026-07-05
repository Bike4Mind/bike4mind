import { useState, useCallback, useRef, useEffect } from 'react';

// Web Audio API synthesized chess sounds. Zero audio files, no dependencies.
// Ported from erikbethke.com/apps/portfolio/app/projects/chess/hooks/useChessSounds.ts.

const STORAGE_KEY = 'lumina5-chess-sound-pref';

export function useChessSounds() {
  const [isSoundOn, setIsSoundOn] = useState(true);
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) setIsSoundOn(saved === 'true');
  }, []);

  const getCtx = useCallback((): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    if (!ctxRef.current) {
      try {
        ctxRef.current = new AudioContext();
      } catch {
        return null;
      }
    }
    if (ctxRef.current.state === 'suspended') {
      void ctxRef.current.resume();
    }
    return ctxRef.current;
  }, []);

  // Piece placed on board - woody tap (bandpass-filtered noise burst)
  const playMove = useCallback(() => {
    if (!isSoundOn) return;
    const ctx = getCtx();
    if (!ctx) return;
    const t = ctx.currentTime;

    const bufLen = Math.floor(ctx.sampleRate * 0.06);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufLen, 3);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 800;
    filter.Q.value = 2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(t);
  }, [isSoundOn, getCtx]);

  // Piece captured - heavier thud with low resonance
  const playCapture = useCallback(() => {
    if (!isSoundOn) return;
    const ctx = getCtx();
    if (!ctx) return;
    const t = ctx.currentTime;

    // Impact noise
    const bufLen = Math.floor(ctx.sampleRate * 0.1);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufLen, 2);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.35, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start(t);

    // Low thud tone
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(80, t + 0.1);
    oscGain.gain.setValueAtTime(0.2, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.start(t);
    osc.stop(t + 0.15);
  }, [isSoundOn, getCtx]);

  // Check - sharp rising alert tone
  const playCheck = useCallback(() => {
    if (!isSoundOn) return;
    const ctx = getCtx();
    if (!ctx) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(600, t);
    osc.frequency.linearRampToValueAtTime(900, t + 0.08);
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    osc.start(t);
    osc.stop(t + 0.15);
  }, [isSoundOn, getCtx]);

  // Checkmate - dramatic two-hit
  const playCheckmate = useCallback(() => {
    if (!isSoundOn) return;
    const ctx = getCtx();
    if (!ctx) return;
    const t = ctx.currentTime;

    // First hit
    const osc1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc1.connect(g1);
    g1.connect(ctx.destination);
    osc1.type = 'sawtooth';
    osc1.frequency.value = 220;
    g1.gain.setValueAtTime(0.2, t);
    g1.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    osc1.start(t);
    osc1.stop(t + 0.3);

    // Second hit (lower, more final)
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.connect(g2);
    g2.connect(ctx.destination);
    osc2.type = 'sawtooth';
    osc2.frequency.value = 110;
    g2.gain.setValueAtTime(0.25, t + 0.25);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    osc2.start(t + 0.25);
    osc2.stop(t + 0.7);
  }, [isSoundOn, getCtx]);

  // Game start - short ascending chime (A4 C#5 E5)
  const playGameStart = useCallback(() => {
    if (!isSoundOn) return;
    const ctx = getCtx();
    if (!ctx) return;
    const notes = [440, 554, 659];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const st = ctx.currentTime + i * 0.08;
      gain.gain.setValueAtTime(0.1, st);
      gain.gain.exponentialRampToValueAtTime(0.001, st + 0.15);
      osc.start(st);
      osc.stop(st + 0.15);
    });
  }, [isSoundOn, getCtx]);

  const toggleSound = useCallback(() => {
    setIsSoundOn(prev => {
      const next = !prev;
      if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return { playMove, playCapture, playCheck, playCheckmate, playGameStart, toggleSound, isSoundOn };
}
