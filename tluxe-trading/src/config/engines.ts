/**
 * Strategy engine registry. Phase 1: every engine is disabled and has no
 * implementation. Status reflects this truthfully.
 */
export interface EngineConfig {
  id: string;
  label: string;
  enabled: boolean;
}

export const ENGINES: EngineConfig[] = [
  { id: 'order-block', label: 'Order Block Engine', enabled: false },
  { id: 'liquidity', label: 'Liquidity Engine', enabled: false },
  { id: 'support-resistance', label: 'Support & Resistance Engine', enabled: false },
  { id: 'sweep-reversal', label: 'Sweep/Reversal Engine', enabled: false },
];
