/**
 * TEST DATA ONLY — replays a scripted synthetic trade stream through the real provider boundary.
 * `info.test = true`: the registry refuses it unless `allowTestProviders` (tests / dev harness only).
 */
import type { FootprintCapabilities, FootprintMsg } from '../../../engines/volumeFootprint/types';
import type { InstrumentDefinition, InstrumentId } from '../../../types/instruments';
import type { FootprintSink, FootprintTradeProvider } from '../types';

export class ScriptedFootprintProvider implements FootprintTradeProvider {
  readonly info = { id: 'test-footprint', name: 'TEST DATA — SYNTHETIC TRADES, NOT MARKET DATA', test: true };
  private sink: FootprintSink | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  subscriptions = 0;
  connects = 0;

  /**
   * @param script   messages (caps / status entries are ignored — capabilities come from `caps`)
   * @param mode     'instant' = deliver everything on subscribe; 'realtime' = deliver messages whose receive
   *                 time has passed (now), then keep delivering on a timer
   */
  constructor(
    private readonly script: readonly FootprintMsg[],
    private readonly caps: FootprintCapabilities,
    private readonly o: { mode: 'instant' | 'realtime'; now?: () => number } = { mode: 'instant' },
  ) {}

  connect(sink: FootprintSink): void {
    this.connects += 1;
    this.sink = sink;
  }
  disconnect(): void {
    this.stop();
    this.sink = null;
  }
  subscribe(i: InstrumentDefinition): void {
    this.subscriptions += 1;
    this.stop();
    this.cursor = 0;
    const sink = this.sink;
    if (!sink) return;
    // Capabilities / status are stamped on the script's own receive clock (keeps the recorded stream in receive order).
    const first = this.script.find((m) => m.type !== 'caps' && m.type !== 'status')?.recvTime ?? 0;
    sink.message({ type: 'caps', instrumentId: i.id, recvTime: first - 2, caps: this.caps });
    sink.message({ type: 'status', instrumentId: i.id, recvTime: first - 1, status: 'LIVE', detail: null });
    const now = this.o.now ?? (() => Date.now());
    const deliver = (upTo: number) => {
      while (this.cursor < this.script.length && this.script[this.cursor]!.recvTime <= upTo) {
        const m = this.script[this.cursor++]!;
        if (m.type === 'caps' || m.type === 'status') continue;
        sink.message({ ...m, instrumentId: i.id });
      }
    };
    if (this.o.mode === 'instant') deliver(Infinity);
    else {
      deliver(now());
      this.timer = setInterval(() => deliver(now()), 250);
    }
  }
  unsubscribe(_id: InstrumentId): void {
    this.stop();
  }
  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
