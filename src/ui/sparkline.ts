// Tiny right-aligned sparkline. Owns one canvas + one ring of values, redraws on push().
export class Sparkline {
  private buf: number[] = [];
  private ctx: CanvasRenderingContext2D;
  private W: number;
  private H: number;

  constructor(
    canvas: HTMLCanvasElement,
    private cap = 120,
    private color = "#7fb3ff",
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.W = canvas.width;
    this.H = canvas.height;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = `${this.W}px`;
    canvas.style.height = `${this.H}px`;
    canvas.width = Math.round(this.W * ratio);
    canvas.height = Math.round(this.H * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  push(v: number) {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
    this.draw();
  }

  reset() {
    this.buf = [];
    this.draw();
  }

  private draw() {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);
    if (this.buf.length < 2) return;

    let mn = Infinity;
    let mx = -Infinity;
    for (const v of this.buf) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mx - mn < 1e-6) {
      mn -= 0.5;
      mx += 0.5;
    }
    const range = mx - mn;
    const step = W / (this.cap - 1);
    const offset = (this.cap - this.buf.length) * step; // right-align newest sample

    ctx.strokeStyle = this.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < this.buf.length; i++) {
      const x = offset + i * step;
      const y = H - 1 - ((this.buf[i] - mn) / range) * (H - 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}
