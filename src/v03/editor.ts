// In-browser network editor for v0.3.
//
// Lets the user click junctions/edges in the 3D scene to toggle signals, hide pads,
// add corridor connections, and remove corridors. Edits are persisted to localStorage
// as a NetworkOverrides object and re-applied on page load.

import * as THREE from "three";
import { buildTrafficLightMeshes } from "../render/lights";
import { buildNetworkMesh, roadEdgesForHit, type NetworkMesh } from "../render/network";
import type { World } from "../sim/world";
import {
  applyOverrides,
  clearOverrides as clearLocalOverrides,
  corridorKey,
  loadOverrides,
  MAX_PHASES,
  parseOverrides,
  saveOverrides,
  type NetworkOverrides,
} from "./overrides";
import { buildOsmNetwork } from "./osm";

export type EditorMode =
  | "off"
  | "toggle-signal"
  | "toggle-junction"
  | "connect"
  | "disconnect"
  | "cycle-phase"
  | "edit-road"
  | "group-nodes";

const NODE_MARKER_RADIUS = 3.0;
const HIGHLIGHT_BASE = 0xffffff;
const HIGHLIGHT_PRIMARY = 0x4cc2ff;
const HIGHLIGHT_REMOVE = 0xff7d6b;
const HIGHLIGHT_PHANTOM = 0xffd24a;

type LightBundle = ReturnType<typeof buildTrafficLightMeshes>;

interface EditorContext {
  world: World;
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  // The OSM XML — needed to re-parse from scratch when overrides change.
  osmXml: string;
  // Live render handles. The editor mutates these in place so the main render loop
  // dereferences the latest meshes after each rebuild.
  refs: {
    networkMesh: NetworkMesh;
    lightBundle: LightBundle;
  };
}

export interface Editor {
  mode: EditorMode;
  setMode(m: EditorMode): void;
  exportJSON(): string;
  importJSON(json: string): void;
  clearAll(): void;
}

export function createEditor(ctx: EditorContext): Editor {
  let overrides = loadOverrides();
  let persistenceFailed = false;

  let mode: EditorMode = "off";
  let firstSelected: string | null = null;
  let hoverNodeId: string | null = null;
  let nodeMarkers: THREE.Group | null = null;
  let highlightLine: THREE.Line | null = null;

  // Undo/redo stacks. Each entry is a deep clone of `overrides` taken before a
  // mutation, so undoing simply restores the previous snapshot. Capped at
  // HISTORY_LIMIT to keep memory bounded — older edits fall off the bottom of the
  // stack quietly. Cmd-Z pops undo and pushes the current state to redo; Cmd-Shift-Z
  // does the reverse. Any new edit clears the redo stack (standard semantics).
  const HISTORY_LIMIT = 50;
  const undoStack: NetworkOverrides[] = [];
  const redoStack: NetworkOverrides[] = [];
  function snapshot(): NetworkOverrides {
    return JSON.parse(JSON.stringify(overrides));
  }
  function pushHistory() {
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }
  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(snapshot());
    if (redoStack.length > HISTORY_LIMIT) redoStack.shift();
    overrides = undoStack.pop()!;
    persistenceFailed = !saveOverrides(overrides);
    rebuildSceneFromOsm();
    ctx.world.reset();
  }
  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(snapshot());
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    overrides = redoStack.pop()!;
    persistenceFailed = !saveOverrides(overrides);
    rebuildSceneFromOsm();
    ctx.world.reset();
  }

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  const panelEl = document.getElementById("editor-panel")!;
  const statusEl = document.getElementById("editor-status")!;
  const modeButtons: Record<EditorMode, HTMLButtonElement | null> = {
    off: document.getElementById("ed-mode-off") as HTMLButtonElement,
    "toggle-signal": document.getElementById("ed-mode-signal") as HTMLButtonElement,
    "toggle-junction": document.getElementById("ed-mode-junction") as HTMLButtonElement,
    connect: document.getElementById("ed-mode-connect") as HTMLButtonElement,
    disconnect: document.getElementById("ed-mode-disconnect") as HTMLButtonElement,
    "cycle-phase": document.getElementById("ed-mode-phase") as HTMLButtonElement,
    "edit-road": document.getElementById("ed-mode-road") as HTMLButtonElement,
    "group-nodes": document.getElementById("ed-mode-group") as HTMLButtonElement,
  };
  const exportBtn = document.getElementById("ed-export") as HTMLButtonElement;
  const importBtn = document.getElementById("ed-import") as HTMLButtonElement;
  const clearBtn = document.getElementById("ed-clear") as HTMLButtonElement;
  const importFile = document.getElementById("ed-import-file") as HTMLInputElement;

  // Road-edit popup (shown only while a road is being edited).
  const roadPopup = document.getElementById("road-edit-popup")!;
  const roadFwdInput = document.getElementById("rep-fwd") as HTMLInputElement;
  const roadBwdInput = document.getElementById("rep-bwd") as HTMLInputElement;
  const roadFlipBtn = document.getElementById("rep-flip") as HTMLButtonElement;
  const roadApplyBtn = document.getElementById("rep-apply") as HTMLButtonElement;
  const roadCancelBtn = document.getElementById("rep-cancel") as HTMLButtonElement;
  let editingCorridor: { key: string; a: string; b: string } | null = null;
  // While in group-nodes mode, the user accumulates a list of nodes via clicks. Enter
  // commits them into a new entry of overrides.nodeGroups; Esc clears.
  let pendingGroup: string[] = [];

  // ---------- Node-marker layer ---------------------------------------------------------------

  function rebuildNodeMarkers() {
    if (nodeMarkers) {
      ctx.scene.remove(nodeMarkers);
      disposeGroup(nodeMarkers);
      nodeMarkers = null;
    }
    const group = new THREE.Group();
    group.name = "editor-node-markers";
    const geo = new THREE.SphereGeometry(NODE_MARKER_RADIUS, 10, 8);
    for (const [nid, node] of ctx.world.net.nodes) {
      if (node.kind !== "intersection") continue;
      const mat = new THREE.MeshBasicMaterial({
        color: HIGHLIGHT_BASE,
        transparent: true,
        opacity: 0.55,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(node.position.x, 1.5, node.position.y);
      mesh.userData.nodeId = nid;
      group.add(mesh);
    }
    group.visible = mode !== "off";
    ctx.scene.add(group);
    nodeMarkers = group;
  }

  function disposeGroup(group: THREE.Group) {
    group.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m instanceof THREE.InstancedMesh) m.dispose();
      if (m.geometry) m.geometry.dispose();
      const mat = (c as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
  }

  function updateMarkerHighlights() {
    if (!nodeMarkers) return;
    const pendingSet = new Set(pendingGroup);
    for (const m of nodeMarkers.children) {
      const mat = (m as THREE.Mesh).material as THREE.MeshBasicMaterial;
      const nid = (m as THREE.Mesh).userData.nodeId as string;
      let color = HIGHLIGHT_BASE;
      let opacity = 0.45;
      if (pendingSet.has(nid)) {
        color = HIGHLIGHT_PHANTOM;
        opacity = 0.95;
      } else if (firstSelected === nid) {
        color = HIGHLIGHT_PHANTOM;
        opacity = 0.95;
      } else if (hoverNodeId === nid) {
        color = mode === "disconnect" ? HIGHLIGHT_REMOVE : HIGHLIGHT_PRIMARY;
        opacity = 0.85;
      }
      mat.color.setHex(color);
      mat.opacity = opacity;
    }
  }

  function clearPhantomEdge() {
    if (highlightLine) {
      ctx.scene.remove(highlightLine);
      (highlightLine.geometry as THREE.BufferGeometry).dispose();
      (highlightLine.material as THREE.Material).dispose();
      highlightLine = null;
    }
  }

  function updatePhantomEdge() {
    clearPhantomEdge();
    if (mode !== "connect" || !firstSelected || !hoverNodeId || firstSelected === hoverNodeId) {
      return;
    }
    const a = ctx.world.net.nodes.get(firstSelected);
    const b = ctx.world.net.nodes.get(hoverNodeId);
    if (!a || !b) return;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(a.position.x, 2, a.position.y),
      new THREE.Vector3(b.position.x, 2, b.position.y),
    ]);
    highlightLine = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: HIGHLIGHT_PHANTOM }),
    );
    ctx.scene.add(highlightLine);
  }

  // ---------- Pointer handling ----------------------------------------------------------------

  function updateMouse(event: PointerEvent) {
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pickNode(): string | null {
    if (!nodeMarkers) return null;
    raycaster.setFromCamera(mouse, ctx.camera);
    const hits = raycaster.intersectObjects(nodeMarkers.children, false);
    return hits.length > 0 ? (hits[0].object.userData.nodeId as string) : null;
  }

  function pickEdge(): string | null {
    raycaster.setFromCamera(mouse, ctx.camera);
    const hits = raycaster.intersectObject(ctx.refs.networkMesh.group, true);
    for (const h of hits) {
      const edgeIds = roadEdgesForHit(h);
      if (edgeIds.length > 0) return edgeIds[0];
    }
    return null;
  }

  // Pick the inbound edge for a cycle-phase click: try bulbs first (large, easy to
  // hit), then stop bars (thinner but at ground level — useful when bulbs are zoomed
  // off-screen). Both objects carry `userData.edgeId`.
  function pickPhaseTarget(): string | null {
    raycaster.setFromCamera(mouse, ctx.camera);
    const targets: THREE.Object3D[] = [
      ...ctx.refs.lightBundle.handles.map((h) => h.mesh),
      ...Array.from(ctx.refs.networkMesh.stopBarHandles.values()),
    ];
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    return (hits[0].object.userData.edgeId as string | undefined) ?? null;
  }

  function onPointerMove(event: PointerEvent) {
    if (mode === "off") return;
    updateMouse(event);
    const usesNodes =
      mode === "toggle-signal" || mode === "toggle-junction" || mode === "connect";
    hoverNodeId = usesNodes ? pickNode() : null;
    updateMarkerHighlights();
    updatePhantomEdge();
  }

  function onClick(event: PointerEvent) {
    if (mode === "off") return;
    if (event.button !== 0) return;
    updateMouse(event);
    if (mode === "disconnect") {
      const eid = pickEdge();
      if (eid) handleDisconnect(eid);
      return;
    }
    if (mode === "edit-road") {
      const eid = pickEdge();
      if (eid) openRoadPopup(eid, event);
      return;
    }
    if (mode === "cycle-phase") {
      const eid = pickPhaseTarget();
      if (eid) handleCyclePhase(eid);
      return;
    }
    const nid = pickNode();
    if (!nid) return;
    if (mode === "toggle-signal") handleToggleSignal(nid);
    else if (mode === "toggle-junction") handleToggleJunction(nid);
    else if (mode === "connect") handleConnect(nid);
    else if (mode === "group-nodes") handleGroupClick(nid);
  }

  function onContextMenu(event: MouseEvent) {
    if (mode === "connect" && firstSelected) {
      event.preventDefault();
      firstSelected = null;
      updateMarkerHighlights();
      updatePhantomEdge();
      updateStatus();
    }
  }

  // ---------- Edit handlers -------------------------------------------------------------------

  function handleToggleSignal(nid: string) {
    const node = ctx.world.net.nodes.get(nid);
    if (!node) return;
    const isSignaled = (node.phaseOf?.size ?? 0) > 0;
    pushHistory();
    overrides.signals[nid] = !isSignaled;
    persistAndRebuild();
  }

  function handleToggleJunction(nid: string) {
    const node = ctx.world.net.nodes.get(nid);
    if (!node) return;
    pushHistory();
    overrides.junctions[nid] = !node.isJunction;
    persistAndRebuild();
  }

  function handleConnect(nid: string) {
    if (!firstSelected) {
      firstSelected = nid;
      updateMarkerHighlights();
      updateStatus();
      return;
    }
    if (firstSelected === nid) {
      firstSelected = null;
      updateMarkerHighlights();
      updateStatus();
      return;
    }
    pushHistory();
    overrides.addedEdges.push({ from: firstSelected, to: nid, oneway: false });
    firstSelected = null;
    persistRebuildAndReset();
  }

  function handleDisconnect(edgeId: string) {
    // Remove both directions of the corridor — clicking a ribbon takes the whole road.
    const edge = ctx.world.net.edges.get(edgeId);
    if (!edge) return;
    const reverseId = `${edge.to}->${edge.from}`;
    pushHistory();
    overrides.addedEdges = overrides.addedEdges.filter(
      (added) => corridorKey(added.from, added.to) !== corridorKey(edge.from, edge.to),
    );
    if (!overrides.removedEdges.includes(edgeId)) overrides.removedEdges.push(edgeId);
    if (!overrides.removedEdges.includes(reverseId)) {
      overrides.removedEdges.push(reverseId);
    }
    persistRebuildAndReset();
  }

  function handleCyclePhase(edgeId: string) {
    const edge = ctx.world.net.edges.get(edgeId);
    if (!edge) return;
    const node = ctx.world.net.nodes.get(edge.to);
    if (!node || node.kind !== "intersection") return;
    if (!node.phaseOf || !node.phaseOf.has(edgeId)) return; // unsignaled approach — ignore
    const current = node.phaseOf.get(edgeId)!;
    const next = (current + 1) % MAX_PHASES;
    pushHistory();
    overrides.phaseAssignments[edgeId] = next;
    persistAndRebuild();
  }

  function openRoadPopup(edgeId: string, event: PointerEvent) {
    const edge = ctx.world.net.edges.get(edgeId);
    if (!edge) return;
    const a = edge.from < edge.to ? edge.from : edge.to;
    const b = edge.from < edge.to ? edge.to : edge.from;
    const fwdEdge = ctx.world.net.edges.get(`${a}->${b}`);
    const bwdEdge = ctx.world.net.edges.get(`${b}->${a}`);
    editingCorridor = { key: corridorKey(a, b), a, b };
    roadFwdInput.value = String(fwdEdge?.laneCount ?? 0);
    roadBwdInput.value = String(bwdEdge?.laneCount ?? 0);
    // Show the popup near the click. Clamp to viewport so it stays visible.
    const w = roadPopup.offsetWidth || 240;
    const h = roadPopup.offsetHeight || 160;
    const x = Math.min(window.innerWidth - w - 12, event.clientX + 12);
    const y = Math.min(window.innerHeight - h - 12, event.clientY + 12);
    roadPopup.style.left = `${x}px`;
    roadPopup.style.top = `${y}px`;
    roadPopup.classList.remove("hidden");
    roadFwdInput.focus();
  }

  function closeRoadPopup() {
    roadPopup.classList.add("hidden");
    editingCorridor = null;
  }

  function applyRoadEdit() {
    if (!editingCorridor) return;
    const fwd = clampLanes(parseInt(roadFwdInput.value, 10));
    const bwd = clampLanes(parseInt(roadBwdInput.value, 10));
    if (fwd === 0 && bwd === 0) {
      alert("At least one direction must have a lane count > 0.");
      return;
    }
    pushHistory();
    overrides.roadConfigs[editingCorridor.key] = { forwardLanes: fwd, backwardLanes: bwd };
    closeRoadPopup();
    persistRebuildAndReset();
  }

  function clampLanes(n: number): number {
    if (isNaN(n) || n < 0) return 0;
    if (n > 8) return 8;
    return Math.floor(n);
  }

  function handleGroupClick(nid: string) {
    const idx = pendingGroup.indexOf(nid);
    if (idx >= 0) pendingGroup.splice(idx, 1); // toggle off if already in pending
    else pendingGroup.push(nid);
    updateMarkerHighlights();
    updateStatus();
  }

  function commitPendingGroup() {
    if (pendingGroup.length < 2) return;
    pushHistory();
    overrides.nodeGroups.push([...pendingGroup]);
    pendingGroup = [];
    persistAndRebuild();
  }

  function cancelPendingGroup() {
    if (pendingGroup.length === 0) return;
    pendingGroup = [];
    updateMarkerHighlights();
    updateStatus();
  }

  // ---------- Scene rebuild -------------------------------------------------------------------

  function persistAndRebuild() {
    persistenceFailed = !saveOverrides(overrides);
    rebuildSceneFromOsm();
  }

  function rebuildSceneFromOsm() {
    // Re-parse OSM and re-apply overrides — this is simpler than reverting individual
    // mutations and keeps the post-edit network identical to a fresh page load.
    const summary = buildOsmNetwork(ctx.osmXml);
    applyOverrides(summary.network, overrides);
    ctx.world.swapNetwork(summary.network);

    ctx.scene.remove(ctx.refs.networkMesh.group);
    disposeGroup(ctx.refs.networkMesh.group);
    const newMesh = buildNetworkMesh(ctx.world.net);
    ctx.scene.add(newMesh.group);
    ctx.refs.networkMesh = newMesh;

    ctx.scene.remove(ctx.refs.lightBundle.group);
    disposeGroup(ctx.refs.lightBundle.group);
    ctx.refs.lightBundle = buildTrafficLightMeshes(ctx.world.net);
    ctx.scene.add(ctx.refs.lightBundle.group);

    rebuildNodeMarkers();
    updateMarkerHighlights();
    updateStatus();
  }

  // Edge edits invalidate active vehicle routes — drain the sim instead of trying to
  // reroute every car. Used by handleConnect/handleDisconnect.
  function persistRebuildAndReset() {
    persistAndRebuild();
    ctx.world.reset();
  }

  // ---------- Panel UI ------------------------------------------------------------------------

  function setMode(m: EditorMode) {
    mode = m;
    firstSelected = null;
    hoverNodeId = null;
    pendingGroup = [];
    closeRoadPopup();
    // Node markers are useful for any mode that operates on nodes (incl. grouping).
    const usesNodes =
      m === "toggle-signal" ||
      m === "toggle-junction" ||
      m === "connect" ||
      m === "group-nodes";
    if (!nodeMarkers && usesNodes) rebuildNodeMarkers();
    if (nodeMarkers) nodeMarkers.visible = usesNodes;
    if (!usesNodes && highlightLine) {
      clearPhantomEdge();
    }
    for (const [k, btn] of Object.entries(modeButtons)) {
      if (!btn) continue;
      btn.classList.toggle("active", k === m);
    }
    panelEl.classList.toggle("editing", m !== "off");
    updateMarkerHighlights();
    updateStatus();
  }

  function updateStatus() {
    const parts: string[] = [];
    if (mode === "off") parts.push("Edits paused.");
    else if (mode === "toggle-signal") parts.push("Click a node to toggle its signal.");
    else if (mode === "toggle-junction")
      parts.push("Click a node to show/hide its intersection pad.");
    else if (mode === "connect")
      parts.push(
        firstSelected ? "Click a second node to connect (right-click cancels)." : "Click the first node.",
      );
    else if (mode === "disconnect") parts.push("Click a road to remove it.");
    else if (mode === "cycle-phase")
      parts.push(`Click a bulb or stop bar to cycle its phase (0…${MAX_PHASES - 1}).`);
    else if (mode === "edit-road") parts.push("Click a road to edit lane counts + direction.");
    else if (mode === "group-nodes") {
      if (pendingGroup.length === 0)
        parts.push("Click junction nodes to add them to a signal group; Enter to save.");
      else
        parts.push(
          `${pendingGroup.length} node${pendingGroup.length === 1 ? "" : "s"} pending — Enter to save, Esc to cancel.`,
        );
    }
    const counts: string[] = [];
    const sigCount = Object.keys(overrides.signals).length;
    const junctionCount = Object.keys(overrides.junctions).length;
    const phaseCount = Object.keys(overrides.phaseAssignments).length;
    const roadCount = Object.keys(overrides.roadConfigs).length;
    if (sigCount) counts.push(`${sigCount} signal edits`);
    if (junctionCount) counts.push(`${junctionCount} pad edits`);
    if (phaseCount) counts.push(`${phaseCount} phase edits`);
    if (roadCount) counts.push(`${roadCount} road edits`);
    if (overrides.nodeGroups.length) counts.push(`${overrides.nodeGroups.length} groups`);
    if (overrides.removedEdges.length) counts.push(`${overrides.removedEdges.length} removals`);
    if (overrides.addedEdges.length) counts.push(`${overrides.addedEdges.length} additions`);
    if (counts.length) parts.push(`(${counts.join(", ")})`);
    if (undoStack.length || redoStack.length) {
      parts.push(`· ⌘Z ${undoStack.length}↶  ⇧⌘Z ${redoStack.length}↷`);
    }
    if (persistenceFailed) parts.push("Changes are only kept for this session. Export your edits before reloading.");
    statusEl.textContent = parts.join(" ");
  }

  // ---------- Wire up DOM events --------------------------------------------------------------

  modeButtons.off!.addEventListener("click", () => setMode("off"));
  modeButtons["toggle-signal"]!.addEventListener("click", () => setMode("toggle-signal"));
  modeButtons["toggle-junction"]!.addEventListener("click", () => setMode("toggle-junction"));
  modeButtons.connect!.addEventListener("click", () => setMode("connect"));
  modeButtons.disconnect!.addEventListener("click", () => setMode("disconnect"));
  modeButtons["cycle-phase"]!.addEventListener("click", () => setMode("cycle-phase"));
  modeButtons["edit-road"]!.addEventListener("click", () => setMode("edit-road"));
  modeButtons["group-nodes"]!.addEventListener("click", () => setMode("group-nodes"));

  // Road-edit popup buttons.
  roadApplyBtn.addEventListener("click", applyRoadEdit);
  roadCancelBtn.addEventListener("click", closeRoadPopup);
  roadFlipBtn.addEventListener("click", () => {
    const fwd = roadFwdInput.value;
    roadFwdInput.value = roadBwdInput.value;
    roadBwdInput.value = fwd;
  });

  exportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(overrides, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "rotterdam-overrides.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  importBtn.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error("Override file is too large (1 MB maximum)");
      const imported = parseOverrides(await file.text());
      pushHistory();
      overrides = imported;
      persistenceFailed = !saveOverrides(overrides);
      rebuildSceneFromOsm();
      ctx.world.reset();
    } catch (err) {
      alert(`Could not import overrides: ${(err as Error).message}`);
    } finally {
      importFile.value = "";
    }
  });

  clearBtn.addEventListener("click", () => {
    if (!confirm("Clear all network edits? Cmd-Z still undoes this.")) return;
    pushHistory();
    persistenceFailed = !clearLocalOverrides();
    overrides = {
      signals: {},
      junctions: {},
      phaseAssignments: {},
      removedEdges: [],
      addedEdges: [],
      roadConfigs: {},
      nodeGroups: [],
    };
    rebuildSceneFromOsm();
    ctx.world.reset();
  });

  ctx.renderer.domElement.addEventListener("pointermove", onPointerMove);
  ctx.renderer.domElement.addEventListener("pointerdown", onClick);
  ctx.renderer.domElement.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    const inInput = tag === "input" || tag === "textarea" || target?.isContentEditable;

    // Esc always wins: closes popup, cancels pending group, or exits edit mode.
    if (event.key === "Escape") {
      if (!roadPopup.classList.contains("hidden")) {
        closeRoadPopup();
        event.preventDefault();
        return;
      }
      if (mode === "group-nodes" && pendingGroup.length > 0) {
        cancelPendingGroup();
        return;
      }
      if (mode !== "off") {
        setMode("off");
        return;
      }
    }

    // Don't hijack other typing — let inputs receive Cmd-Z, etc., natively.
    if (inInput) return;

    // Enter commits a pending signal group while in group-nodes mode.
    if (event.key === "Enter" && mode === "group-nodes" && pendingGroup.length >= 2) {
      event.preventDefault();
      commitPendingGroup();
      return;
    }

    // Cmd-Z / Ctrl-Z (and Shift for redo)
    const cmd = event.metaKey || event.ctrlKey;
    if (cmd && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
  });

  setMode("off");
  updateStatus();

  // Initial node-marker build is deferred until the user enters a mode so the initial
  // page load stays fast. Likewise highlightLine only exists during a connect.
  return {
    get mode() {
      return mode;
    },
    setMode,
    exportJSON: () => JSON.stringify(overrides, null, 2),
    importJSON: (json: string) => {
      const imported = parseOverrides(json);
      pushHistory();
      overrides = imported;
      persistenceFailed = !saveOverrides(overrides);
      rebuildSceneFromOsm();
      ctx.world.reset();
    },
    clearAll: () => {
      persistenceFailed = !clearLocalOverrides();
      overrides = {
      signals: {},
      junctions: {},
      phaseAssignments: {},
      removedEdges: [],
      addedEdges: [],
      roadConfigs: {},
      nodeGroups: [],
    };
      rebuildSceneFromOsm();
      ctx.world.reset();
    },
  };
}

// Convenience re-exports so v0.3/main.ts can pull the editor and the override helpers
// from a single module.
export type { NetworkOverrides } from "./overrides";
export { applyOverrides, loadOverrides, saveOverrides } from "./overrides";
