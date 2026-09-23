/**
 * Strategy engine registry. `implemented` engines exist in code; their live
 * status comes from runtime (running on real data or waiting for it).
 * Unimplemented engines are DISABLED. Status reflects this truthfully.
 */
export interface EngineConfig {
  id: string;
  label: string;
  enabled: boolean;
  implemented?: boolean;
}

export const ENGINES: EngineConfig[] = [
  { id: 'order-block', label: 'Order Block Engine', enabled: false },
  { id: 'liquidity', label: 'Liquidity Engine', enabled: false },
  { id: 'support-resistance', label: 'Support & Resistance Engine', enabled: true, implemented: true },
  { id: 'sweep-reversal', label: 'Sweep/Reversal Engine', enabled: false },
];
