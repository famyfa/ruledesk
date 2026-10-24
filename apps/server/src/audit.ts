import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AuditEvent {
  id: number;
  at: string;
  user: string;
  action: string;
  firewallId: string | null;
  outcome: "success" | "failure" | "partial";
  /** JSON details. Never contains secrets. */
  details: Record<string, unknown>;
}

/**
 * Small SQLite store for audit events (and later, app settings).
 * Pass ":memory:" for tests.
 */
export class AuditLog {
  private db: DatabaseSync;

  constructor(dataDir: string | ":memory:") {
    if (dataDir === ":memory:") {
      this.db = new DatabaseSync(":memory:");
    } else {
      mkdirSync(dataDir, { recursive: true });
      this.db = new DatabaseSync(join(dataDir, "ruledeck.sqlite"));
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        user TEXT NOT NULL,
        action TEXT NOT NULL,
        firewall_id TEXT,
        outcome TEXT NOT NULL,
        details TEXT NOT NULL
      );
    `);
  }

  record(e: Omit<AuditEvent, "id" | "at">): void {
    this.db
      .prepare("INSERT INTO audit_events (at, user, action, firewall_id, outcome, details) VALUES (?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), e.user, e.action, e.firewallId, e.outcome, JSON.stringify(e.details));
  }

  list(limit = 200): AuditEvent[] {
    const rows = this.db
      .prepare("SELECT id, at, user, action, firewall_id, outcome, details FROM audit_events ORDER BY id DESC LIMIT ?")
      .all(limit) as { id: number; at: string; user: string; action: string; firewall_id: string | null; outcome: AuditEvent["outcome"]; details: string }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      user: r.user,
      action: r.action,
      firewallId: r.firewall_id,
      outcome: r.outcome,
      details: JSON.parse(r.details) as Record<string, unknown>,
    }));
  }

  close() {
    this.db.close();
  }
}
