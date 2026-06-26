import type { MaterialGraphController } from "./graph/controller";
import { CURVE_CHANNELS, CURVE_IDENTITY, type CurveValue } from "./graph/types";

// Canvas curve editor for the RGB Curves node's `curve` param. Renders the four channel curves (Combined
// + R/G/B) with the active one editable; each channel has 5 fixed-x control points (x = 0/.25/.5/.75/1)
// dragged on the Y axis. Edits write straight to the controller (live uniform-array update). Double-click
// resets the active channel to the identity ramp. Self-contained DOM — disposes with the host Pane.

const W = 220;
const H = 150;
const PAD = 12;
const CH_COLOR: Record<string, string> = { C: "#d8d8d8", R: "#e25555", G: "#5fd25f", B: "#5b8be2" };

// JS twin of tsl/curve.ts curve5 — uniform-x Catmull-Rom with clamped ends. Used to draw the spline.
function evalCurve(t: number, p: number[]): number {
  t = Math.min(1, Math.max(0, t));
  const x = t * 4;
  const seg = Math.min(3, Math.floor(x));
  const s = x - seg;
  const A = p[[0, 0, 1, 2][seg]];
  const B = p[[0, 1, 2, 3][seg]];
  const C = p[[1, 2, 3, 4][seg]];
  const D = p[[2, 3, 4, 4][seg]];
  const s2 = s * s;
  const s3 = s2 * s;
  return 0.5 * (2 * B + (C - A) * s + (2 * A - 5 * B + 4 * C - D) * s2 + (3 * B - 3 * C + D - A) * s3);
}

const px = (i: number) => PAD + (i / 4) * (W - 2 * PAD); // control-point index 0..4 → canvas x
const py = (y: number) => H - PAD - Math.min(1, Math.max(0, y)) * (H - 2 * PAD); // value 0..1 → canvas y
const yFromPx = (cy: number) => Math.min(1, Math.max(0, (H - PAD - cy) / (H - 2 * PAD)));

export function mountCurveWidget(
  host: HTMLElement,
  controller: MaterialGraphController,
  nodeId: string,
  paramKey: string,
  value: CurveValue,
): void {
  let active = "C";
  let dragging = -1;

  const root = document.createElement("div");
  root.className = "curve-widget";

  const tabs = document.createElement("div");
  tabs.className = "curve-tabs";
  const tabBtns: Record<string, HTMLButtonElement> = {};
  for (const c of CURVE_CHANNELS) {
    const b = document.createElement("button");
    b.textContent = c;
    b.style.color = CH_COLOR[c];
    b.onclick = () => {
      active = c;
      syncTabs();
      draw();
    };
    tabs.appendChild(b);
    tabBtns[c] = b;
  }
  root.appendChild(tabs);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.className = "curve-canvas";
  root.appendChild(canvas);
  host.appendChild(root);
  const ctx = canvas.getContext("2d")!;

  function syncTabs() {
    for (const c of CURVE_CHANNELS) tabBtns[c].classList.toggle("active", c === active);
  }

  function pts(c: string): number[] {
    return value[c as keyof CurveValue];
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    // grid
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      ctx.beginPath();
      ctx.moveTo(px(i), PAD);
      ctx.lineTo(px(i), H - PAD);
      ctx.moveTo(PAD, py(i / 4));
      ctx.lineTo(W - PAD, py(i / 4));
      ctx.stroke();
    }
    // curves: inactive faint, active bold + points
    for (const c of CURVE_CHANNELS) {
      if (c === active) continue;
      strokeCurve(c, 1, 0.35);
    }
    strokeCurve(active, 2, 1);
    const p = pts(active);
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.arc(px(i), py(p[i]), i === dragging ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = CH_COLOR[active];
      ctx.fill();
      ctx.strokeStyle = "#1a1a1a";
      ctx.stroke();
    }
  }

  function strokeCurve(c: string, width: number, alpha: number) {
    const p = pts(c);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = CH_COLOR[c];
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let s = 0; s <= 64; s++) {
      const t = s / 64;
      const X = PAD + t * (W - 2 * PAD);
      const Y = py(evalCurve(t, p));
      s === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function hitPoint(mx: number, my: number): number {
    const p = pts(active);
    for (let i = 0; i < 5; i++) {
      if (Math.hypot(mx - px(i), my - py(p[i])) < 9) return i;
    }
    return -1;
  }

  function localXY(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  }

  canvas.addEventListener("pointerdown", (e) => {
    const [mx, my] = localXY(e);
    const i = hitPoint(mx, my);
    if (i < 0) return;
    dragging = i;
    canvas.setPointerCapture(e.pointerId);
    draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging < 0) return;
    const [, my] = localXY(e);
    pts(active)[dragging] = yFromPx(my);
    controller.setParam(nodeId, paramKey, value);
    draw();
  });
  const endDrag = () => {
    if (dragging < 0) return;
    dragging = -1;
    draw();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("dblclick", () => {
    value[active as keyof CurveValue] = [...CURVE_IDENTITY];
    controller.setParam(nodeId, paramKey, value);
    draw();
  });

  syncTabs();
  draw();
}
