// ─── AlexBot Webhook Alert Client ────────────────────────────────────
//
// Sends structured alerts to AlexBot webhook:
//   POST {ALEXBOT_WEBHOOK_URL}/hooks/prediction-alert
//   Header: Authorization: Bearer {PREDICTION_ALERTS_TOKEN}
//
// Retry policy: 3 attempts (100ms / 300ms / 1000ms)
// Timeout: 1500ms per request
// ─────────────────────────────────────────────────────────────────────

export interface AlertPayload {
  /** Alert type */
  type:
    | "opportunity_new"
    | "opportunity_stable"
    | "opportunity_vanished"
    | "opportunity_thinned"
    | "ws_down"
    | "ws_up"
    | "summary";
  /** Severity: info | warn | alert | critical */
  severity: "info" | "warn" | "alert" | "critical";
  /** One-line title */
  title: string;
  /** Detail body (plain text, no markdown) */
  body: string;
  /** ISO-8601 timestamp */
  ts: string;
  /** Optional structured data */
  data?: {
    tokenId?: string;
    label?: string;
    spreadBps?: number;
    bestBid?: string;
    bestAsk?: string;
    mid?: string;
    bidDepthUsd?: number;
    askDepthUsd?: number;
    stabilityCount?: number;
    recentTrades?: number;
    eventCount?: number;
    tokenCount?: number;
    activeOpps?: number;
    stableOpps?: number;
    wsConnected?: boolean;
  };
}

// ─── Config ────────────────────────────────────────────────────────

export interface AlertClientConfig {
  /** AlexBot base URL (e.g. https://alexbot.example.com) */
  webhookUrl: string;
  /** Bearer token for Authorization header */
  token: string;
  /** Enable/disable */
  enabled: boolean;
}

const RETRY_DELAYS = [100, 300, 1000]; // ms
const TIMEOUT_MS = 1500;

// ─── Client ────────────────────────────────────────────────────────

export class AlertClient {
  private config: AlertClientConfig;
  private stats = {
    sent: 0,
    failed: 0,
    retries: 0,
    lastError: null as string | null,
    lastSentAt: null as string | null,
  };

  constructor(config: AlertClientConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return !!(this.config.webhookUrl && this.config.token && this.config.enabled);
  }

  getStats() {
    return { ...this.stats };
  }

  getConfig() {
    return {
      enabled: this.config.enabled,
      webhookUrl: this.config.webhookUrl ? maskUrl(this.config.webhookUrl) : "",
      hasToken: !!this.config.token,
    };
  }

  // ── Main send method ─────────────────────────────────────────────

  async sendAlert(payload: AlertPayload): Promise<void> {
    if (!this.isConfigured()) return;

    const url = `${this.config.webhookUrl.replace(/\/+$/, "")}/hooks/prediction-alert`;

    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.token}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (resp.ok) {
          this.stats.sent++;
          this.stats.lastSentAt = new Date().toISOString();
          return;
        }

        // Non-retryable status codes
        if (resp.status === 401 || resp.status === 403) {
          const msg = `Auth failed (${resp.status})`;
          this.stats.failed++;
          this.stats.lastError = msg;
          console.error(`[alert-client] ${msg}`);
          return;
        }

        lastErr = new Error(`HTTP ${resp.status}`);
      } catch (err: any) {
        lastErr = err;
        if (err.name === "AbortError") {
          lastErr = new Error("Timeout (1500ms)");
        }
      }

      // Retry with delay (if not last attempt)
      if (attempt < RETRY_DELAYS.length) {
        this.stats.retries++;
        await sleep(RETRY_DELAYS[attempt]);
      }
    }

    // All retries exhausted
    this.stats.failed++;
    this.stats.lastError = lastErr?.message || "Unknown error";
    console.error(`[alert-client] failed after ${RETRY_DELAYS.length + 1} attempts: ${this.stats.lastError}`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return "***";
  }
}
