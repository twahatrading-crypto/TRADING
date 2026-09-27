import type { AiActionId, AiTab } from '../../types/ai';
import type { ProviderStatus } from '../../types/providers';
import type { AiContext } from './context/types';

/** One conversation turn sent to the model (system notices / errors are never part of the history). */
export interface AiTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  /** Instrument the request is about. Explicit — never assumed. Null only if no context is set. */
  instrumentId: string | null;
  tab: AiTab;
  action: AiActionId | null;
  text: string;
  /** Prior turns (oldest first, bounded) for multi-turn context. The current `text` is NOT included. */
  history?: AiTurn[];
  /** Read-only market / engine snapshot with provenance (never secrets). */
  context?: AiContext | null;
  /** Cancels the request (Stop). */
  signal?: AbortSignal;
}

export interface AiResponse {
  text: string;
  model?: string | null;
}

export interface AiProvider {
  readonly name: string | null;
  status(): ProviderStatus;
  send(request: AiRequest): Promise<AiResponse>;
  /** Why the provider is not connected (safe text for the UI), when known. */
  statusReason?(): string | null;
  /** Start background health checks; returns the stop function (HMR-safe, idempotent). */
  start?(): () => void;
  /** Notified whenever status / name / reason change. */
  subscribe?(listener: () => void): () => void;
}

export class AiNotConnectedError extends Error {
  constructor() {
    super('TLUXE AI provider is not connected');
    this.name = 'AiNotConnectedError';
  }
}

/** Used until a real model backend is configured. Never fabricates a reply. */
export class NullAiProvider implements AiProvider {
  readonly name = null;
  status(): ProviderStatus {
    return 'NOT_CONNECTED';
  }
  send(): Promise<AiResponse> {
    return Promise.reject(new AiNotConnectedError());
  }
}
