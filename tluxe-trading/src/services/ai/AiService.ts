import { createStore, type Store } from '../../store/createStore';
import type { AiActionId, AiMessage, AiTab } from '../../types/ai';
import type { ProviderStatus } from '../../types/providers';
import type { AiProvider, AiTurn } from './AiProvider';
import type { AiContext } from './context/types';

export interface AiState {
  status: ProviderStatus;
  providerName: string | null;
  /** Why the provider is not connected (safe text), when known. */
  statusReason: string | null;
  messages: AiMessage[];
  pending: boolean;
  /** True when a read-only market / engine context adapter is attached. */
  contextAvailable: boolean;
}

export const AI_ACTION_LABELS: Record<AiActionId, string> = {
  'analyze-market': 'Analyze Market',
  'check-engine': 'Check My Engine',
  'find-problems': 'Find Problems',
  'deep-research': 'Deep Research',
  'build-feature': 'Build Feature',
};

export const AI_NOT_CONNECTED_NOTICE =
  'Not sent — TLUXE AI is not connected. Configure an AI provider to enable responses.';
export const AI_CANCELLED_NOTICE = 'Generation stopped.';

const isAbort = (e: unknown) => e instanceof Error && (e.name === 'AbortError' || e.name === 'TluxeAiCancelledError');

/**
 * TLUXE AI conversation runtime (outside React). One request at a time (duplicate sends are ignored), multi-turn
 * history from the answered turns only, Stop (AbortController), Retry of a failed / stopped turn, Clear.
 * Never fabricates an answer: a missing provider or a failure is shown as a system notice.
 */
export class AiService {
  readonly store: Store<AiState>;
  private seq = 0;
  private instrumentId: string | null = null;
  private controller: AbortController | null = null;
  private contextSource: (() => AiContext | null) | null = null;

  constructor(private readonly provider: AiProvider, private readonly clock: () => number = Date.now) {
    this.store = createStore<AiState>({
      status: provider.status(),
      providerName: provider.name,
      statusReason: provider.statusReason?.() ?? null,
      messages: [],
      pending: false,
      contextAvailable: false,
    });
  }

  private push(role: AiMessage['role'], text: string, extra: Partial<AiMessage> = {}): AiMessage {
    const msg: AiMessage = { id: `m${++this.seq}`, role, text, createdAt: this.clock(), ...extra };
    this.store.setState((s) => ({ ...s, messages: [...s.messages, msg] }));
    return msg;
  }
  private patch(id: string, p: Partial<AiMessage>): void {
    this.store.setState((s) => ({ ...s, messages: s.messages.map((m) => (m.id === id ? { ...m, ...p } : m)) }));
  }
  private syncStatus(): void {
    this.store.setState({ status: this.provider.status(), providerName: this.provider.name, statusReason: this.provider.statusReason?.() ?? null });
  }

  /** The dashboard's active instrument; every request carries it. */
  setInstrument(instrumentId: string): void {
    this.instrumentId = instrumentId;
  }

  /** Attach the READ-ONLY market / engine context adapter (see context/buildAiContext). */
  setContextSource(source: (() => AiContext | null) | null): void {
    this.contextSource = source;
    this.store.setState({ contextAvailable: source !== null });
  }

  /** Start provider health checks (if the provider has them) and mirror its status. Returns the stop function. */
  start(): () => void {
    const off = this.provider.subscribe?.(() => this.syncStatus()) ?? (() => {});
    const stop = this.provider.start?.() ?? (() => {});
    this.syncStatus();
    return () => {
      off();
      stop();
      this.cancel(false);
    };
  }

  /** Answered turns only (failed / stopped questions and system notices are never part of the model history). */
  private history(before: string): AiTurn[] {
    const out: AiTurn[] = [];
    for (const m of this.store.getState().messages) {
      if (m.id === before) break;
      if (m.role === 'assistant') out.push({ role: 'assistant', content: m.text });
      else if (m.role === 'user' && (m.state === undefined || m.state === 'answered')) out.push({ role: 'user', content: m.text });
    }
    // Keep only complete user → assistant pairs.
    const pairs: AiTurn[] = [];
    for (let i = 0; i < out.length; i++) {
      if (out[i]!.role === 'user' && out[i + 1]?.role === 'assistant') {
        pairs.push(out[i]!, out[i + 1]!);
        i++;
      }
    }
    return pairs;
  }

  async send(tab: AiTab, text: string, action: AiActionId | null = null): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.store.getState().pending) return; // duplicate / blank sends are ignored
    const user = this.push('user', trimmed, { state: 'pending' });
    await this.dispatch(user, tab, action);
  }

  private async dispatch(user: AiMessage, tab: AiTab, action: AiActionId | null): Promise<void> {
    const status = this.provider.status();
    this.store.setState({ status });
    if (status !== 'CONNECTED') {
      this.patch(user.id, { state: 'failed' });
      this.push('system', AI_NOT_CONNECTED_NOTICE, { state: 'notice' });
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.store.setState({ pending: true });
    try {
      let context: AiContext | null = null;
      try {
        context = this.contextSource?.() ?? null;
      } catch {
        context = null; // a context problem never blocks the chat; it is simply not sent
      }
      const res = await this.provider.send({ instrumentId: this.instrumentId, tab, action, text: user.text, history: this.history(user.id), context, signal: controller.signal });
      if (controller.signal.aborted) return;
      this.patch(user.id, { state: 'answered' });
      this.push('assistant', res.text, { model: res.model ?? null });
    } catch (err) {
      if (controller.signal.aborted || isAbort(err)) {
        this.patch(user.id, { state: 'cancelled' });
        if (!this.store.getState().messages.some((m) => m.retryOf === user.id && m.state === 'cancelled')) this.push('system', AI_CANCELLED_NOTICE, { state: 'cancelled', retryOf: user.id });
        return;
      }
      this.patch(user.id, { state: 'failed' });
      const retryable = !(err instanceof Error && 'retryable' in err && (err as { retryable: unknown }).retryable === false);
      this.push('system', `Request failed: ${err instanceof Error ? err.message : String(err)}`, { state: 'error', ...(retryable ? { retryOf: user.id } : {}) });
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.store.setState({ pending: false });
      }
      this.syncStatus();
    }
  }

  /** Stop the answer being generated (the request is aborted; nothing partial is shown as an answer). */
  cancel(notify = true): void {
    const c = this.controller;
    if (!c) return;
    this.controller = null;
    c.abort();
    this.store.setState({ pending: false });
    if (!notify) return;
    const pendingUser = [...this.store.getState().messages].reverse().find((m) => m.role === 'user' && m.state === 'pending');
    if (pendingUser) {
      this.patch(pendingUser.id, { state: 'cancelled' });
      this.push('system', AI_CANCELLED_NOTICE, { state: 'cancelled', retryOf: pendingUser.id });
    }
  }

  /** Re-send the last failed / stopped question (its error notice is replaced by the new attempt). */
  async retry(tab: AiTab = 'chat'): Promise<void> {
    if (this.store.getState().pending) return;
    const msgs = this.store.getState().messages;
    const notice = [...msgs].reverse().find((m) => m.retryOf);
    const user = notice ? msgs.find((m) => m.id === notice.retryOf) : undefined;
    if (!notice || !user) return;
    this.store.setState((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== notice.id) }));
    this.patch(user.id, { state: 'pending' });
    await this.dispatch({ ...user, state: 'pending' }, tab, null);
  }

  /** Clear the conversation (stops a running request first). */
  clear(): void {
    this.cancel(false);
    this.store.setState({ messages: [], pending: false });
  }

  runAction(tab: AiTab, action: AiActionId): Promise<void> {
    return this.send(tab, AI_ACTION_LABELS[action], action);
  }
}
