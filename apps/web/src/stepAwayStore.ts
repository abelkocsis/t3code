import { create } from "zustand";

/**
 * Step away mode: the overlay window at a size that reads from across a room.
 *
 * Deliberately not a persisted setting. It answers "I am leaving the machine
 * now", so it must not survive a restart and come back on tomorrow morning
 * over an app the user is sitting in front of.
 */
interface StepAwayState {
  readonly active: boolean;
  readonly setActive: (active: boolean) => void;
  readonly toggle: () => void;
}

export const useStepAwayStore = create<StepAwayState>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
  toggle: () => set((state) => ({ active: !state.active })),
}));
