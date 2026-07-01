import type { BakeReport } from "../scene/material/graph/bake-service";
import "./bake-progress-widget.css";

export interface BakeProgressWidgetOptions {
  // Where to mount (e.g. the node editor's canvas host).
  mount: HTMLElement;
  // Subscribe to bake telemetry; returns an unsubscribe fn. Inject `bakeService.onBakeReport`.
  subscribe: (cb: (r: BakeReport) => void) => () => void;
}

const COLLAPSE_KEY = "bake-widget-collapsed";
// A burst of edits (a slider drag) fires several coalesced runs back-to-back. Treat them as ONE load: only
// finish the bar once no new run has arrived for this long (bridges the gaps between a drag's runs).
const SETTLE_MS = 150;
// Nominal fill durations so the single bar climbs smoothly toward ~95% (it caps/holds there until the work
// actually finishes, then snaps to 100% — so it never runs backwards mid-load).
const FILL_STRUCTURAL_MS = 600;
const FILL_UNIFORM_MS = 200;

// A docked, collapsible widget with ONE 0–100% loader for the bake of the CURRENT editor document.
// `setActive` re-scopes it to whichever material the editor shows (tree / floor). Self-contained DOM;
// imports nothing from the generic node editor.
export class BakeProgressWidget {
  private readonly root: HTMLDivElement;
  private readonly summaryEl: HTMLSpanElement;
  private readonly fill: HTMLDivElement;
  private readonly detailEl: HTMLDivElement;

  private collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";

  // Active binding (the document the editor currently shows).
  private source: string | null = null;
  private nodeCount = 0;

  // Single-loader run state. A "burst" spans one or more coalesced runs (a drag); it ends when the work
  // settles (no new run for SETTLE_MS).
  private runId = -1;
  private busy = false;
  private finishing = false;
  private recompiled = false;
  private texCount = 0;
  private lastTotalMs = 0;
  private pct = 0;
  private runStart = 0;
  private estimateMs = FILL_UNIFORM_MS;
  private raf = 0;
  private settleTimer = 0;

  constructor(opts: BakeProgressWidgetOptions) {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] => {
      const el = document.createElement(tag);
      el.className = cls;
      return el;
    };

    this.root = make("div", "bake-widget");

    const header = make("div", "bake-widget__header");
    const title = make("span", "bake-widget__title");
    title.textContent = "Material bake";
    this.summaryEl = make("span", "bake-widget__summary");
    this.summaryEl.textContent = "idle";
    const chevron = make("span", "bake-widget__chevron");
    chevron.textContent = "▾";
    header.append(title, this.summaryEl, chevron);
    header.addEventListener("click", () => this.setCollapsed(!this.collapsed));

    const body = make("div", "bake-widget__body");
    const bar = make("div", "bake-bar");
    this.fill = make("div", "bake-bar__fill");
    bar.appendChild(this.fill);
    this.detailEl = make("div", "bake-widget__detail");
    this.detailEl.textContent = "—";
    body.append(bar, this.detailEl);

    this.root.append(header, body);
    this.applyCollapsed();
    opts.mount.appendChild(this.root);

    opts.subscribe((r) => {
      if (r.source === this.source) this.onReport(r);
    });
  }

  // Re-scope to the material the editor is now showing; show its current node count immediately.
  setActive(source: string, getNodeCount: () => number): void {
    this.source = source;
    this.nodeCount = getNodeCount();
    if (!this.busy) {
      this.fill.style.width = "0%";
      this.root.classList.remove("bake-widget--busy");
      this.summaryEl.textContent = `${this.nodeCount} nodes`;
      this.detailEl.textContent = `${this.nodeCount} nodes`;
    }
  }

  private setCollapsed(v: boolean): void {
    this.collapsed = v;
    localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
    this.applyCollapsed();
  }
  private applyCollapsed(): void {
    this.root.classList.toggle("bake-widget--collapsed", this.collapsed);
  }

  private onReport(r: BakeReport): void {
    if (r.runId !== this.runId) {
      // A new run. Cancel any pending settle (more work arrived → the burst continues).
      this.runId = r.runId;
      if (this.settleTimer) {
        clearTimeout(this.settleTimer);
        this.settleTimer = 0;
      }
      if (!this.busy) {
        // Start a fresh burst at 0 (only between distinct edits — never mid-drag, so no backwards jump).
        this.busy = true;
        this.finishing = false;
        this.recompiled = false;
        this.pct = 0;
        this.runStart = performance.now();
        this.estimateMs = r.nodeCount > 0 ? FILL_STRUCTURAL_MS : FILL_UNIFORM_MS;
        this.root.classList.add("bake-widget--busy");
        this.startRaf();
      }
    }

    if (r.nodeCount > 0) {
      this.nodeCount = r.nodeCount;
      this.recompiled = true;
      this.estimateMs = FILL_STRUCTURAL_MS; // a recompile joined the burst → expect the longer fill
    }
    this.texCount = r.texturesTotal;
    this.detailEl.textContent = `Regenerating ${this.texCount} textures…`;
    this.summaryEl.textContent = "Regenerating…";

    if (r.phase === "done") {
      this.lastTotalMs = r.totalMs;
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => this.finish(), SETTLE_MS);
    }
  }

  // The burst has settled — ease the single bar to 100%, then idle.
  private finish(): void {
    this.settleTimer = 0;
    this.finishing = true;
    const nodes = this.recompiled ? `${this.nodeCount} nodes · ` : "";
    const ms = Math.round(this.lastTotalMs);
    this.detailEl.textContent = `${nodes}${this.texCount} textures · ${ms}ms`;
    this.summaryEl.textContent = `✓ ${this.texCount} tex · ${ms}ms`;
    if (!this.raf) this.startRaf();
  }

  // One bar. While working it climbs asymptotically toward ~95% (capping so a long drag holds, never
  // reverses); once finishing it eases to 100% and stops. DOM rAF, so it runs even while the 3D render is
  // gated during a compile.
  private startRaf(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    const tick = (): void => {
      if (this.finishing) {
        this.pct += (100 - this.pct) * 0.25;
        if (this.pct > 99.5) {
          this.pct = 100;
          this.fill.style.width = "100%";
          this.busy = false;
          this.finishing = false;
          this.root.classList.remove("bake-widget--busy");
          this.raf = 0;
          return;
        }
      } else {
        const elapsed = performance.now() - this.runStart;
        const target = Math.min(95, (elapsed / this.estimateMs) * 95);
        if (target > this.pct) this.pct = target; // monotonic: never runs backwards
      }
      this.fill.style.width = `${this.pct}%`;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
}
