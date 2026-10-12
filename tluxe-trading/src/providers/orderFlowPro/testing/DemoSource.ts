import { demoHistory, demoStatus, type DemoStream } from '../../../engines/orderFlowPro/testing/demoFixture';
import type { OfpFrame, OfpRoot } from '../../../engines/orderFlowPro/types';
import type { OfpSource, SourceSink } from '../source';

/**
 * DEMO source for the dev harness and tests ONLY: replays the seeded demo fixture (history, then one fixture
 * second per `stepMs`). Status is always feed 'DEMO'. Refused by the controller unless demo sources are allowed.
 */
export class DemoSource implements OfpSource {
  readonly info = { id: 'ofp-demo', name: 'DEMO fixture (synthetic, not market data)', demo: true };

  constructor(private readonly opts: { t0: number; historySeconds: number; seed?: number; stepMs?: number; gapEverySteps?: number }) {}

  subscribe(root: OfpRoot, sink: SourceSink): () => void {
    const { stream, frames } = demoHistory(root, this.opts.t0, this.opts.historySeconds, this.opts.seed, this.opts.gapEverySteps);
    sink.status(demoStatus(root, stream.t));
    sink.frames(frames);
    sink.time(stream.t);
    if (!this.opts.stepMs) return () => {};
    const s: DemoStream = stream;
    const id = setInterval(() => {
      const evs = s.step();
      if (evs.length) sink.frames([s.frame(evs)]);
      sink.time(s.t);
      sink.status(demoStatus(root, s.t));
    }, this.opts.stepMs);
    return () => clearInterval(id);
  }

  async history(root: OfpRoot, from: number, to: number): Promise<OfpFrame[]> {
    // Deterministic: regenerate the same fixture from its start (so the book snapshot is included) up to `to`.
    // The controller fast-forwards everything before `from`.
    void from;
    const { frames } = demoHistory(root, this.opts.t0, Math.max(0, Math.ceil((to - this.opts.t0) / 1000)), this.opts.seed, this.opts.gapEverySteps);
    return frames;
  }
}
