/**
 * Per-pass GPU timing with EXT_disjoint_timer_query_webgl2.
 *
 * A/B testing settings only tells you what a feature costs *including* every
 * indirect effect it has on the driver. When those numbers stop adding up — a
 * feature that costs 74% of the frame but gets no cheaper when you halve its
 * work — the answer is to measure the passes directly.
 *
 * Results arrive a few frames late because the query has to drain, so scopes
 * are kept in a small ring and read when the GPU is done with them.
 */

interface Scope {
  name: string;
  query: WebGLQuery;
  frame: number;
}

export class GpuProfiler {
  private readonly ext: {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null;

  private readonly pending: Scope[] = [];
  private readonly free: WebGLQuery[] = [];
  private active: Scope | null = null;
  private frame = 0;

  /** Exponentially smoothed milliseconds per pass name. */
  readonly timings = new Map<string, number>();

  enabled = false;

  constructor(private readonly gl: WebGL2RenderingContext, available: boolean) {
    this.ext = available
      ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
          TIME_ELAPSED_EXT: number;
          GPU_DISJOINT_EXT: number;
        } | null)
      : null;
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  beginFrame(): void {
    this.frame++;
    if (this.enabled) this.collect();
  }

  /**
   * Opens a timing scope. Only one TIME_ELAPSED query may be active at a time,
   * so a scope that is already open is closed first.
   */
  begin(name: string): void {
    if (!this.enabled || !this.ext) return;
    if (this.active) this.end();

    const query = this.free.pop() ?? this.gl.createQuery();
    if (!query) return;

    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.active = { name, query, frame: this.frame };
  }

  end(): void {
    if (!this.enabled || !this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Drains finished queries into `timings`. */
  private collect(): void {
    const gl = this.gl;
    if (!this.ext) return;

    // A disjoint event means the GPU was interrupted and every outstanding
    // result is meaningless; throw them all away rather than report noise.
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    if (disjoint) {
      for (const scope of this.pending) this.free.push(scope.query);
      this.pending.length = 0;
      return;
    }

    while (this.pending.length > 0) {
      const scope = this.pending[0];
      const available = gl.getQueryParameter(scope.query, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (!available) break;

      const nanoseconds = gl.getQueryParameter(scope.query, gl.QUERY_RESULT) as number;
      const ms = nanoseconds / 1e6;

      const previous = this.timings.get(scope.name);
      this.timings.set(scope.name, previous === undefined ? ms : previous * 0.85 + ms * 0.15);

      this.free.push(scope.query);
      this.pending.shift();
    }
  }

  snapshot(): Array<{ name: string; ms: number }> {
    return [...this.timings.entries()]
      .map(([name, ms]) => ({ name, ms }))
      .sort((a, b) => b.ms - a.ms);
  }

  reset(): void {
    this.timings.clear();
  }

  dispose(): void {
    for (const scope of this.pending) this.gl.deleteQuery(scope.query);
    for (const query of this.free) this.gl.deleteQuery(query);
    this.pending.length = 0;
    this.free.length = 0;
  }
}
