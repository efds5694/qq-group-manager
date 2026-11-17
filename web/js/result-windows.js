export const WINDOW_SIZE = 200;

// 只缓存已访问的结果窗口；未访问的中间窗口不必请求。
export class ResultWindows {
  constructor(data, fetchWindow) {
    this.queryId = data.query_id;
    this.count = data.total_rows;
    this.rows = new Map();
    this.pending = new Map();
    this.errors = new Map();
    this.expired = false;
    this.fetchWindow = fetchWindow;
    this.add(data);
  }

  add(data) { data.items.forEach((row, i) => this.rows.set((data.offset || 0) + i, row)); }
  get(index) { return this.rows.get(index); }

  async request(index) {
    const offset = Math.floor(index / WINDOW_SIZE) * WINDOW_SIZE;
    if (this.expired || this.errors.has(offset) || this.rows.has(index) || !this.queryId) return;
    if (this.pending.has(offset)) return this.pending.get(offset);
    const task = (async () => {
      try { this.add(await this.fetchWindow(this.queryId, offset, WINDOW_SIZE)); }
      catch (error) {
        this.errors.set(offset, error);
        if (error.code === 'QUERY_EXPIRED') this.expired = true;
      } finally { this.pending.delete(offset); }
    })();
    this.pending.set(offset, task);
    return task;
  }
}
