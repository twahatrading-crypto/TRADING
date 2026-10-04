/* XAUUSD strategy dashboard – renders ONLY what the local backend streams from MT5.
   There is no client-side market data of any kind. */
(() => {
  "use strict";
  const TF_SEC = { M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14400, D1: 86400 };
  const LEVEL_COLORS = {
    PDH: "#d65bf0", PDL: "#d65bf0", ASIA_HIGH: "#f2c94c", ASIA_LOW: "#f2c94c",
    EQH: "#38bdf8", EQL: "#38bdf8", H1_SWING_HIGH: "#f59e0b", H1_SWING_LOW: "#f59e0b",
    M15_SWING_HIGH: "#94a3b8", M15_SWING_LOW: "#94a3b8",
  };
  const STATUS_UI = {
    LIVE: ["MT5 LIVE", "live"], STALE: ["DATA STALE", "stale"], RECONNECTING: ["MT5 RECONNECTING", "reconnecting"],
    OFFLINE: ["MT5 OFFLINE", "offline"], MARKET_CLOSED: ["MARKET CLOSED", "closed"], CONNECTING: ["MT5 CONNECTING", "reconnecting"],
    BACKEND: ["BACKEND OFFLINE", "offline"],
  };
  const S = {
    tf: localGet("tf") || "M5", tz: [[0, 0]], status: null, tick: null, spec: null, strategy: null,
    settings: null, candles: [], clockBase: null, ws: null, wsRetry: 0, priceLines: [], digits: 2,
  };
  const $ = (id) => document.getElementById(id);

  function localGet(k) { try { return localStorage.getItem("xau." + k); } catch (e) { return null; } }
  function localSet(k, v) { try { localStorage.setItem("xau." + k, v); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------- time
  function offAt(t) {
    const tz = S.tz; let lo = 0, hi = tz.length - 1, ans = tz[0][1];
    while (lo <= hi) { const m = (lo + hi) >> 1; if (tz[m][0] <= t) { ans = tz[m][1]; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  const disp = (t) => t + offAt(t);                                   // UTC -> broker server wall time
  const snapT = (t) => { const s = TF_SEC[S.tf]; return Math.floor(disp(t) / s) * s; };
  const pad = (n) => String(n).padStart(2, "0");
  function fmtDT(t, withDate = true) {
    if (t == null) return "—";
    const d = new Date(disp(t) * 1000);
    const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    return withDate ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${hm}` : hm;
  }
  const fp = (x) => (x == null || isNaN(x) ? "—" : Number(x).toFixed(S.digits));

  // ---------------------------------------------------------------- chart
  const chartEl = $("chart");
  const chart = LightweightCharts.createChart(chartEl, {
    autoSize: true,
    layout: { background: { type: "solid", color: "#0c1526" }, textColor: "#9db4d8", fontSize: 12 },
    grid: { vertLines: { color: "#122036" }, horzLines: { color: "#122036" } },
    rightPriceScale: { borderColor: "#1c2b47", scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: "#1c2b47", timeVisible: true, secondsVisible: false, rightOffset: 18 },
    crosshair: { mode: 0 },
  });
  const series = chart.addCandlestickSeries({
    upColor: "#1fbf66", downColor: "#e5383b", borderVisible: false, wickUpColor: "#1fbf66", wickDownColor: "#e5383b",
    priceFormat: { type: "price", precision: 2, minMove: 0.01 },
  });
  const overlay = $("overlay");
  const ctx = overlay.getContext("2d");

  chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestDraw());
  chart.subscribeCrosshairMove((p) => {
    if (!p || !p.time) { showOHLC(S.candles[S.candles.length - 1]); return; }
    const d = p.seriesData.get(series);
    if (d) showOHLC({ o: d.open, h: d.high, l: d.low, c: d.close });
  });
  new ResizeObserver(() => requestDraw()).observe(chartEl);

  function showOHLC(c) {
    if (!c) { $("ohlc").innerHTML = ""; return; }
    const ch = c.c - c.o, cls = ch >= 0 ? "up" : "dn";
    $("ohlc").innerHTML = `O <b class="${cls}">${fp(c.o)}</b> H <b class="${cls}">${fp(c.h)}</b> L <b class="${cls}">${fp(c.l)}</b> ` +
      `C <b class="${cls}">${fp(c.c)}</b> <b class="${cls}">${ch >= 0 ? "+" : ""}${ch.toFixed(S.digits)} (${(ch / c.o * 100).toFixed(2)}%)</b>`;
  }

  function toBar(c) { return { time: disp(c.t), open: c.o, high: c.h, low: c.l, close: c.c }; }

  function setCandles(tf, list) {
    if (tf !== S.tf) return;
    S.candles = list;
    series.setData(list.map(toBar));
    showOHLC(list[list.length - 1]);
    $("chartTitle").textContent = `${S.status?.symbol || "XAUUSD"} · ${tf} · ${S.status?.account?.company || S.status?.terminal?.company || ""}`;
    drawStrategy();
  }

  function updateBars(tf, list) {
    if (tf !== S.tf || !S.candles.length) return;
    for (const c of list) {
      const last = S.candles[S.candles.length - 1];
      if (c.t < last.t) continue;
      if (c.t === last.t) S.candles[S.candles.length - 1] = c; else S.candles.push(c);
      series.update(toBar(c));
    }
    showOHLC(S.candles[S.candles.length - 1]);
    requestDraw();
  }

  function tickIntoBar(t) {
    if (!S.candles.length || !S.status || S.status.status !== "LIVE") return;
    const last = S.candles[S.candles.length - 1];
    if (t.time >= last.t && t.time < last.t + TF_SEC[S.tf]) {
      const c = { ...last, c: t.bid, h: Math.max(last.h, t.bid), l: Math.min(last.l, t.bid) };
      S.candles[S.candles.length - 1] = c;
      series.update(toBar(c));
    }
  }

  // ------------------------------------------------------------- overlays
  let drawPending = false;
  function requestDraw() { if (!drawPending) { drawPending = true; requestAnimationFrame(() => { drawPending = false; drawOverlay(); }); } }

  function xOf(t) {
    if (t == null || !S.candles.length) return null;
    const ts = chart.timeScale();
    const st = snapT(t);
    const first = disp(S.candles[0].t), last = disp(S.candles[S.candles.length - 1].t);
    if (st < first) return -10;
    if (st > last) {
      const xl = ts.timeToCoordinate(last);
      return xl == null ? null : xl + (st - last) / TF_SEC[S.tf] * ts.options().barSpacing;
    }
    return ts.timeToCoordinate(st);
  }
  const yOf = (p) => (p == null ? null : series.priceToCoordinate(p));

  function rect(x1, y1, x2, y2, fill, stroke) {
    const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, w, h); }
  }
  function hline(x1, x2, y, color, dash = [], width = 1) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(x1, Math.round(y) + .5); ctx.lineTo(x2, Math.round(y) + .5); ctx.stroke(); ctx.restore();
  }
  function label(text, x, y, color, opts = {}) {
    ctx.save(); ctx.font = `${opts.bold ? "600 " : ""}${opts.size || 12}px Segoe UI, Roboto, Arial`;
    ctx.textAlign = opts.align || "left"; ctx.textBaseline = opts.base || "bottom";
    if (opts.bg) {
      const w = ctx.measureText(text).width + 10, h = (opts.size || 12) + 8;
      const bx = opts.align === "right" ? x - w : (opts.align === "center" ? x - w / 2 : x);
      const by = opts.base === "top" ? y : (opts.base === "middle" ? y - h / 2 : y - h);
      ctx.fillStyle = opts.bg; ctx.fillRect(bx, by, w, h);
      ctx.fillStyle = color; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      ctx.fillText(text, bx + 5, by + h / 2);
    } else { ctx.fillStyle = color; ctx.fillText(text, x, y); }
    ctx.restore();
  }

  function drawOverlay() {
    const w = chartEl.clientWidth, h = chartEl.clientHeight, dpr = window.devicePixelRatio || 1;
    if (overlay.width !== w * dpr || overlay.height !== h * dpr) {
      overlay.width = w * dpr; overlay.height = h * dpr; overlay.style.width = w + "px"; overlay.style.height = h + "px";
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const st = S.strategy;
    if (!st || !S.candles.length) return;
    const paneW = chart.timeScale().width();
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, paneW, h - 28); ctx.clip();

    // liquidity levels
    for (const l of st.levels || []) {
      const y = yOf(l.price); if (y == null) continue;
      const x1 = Math.max(0, xOf(l.source_time) ?? 0);
      const col = LEVEL_COLORS[l.kind] || "#94a3b8";
      const live = l.taken_time == null;
      hline(x1, paneW, y, live ? col : "rgba(148,163,184,.5)", l.kind.includes("SWING") || !live ? [5, 4] : [], live ? 1.4 : 1);
      const tag = l.tags && l.tags.length ? ` + ${l.tags.join(", ")}` : "";
      label(`${l.label}${tag}${live ? "" : " (swept)"}`, Math.max(x1 + 4, 6), y - 3, live ? col : "#94a3b8", { size: 12 });
    }

    const s = st.setup;
    if (s) {
      const sell = s.direction === "SELL";
      const right = paneW;
      // displacement leg
      if (s.displacement) {
        const xa = xOf(s.sweep.extreme_time), xb = xOf(s.displacement.end_time);
        const ya = yOf(s.sweep.extreme_price), yb = yOf(s.mss ? s.mss.break_close : s.sweep.level_price);
        if (xa != null && xb != null && ya != null && yb != null) {
          rect(xa - 4, ya, xb + 4, yb, "rgba(148,163,184,.12)", "rgba(148,163,184,.35)");
          label("Displacement", xa - 8, (ya + yb) / 2, "#dbe4f3", { bold: true, base: "middle", align: "right", bg: "rgba(12,21,38,.85)" });
        }
      }
      // MSS
      if (s.mss) {
        const x1 = xOf(s.mss.swing_time), x2 = xOf(s.mss.break_time), y = yOf(s.mss.level);
        if (x1 != null && x2 != null && y != null) {
          hline(x1, x2 + 6, y, "#dbe4f3", [], 1.5);
          label("MSS", (x1 + x2) / 2, sell ? y + 4 : y - 4, "#dbe4f3", { bold: true, align: "center", base: sell ? "top" : "bottom" });
        }
      }
      // FVG / entry zone
      if (s.fvg) {
        const x1 = xOf(s.fvg.c1_time), y1 = yOf(s.fvg.top), y2 = yOf(s.fvg.bottom);
        const xEnd = s.entry_time ? xOf(s.entry_time) + 12 : right;
        if (x1 != null && y1 != null && y2 != null) {
          rect(x1, y1, xEnd, y2, "rgba(47,125,246,.25)", "rgba(80,150,255,.9)");
          label(`Entry Zone (FVG) ${fp(s.fvg.bottom)}–${fp(s.fvg.top)}`, Math.min(y1, y2) === y1 ? x1 + 4 : x1 + 4,
            Math.max(y1, y2) + 2, "#bcd5ff", { bold: true, base: "top", bg: "rgba(20,45,90,.85)" });
        }
      }
      // plan boxes: risk (red) and reward (green) from entry
      const p = s.plan;
      if (p && p.sl != null && p.entry != null) {
        const xs = s.entry_time ? xOf(s.entry_time) : (s.fvg ? xOf(s.fvg.c3_time) + 10 : right - 120);
        const xe = right;
        const ye = yOf(s.entry_price ?? p.entry), ysl = yOf(p.sl);
        if (xs != null && ye != null && ysl != null) {
          rect(xs, ye, xe, ysl, "rgba(229,56,59,.22)", null);
          label(`SL ${fp(p.sl)} (beyond sweep)`, xe - 6, sell ? ysl + 3 : ysl - 3, "#ffb1b2", { align: "right", base: sell ? "top" : "bottom", bg: "rgba(90,20,24,.85)" });
          if (p.tp2 != null) {
            const yt = yOf(p.tp2);
            if (yt != null) {
              rect(xs, ye, xe, yt, "rgba(31,191,102,.14)", null);
              hline(xs, xe, yt, "#3ee089", [6, 4], 1.2);
              label(`TP2 (1:${p.tp2_rr.toFixed(1)}) – ${p.tp2_source}`, xe - 6, yt - 3, "#6ff0a6", { align: "right" });
            }
          }
          if (p.tp1 != null && p.tp1 !== p.tp2) {
            const yt1 = yOf(p.tp1);
            if (yt1 != null) { hline(xs, xe, yt1, "#3ee089", [6, 4], 1); label(`TP1 (1:${p.tp1_rr.toFixed(1)})`, xe - 6, yt1 - 3, "#6ff0a6", { align: "right" }); }
          }
          hline(xs, xe, ye, "#5aa0ff", [], 1.2);
        }
      }
      // sweep circle
      const xs = xOf(s.sweep.extreme_time), ys = yOf(s.sweep.extreme_price);
      if (xs != null && ys != null) {
        ctx.save(); ctx.strokeStyle = "#ff4d4f"; ctx.fillStyle = "rgba(255,77,79,.18)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(xs, ys, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
        label(`Liquidity Sweep: ${s.sweep.level.label} ${fp(s.sweep.level_price)} → ${fp(s.sweep.extreme_price)}`,
          xs - 16, sell ? ys - 10 : ys + 10, "#ffd0d0", { bold: true, align: "right", base: sell ? "bottom" : "top", bg: "rgba(12,21,38,.85)" });
      }
    }
    ctx.restore();
  }

  function drawStrategy() {
    // axis price labels + markers (the chart library), rest is drawn on the overlay canvas
    for (const pl of S.priceLines) series.removePriceLine(pl);
    S.priceLines = [];
    const st = S.strategy;
    const markers = [];
    if (st) {
      for (const l of st.levels || []) {
        if (l.taken_time != null) continue;
        S.priceLines.push(series.createPriceLine({ price: l.price, color: LEVEL_COLORS[l.kind] || "#94a3b8", lineVisible: false, axisLabelVisible: true, title: "" }));
      }
      const s = st.setup;
      if (s && s.plan) {
        const p = s.plan;
        const add = (price, color, title) => price != null && S.priceLines.push(series.createPriceLine({ price, color, lineVisible: false, axisLabelVisible: true, title }));
        add(s.entry_price ?? p.entry, "#2f7df6", "Entry");
        add(p.sl, "#e5383b", "SL");
        add(p.tp1, "#149150", "TP1");
        if (p.tp2 !== p.tp1) add(p.tp2, "#149150", "TP2");
      }
      if (s && s.entry_time) {
        markers.push({ time: snapT(s.entry_time), position: s.direction === "SELL" ? "aboveBar" : "belowBar",
          color: s.direction === "SELL" ? "#e5383b" : "#1fbf66", shape: s.direction === "SELL" ? "arrowDown" : "arrowUp",
          text: s.taken ? `A+ ${s.direction}` : s.direction + " (filtered)" });
      }
      for (const t of st.open_trades || []) {
        if (s && t.id === s.id) continue;
        markers.push({ time: snapT(t.entry_time), position: "aboveBar", color: "#94a3b8", shape: "circle", text: t.direction });
      }
    }
    markers.sort((a, b) => a.time - b.time);
    try { series.setMarkers(markers.filter((m) => S.candles.length && m.time >= disp(S.candles[0].t))); } catch (e) { /* ignore */ }
    requestDraw();
  }

  // --------------------------------------------------------------- panels
  function renderStatus() {
    const st = S.status; if (!st) return;
    const [txt, cls] = STATUS_UI[st.status] || [st.status, "offline"];
    const b = $("connBadge"); b.textContent = txt; b.className = "badge " + cls;
    b.title = st.detail || "";
    $("brokerSymbol").textContent = st.symbol || "not detected";
    const live = st.status === "LIVE";
    const banner = $("feedBanner");
    banner.classList.toggle("hidden", live);
    banner.className = "feed-banner" + (live ? " hidden" : st.status === "MARKET_CLOSED" ? " closed" : st.status === "STALE" ? " stale" : "");
    banner.querySelector(".fb-title").textContent = txt;
    banner.querySelector(".fb-sub").textContent = (st.detail || "") +
      (st.status === "MARKET_CLOSED" ? " – candles shown are history, not live prices." : " – nothing shown is a live quote.");
    if (!live) { $("bid").textContent = "—"; $("ask").textContent = "—"; $("spread").textContent = "—"; $("zoneFlag").classList.add("hidden"); }
    document.querySelectorAll("#sessions .pill").forEach((p) => {
      const info = (st.sessions || []).find((x) => x.name === p.dataset.s);
      p.classList.toggle("active", !!(info && info.active));
      if (info) p.title = `${info.name}: ${info.local_start}–${info.local_end} ${info.tz}\n` +
        `${info.active ? "now" : "next"}: ${fmtDT(info.start_utc)} → ${fmtDT(info.end_utc, false)} (server time)`;
    });
    S.clockBase = { utc: st.now_utc, at: performance.now() };
    const acc = st.account || {}, tz = st.tz || {};
    const tzOk = tz.state === "VERIFIED_LIVE" || tz.state === "VERIFIED_HISTORY";
    const lt = st.last_tick_msc ? new Date(disp(st.last_tick_msc / 1000) * 1000) : null;
    const ltTxt = lt ? `${pad(lt.getUTCHours())}:${pad(lt.getUTCMinutes())}:${pad(lt.getUTCSeconds())}.${String(lt.getUTCMilliseconds()).padStart(3, "0")}` : "—";
    $("acctInfo").innerHTML = `${esc(acc.company || st.terminal?.company || "—")} · <b>${esc(acc.server || "—")}</b> · ` +
      `<b>${esc(acc.trade_mode || "—")}</b> · last tick <b>${ltTxt}</b>${st.tick_age != null ? ` (${st.tick_age}s)` : ""} · ` +
      `<span class="${tzOk ? "tz-ok" : "tz-bad"}" title="${esc(tz.detail || "")}">server time ${tzOk ? "verified" : "NOT verified"}</span>`;
    const warn = $("warnings");
    const ws = (st.warnings || []).filter((x) => !x.startsWith("Prices are NOT live"));
    warn.classList.toggle("hidden", !ws.length);
    warn.textContent = ws.join("  •  ");
    renderSignal();
  }

  function tickClock() {
    if (!S.clockBase) return;
    const t = Math.floor(S.clockBase.utc + (performance.now() - S.clockBase.at) / 1000);
    const d = new Date(disp(t) * 1000);
    $("srvTime").textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    $("srvDate").textContent = d.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  }
  setInterval(tickClock, 1000);

  function renderTick(t) {
    S.tick = t;
    if (!S.status || S.status.status !== "LIVE" || !t || t.bid == null) return;
    $("bid").textContent = fp(t.bid); $("ask").textContent = fp(t.ask);
    $("spread").textContent = `${t.spread_points} pts`;
    tickIntoBar(t);
    renderZoneFlag();
  }

  function renderZoneFlag() {
    const s = S.strategy?.setup, t = S.tick, f = $("zoneFlag");
    if (s && s.stage === "RETRACE" && s.fvg && t && S.status?.status === "LIVE") {
      const inZone = t.bid <= s.fvg.top && t.bid >= s.fvg.bottom;
      f.textContent = inZone ? "PRICE IN ENTRY ZONE – entry is evaluated on the M5 close" : `Waiting for retracement to ${fp(s.plan.entry)}`;
      f.classList.remove("hidden");
    } else f.classList.add("hidden");
  }

  function renderPlan() {
    const st = S.strategy || {}, s = st.setup, p = s && s.plan;
    const dir = $("dirBadge");
    if (!s) { dir.textContent = "NO SETUP"; dir.className = "dir none"; }
    else { dir.textContent = `${s.direction} SETUP`; dir.className = "dir " + s.direction.toLowerCase(); }
    const entry = s ? (s.entry_price ?? p?.entry) : null;
    $("pEntry").textContent = fp(entry);
    $("pSL").textContent = fp(p?.sl);
    $("pTP1").textContent = fp(p?.tp1); $("pTP2").textContent = fp(p?.tp2);
    $("lTP1").textContent = p?.tp1 ? `Take Profit 1 (1:${p.tp1_rr.toFixed(1)})` : "Take Profit 1";
    $("lTP2").textContent = p?.tp2 ? `Take Profit 2 (1:${p.tp2_rr.toFixed(1)})` : "Take Profit 2";
    $("lTP1").title = p?.tp1_source || ""; $("lTP2").title = p?.tp2_source || "";
    const pt = S.spec?.point || 0.01;
    $("pRisk").textContent = p?.risk ? `$${p.risk.toFixed(2)} · ${Math.round(p.risk / pt)} pts` : "—";
    const rew = p?.tp2 != null && entry != null ? Math.abs(entry - p.tp2) : null;
    $("pReward").textContent = rew ? `$${rew.toFixed(2)} · ${Math.round(rew / pt)} pts` : "—";
    $("pRR").textContent = p?.tp2_rr ? `1 : ${p.tp2_rr.toFixed(2)}` : "—";
    const z = st.sizing, rp = S.settings?.risk_percent;
    $("lSize").textContent = `Position Size (${rp ?? "?"}%)`;
    if (z) {
      $("pSize").textContent = z.volume ? `${z.volume} lots` : "below min lot";
      $("pSize").title = (z.warnings || []).join("; ") + (z.balance_source ? `\nbalance: ${z.balance_source}` : "");
      $("pRiskMoney").textContent = z.volume ? `${z.actual_risk_money.toFixed(2)} (${z.actual_risk_percent.toFixed(2)}%)` : (z.warnings || [""])[0];
    } else { $("pSize").textContent = "—"; $("pRiskMoney").textContent = "—"; }
    $("pScore").textContent = s && s.score_total ? `${s.score_total} / 100${s.score_provisional ? " (provisional)" : ""}` : "—";
  }

  function renderChecklist() {
    const ol = $("checklist"); ol.innerHTML = "";
    const sym = { pass: "✓", fail: "✕", warn: "!", pending: "" };
    (S.strategy?.checklist || []).forEach((c, i) => {
      const li = document.createElement("li"); li.className = c.state;
      li.innerHTML = `<span class="num">${i + 1}</span><span class="txt">${c.label}${c.detail ? `<small title="${esc(c.detail)}">${esc(c.detail)}</small>` : ""}</span>` +
        `<span class="st ${c.state}" title="${c.state}">${sym[c.state] ?? ""}</span>`;
      ol.appendChild(li);
    });
  }

  function renderSignal() {
    const st = S.strategy, status = S.status?.status;
    const box = $("signalBox"), txt = $("signalText"), arrow = $("signalArrow");
    let kind = "waiting", text = "WAITING", detail = "", arr = "";
    if (status && status !== "LIVE" && status !== "MARKET_CLOSED") {
      kind = "stale"; text = STATUS_UI[status]?.[0] || status; detail = "no signals are evaluated without a live MT5 feed";
    } else if (st && st.label) {
      kind = st.label.kind; text = st.label.text; detail = st.label.detail || "";
      if (kind === "signal") { const sell = text.includes("SELL"); kind = sell ? "signal-sell" : "signal-buy"; arr = sell ? "↓" : "↑"; }
      if (status === "MARKET_CLOSED") detail = (detail ? detail + " · " : "") + "market closed";
      if (st.paused_reason) detail = st.paused_reason;
      if (st.paused_reason && st.paused_reason.startsWith("TIMEZONE")) { kind = "stale"; text = "TIMEZONE VERIFICATION REQUIRED"; arr = ""; }
    }
    box.className = "signal " + kind; txt.textContent = text; arrow.textContent = arr;
    $("signalDetail").textContent = detail;
    const s = st?.setup;
    const score = s?.score_total || 0, thr = st?.threshold ?? 80;
    $("sScore").textContent = s?.score_total ? `${score} / 100${s.score_provisional ? " (prov.)" : ""}` : "— / 100";
    $("sBar").style.width = `${score}%`;
    $("sBar").style.background = score >= thr ? "var(--green)" : "var(--orange)";
    $("sThr").style.left = `${thr}%`; $("sThr").title = `A+ threshold ${thr}`;
    const br = $("scoreBreak"); br.innerHTML = "";
    if (s && s.score) {
      for (const [k, v] of Object.entries(s.score)) {
        br.insertAdjacentHTML("beforeend", `<div class="comp"><span>${k}</span><span>${v.points} / ${v.max}</span></div><div class="rules">${v.rules.map(esc).join("<br>")}</div>`);
      }
    } else br.textContent = "Scored when the retracement fills (all components are rule-based).";
    $("sStatus").textContent = s ? (s.status === "SIGNAL" ? "CONFIRMED" : s.status.replace("_", " ")) : "WAITING";
    $("sStatus").style.color = s?.status === "SIGNAL" ? "#6ff0a6" : "";
    let target = "—";
    if (s?.plan) {
      const tr = s.trade;
      if (tr && tr.outcomes && tr.outcomes.TP1?.status === "win") target = `${fp(s.plan.tp2)} (TP2)`;
      else target = `${fp(s.plan.tp1)} (TP1)`;
    }
    $("sTarget").textContent = target;
    $("sSession").textContent = (st?.sessions_active || []).join(" / ") || "Off-session";
    const b = st?.bias || {};
    $("sBias").textContent = b.H1 ? `${b.H1} / ${b.M15}` : "—";
    renderZoneFlag();
  }

  const STEP_INFO = [
    ["Liquidity Found", "Asia High/Low, PDH/PDL, Equal Highs/Lows, H1/M15 swings", "M4 40 L20 28 L30 34 L46 18 L58 26 L72 14 M2 14 H98"],
    ["Sweep", "Price runs beyond liquidity and closes back inside", "M4 44 L22 30 L34 36 L52 8 L58 22 L70 30 M2 16 H98"],
    ["MSS", "M5 candle closes through the protected swing", "M4 20 L20 10 L32 24 L46 16 L60 40 L74 46 M26 26 H70"],
    ["Displacement", "Strong impulsive candle(s) vs ATR & median body", "M4 8 L18 12 L26 10 L44 44 L60 48 L78 46"],
    ["Retracement", "Price returns into the FVG entry zone", "M4 8 L22 40 L36 46 L52 26 L66 34 L80 40 M40 22 H96 M40 30 H96"],
    ["Entry", "Filled at the zone once all filters & score pass", "M4 40 L22 18 L40 22 L58 30 L74 40 M40 22 H96"],
    ["Target", "TP at opposing liquidity (>= 1:3 or no trade)", "M4 10 L20 18 L34 14 L52 34 L70 44 L90 48 M2 46 H98"],
  ];
  function stepDetail(i, s) {
    if (!s) return "";
    try {
      switch (i) {
        case 0: return `${s.sweep.level.label} ${fp(s.sweep.level_price)}`;
        case 1: return `${fp(s.sweep.extreme_price)} · ${s.sweep.reclaim_bars} bar reclaim`;
        case 2: return s.mss ? `close ${fp(s.mss.break_close)} through ${fp(s.mss.level)}` : "";
        case 3: return s.displacement ? `${s.displacement.best_body_atr.toFixed(2)}×ATR ${s.displacement.rule}` : "";
        case 4: return s.fvg ? `FVG ${fp(s.fvg.bottom)}–${fp(s.fvg.top)}` : "";
        case 5: return s.entry_time ? `${fp(s.entry_price)} @ ${fmtDT(s.entry_time, false)}` : "";
        case 6: return s.trade?.result && s.trade.result !== "open" ? `${s.trade.result} ${(s.trade.r_result ?? 0).toFixed(2)}R` : "";
      }
    } catch (e) { return ""; }
    return "";
  }
  function renderSteps() {
    const wrap = $("steps"); wrap.innerHTML = "";
    const steps = S.strategy?.steps || STEP_INFO.map((x) => ({ name: x[0], state: "locked" }));
    const s = S.strategy?.setup;
    const label = { done: "✓ DONE", current: "● WAITING", locked: "LOCKED", failed: "✕ FAILED" };
    steps.forEach((st, i) => {
      const [name, desc, path] = STEP_INFO[i];
      const det = stepDetail(i, s);
      const col = st.state === "done" ? "#1fbf66" : st.state === "current" ? "#5aa0ff" : st.state === "failed" ? "#e5383b" : "#4b5a74";
      wrap.insertAdjacentHTML("beforeend", `<div class="step ${st.state}"><div class="sh">${i + 1}. ${name}</div>
        <svg viewBox="0 0 100 54" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="${col}" stroke-width="2"/></svg>
        <div class="sd">${desc}${det ? `<br><b>${esc(det)}</b>` : ""}</div><span class="ss">${label[st.state] || st.state}</span></div>`);
    });
  }

  function renderStrategy() {
    renderPlan(); renderChecklist(); renderSignal(); renderSteps(); drawStrategy();
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ------------------------------------------------------------ websocket
  function connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => { S.wsRetry = 0; if (S.tf !== "M5") ws.send(JSON.stringify({ type: "set_tf", tf: S.tf })); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      switch (m.type) {
        case "snapshot":
          S.tz = m.tz && m.tz.length ? m.tz : S.tz; S.spec = m.spec; S.settings = m.settings;
          S.digits = m.spec?.digits ?? 2;
          series.applyOptions({ priceFormat: { type: "price", precision: S.digits, minMove: Math.pow(10, -S.digits) } });
          S.status = m.status; S.strategy = m.strategy;
          renderStatus(); if (m.tick && m.tick.bid != null) renderTick(m.tick); renderStrategy();
          break;
        case "status": S.status = m; renderStatus(); break;
        case "tick": renderTick(m); break;
        case "candles": setCandles(m.tf, m.candles); break;
        case "bar": updateBars(m.tf, m.candles); break;
        case "strategy": S.strategy = m.strategy; renderStrategy(); break;
      }
    };
    ws.onclose = () => {
      S.status = { ...(S.status || {}), status: "BACKEND", detail: "dashboard backend not reachable – is start.bat running?", warnings: [] };
      renderStatus();
      setTimeout(connect, Math.min(10000, 500 * 2 ** S.wsRetry++));
    };
  }

  // -------------------------------------------------------------- controls
  document.querySelectorAll("#tfs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tf === S.tf);
    b.onclick = () => {
      S.tf = b.dataset.tf; localSet("tf", S.tf);
      document.querySelectorAll("#tfs button").forEach((x) => x.classList.toggle("active", x === b));
      S.candles = []; series.setData([]);
      if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ type: "set_tf", tf: S.tf }));
    };
  });
  document.querySelectorAll("[data-close]").forEach((b) => b.onclick = () => b.closest(".modal").classList.add("hidden"));

  $("btnLog").onclick = async () => {
    $("logModal").classList.remove("hidden");
    const rows = await (await fetch("/api/signals?limit=300")).json();
    const tb = document.querySelector("#logTable tbody"); tb.innerHTML = "";
    for (const r of rows) {
      tb.insertAdjacentHTML("beforeend", `<tr><td>${fmtDT(r.created_utc)}</td><td>${r.direction}</td><td>${r.liquidity_kind || ""} ${fp(r.liquidity_price)}</td>
        <td>${r.status}</td><td>${r.grade || ""}</td><td>${r.score_total ?? ""}</td><td>${fp(r.entry)}</td><td>${fp(r.sl)}</td><td>${fp(r.tp1)}</td><td>${fp(r.tp2)}</td>
        <td>${r.rr_tp2 ? r.rr_tp2.toFixed(2) : ""}</td><td>${r.session || ""}</td><td>${r.result || ""}</td><td>${r.r_result != null ? r.r_result.toFixed(2) : ""}</td>
        <td>${r.mfe_r != null ? r.mfe_r.toFixed(2) : ""}</td><td>${r.mae_r != null ? r.mae_r.toFixed(2) : ""}</td><td class="reason">${esc((r.reasons || []).join("; "))}</td></tr>`);
    }
    if (!rows.length) tb.innerHTML = `<tr><td colspan="17">No setups logged yet.</td></tr>`;
  };

  $("btnSettings").onclick = async () => {
    const cfg = await (await fetch("/api/settings")).json();
    $("setBalSrc").value = cfg.account.balance_source; $("setBal").value = cfg.account.manual_balance;
    $("setRisk").value = cfg.account.risk_percent; $("setSymbol").value = cfg.feed.symbol_override;
    $("setTz").value = cfg.feed.server_timezone; $("setStale").value = cfg.feed.stale_seconds;
    $("setEntry").value = cfg.strategy.entry.mode; $("setMinRR").value = cfg.strategy.risk.min_rr;
    $("setThr").value = cfg.strategy.score.a_plus_threshold; $("setMaxSL").value = cfg.strategy.risk.max_sl_price;
    $("setHtf").value = cfg.strategy.filters.htf_mode;
    document.querySelectorAll(".setSess").forEach((c) => c.checked = cfg.strategy.filters.allowed_entry_sessions.includes(c.value));
    $("setNews").value = (cfg.strategy.filters.news_events || []).map((e) => `${e.time}  ${e.title || ""}`).join("\n");
    $("setAdvanced").value = JSON.stringify(cfg.strategy, null, 2);
    const dl = $("symList"); dl.innerHTML = "";
    for (const n of S.status?.candidates || []) dl.insertAdjacentHTML("beforeend", `<option value="${esc(n)}">`);
    $("setMsg").textContent = ""; $("settingsModal").classList.remove("hidden");
  };

  $("setSave").onclick = async () => {
    const msg = $("setMsg");
    let strategy;
    try { strategy = JSON.parse($("setAdvanced").value); } catch (e) { msg.className = "set-msg err"; msg.textContent = "Advanced JSON is invalid: " + e.message; return; }
    strategy.entry.mode = $("setEntry").value;
    strategy.risk.min_rr = parseFloat($("setMinRR").value);
    strategy.risk.max_sl_price = parseFloat($("setMaxSL").value);
    strategy.score.a_plus_threshold = parseInt($("setThr").value, 10);
    strategy.filters.htf_mode = $("setHtf").value;
    strategy.filters.allowed_entry_sessions = [...document.querySelectorAll(".setSess")].filter((c) => c.checked).map((c) => c.value);
    strategy.filters.news_events = $("setNews").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [time, ...rest] = l.split(/\s+/); return { time, title: rest.join(" ") || "news" };
    });
    const body = {
      account: { balance_source: $("setBalSrc").value, manual_balance: parseFloat($("setBal").value), risk_percent: parseFloat($("setRisk").value) },
      feed: { symbol_override: $("setSymbol").value.trim(), server_timezone: $("setTz").value.trim(), stale_seconds: parseFloat($("setStale").value) },
      strategy,
    };
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) { msg.className = "set-msg ok"; msg.textContent = "Saved. Engine re-evaluated with the new rules."; }
    else { msg.className = "set-msg err"; msg.textContent = (await r.json()).detail || "error"; }
  };

  renderSteps();
  connect();
})();
