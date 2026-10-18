import type { Network } from "../sim/types";

/** A small, static view of the actual study network. No renderer or map tiles needed. */
export function drawCorridorMap(canvas: HTMLCanvasElement, network: Network | undefined, edgeIds: string[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const edges = network ? [...network.edges.values()] : [];
  if (!edges.length) return;
  const selected = edges.filter((edge) => edgeIds.includes(edge.id));
  const focus = selected.length ? selected : edges;
  const xs = focus.flatMap((edge) => [edge.start.x, edge.end.x]);
  const ys = focus.flatMap((edge) => [edge.start.y, edge.end.y]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const extent = Math.max(220, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const scale = Math.min(width, height) / (extent * 1.6);
  const x = (value: number) => width / 2 + (value - cx) * scale;
  const y = (value: number) => height / 2 + (value - cy) * scale;
  ctx.strokeStyle = "#1c3040";
  ctx.lineWidth = .6;
  for (let i = 0; i < width; i += 24) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, height); ctx.stroke(); }
  for (let i = 0; i < height; i += 24) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(width, i); ctx.stroke(); }
  ctx.lineCap = "round";
  for (const edge of [...edges.filter((row) => !edgeIds.includes(row.id)), ...selected]) {
    const highlighted = edgeIds.includes(edge.id);
    ctx.strokeStyle = highlighted ? "#98e4cb" : "#405b6b";
    ctx.lineWidth = highlighted ? 3 : 1.3;
    ctx.beginPath(); ctx.moveTo(x(edge.start.x), y(edge.start.y)); ctx.lineTo(x(edge.end.x), y(edge.end.y)); ctx.stroke();
  }
  if (selected.length) {
    ctx.fillStyle = "#aaf3d9";
    for (const point of [selected[0].start, selected[0].end]) {
      ctx.beginPath(); ctx.arc(x(point.x), y(point.y), 3, 0, Math.PI * 2); ctx.fill();
    }
  }
}
