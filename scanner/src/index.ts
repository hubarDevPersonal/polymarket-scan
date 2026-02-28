import { EventEmitter } from "events";
import {
  fetchCryptoEvents,
  filterHitPriceEvents,
  extractTokenIds,
  parseMarketOutcomes,
  GammaEvent,
} from "./gamma";
import { fetchBooks } from "./clob";
import {
  OrderbookState,
  createBook,
  applySnapshot,
  applyDelta,
  DeltaUpdate,
  getSortedBids,
  getSortedAsks,
} from "./orderbook";
import { computeAnalytics, BookAnalytics } from "./analytics";
import {
  PolymarketWS,
  WSBookEvent,
  WSPriceChangeEvent,
  WSLastTradeEvent,
} from "./ws-client";
import { OpportunityDetector, Opportunity } from "./detector";
import { NotificationManager } from "./notifications";
import { NotionSync, NotionSyncConfig } from "./notion-sync";
import { AuditLogger, AuditConfig } from "./audit";
import { TelegramAlerts, TelegramConfig } from "./telegram";
import { AlertClient, AlertClientConfig, AlertPayload } from "./alerts/alertClient";
import { ClickHouseDb, ClickHouseConfig } from "./db/connection";
import { HistorySync } from "./db/sync";
import { createServer } from "./server";
import Decimal from "decimal.js";

const PORT = parseInt(process.env.PORT || "3847", 10);
const REFRESH_INTERVAL = 60_000;

// ─── Notion sync config (from env) ─────────────────────────────────

const notionConfig: NotionSyncConfig | null = process.env.NOTION_TOKEN
  ? {
      notionToken: process.env.NOTION_TOKEN,
      dailyDatabaseId: process.env.NOTION_DAILY_DB || "",
      weeklyDatabaseId: process.env.NOTION_WEEKLY_DB || "",
      enabled: process.env.NOTION_SYNC_ENABLED !== "false",
      dailySyncHour: parseInt(process.env.NOTION_SYNC_HOUR || "0", 10),
      weeklySyncDay: parseInt(process.env.NOTION_SYNC_DAY || "0", 10),
    }
  : null;

// ─── Global state ──────────────────────────────────────────────────

const events: GammaEvent[] = [];
const books = new Map<string, OrderbookState>();
const bookAnalytics = new Map<string, BookAnalytics>();
const ladders = new Map<string, { bids: any[]; asks: any[] }>();
let wsConnected = false;

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

const wsClient = new PolymarketWS();
const detector = new OpportunityDetector();
const notifications = new NotificationManager();

let notionSync: NotionSync | null = null;
if (notionConfig && notionConfig.dailyDatabaseId && notionConfig.weeklyDatabaseId) {
  notionSync = new NotionSync(
    notionConfig,
    () => ({
      events,
      bookAnalytics,
      opportunities: detector.getActiveOpportunities(),
      wsStats: wsClient.getStats(),
      notifications: notifications.getAll(200),
    }),
    notifications
  );
  console.log("[notion-sync] configured and ready");
} else {
  console.log("[notion-sync] not configured (set NOTION_TOKEN, NOTION_DAILY_DB, NOTION_WEEKLY_DB)");
}

// ─── DynamoDB audit (critical events only) ──────────────────────────

const auditConfig: AuditConfig = {
  endpoint: process.env.DYNAMO_ENDPOINT || undefined,
  table: process.env.DYNAMO_TABLE || "scanner-audit",
  region: process.env.DYNAMO_REGION || "us-east-1",
  enabled: process.env.AUDIT_ENABLED === "true",
};

const audit = new AuditLogger(auditConfig);
if (auditConfig.enabled) {
  console.log(`[audit] enabled → ${auditConfig.table} @ ${auditConfig.endpoint || "AWS"}`);
} else {
  console.log("[audit] disabled (set AUDIT_ENABLED=true)");
}

// ─── Telegram alerts ─────────────────────────────────────────────────

const telegramConfig: TelegramConfig = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  chatId: process.env.TELEGRAM_CHAT_ID || "",
  enabled: process.env.TELEGRAM_ENABLED === "true",
  minSeverity: (process.env.TELEGRAM_MIN_SEVERITY as any) || "alert",
  allowedTypes: process.env.TELEGRAM_ALLOWED_TYPES
    ? (process.env.TELEGRAM_ALLOWED_TYPES.split(",") as any[])
    : [],
  rateLimitMs: parseInt(process.env.TELEGRAM_RATE_LIMIT_MS || "5000", 10),
  silentForLow: process.env.TELEGRAM_SILENT_LOW !== "false",
};

const telegram = new TelegramAlerts(telegramConfig);
if (telegram.isConfigured()) {
  console.log(`[telegram] enabled → chat ${telegramConfig.chatId}`);
} else {
  console.log("[telegram] disabled (set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ENABLED=true)");
}

// ─── AlexBot webhook alert client ─────────────────────────────────────

const alertClientConfig: AlertClientConfig = {
  webhookUrl: process.env.ALEXBOT_WEBHOOK_URL || "",
  token: process.env.PREDICTION_ALERTS_TOKEN || "",
  enabled: process.env.ALEXBOT_ALERTS_ENABLED === "true",
};

const alertClient = new AlertClient(alertClientConfig);
if (alertClient.isConfigured()) {
  console.log(`[alert-client] enabled → ${alertClientConfig.webhookUrl}`);
} else {
  console.log("[alert-client] disabled (set ALEXBOT_WEBHOOK_URL, PREDICTION_ALERTS_TOKEN, ALEXBOT_ALERTS_ENABLED=true)");
}

// ─── ClickHouse historical database ──────────────────────────────────

const clickhouseConfig: ClickHouseConfig = {
  url: process.env.CLICKHOUSE_URL || "http://localhost:8123",
  database: process.env.CLICKHOUSE_DB || "scanner",
  enabled: process.env.DB_ENABLED === "true",
};

let clickhouseDb: ClickHouseDb | null = null;
let historySync: HistorySync | null = null;

if (clickhouseConfig.enabled) {
  clickhouseDb = new ClickHouseDb(clickhouseConfig);
  clickhouseDb.init().then(() => {
    if (clickhouseDb!.ready) {
      historySync = new HistorySync(clickhouseDb!);
      console.log(`[clickhouse] sync engine ready`);
    }
  }).catch((err) => {
    console.error(`[clickhouse] init failed: ${err.message}`);
  });
  console.log(`[clickhouse] enabled → ${clickhouseConfig.url}/${clickhouseConfig.database}`);
} else {
  console.log("[clickhouse] disabled (set DB_ENABLED=true, CLICKHOUSE_URL)");
}

// ─── State getter for server ───────────────────────────────────────

function getState() {
  return {
    events,
    wsConnected,
    bookAnalytics,
    ladders,
    opportunities: detector.getActiveOpportunities(),
    detectorConfig: detector.getConfig(),
    wsStats: wsClient.getStats(),
    getNotifications: (limit: number) => notifications.getAll(limit),
    markAllRead: () => notifications.markAllRead(),
    updateDetectorConfig: (patch: any) => detector.updateConfig(patch),
    notionSync,
    audit,
    telegram,
    alertClient,
    clickhouseDb,
    historySync,
  };
}

// ─── Book helpers ──────────────────────────────────────────────────

function updateLadder(tokenId: string) {
  const book = books.get(tokenId);
  if (!book) return;

  const bidLevels = getSortedBids(book)
    .slice(0, 15)
    .map((l) => ({
      price: l.price.toFixed(4),
      size: l.size.toFixed(2),
      total: l.price.mul(l.size).toFixed(2),
    }));

  const askLevels = getSortedAsks(book)
    .slice(0, 15)
    .map((l) => ({
      price: l.price.toFixed(4),
      size: l.size.toFixed(2),
      total: l.price.mul(l.size).toFixed(2),
    }));

  ladders.set(tokenId, { bids: bidLevels, asks: askLevels });
}

function refreshAnalytics(tokenId: string) {
  const book = books.get(tokenId);
  if (!book) return;

  const analytics = computeAnalytics(book);
  bookAnalytics.set(tokenId, analytics);
  updateLadder(tokenId);

  // Run opportunity detector
  detector.evaluate(book);

  emitter.emit("book", { tokenId, analytics });
}

// ─── Bootstrap ─────────────────────────────────────────────────────

async function bootstrapBooks(tokenIds: string[]) {
  if (tokenIds.length === 0) return;
  console.log(`[bootstrap] fetching ${tokenIds.length} orderbooks...`);

  try {
    const snapshots = await fetchBooks(tokenIds);
    console.log(`[bootstrap] got ${snapshots.length} snapshots`);

    for (const snap of snapshots) {
      const tokenId = snap.asset_id;
      if (!tokenId) continue;

      let book = books.get(tokenId);
      if (!book) {
        book = createBook(tokenId);
        books.set(tokenId, book);
      }

      applySnapshot(book, snap);
      refreshAnalytics(tokenId);
    }
  } catch (err: any) {
    console.error(`[bootstrap] error: ${err.message}`);
  }
}

// ─── Discovery ─────────────────────────────────────────────────────

async function discoverMarkets() {
  console.log("[discover] fetching crypto events...");

  try {
    const allEvents = await fetchCryptoEvents(100);
    console.log(`[discover] got ${allEvents.length} crypto events`);

    const hitPrice = filterHitPriceEvents(allEvents);
    console.log(`[discover] ${hitPrice.length} hit-price events found`);

    events.length = 0;
    events.push(...hitPrice);

    if (hitPrice.length === 0) {
      console.log("[discover] no hit-price events, showing top crypto events");
      events.push(...allEvents.slice(0, 20));
    }

    // Register labels for each token with the detector
    for (const event of events) {
      const outcomes = parseMarketOutcomes(event);
      for (const o of outcomes) {
        if (o.tokenId) {
          detector.setLabel(o.tokenId, `${o.question} [${o.outcome}]`);
        }
      }
    }

    // Gather all token IDs and bootstrap
    const allTokenIds: string[] = [];
    for (const event of events) {
      allTokenIds.push(...extractTokenIds(event));
    }

    const unique = [...new Set(allTokenIds)].filter(Boolean);
    console.log(`[discover] ${unique.length} unique tokens to track`);

    const batchSize = 20;
    for (let i = 0; i < unique.length; i += batchSize) {
      const batch = unique.slice(i, i + batchSize);
      await bootstrapBooks(batch);
      if (i + batchSize < unique.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    wsClient.subscribe(unique);

    emitter.emit("status", {
      type: "discovery",
      eventCount: events.length,
      tokenCount: unique.length,
    });

    emitter.emit("update", { type: "events_refreshed" });

    notifications.push(
      "discovery_complete",
      "info",
      "Discovery Complete",
      `Found ${events.length} events with ${unique.length} tokens`
    );

    audit.log("DISCOVERY", "info", `${events.length} events, ${unique.length} tokens`, { eventCount: events.length, tokenCount: unique.length });
    telegram.handleDiscovery(events.length, unique.length);
  } catch (err: any) {
    console.error(`[discover] error: ${err.message}`);
  }
}

// ─── WS event handlers ────────────────────────────────────────────

wsClient.on("book", (msg: WSBookEvent) => {
  const tokenId = msg.asset_id;
  if (!tokenId) return;

  let book = books.get(tokenId);
  if (!book) {
    book = createBook(tokenId);
    books.set(tokenId, book);
  }

  applySnapshot(book, {
    market: msg.market,
    asset_id: msg.asset_id,
    timestamp: msg.timestamp,
    hash: msg.hash,
    bids: msg.bids,
    asks: msg.asks,
  });

  refreshAnalytics(tokenId);
});

wsClient.on("price_change", (msg: WSPriceChangeEvent) => {
  const tokenId = msg.asset_id;
  if (!tokenId) return;

  let book = books.get(tokenId);
  if (!book) {
    book = createBook(tokenId);
    books.set(tokenId, book);
  }

  applyDelta(book, {
    asset_id: msg.asset_id,
    price: msg.price,
    size: msg.size,
    side: msg.side as any,
  });

  refreshAnalytics(tokenId);
});

wsClient.on("last_trade", (msg: WSLastTradeEvent) => {
  const tokenId = msg.asset_id;
  if (!tokenId) return;

  // Record trade for activity tracking
  detector.recordTrade({
    tokenId,
    price: msg.price,
    size: msg.size,
    side: msg.side,
    timestamp: Date.now(),
  });

  const book = books.get(tokenId);
  if (book && msg.price) {
    book.lastTradePrice = new Decimal(msg.price);
    refreshAnalytics(tokenId);
  }
});

wsClient.on("connected", () => {
  wsConnected = true;
  emitter.emit("status", { type: "ws", connected: true });
  notifications.push("ws_connected", "info", "WebSocket Connected", "Live market data streaming");
  telegram.handleWsStatus(true);
  alertClient.sendAlert({ type: "ws_up", severity: "info", title: "WebSocket Connected", body: "Live market data streaming resumed", ts: new Date().toISOString(), data: { wsConnected: true } });
});

wsClient.on("disconnected", () => {
  wsConnected = false;
  emitter.emit("status", { type: "ws", connected: false });
  notifications.push("ws_disconnected", "warn", "WebSocket Disconnected", "Reconnecting...");
  audit.log("WS_DOWN", "warn", "WebSocket disconnected", wsClient.getStats() as any);
  telegram.handleWsStatus(false);
  alertClient.sendAlert({ type: "ws_down", severity: "warn", title: "WebSocket Disconnected", body: "Connection lost — reconnecting...", ts: new Date().toISOString(), data: { wsConnected: false } });
});

wsClient.on("stall", () => {
  notifications.push(
    "ws_disconnected",
    "warn",
    "WebSocket Stall Detected",
    "No messages received — forcing reconnect"
  );
  audit.log("WS_STALL", "warn", "No messages — forcing reconnect", wsClient.getStats() as any);
});

// ─── Detector → Notifications + SSE ───────────────────────────────

detector.on("opportunity", (opp: Opportunity) => {
  console.log(`[detector] NEW opportunity: ${opp.label || opp.tokenId} spread=${opp.spreadBps}bps`);
  const notif = notifications.push(
    "opportunity_new",
    "alert",
    "New Opportunity",
    `${opp.label || opp.tokenId.substring(0, 16)} — spread ${opp.spreadBps} bps, bid $${opp.bidDepthUsd.toFixed(0)} / ask $${opp.askDepthUsd.toFixed(0)}`,
    { tokenId: opp.tokenId, data: opp as any }
  );
  emitter.emit("opportunity", opp);
  emitter.emit("notification", notif);

  // Telegram: forward new opportunities
  telegram.handleNotification(notif);

  // AlexBot webhook
  alertClient.sendAlert({
    type: "opportunity_new",
    severity: "alert",
    title: "New Opportunity",
    body: `${opp.label || opp.tokenId.substring(0, 30)} — spread ${opp.spreadBps} bps, bid $${opp.bidDepthUsd.toFixed(0)} / ask $${opp.askDepthUsd.toFixed(0)}`,
    ts: new Date().toISOString(),
    data: { tokenId: opp.tokenId, label: opp.label, spreadBps: opp.spreadBps, bestBid: opp.bestBid, bestAsk: opp.bestAsk, mid: opp.mid, bidDepthUsd: opp.bidDepthUsd, askDepthUsd: opp.askDepthUsd, stabilityCount: opp.stabilityCount, recentTrades: opp.recentTrades },
  });

  // Audit only very wide spreads (>= 2000 bps)
  if (opp.spreadBps >= 2000) {
    audit.log("OPP_WIDE", "alert", `${opp.label || opp.tokenId.substring(0, 30)} — ${opp.spreadBps} bps`, opp as any);
  }
});

detector.on("opportunity_stable", (opp: Opportunity) => {
  console.log(`[detector] STABLE opportunity: ${opp.label || opp.tokenId} spread=${opp.spreadBps}bps (${opp.stabilityCount} checks)`);
  const notif = notifications.push(
    "opportunity_stable",
    "critical",
    "Stable Opportunity",
    `${opp.label || opp.tokenId.substring(0, 16)} — spread ${opp.spreadBps} bps held for ${opp.stabilityCount} checks`,
    { tokenId: opp.tokenId, data: opp as any }
  );
  emitter.emit("opportunity", opp);
  emitter.emit("notification", notif);

  // Telegram: ALWAYS send stable opportunities (high-value, dedicated formatter)
  telegram.handleOpportunityStable(opp);

  // AlexBot webhook — stable = critical
  alertClient.sendAlert({
    type: "opportunity_stable",
    severity: "critical",
    title: "STABLE Opportunity",
    body: `${opp.label || opp.tokenId.substring(0, 30)} — spread ${opp.spreadBps} bps held for ${opp.stabilityCount} checks`,
    ts: new Date().toISOString(),
    data: { tokenId: opp.tokenId, label: opp.label, spreadBps: opp.spreadBps, bestBid: opp.bestBid, bestAsk: opp.bestAsk, mid: opp.mid, bidDepthUsd: opp.bidDepthUsd, askDepthUsd: opp.askDepthUsd, stabilityCount: opp.stabilityCount, recentTrades: opp.recentTrades },
  });

  // Audit all stable opportunities
  audit.log("OPP_STABLE", "critical", `${opp.label || opp.tokenId.substring(0, 30)} — ${opp.spreadBps} bps, ${opp.stabilityCount} checks`, opp as any);
});

detector.on("opportunity_vanished", (opp: Opportunity) => {
  console.log(`[detector] ${opp.status.toUpperCase()}: ${opp.label || opp.tokenId}`);
  const notif = notifications.push(
    opp.status === "thinned" ? "opportunity_thinned" : "opportunity_vanished",
    "warn",
    opp.status === "thinned" ? "Book Thinned" : "Opportunity Vanished",
    `${opp.label || opp.tokenId.substring(0, 16)} — ${opp.status === "thinned" ? "depth dropped below threshold" : "spread narrowed"}`,
    { tokenId: opp.tokenId }
  );
  emitter.emit("opportunity", opp);
  emitter.emit("notification", notif);

  // Telegram: forward vanished/thinned
  telegram.handleNotification(notif);

  // AlexBot webhook
  alertClient.sendAlert({
    type: opp.status === "thinned" ? "opportunity_thinned" : "opportunity_vanished",
    severity: "warn",
    title: opp.status === "thinned" ? "Book Thinned" : "Opportunity Vanished",
    body: `${opp.label || opp.tokenId.substring(0, 30)} — ${opp.status === "thinned" ? "depth dropped" : "spread narrowed"}`,
    ts: new Date().toISOString(),
    data: { tokenId: opp.tokenId, label: opp.label, spreadBps: opp.spreadBps },
  });
});

detector.on("opportunity_update", (opp: Opportunity) => {
  emitter.emit("opportunity", opp);
});

// Forward all notifications to SSE
notifications.on("notification", (notif) => {
  emitter.emit("notification", notif);
});

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("=== Polymarket Orderbook Scanner ===");
  console.log(`Starting on port ${PORT}...`);

  const { server } = createServer(PORT, getState, emitter);
  wsClient.start();
  await discoverMarkets();

  if (notionSync) {
    notionSync.startScheduler();
  }

  setInterval(() => {
    discoverMarkets().catch((err) =>
      console.error(`[periodic] discovery error: ${err.message}`)
    );
  }, REFRESH_INTERVAL);

  // Periodic Telegram summary every 4 hours
  const SUMMARY_INTERVAL = 4 * 60 * 60 * 1000;
  setInterval(() => {
    const activeOpps = detector.getActiveOpportunities();
    telegram.sendSummary({
      activeOpps: activeOpps.length,
      stableOpps: activeOpps.filter((o) => o.status === "stable").length,
      events: events.length,
      tokens: bookAnalytics.size,
      wsConnected,
      topOpps: activeOpps.slice(0, 5),
    }).catch((err) => console.error(`[telegram] summary error: ${err.message}`));

    // Also send summary to AlexBot
    alertClient.sendAlert({
      type: "summary",
      severity: "info",
      title: "Scanner Summary (4h)",
      body: `Active: ${activeOpps.length}, Stable: ${activeOpps.filter((o) => o.status === "stable").length}, Events: ${events.length}, Tokens: ${bookAnalytics.size}, WS: ${wsConnected ? "up" : "down"}`,
      ts: new Date().toISOString(),
      data: {
        activeOpps: activeOpps.length,
        stableOpps: activeOpps.filter((o) => o.status === "stable").length,
        eventCount: events.length,
        tokenCount: bookAnalytics.size,
        wsConnected,
      },
    });
  }, SUMMARY_INTERVAL);

  // ─── Graceful shutdown ─────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] ${signal} received, shutting down gracefully...`);

    server.close(() => {
      console.log("[shutdown] HTTP server closed");
    });

    try {
      wsClient.stop();
      console.log("[shutdown] WebSocket closed");
    } catch { /* ignore */ }

    if (clickhouseDb) {
      try {
        await clickhouseDb.close();
        console.log("[shutdown] ClickHouse connection closed");
      } catch { /* ignore */ }
    }

    console.log("[shutdown] Done. Goodbye.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(`\nOpen http://localhost:${PORT} in your browser`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
