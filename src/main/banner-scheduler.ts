import { BannerItem } from '../shared/types';

interface ActiveBanner {
  item: BannerItem;
  height: number;
  timer: NodeJS.Timeout;
}

export interface SchedulerHooks {
  getMaxHeight: () => number;
  getMaxCount: () => number;
  measure: (item: BannerItem) => void;
  show: (item: BannerItem) => void;
  remove: (id: string) => void;
  durationFor: (item: BannerItem) => number;
}

export class BannerScheduler {
  private active = new Map<string, ActiveBanner>();
  private queue: BannerItem[] = [];
  private pending = new Map<string, BannerItem>();

  constructor(private hooks: SchedulerHooks) {}

  getUsedHeight(): number {
    let used = 0;
    for (const a of this.active.values()) used += a.height;
    return used;
  }

  getMaxHeight(): number {
    return Math.max(0, this.hooks.getMaxHeight());
  }

  private canActivateByCount(): boolean {
    const maxCount = this.hooks.getMaxCount();
    if (maxCount > 0 && this.active.size >= maxCount) return false;
    return true;
  }

  request(item: BannerItem): void {
    if (this.active.has(item.id) || this.pending.has(item.id)) return;
    this.pending.set(item.id, item);
    this.hooks.measure(item);
  }

  handleMeasured(id: string, height: number): void {
    const item = this.pending.get(id);
    if (!item) return;
    this.pending.delete(id);
    item.height = Math.max(1, height);
    if (this.canActivateByCount() && this.getUsedHeight() + height <= this.getMaxHeight()) {
      this.activate(item);
    } else {
      this.queue.push(item);
    }
  }

  private activate(item: BannerItem): void {
    if (this.active.has(item.id)) return;
    const height = item.height || 1;
    const duration = Math.max(1000, this.hooks.durationFor(item));
    const timer = setTimeout(() => this.expire(item.id), duration);
    this.active.set(item.id, { item, height, timer });
    this.hooks.show(item);
  }

  private expire(id: string): void {
    const a = this.active.get(id);
    if (!a) return;
    clearTimeout(a.timer);
    this.active.delete(id);
    this.hooks.remove(id);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      if (!this.canActivateByCount()) break;
      const max = this.getMaxHeight();
      const used = this.getUsedHeight();
      const idx = this.queue.findIndex((q) => used + (q.height || 1) <= max);
      if (idx === -1) break;
      const [item] = this.queue.splice(idx, 1);
      this.activate(item);
    }
  }

  recheck(): void {
    this.drainQueue();
  }

  clear(): void {
    for (const [, a] of this.active) clearTimeout(a.timer);
    this.active.clear();
    this.queue = [];
    this.pending.clear();
  }
}
