import * as THREE from "three";
import type { Chrome } from "../ui/chrome";
import type { SceneCtx } from "../render/scene";
import type { StudySelection } from "./context";
import { cityPoint, loadStudy, nearestSection, studySections, type Origin } from "./data";
import { selectedCorridor } from "../v03/corridors";

export async function mountStudyMap(ui: Chrome, scene: SceneCtx, origin: Origin, selection: StudySelection, signal: AbortSignal) {
  const panel = document.createElement("details"); panel.id = "study-picker";
  panel.innerHTML = `<summary>Study corridors <span>↗</span></summary><div class="study-picker-body"><label>Road section<select aria-label="Study road section"><option value="">Loading sections…</option></select></label><p role="status">Preparing the corridor study area…</p><div class="study-actions"><button data-action="area">Show study area</button><button data-action="pick" aria-pressed="false">Pick on map</button></div><div class="study-actions"><button data-action="intelligence" disabled>Inspect evidence</button><button data-action="lab" disabled>Compare signals</button></div></div>`;
  ui.hud.append(panel);
  const select = panel.querySelector("select")!, status = panel.querySelector("p")!;
  const button = (action: string) => panel.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
  const study = await loadStudy().catch((error) => {
    status.textContent = `Study area unavailable: ${error instanceof Error ? error.message : String(error)}`;
    const retry = document.createElement("button"); retry.textContent = "Retry study area";
    retry.onclick = () => { panel.remove(); void mountStudyMap(ui, scene, origin, selection, signal); };
    status.append(" ", retry); return null;
  });
  if (!study || signal.aborted) return;
  const sections = studySections(study);
  const projected = sections.map(({ edge }) => ({ id: edge.id, a: cityPoint(edge.start, study.origin, origin), b: cityPoint(edge.end, study.origin, origin) }));
  select.replaceChildren(new Option("Choose a road section", ""), ...sections.map(({ edge, measured }) => new Option(`${edge.name || "Unnamed road"} · ${Math.round(edge.length)} m${measured ? " · detector history" : ""}`, edge.id)));
  const material = new THREE.LineBasicMaterial({ color: 0x778b86, transparent: true, opacity: .65, depthTest: false });
  const all = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(projected.flatMap(({ a, b }) => [new THREE.Vector3(a.x, 3, a.z), new THREE.Vector3(b.x, 3, b.z)])), material);
  const highlight = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x84e1bd, depthTest: false }));
  all.visible = false; all.renderOrder = 10; highlight.renderOrder = 11; scene.scene.add(all, highlight);
  let picking = false;
  const focus = (id?: string | null) => {
    const edge = id ? study.network.edges.get(id) : null;
    const p = cityPoint(edge ? { x: (edge.start.x + edge.end.x) / 2, y: (edge.start.y + edge.end.y) / 2 } : { x: 0, y: 0 }, study.origin, origin);
    scene.flyTo(new THREE.Vector3(p.x, 0, p.z), edge ? Math.max(500, edge.length * 4) : 2300, 700);
  };
  const unsubscribe = selection.subscribe((id) => {
    const match = id ? selectedCorridor(study.network, id) : null;
    const canonical = match && sections.find(({ edge }) => match.edgeIds.includes(edge.id));
    select.value = canonical ? canonical.edge.id : "";
    button("intelligence").disabled = button("lab").disabled = !match;
    highlight.geometry.dispose();
    const edge = match ? study.network.edges.get(match.edgeIds[0])! : null;
    const points = edge ? [edge.start, edge.end].map((p) => cityPoint(p, study.origin, origin)).map((p) => new THREE.Vector3(p.x, 4, p.z)) : [];
    highlight.geometry = new THREE.BufferGeometry().setFromPoints(points); highlight.visible = !!edge;
    status.textContent = edge ? `${edge.name || "Selected road"} · ${Math.round(edge.length)} m. ${canonical?.measured ? "Detector history available." : "No matched observations; model comparison available."}`
      : id ? "This section is unavailable in the bundled study area." : "Select a section here or pick a highlighted road. Sections with detector history appear first.";
    if (id) panel.open = true;
  });
  select.onchange = () => { selection.select(select.value || null); focus(select.value); };
  panel.addEventListener("toggle", () => { all.visible = panel.open; });
  button("area").onclick = () => { focus(selection.id); };
  button("pick").onclick = () => {
    picking = !picking; button("pick").setAttribute("aria-pressed", String(picking));
    button("pick").textContent = picking ? "Done picking" : "Pick on map";
    if (picking) { focus(); status.textContent = "Click a highlighted study road. Drag to pan as usual."; }
  };
  button("intelligence").onclick = () => selection.open("intelligence");
  button("lab").onclick = () => selection.open("lab");
  let start = { x: 0, y: 0 };
  ui.sceneCanvas.addEventListener("pointerdown", (event) => { start = { x: event.clientX, y: event.clientY }; }, { signal });
  ui.sceneCanvas.addEventListener("pointerup", (event) => {
    if (!picking || !panel.open || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
    event.stopPropagation();
    const bounds = ui.sceneCanvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2), scene.camera);
    const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    const id = point && nearestSection(point, projected);
    if (id) selection.select(id);
    else status.textContent = "No study section here. Pick a highlighted road or use the road list.";
  }, { signal });
  signal.addEventListener("abort", () => { unsubscribe(); all.geometry.dispose(); material.dispose(); highlight.geometry.dispose(); highlight.material.dispose(); scene.scene.remove(all, highlight); }, { once: true });
}
