import type { AiProvider, AiRequest, AiResponse, AiTurn } from '../../services/ai/AiProvider';
import type { ProviderStatus } from '../../types/providers';
import { TluxeAiClient, TluxeAiError, type TluxeAiHealth } from './client';
import type { TluxeAiConfig } from './config';

/** Browser-side request bounds (the backend enforces its own limits too). */
export const AI_HISTORY_LIMITS = { turns: 20, chars: 48_000 } as const;

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

/**
 * TLUXE AI → local TLUXE AI backend (bridge/ai) → OpenAI Responses API.
 *
 * The browser never calls OpenAI and never holds the OpenAI key. "Connected" is reported ONLY when the backend says
 * OpenAI itself verified the key and the configured model (`health.connected === true`) — a running backend alone
 * is not enough. Phase 1 is Chat only and READ-ONLY; other modes are refused here (never faked).
 */
export class TluxeAiProvider implements AiProvider {
  private health_: TluxeAiHealth | null = null;
  private reason_: string | null = 'Checking the TLUXE AI backend…';
  private state: ProviderStatus = 'CONNECTING';
  private listeners = new Set<() => void>();
  private timer: unknown = null;
  private running = false;
  private inflight: AbortController | null = null;
  private readonly client: TluxeAiClient;
  private readonly timers: Timers;

  constructor(
    private readonly cfg: TluxeAiConfig,
    deps: { client?: TluxeAiClient; timers?: Timers } = {},
  ) {
    this.client = deps.client ?? new TluxeAiClient(cfg.url, cfg.token);
    this.timers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
  }

  get name(): string | null {
    return this.health_?.connected ? `OpenAI · ${this.health_.model}` : null;
  }
  status(): ProviderStatus {
    return this.state;
  }
  statusReason(): string | null {
    return this.reason_;
  }
  lastHealth(): TluxeAiHealth | null {
    return this.health_;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
  private set(state: ProviderStatus, reason: string | null, health: TluxeAiHealth | null): void {
    const changed = state !== this.state || reason !== this.reason_ || health?.model !== this.health_?.model || health?.connected !== this.health_?.connected;
    this.state = state;
    this.reason_ = reason;
    this.health_ = health;
    if (changed) this.emit();
  }

  /** One health check. CONNECTED only when the backend reports the provider verified. */
  async checkHealth(): Promise<void> {
    this.inflight?.abort();
    const ctl = new AbortController();
    this.inflight = ctl;
    try {
      const h = await this.client.health(10_000, ctl.signal);
      if (h?.service !== 'tluxe-ai' || typeof h.connected !== 'boolean') return this.set('NOT_CONNECTED', 'Unexpected answer from the TLUXE AI backend.', null);
      if (h.connected === true && h.status === 'CONNECTED') this.set('CONNECTED', null, h);
      else this.set('NOT_CONNECTED', h.reason ?? `AI provider ${h.status.replace(/_/g, ' ').toLowerCase()}.`, h);
    } catch (e) {
      if (ctl.signal.aborted && this.inflight !== ctl) return; // superseded
      this.set('NOT_CONNECTED', e instanceof TluxeAiError ? e.message : 'The TLUXE AI backend is not reachable.', null);
    } finally {
      if (this.inflight === ctl) this.inflight = null;
    }
  }

  /** Single health loop (idempotent; HMR / StrictMode safe). Faster re-checks while not connected. */
  start(): () => void {
    if (this.running) return () => this.stop();
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.checkHealth();
      if (!this.running) return;
      this.timer = this.timers.setTimeout(() => void loop(), this.state === 'CONNECTED' ? this.cfg.healthMs : Math.min(this.cfg.healthMs, 10_000));
    };
    void loop();
    return () => this.stop();
  }
  private stop(): void {
    this.running = false;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.inflight?.abort();
  }
  isRunning(): boolean {
    return this.running;
  }

  async send(req: AiRequest): Promise<AiResponse> {
    if (req.tab !== 'chat' || req.action !== null) {
      throw new TluxeAiError('MODE_NOT_AVAILABLE', 'Only Chat is available in this phase - this mode is not implemented yet.', false);
    }
    if (this.state !== 'CONNECTED') throw new TluxeAiError('NOT_CONNECTED', this.reason_ ?? 'TLUXE AI is not connected.', true);
    const history = boundHistory(req.history ?? []);
    try {
      const res = await this.client.chat({ mode: 'chat', messages: [...history, { role: 'user', content: req.text }], context: req.context ?? null }, this.cfg.requestTimeoutMs, req.signal);
      if (typeof res?.text !== 'string' || !res.text.trim()) throw new TluxeAiError('EMPTY_RESPONSE', 'The AI provider returned no answer.', true);
      return { text: res.text, model: res.model ?? null };
    } catch (e) {
      // A provider-side authentication / model problem means we are no longer connected: re-verify.
      if (e instanceof TluxeAiError && ['PROVIDER_AUTH', 'MODEL_UNAVAILABLE', 'PROVIDER_PERMISSION', 'NOT_CONFIGURED', 'UNAUTHORIZED', 'BACKEND_UNREACHABLE'].includes(e.code)) void this.checkHealth();
      throw e;
    }
  }
}

/** Keep the most recent turns within the turn / character budget, starting on a user turn. */
export function boundHistory(turns: readonly AiTurn[]): AiTurn[] {
  const out: AiTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && out.length < AI_HISTORY_LIMITS.turns; i--) {
    const t = turns[i]!;
    if (chars + t.content.length > AI_HISTORY_LIMITS.chars) break;
    chars += t.content.length;
    out.unshift(t);
  }
  while (out.length && out[0]!.role !== 'user') out.shift();
  return out;
}
