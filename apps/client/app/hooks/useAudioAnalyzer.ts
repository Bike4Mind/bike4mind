import { useCallback, useEffect, useRef, useState } from 'react';

interface AudioData {
  frequencyBars: number[];
  volume: number;
  isActive: boolean;
}

export const useAudioAnalyzer = (stream: MediaStream | null) => {
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const frameRef = useRef<number | null>(null);
  const analyzeRef = useRef<(() => void) | null>(null);

  const [audioData, setAudioData] = useState<AudioData>({
    frequencyBars: new Array(16).fill(0),
    volume: 0,
    isActive: false,
  });

  const analyze = useCallback(() => {
    if (!analyserRef.current) return;

    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const frequencyData = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(frequencyData);

    const sum = frequencyData.reduce((acc, val) => acc + val, 0);
    const volume = Math.min(sum / (bufferLength * 255), 1);

    // Generate 16 frequency bars
    const barCount = 16;
    const barWidth = Math.floor(bufferLength / barCount);
    const frequencyBars = Array.from({ length: barCount }, (_, i) => {
      const start = i * barWidth;
      const end = Math.min(start + barWidth, bufferLength);
      const barSum = frequencyData.slice(start, end).reduce((acc, val) => acc + val, 0);
      return Math.min(barSum / (barWidth * 255), 1);
    });

    setAudioData({
      frequencyBars,
      volume,
      isActive: volume > 0.01,
    });

    frameRef.current = requestAnimationFrame(() => analyzeRef.current?.());
  }, []);

  useEffect(() => {
    analyzeRef.current = analyze;
  }, [analyze]);

  const cleanup = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current?.state !== 'closed') {
      audioContextRef.current?.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  // Initialize audio analysis when stream is available
  useEffect(() => {
    if (!stream) {
      cleanup();
      return;
    }

    const setupAudioAnalysis = async () => {
      try {
        cleanup(); // Clean previous setup

        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        const analyser = audioContext.createAnalyser();

        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        analyser.minDecibels = -90;
        analyser.maxDecibels = -10;

        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);

        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        sourceRef.current = source;

        analyze();
      } catch (error) {
        console.error('Failed to setup audio analysis:', error);
      }
    };

    setupAudioAnalysis();
  }, [stream, analyze, cleanup]);

  useEffect(() => cleanup, [cleanup]);

  return audioData;
};
