import type { AiActionId, AiTab } from '../../types/ai';
import type { ProviderStatus } from '../../types/providers';

export interface AiRequest {
  /** Instrument the request is about. Explicit — never assumed. Null only if no context is set. */
  instrumentId: string | null;
  tab: AiTab;
  action: AiActionId | null;
  text: string;
}

export interface AiResponse {
  text: string;
}

export interface AiProvider {
  readonly name: string | null;
  status(): ProviderStatus;
  send(request: AiRequest): Promise<AiResponse>;
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
