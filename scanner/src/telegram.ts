import { EventEmitter } from "events";
import { Notification, Severity, NotificationType } from "./notifications";
import { Opportunity } from "./detector";

// ─── Config ────────────────────────────────────────────────────────

export interface TelegramConfig {
  /** Telegram Bot API token (from @BotFather) */
  botToken: string;
  /** Chat ID or channel ID to send alerts to */
  chatId: string;
  /** Enable/disable Telegram alerts */
  enabled: boolean;
  /** Minimum severity to send: info, warn, alert, critical */
  minSeverity: Severity;
  /** Alert types to send (empty = all) */
  allowedTypes: NotificationType[];
  /** Cooldown between messages to avoid flood (ms) */
  rateLimitMs: number;
  /** Whether to send silent (no notification sound) messages for info/warn */
  silentForLow: boolean;
}

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  botToken: "",
  chatId: "",
  enabled: false,
  minSeverity: "alert",
  allowedTypes: [],
  rateLimitMs: 5_000,
  silentForLow: true,
};

// Severity ranking for filtering
const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warn: 1,
  alert: 2,
  critical: 3,
};

// ─── Telegram Alert Manager ─────────────────────────────────────────

export class TelegramAlerts extends EventEmitter {
  private config: TelegramConfig;
  private lastSentAt = 0;
  private queue: string[] = [];
  private sending = false;
  private stats = {
    sent: 0,
    failed: 0,
    queued: 0,
    lastError: null as string | null,
    lastSentAt: null as string | null,
  };

  constructor(config: Partial<TelegramConfig> = {}) {
    super();
    this.config = { ...DEFAULT_TELEGRAM_CONFIG, ...config };
  }

  // ── Public API ─────────────────────────────────────────────────

  getConfig(): TelegramConfig {
    return { ...this.config };
  }

  updateConfig(patch: Partial<TelegramConfig>) {
    Object.assign(this.config, patch);
    this.emit("config_changed", this.config);
  }

  getStats() {
    return { ...this.stats, queueLength: this.queue.length };
  }

  /** Check if TG is properly configured */
  isConfigured(): boolean {
    return !!(this.config.botToken && this.config.chatId && this.config.enabled);
  }

  /** Send a test message to verify bot works */
  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    if (!this.config.botToken || !this.config.chatId) {
      return { ok: false, error: "Bot token or chat ID not configured" };
    }
    try {
      await this.sendMessage(
        "🧪 *Test Alert*\n\nPolymarket Scanner Telegram alerts are working\\!",
        false
      );
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  // ── Notification handler ────────────────────────────────────────

  /** Process a notification and decide whether to send via Telegram */
  handleNotification(notif: Notification) {
    if (!this.isConfigured()) return;

    // Check severity threshold
    if (SEVERITY_RANK[notif.severity] < SEVERITY_RANK[this.config.minSeverity]) {
      return;
    }

    // Check allowed types (empty = all)
    if (
      this.config.allowedTypes.length > 0 &&
      !this.config.allowedTypes.includes(notif.type)
    ) {
      return;
    }

    const text = this.formatNotification(notif);
    const silent =
      this.config.silentForLow &&
      SEVERITY_RANK[notif.severity] < SEVERITY_RANK["alert"];

    this.enqueue(text, silent);
  }

  /** Direct opportunity alert (for stable/high-value opportunities) */
  handleOpportunityStable(opp: Opportunity) {
    if (!this.isConfigured()) return;

    const text = this.formatOpportunity(opp);
    this.enqueue(text, false); // Never silent for stable opportunities
  }

  /** WS connection alert */
  handleWsStatus(connected: boolean) {
    if (!this.isConfigured()) return;
    if (SEVERITY_RANK["warn"] < SEVERITY_RANK[this.config.minSeverity]) return;

    const emoji = connected ? "🟢" : "🔴";
    const status = connected ? "Connected" : "Disconnected";
    const text = `${emoji} *WebSocket ${status}*\n\n${connected ? "Live market data streaming resumed\\." : "Connection lost — reconnecting\\.\\.\\."}\n\n_${escapeMarkdown(new Date().toLocaleString())}_`;

    this.enqueue(text, connected); // silent for reconnect, loud for disconnect
  }

  /** Discovery cycle complete */
  handleDiscovery(eventCount: number, tokenCount: number) {
    if (!this.isConfigured()) return;
    if (SEVERITY_RANK["info"] < SEVERITY_RANK[this.config.minSeverity]) return;

    const text = `📡 *Discovery Complete*\n\n• Events: *${eventCount}*\n• Tokens tracked: *${tokenCount}*\n\n_${escapeMarkdown(new Date().toLocaleString())}_`;
    this.enqueue(text, true); // always silent for routine discovery
  }

  /** Summary alert — send periodic digest */
  async sendSummary(data: {
    activeOpps: number;
    stableOpps: number;
    events: number;
    tokens: number;
    wsConnected: boolean;
    topOpps: Opportunity[];
  }) {
    if (!this.isConfigured()) return;

    let text = `📊 *Scanner Summary*\n\n`;
    text += `• Active opportunities: *${data.activeOpps}*\n`;
    text += `• Stable opportunities: *${data.stableOpps}*\n`;
    text += `• Events tracked: *${data.events}*\n`;
    text += `• Tokens tracked: *${data.tokens}*\n`;
    text += `• WebSocket: ${data.wsConnected ? "🟢 Connected" : "🔴 Disconnected"}\n`;

    if (data.topOpps.length > 0) {
      text += `\n*Top Opportunities:*\n`;
      for (const opp of data.topOpps.slice(0, 5)) {
        const label = escapeMarkdown(
          opp.label || opp.tokenId.substring(0, 20)
        );
        text += `  • ${label}: *${opp.spreadBps} bps* \\(\\$${opp.bidDepthUsd.toFixed(0)}/$${opp.askDepthUsd.toFixed(0)}\\)\n`;
      }
    }

    text += `\n_${escapeMarkdown(new Date().toLocaleString())}_`;
    this.enqueue(text, true);
  }

  // ── Message formatting ─────────────────────────────────────────

  private formatNotification(notif: Notification): string {
    const emoji = severityEmoji(notif.severity);
    const title = escapeMarkdown(notif.title);
    const body = escapeMarkdown(notif.body);
    const time = escapeMarkdown(new Date(notif.timestamp).toLocaleTimeString());

    let text = `${emoji} *${title}*\n\n${body}\n\n`;

    if (notif.tokenId) {
      text += `Token: \`${notif.tokenId.substring(0, 16)}\\.\\.\\.\`\n`;
    }

    text += `_${time}_`;
    return text;
  }

  private formatOpportunity(opp: Opportunity): string {
    const label = escapeMarkdown(
      opp.label || opp.tokenId.substring(0, 30)
    );
    const time = escapeMarkdown(new Date(opp.updatedAt).toLocaleTimeString());

    let text = `🎯 *STABLE Opportunity Detected*\n\n`;
    text += `*${label}*\n\n`;
    text += `• Spread: *${opp.spreadBps} bps*\n`;
    text += `• Best Bid: \`${opp.bestBid}\`\n`;
    text += `• Best Ask: \`${opp.bestAsk}\`\n`;
    text += `• Mid: \`${opp.mid}\`\n`;
    text += `• Bid Depth: *\\$${opp.bidDepthUsd.toFixed(2)}*\n`;
    text += `• Ask Depth: *\\$${opp.askDepthUsd.toFixed(2)}*\n`;
    text += `• Stability: *${opp.stabilityCount} checks*\n`;
    text += `• Recent Trades: *${opp.recentTrades}*\n\n`;
    text += `_${time}_`;

    return text;
  }

  // ── Queue & rate limiter ───────────────────────────────────────

  private enqueue(text: string, silent: boolean) {
    // Pack silent flag into the string (we'll unpack in flush)
    this.queue.push(JSON.stringify({ text, silent }));
    this.stats.queued++;
    this.flush();
  }

  private async flush() {
    if (this.sending || this.queue.length === 0) return;

    const now = Date.now();
    const elapsed = now - this.lastSentAt;

    if (elapsed < this.config.rateLimitMs) {
      // Schedule flush after cooldown
      setTimeout(() => this.flush(), this.config.rateLimitMs - elapsed + 100);
      return;
    }

    this.sending = true;

    while (this.queue.length > 0) {
      const raw = this.queue.shift()!;
      const { text, silent } = JSON.parse(raw);

      try {
        await this.sendMessage(text, silent);
        this.stats.sent++;
        this.stats.lastSentAt = new Date().toISOString();
        this.lastSentAt = Date.now();
      } catch (err: any) {
        this.stats.failed++;
        this.stats.lastError = err.message;
        console.error(`[telegram] send error: ${err.message}`);
      }

      // Rate limit between messages
      if (this.queue.length > 0) {
        await sleep(this.config.rateLimitMs);
      }
    }

    this.sending = false;
  }

  // ── Telegram Bot API call ──────────────────────────────────────

  private async sendMessage(text: string, silent: boolean): Promise<any> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.config.chatId,
        text,
        parse_mode: "MarkdownV2",
        disable_notification: silent,
        disable_web_page_preview: true,
      }),
    });

    const data = (await resp.json()) as any;

    if (!data.ok) {
      // If MarkdownV2 parsing fails, retry with plain text
      if (data.description?.includes("can't parse")) {
        console.warn("[telegram] MarkdownV2 failed, retrying plain text");
        const plainResp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.config.chatId,
            text: stripMarkdown(text),
            disable_notification: silent,
            disable_web_page_preview: true,
          }),
        });
        const plainData = (await plainResp.json()) as any;
        if (!plainData.ok) {
          throw new Error(`Telegram API error: ${plainData.description}`);
        }
        return plainData;
      }
      throw new Error(`Telegram API error: ${data.description}`);
    }

    return data;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function severityEmoji(severity: Severity): string {
  switch (severity) {
    case "info":
      return "ℹ️";
    case "warn":
      return "⚠️";
    case "alert":
      return "🔔";
    case "critical":
      return "🚨";
  }
}

/** Escape special chars for Telegram MarkdownV2 */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/** Strip markdown formatting for plain text fallback */
function stripMarkdown(text: string): string {
  return text
    .replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1")
    .replace(/[*_`]/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
