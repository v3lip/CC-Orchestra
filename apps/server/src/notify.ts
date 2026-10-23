/**
 * Notifications to a chat webhook (NOTIFY_WEBHOOK_URL): a job completed, needs attention,
 * or lost its turtle. The payload carries the text as `content` (Discord) and `text`
 * (Slack and most others), so either kind of webhook works. Messages are sent one at a
 * time, at most one every MIN_GAP_MS; a burst beyond MAX_QUEUED is collapsed into one
 * "and N more" line. Delivery failures are logged once until a send works again.
 */
export class Notifier {
  private queue: string[] = [];
  private dropped = 0;
  private sending = false;
  private lastSent = 0;
  private failing = false;

  constructor(
    private url: string | undefined,
    private log: (level: 'info' | 'warn', msg: string) => void,
    private post: (url: string, body: string) => Promise<{ ok: boolean; status: number }> = defaultPost,
    private gapMs = MIN_GAP_MS,
  ) {}

  get enabled(): boolean {
    return !!this.url;
  }

  send(text: string): void {
    if (!this.url) return;
    if (this.queue.length >= MAX_QUEUED) this.dropped++;
    else this.queue.push(text.slice(0, 1900));
    void this.pump();
  }

  /** Resolves once everything queued has been sent (or given up on). */
  async flush(): Promise<void> {
    while (this.sending || this.queue.length || this.dropped) await new Promise((r) => setTimeout(r, 20));
  }

  private async pump(): Promise<void> {
    if (this.sending || !this.url) return;
    this.sending = true;
    try {
      while (this.queue.length || this.dropped) {
        const wait = this.lastSent + this.gapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        let text = this.queue.shift();
        if (!text) {
          text = `…and ${this.dropped} more (see the dashboard's activity log)`;
          this.dropped = 0;
        }
        this.lastSent = Date.now();
        try {
          const r = await this.post(this.url, JSON.stringify({ content: text, text }));
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          if (this.failing) this.log('info', 'Notifications are being delivered again');
          this.failing = false;
        } catch (e) {
          if (!this.failing) this.log('warn', `Notification not delivered (${(e as Error).message}); check NOTIFY_WEBHOOK_URL`);
          this.failing = true;
        }
      }
    } finally {
      this.sending = false;
    }
  }
}

const MIN_GAP_MS = 1200;
const MAX_QUEUED = 20;

async function defaultPost(url: string, body: string): Promise<{ ok: boolean; status: number }> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
  return { ok: r.ok, status: r.status };
}
