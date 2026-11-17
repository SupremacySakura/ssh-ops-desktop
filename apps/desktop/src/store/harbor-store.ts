import type { CoreHealth, Group, Server } from '@opspilot/contracts';
import { create } from 'zustand';

export type CoreHealthState =
  | { status: 'loading' }
  | { status: 'ready'; health: CoreHealth }
  | { status: 'unavailable' };

interface HarborState {
  coreHealth: CoreHealthState;
  groups: Group[];
  query: string;
  selectedServerId: string | null;
  servers: Server[];
  reset: () => void;
  setCoreHealth: (health: CoreHealthState) => void;
  setQuery: (query: string) => void;
}

const initialState = {
  coreHealth: { status: 'loading' } satisfies CoreHealthState,
  groups: [] as Group[],
  query: '',
  selectedServerId: null,
  servers: [] as Server[],
};

export const useHarborStore = create<HarborState>((set) => ({
  ...initialState,
  reset: () => set(initialState),
  setCoreHealth: (coreHealth) => set({ coreHealth }),
  setQuery: (query) => set({ query }),
}));
