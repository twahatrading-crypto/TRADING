import type { AiTurn } from '../../services/ai/AiProvider';
import type { AiContext } from '../../services/ai/context/types';
import { backendCredentials, IS_CLOUD } from '../../config/deployment';

/* Wire types of the local TLUXE AI backend (bridge/ai). No credentials ever travel in a body or URL. */

export interface TluxeAiHealth {
  service: 'tluxe-ai';
  version: string;
  provider: 'openai';
  api: 'responses';
  model: string;
  status: 'CONNECTED' | 'NOT_CONFIGURED' | 'AUTH_ERROR' | 'MODEL_UNAVAILABLE' | 'RATE_LIMITED' | 'UNREACHABLE' | 'ERROR';
  connected: boolean;
  reason: string | null;
  checkedAtMs: number | null;
  permissions: { readOnly: boolean; tools: unknown[] } & Record<string, unknown>;
  capabilities: { chat: boolean; research: boolean; analysis: boolean; tools: boolean };
  limits: { maxMessages: number; maxMessageChars: number; maxTotalChars: number; maxContextBytes: number; timeoutS: number };
}

export interface TluxeAiChatRequest {
  mode: 'chat';
  messages: AiTurn[];
  context?: AiContext | null;
  requestId?: string;
}

export interface TluxeAiChatResponse {
  text: string;
  model: string | null;
  responseId: string | null;
  incomplete: boolean;
  requestId: string | null;
}

/** A failed backend call with a user-facing message. `retryable` = the same request may succeed later. */
export class TluxeAiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = 'TluxeAiError';
  }
}

export class TluxeAiCancelledError extends Error {
  constructor() {
    super('Generation stopped.');
    this.name = 'TluxeAiCancelledError';
  }
}

const RETRYABLE = new Set(['TIMEOUT', 'RATE_LIMITED', 'BUSY', 'PROVIDER_UNREACHABLE', 'EMPTY_RESPONSE', 'PROVIDER_ERROR', 'BACKEND_UNREACHABLE', 'ERROR']);

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class TluxeAiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
  ) {}

  private async call<T>(path: string, init: RequestInit, timeoutMs: number, external?: AbortSignal): Promise<T> {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
    const onAbort = () => ctl.abort();
    if (external?.aborted) ctl.abort();
    external?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${this.token}` },
        cache: 'no-store',
        credentials: backendCredentials(),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) {
        const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
        const code = err?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'ORIGIN_NOT_ALLOWED' : 'ERROR');
        const message =
          code === 'UNAUTHORIZED' ? 'The TLUXE AI backend rejected the bridge token (Settings → TLUXE AI).' : err?.message ?? `TLUXE AI backend error (HTTP ${res.status}).`;
        throw new TluxeAiError(code, message, RETRYABLE.has(code), res.status);
      }
      return body as T;
    } catch (e) {
      if (e instanceof TluxeAiError) throw e;
      if (external?.aborted) throw new TluxeAiCancelledError();
      if (timedOut) throw new TluxeAiError('TIMEOUT', `TLUXE AI did not answer within ${Math.round(timeoutMs / 1000)} s.`, true);
      throw new TluxeAiError('BACKEND_UNREACHABLE', IS_CLOUD ? 'The TLUXE AI service is not reachable through the TLUXE gateway.' : 'The TLUXE AI backend is not reachable (start bridge\\ai\\start_ai.cmd).', true);
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }

  health(timeoutMs = 10_000, signal?: AbortSignal): Promise<TluxeAiHealth> {
    return this.call<TluxeAiHealth>('/api/ai/health', { method: 'GET' }, timeoutMs, signal);
  }

  chat(body: TluxeAiChatRequest, timeoutMs: number, signal?: AbortSignal): Promise<TluxeAiChatResponse> {
    return this.call<TluxeAiChatResponse>('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs, signal);
  }
}
