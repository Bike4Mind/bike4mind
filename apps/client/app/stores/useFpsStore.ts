import { create } from 'zustand';

interface FpsState {
  fps: number;
  setFps: (fps: number) => void;
}

const useFpsStore = create<FpsState>(set => ({
  fps: 0,
  setFps: fps => set({ fps }),
}));

export default useFpsStore;
