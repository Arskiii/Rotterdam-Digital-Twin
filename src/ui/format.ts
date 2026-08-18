export function fmtClockAmPm(d: Date, tz: string): string {
  const s = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }).format(d);
  return s.replace(" ", "");
}

export function fmtSimClock(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function fmtSession(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}HR ${String(m).padStart(2, "0")}MIN`;
  return `${m}MIN`;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function fmtTimestamp(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: tz,
  }).format(d);
}

/** Monochrome sparkline with optional area fill. */
export function drawSparkline(
  canvas: HTMLCanvasElement,
  values: number[],
  opts: { min?: number; max?: number; color?: string; fill?: boolean; grid?: boolean } = {}
) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 180;
  const h = canvas.clientHeight || 50;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  let min = opts.min ?? Math.min(...values);
  let max = opts.max ?? Math.max(...values);
  if (max - min < 1e-6) { max = min + 1; }
  const pad = 2;
  const xy = (i: number, v: number): [number, number] => [
    pad + (i / (values.length - 1)) * (w - pad * 2),
    h - pad - ((v - min) / (max - min)) * (h - pad * 2),
  ];
  if (opts.grid !== false) {
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(pad, h * f);
      ctx.lineTo(w - pad, h * f);
      ctx.stroke();
    }
  }
  ctx.beginPath();
  values.forEach((v, i) => {
    const [x, y] = xy(i, v);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = opts.color ?? "#dedede";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  if (opts.fill !== false) {
    ctx.lineTo(w - pad, h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    ctx.fillStyle = "rgba(230,230,230,0.07)";
    ctx.fill();
  }
}
