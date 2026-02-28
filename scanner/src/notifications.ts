import { EventEmitter } from "events";

export type NotificationType =
  | "opportunity_new"
  | "opportunity_stable"
  | "opportunity_vanished"
  | "opportunity_thinned"
  | "ws_connected"
  | "ws_disconnected"
  | "discovery_complete"
  | "book_stale"
  | "volatility_spike";

export type Severity = "info" | "warn" | "alert" | "critical";

export interface Notification {
  id: number;
  type: NotificationType;
  severity: Severity;
  title: string;
  body: string;
  tokenId?: string;
  timestamp: number;
  read: boolean;
  data?: Record<string, any>;
}

const MAX_NOTIFICATIONS = 200;

export class NotificationManager extends EventEmitter {
  private notifications: Notification[] = [];
  private nextId = 1;

  push(
    type: NotificationType,
    severity: Severity,
    title: string,
    body: string,
    extra?: { tokenId?: string; data?: Record<string, any> }
  ): Notification {
    const notif: Notification = {
      id: this.nextId++,
      type,
      severity,
      title,
      body,
      tokenId: extra?.tokenId,
      timestamp: Date.now(),
      read: false,
      data: extra?.data,
    };

    this.notifications.unshift(notif);

    // Prune old
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications = this.notifications.slice(0, MAX_NOTIFICATIONS);
    }

    this.emit("notification", notif);
    return notif;
  }

  getAll(limit = 50): Notification[] {
    return this.notifications.slice(0, limit);
  }

  getUnread(): Notification[] {
    return this.notifications.filter((n) => !n.read);
  }

  markRead(id: number) {
    const n = this.notifications.find((n) => n.id === id);
    if (n) n.read = true;
  }

  markAllRead() {
    for (const n of this.notifications) n.read = true;
  }

  getUnreadCount(): number {
    return this.notifications.filter((n) => !n.read).length;
  }

  clear() {
    this.notifications = [];
  }
}
