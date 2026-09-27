import type { OrderFlowCapabilities, OrderFlowMsg } from '../../engines/orderFlow/types';
import type { InstrumentDefinition, InstrumentId } from '../../types/instruments';
import type { OrderFlowDepthProvider, OrderFlowProviders, OrderFlowSink, OrderFlowTradeProvider } from '../orderFlow/types';

/*
 * Level-2 architecture (market data only):
 *
 *   Databento Standard (GLBX.MDP3)  -> trades, OHLCV, volume  ─┐
 *   IBKR / T4 / other depth adapter -> Level-2 depth            ├─> normalized order-flow layer -> engines / Heatmap
 *                                                              ─┘
 *
 * A depth adapter implements `OrderFlowDepthProvider` (providers/orderFlow/types) and is passed here as `depth`;
 * trades keep coming from Databento. Nothing in the Heatmap, Footprint or Volume Profile changes.
 *
 * The OrderFlowService keeps ONE capability record per instrument, so when depth and trades come from different
 * adapters each adapter only owns its half: depth fields from the depth adapter, trade fields from the trade
 * adapter. Each adapter may only send its own stream - a trades feed can never inject a book and vice versa.
 * With no depth adapter connected, `depth` stays null and the page reports LEVEL-2 PROVIDER NOT CONNECTED.
 */

const NONE: OrderFlowCapabilities = {
  depth: 'NONE',
  depthLevels: null,
  incrementalDepth: false,
  trades: false,
  aggressorSide: false,
  depthReasons: false,
  sequenced: false,
  snapshotOnDemand: false,
};

type Role = 'depth' | 'trade';

export function mergeCapabilities(depth: OrderFlowCapabilities | null, trade: OrderFlowCapabilities | null): OrderFlowCapabilities {
  const d = depth ?? NONE;
  const t = trade ?? NONE;
  return {
    depth: d.depth,
    depthLevels: d.depthLevels,
    incrementalDepth: d.incrementalDepth,
    depthReasons: d.depthReasons,
    snapshotOnDemand: d.snapshotOnDemand,
    trades: t.trades,
    aggressorSide: t.aggressorSide,
    // Sequence-gap detection only when BOTH sources are sequenced (never assume numbers a source does not send).
    sequenced: d.sequenced && t.sequenced,
  };
}

const streamOf = (m: OrderFlowMsg): Role => (m.type === 'trade' || (m.type === 'heartbeat' && m.stream === 'trade') ? 'trade' : 'depth');

class Composer {
  private sink: OrderFlowSink | null = null;
  private caps = new Map<InstrumentId, { depth: OrderFlowCapabilities | null; trade: OrderFlowCapabilities | null }>();
  private connected = 0;

  sinkFor(role: Role, outer: OrderFlowSink): OrderFlowSink {
    this.sink = outer;
    return {
      message: (m) => {
        if (streamOf(m) === role) this.sink?.message(m);
      },
      status: (id, stream, status, detail) => {
        if (stream === role) this.sink?.status(id, stream, status, detail);
      },
      capabilities: (id, c) => {
        const cur = this.caps.get(id) ?? { depth: null, trade: null };
        cur[role] = c;
        this.caps.set(id, cur);
        this.sink?.capabilities(id, mergeCapabilities(cur.depth, cur.trade));
      },
      contract: (id, contract) => {
        // The trade source names the contract (Databento reports the actual continuous-resolved contract).
        if (role === 'trade') this.sink?.contract(id, contract);
      },
    };
  }
  onConnect(): void {
    this.connected += 1;
  }
  onDisconnect(): void {
    this.connected = Math.max(0, this.connected - 1);
    if (this.connected === 0) {
      this.sink = null;
      this.caps.clear();
    }
  }
  forget(id: InstrumentId): void {
    this.caps.delete(id);
  }
}

class RoleView {
  constructor(
    protected readonly inner: OrderFlowDepthProvider | OrderFlowTradeProvider,
    protected readonly role: Role,
    protected readonly c: Composer,
  ) {}
  get info() {
    return this.inner.info;
  }
  connect(sink: OrderFlowSink): void {
    this.c.onConnect();
    this.inner.connect(this.c.sinkFor(this.role, sink));
  }
  disconnect(): void {
    this.inner.disconnect();
    this.c.onDisconnect();
  }
  subscribe(def: InstrumentDefinition): void {
    this.inner.subscribe(def);
  }
  unsubscribe(id: InstrumentId): void {
    this.inner.unsubscribe(id);
    if (this.role === 'trade') this.c.forget(id);
  }
}

class DepthView extends RoleView implements OrderFlowDepthProvider {
  readonly stream = 'depth' as const;
  constructor(private readonly depth: OrderFlowDepthProvider, c: Composer) {
    super(depth, 'depth', c);
  }
  requestSnapshot(id: InstrumentId): void {
    this.depth.requestSnapshot(id);
  }
}

class TradeView extends RoleView implements OrderFlowTradeProvider {
  readonly stream = 'trade' as const;
  constructor(trade: OrderFlowTradeProvider, c: Composer) {
    super(trade, 'trade', c);
  }
}

/**
 * Combine a Level-2 depth adapter (IBKR / T4 / …, or null while none is connected) with a trades adapter
 * (Databento). Same object for both (e.g. Databento on a MBO plan) or a missing side -> returned unchanged.
 */
export function composeOrderFlowProviders(depth: OrderFlowDepthProvider | null, trade: OrderFlowTradeProvider | null): OrderFlowProviders {
  if (!depth || !trade || (depth as unknown) === (trade as unknown)) return { depth, trade };
  const c = new Composer();
  return { depth: new DepthView(depth, c), trade: new TradeView(trade, c) };
}
