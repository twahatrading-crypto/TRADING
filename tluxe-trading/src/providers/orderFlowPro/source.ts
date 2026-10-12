import type { OfpFrame, OfpRoot, SourceStatus } from '../../engines/orderFlowPro/types';

export interface SourceSink {
  frames(frames: OfpFrame[]): void;
  status(s: SourceStatus): void;
  /** Source clock (ms). For the backend: server time; for DEMO: the fixture clock. */
  time(now: number): void;
  /** The stream restarted from a fresh snapshot (backend restart / fell behind): clear all derived state first. */
  reset?(reason: string): void;
}

export interface SourceInfo {
  id: string;
  name: string;
  /** DEMO sources are never labelled LIVE and are refused outside the dev harness / tests. */
  demo: boolean;
}

/** A market-data source for Order Flow Pro. Read-only: there is no method that could send anything but a read. */
export interface OfpSource {
  readonly info: SourceInfo;
  subscribe(root: OfpRoot, sink: SourceSink): () => void;
  /** Recorded frames for replay (backend database / regenerated DEMO). */
  history(root: OfpRoot, from: number, to: number): Promise<OfpFrame[]>;
  /** Ask the backend to subscribe a different verified contract. */
  selectContract?(root: OfpRoot, localSymbol: string): Promise<void>;
}
