// Application controller: pages, units, dock, markers, events — everything
// that reacts to user input and simulation telemetry.

import * as THREE from "three";
import type { Chrome } from "./chrome";
import { setMeter, barGlyphHTML } from "./chrome";
import type { SceneCtx, ScaleName } from "../render/scene";
import type { CityMeshes } from "../render/city";
import type { SignalsLayer, VehiclesLayer, CongestionLayer, NdwLayer } from "../render/dynamic";
import type { TransitLayer } from "../render/transit";
import { DroneViewer } from "../render/drone";
import type { CityData } from "../data/loader";
import type { MetricsMsg, WorkerToMain } from "../sim/protocol";
import { DISTRICTS, UNITS, TIMEZONE, type UnitDef } from "../config";
import { fmtClockAmPm, fmtSimClock, fmtSession, fmtInt, fmtTimestamp, drawSparkline, escapeHtml } from "./format";

interface UnitRuntime {
  def: UnitDef;
  x: number; // data coords (east)
  y: number; // north
  baseX: number;
  baseY: number;
  patrolPhase: number;
  power: number;
  sessionSec: number;
  signal: string;
  linkPct: number;
  status: UnitDef["status"];
  el: HTMLElement;
  tagEl: HTMLElement;
}

const SIGNAL_COLOR: Record<string, string> = { STRONG: "green", MODERATE: "amber", WEAK: "red", "NO LINK": "" };

export class App {
  page: "map" | "brief" | "setup" = "map";
  selected: UnitRuntime | null = null;
  // pan-away dismissal: arms once the camera target has been near the
  // selected unit, so a selection made from far away doesn't self-close
  private unitCardArmed = false;
  units: UnitRuntime[] = [];
  metrics: MetricsMsg | null = null;
  cityHistory: { active: number; speed: number; cong: number }[] = [];
  districtSpeedHist: number[][] = DISTRICTS.map(() => []);
  drone: DroneViewer;
  perfState: "loading" | "live" = "loading";
  perfProgress = 0;
  ucTab: "perf" | "health" = "perf";
  simSpeed = 1;
  paused = false;
  msgCount = 0;
  density = 5200;
  track: { kind: "agent" | "transit" | "liveTransit"; id: number; key?: string; label: string; missFrames: number } | null = null;
  lastFrame: { data: Float32Array; ids: Int32Array; speeds: Float32Array; count: number } | null = null;
  incidentEls: HTMLElement[] = [];
  incidentPts: { x: number; y: number }[] = [];
  clockMin = 8 * 60;
  // congestion history (fed by the worker's 10s heartbeat)
  private history: { t: number; clockMin: number; cong: Uint8Array }[] = [];
  private lastSnapAt = 0;
  replayIdx: number | null = null;
  private replayBar!: HTMLElement;
  private replayRange!: HTMLInputElement;
  private replayTime!: HTMLElement;
  private liveCong: Float32Array | null = null;
  stationIdx: number | null = null;
  private stationCard!: HTMLElement;
  private boardCard!: HTMLElement;
  /** station key whose departure board is open */
  private boardKey: string | null = null;
  private live: import("../data/live").LiveSnapshot | null = null;
  private liveFresh = true;
  // signal-program trial (A/B/C experiment)
  private trial: {
    stage: number;
    stageStartSim: number;
    acc: { n: number; speed: number; queued: number; thr: number; wait: number };
    results: { program: string; speed: number; queued: number; thr: number; wait: number }[];
  } | null = null;
  // street-intel spatial index (built lazily from graph geometry)
  private streetGrid: { cellOff: Int32Array; list: Int32Array; xy: Float32Array; edge: Uint32Array; minX: number; minY: number; nx: number; ny: number } | null = null;
  private hoverPx = { x: -1, y: -1 };
  private streetChip: HTMLElement;
  // tracked-target trail
  private trail: THREE.Line;
  private trailPts: number[] = [];

  constructor(
    public ui: Chrome,
    public scene: SceneCtx,
    public data: CityData,
    public meshes: CityMeshes,
    public layers: {
      signals: SignalsLayer;
      vehicles: VehiclesLayer;
      congestion: CongestionLayer;
      transit: TransitLayer;
      districtLines: THREE.LineSegments;
      ndwLayer: NdwLayer;
      airLayer?: import("../render/dynamic").AirLayer;
      fixesLayer?: import("../render/transit").LiveTransitLayer;
      stopsLayer?: import("../render/transit").LiveStopsLayer;
    },
    public worker: Worker
  ) {
    this.drone = new DroneViewer(ui.droneCanvas);

    this.streetChip = document.createElement("div");
    this.streetChip.id = "street-chip";
    ui.hud.appendChild(this.streetChip);

    this.stationCard = document.createElement("div");
    this.stationCard.id = "station-card";
    ui.hud.appendChild(this.stationCard);

    this.boardCard = document.createElement("div");
    this.boardCard.id = "board-card";
    ui.hud.appendChild(this.boardCard);
    this.boardCard.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("#board-close")) this.closeBoard();
    });

    // replay scrubber
    this.replayBar = document.createElement("div");
    this.replayBar.id = "replay-bar";
    this.replayBar.innerHTML = `
      <button id="rp-live">Live</button>
      <input id="rp-range" type="range" min="0" max="0" value="0" />
      <span id="rp-time">—</span>`;
    ui.hud.appendChild(this.replayBar);
    this.replayRange = this.replayBar.querySelector("#rp-range") as HTMLInputElement;
    this.replayTime = this.replayBar.querySelector("#rp-time") as HTMLElement;
    ui.mapTools.insertAdjacentHTML(
      "beforeend",
      `<div class="tool-gap"></div><button class="tool-btn" id="replay-btn" title="Congestion replay">${_replayIcon}</button>`
    );
    const replayBtn = ui.hud.querySelector("#replay-btn") as HTMLButtonElement;
    replayBtn.addEventListener("click", () => {
      const open = this.replayBar.classList.toggle("open");
      replayBtn.classList.toggle("on", open);
      if (open) {
        this.syncReplayRange(true);
        this.enterReplay(this.history.length - 1);
      } else {
        this.exitReplay();
      }
    });
    (this.replayBar.querySelector("#rp-live") as HTMLButtonElement).addEventListener("click", () => {
      this.replayBar.classList.remove("open");
      replayBtn.classList.remove("on");
      this.exitReplay();
    });
    this.replayRange.addEventListener("input", () => this.enterReplay(+this.replayRange.value));

    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(600 * 3), 3));
    trailGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(600 * 3), 3));
    trailGeo.setDrawRange(0, 0);
    this.trail = new THREE.Line(
      trailGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 6;
    scene.scene.add(this.trail);

    this.buildUnits();
    this.buildDistrictLabels();
    this.buildBriefPage();
    this.buildSetupPage();
    this.buildOverview();
    this.wire();
    this.restoreSettings();
    this.log("info", "UPLINK ESTABLISHED — SURVEILTRACK NODE 04 ONLINE");
    this.log("info", `CITY GRID LOADED — ${fmtInt(this.data.meta.counts.roadKm)} KM ROADWAY / ${fmtInt(this.data.meta.counts.signalsInventory)} SIGNAL UNITS`);
    this.selectUnit(this.units[0], false);
    setInterval(() => this.slowTick(), 1500);
    setInterval(() => this.flavorEvent(), 26000);
  }

  // ---------- units ----------
  districtLabels: HTMLElement[] = [];
  private buildDistrictLabels() {
    for (const b of this.data.districtBounds) {
      const el = document.createElement("div");
      el.className = "district-label";
      el.textContent = b.name.toUpperCase();
      this.ui.markers.appendChild(el);
      (el as unknown as { _x: number; _y: number })._x = b.labelX;
      (el as unknown as { _y: number })._y = b.labelY;
      this.districtLabels.push(el);
    }
  }

  private buildUnits() {
    const distByKey = new Map(this.data.meta.districts.map((d) => [d.key, d]));
    for (const def of UNITS) {
      const d = distByKey.get(def.district);
      if (!d) continue;
      const h = hash(def.id);
      const x = d.x + ((h % 1000) / 1000 - 0.5) * 900;
      const y = d.y + (((h >> 10) % 1000) / 1000 - 0.5) * 900;
      const el = document.createElement("div");
      el.className = `marker ${def.status !== "active" ? def.status : ""}`;
      el.innerHTML = `<div class="box"></div><div class="tag">${def.id}</div>`;
      this.ui.markers.appendChild(el);
      const unit: UnitRuntime = {
        def,
        x,
        y,
        baseX: x,
        baseY: y,
        patrolPhase: (h % 628) / 100,
        power: def.power,
        sessionSec: def.sessionMin * 60,
        signal: def.signal,
        linkPct: def.signal === "STRONG" ? 92 : def.signal === "MODERATE" ? 71 : def.signal === "WEAK" ? 38 : 0,
        status: def.status,
        el,
        tagEl: el.querySelector(".tag") as HTMLElement,
      };
      el.addEventListener("click", () => this.selectUnit(unit, true));
      this.units.push(unit);
    }
  }

  selectUnit(u: UnitRuntime, fly: boolean) {
    this.selected = u;
    this.unitCardArmed = false;
    this.units.forEach((x) => x.el.classList.toggle("sel", x === u));
    this.ui.unitChips.forEach((c) => c.classList.toggle("sel", c.dataset.unit === u.def.id));
    // phones: the card covers half the map — only open it on an explicit tap
    if (fly || !window.matchMedia("(max-width: 780px)").matches) this.ui.unitCard.classList.add("open");
    this.updateUnitCard();
    this.startPerfLoading();
    if (fly) this.scene.flyTo(new THREE.Vector3(u.x, 0, -u.y), Math.max(2600, Math.min(5200, this.scene.distance)), 1100);
    this.positionPerfCard();
  }

  /** Close the unit detail pop-up (the unit stays selected in the lists). */
  private dismissUnitCard() {
    this.ui.unitCard.classList.remove("open");
    this.ui.perfCard.classList.remove("open");
    this.unitCardArmed = false;
  }

  private updateUnitCard() {
    const u = this.selected;
    if (!u) return;
    const st = u.status;
    this.ui.ucChip.innerHTML = `<span class="dot ${st === "active" ? "green" : st === "inactive" ? "red" : "gray"}"></span>${st.toUpperCase()}`;
    this.ui.ucId.textContent = u.def.id;
    this.ui.ucPower.innerHTML = st === "disabled" ? `<span style="color:var(--text-faint)">OFFLINE</span>` : `${Math.round(u.power)}% ${barGlyphHTML(u.power / 100)}`;
    this.ui.ucSession.textContent = st === "disabled" ? "—" : fmtSession(u.sessionSec);
    const sigCls = SIGNAL_COLOR[u.signal];
    this.ui.ucSignal.className = `v ${sigCls}`;
    this.ui.ucSignal.innerHTML = `${u.signal} <span class="dot ${sigCls || "gray"}"></span>`;
  }

  private positionPerfCard() {
    const cardRect = this.ui.unitCard.getBoundingClientRect();
    const hudRect = this.ui.hud.getBoundingClientRect();
    this.ui.perfCard.style.top = `${cardRect.bottom - hudRect.top + 12}px`;
  }

  private startPerfLoading() {
    this.perfState = "loading";
    this.perfProgress = 0;
    this.ui.perfCard.classList.add("open");
    this.ui.perfLoading.style.display = "block";
    this.ui.perfLive.classList.remove("open");
    const captions = this.ucTab === "perf" ? "PREPARING PERFORMANCE DETAILS" : "RUNNING DIAGNOSTIC SWEEP";
    this.ui.perfCaption.innerHTML = `${captions}<span class="blink">…</span>`;
  }

  // ---------- wiring ----------
  private wire() {
    const ui = this.ui;

    // clock
    const tickClock = () => (ui.clock.textContent = fmtClockAmPm(new Date(), TIMEZONE));
    tickClock();
    setInterval(tickClock, 5000);

    // top nav
    ui.navBtns.forEach((b) =>
      b.addEventListener("click", () => this.setPage(b.dataset.page as typeof this.page))
    );

    // rail
    ui.rail.querySelectorAll<HTMLButtonElement>(".rail-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const k = b.dataset.rail;
        if (k === "units") this.setPage("map");
        else if (k === "menu") this.setPage("brief");
        else if (k === "prefs") this.setPage("setup");
        else if (k === "incidents") {
          this.setPage("map");
          this.setDock("messages");
        } else if (k === "integrity") {
          this.setPage("brief");
        } else if (k === "account") this.toast("info", "<b>OPERATOR</b> — A. NOORDERMEER · CLEARANCE L4");
        else if (k === "secure") this.toast("info", "SECURE FEEDS: <b>3 CHANNELS ENCRYPTED</b>");
        else if (k === "crowd") this.toast("info", "CROWD FLOW MODULE — <b>STANDBY</b>");
        else if (k === "comms") this.toast("info", "COMMS RELAY NOMINAL — LATENCY 41MS");
        ui.rail.querySelectorAll(".rail-btn").forEach((x) => x.classList.toggle("on", x === b));
      });
    });

    // scale switch
    ui.scaleBtns.forEach((b) =>
      b.addEventListener("click", () => {
        this.scene.setScale(b.dataset.scale as ScaleName);
        ui.scaleBtns.forEach((x) => x.classList.toggle("on", x === b));
      })
    );
    this.scene.onScaleChange = (s) => {
      ui.scaleBtns.forEach((x) => x.classList.toggle("on", x.dataset.scale === s));
    };

    // zoom / layers
    ui.zoomIn.addEventListener("click", () => this.scene.zoomBy(0.55));
    ui.zoomOut.addEventListener("click", () => this.scene.zoomBy(1.8));
    ui.layersBtn.addEventListener("click", () => {
      ui.layersPop.classList.toggle("open");
      ui.layersBtn.classList.toggle("on", ui.layersPop.classList.contains("open"));
    });
    ui.layerBoxes.forEach((box) =>
      box.addEventListener("change", () => {
        this.applyLayer(box.dataset.layer!, box.checked);
        this.persistLayerStates();
      })
    );

    // unit card tabs & details
    ui.ucTabPerf.addEventListener("click", () => this.setUcTab("perf"));
    ui.ucTabHealth.addEventListener("click", () => this.setUcTab("health"));
    ui.ucDetails.addEventListener("click", () =>
      this.toast("warn", "FULL DOSSIER RESTRICTED — <b>CLEARANCE L5 REQUIRED</b>")
    );

    // dock
    ui.dockTabs.forEach((b) => b.addEventListener("click", () => this.setDock(b.dataset.dock!)));
    ui.unitChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const u = this.units.find((x) => x.def.id === chip.dataset.unit);
        if (u) {
          this.setPage("map");
          this.selectUnit(u, true);
        }
      });
    });

    // strip scrollbar
    const strip = ui.unitStrip;
    const syncThumb = () => {
      const frac = strip.clientWidth / strip.scrollWidth;
      const w = Math.max(8, frac * 100);
      ui.stripThumb.style.width = `${w}%`;
      const maxScroll = strip.scrollWidth - strip.clientWidth;
      const p = maxScroll > 0 ? strip.scrollLeft / maxScroll : 0;
      ui.stripThumb.style.left = `${p * (100 - w)}%`;
    };
    strip.addEventListener("scroll", syncThumb);
    new ResizeObserver(syncThumb).observe(strip);
    ui.stripLeft.addEventListener("click", () => strip.scrollBy({ left: -320, behavior: "smooth" }));
    ui.stripRight.addEventListener("click", () => strip.scrollBy({ left: 320, behavior: "smooth" }));
    let dragging = false;
    let dragX = 0;
    let dragStart = 0;
    ui.stripThumb.addEventListener("pointerdown", (e) => {
      dragging = true;
      dragX = e.clientX;
      dragStart = strip.scrollLeft;
      ui.stripThumb.setPointerCapture(e.pointerId);
    });
    ui.stripThumb.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const track = ui.stripTrack.clientWidth;
      const ratio = strip.scrollWidth / track;
      strip.scrollLeft = dragStart + (e.clientX - dragX) * ratio;
    });
    ui.stripThumb.addEventListener("pointerup", () => (dragging = false));
    syncThumb();

    // worker messages
    this.worker.onmessage = (ev: MessageEvent<WorkerToMain>) => this.onWorker(ev.data);

    // click empty map: deselect · short click on an agent: acquire track
    let downX = 0;
    let downY = 0;
    this.ui.viewport.addEventListener("pointerdown", (e) => {
      if (e.target === this.scene.renderer.domElement) {
        ui.layersPop.classList.remove("open");
        ui.layersBtn.classList.remove("on");
        downX = e.clientX;
        downY = e.clientY;
      }
    });
    this.ui.viewport.addEventListener("pointerup", (e) => {
      if (e.target !== this.scene.renderer.domElement) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
      // a tap anywhere on the map dismisses the unit pop-up (unit chips and
      // cards sit above the canvas, so their taps never land here)
      this.dismissUnitCard();
      this.tryAcquireTrack(e.clientX, e.clientY);
    });
    this.ui.viewport.addEventListener("pointermove", (e) => {
      const rect = this.scene.renderer.domElement.getBoundingClientRect();
      this.hoverPx.x = e.clientX - rect.left;
      this.hoverPx.y = e.clientY - rect.top;
    });
    this.ui.viewport.addEventListener("pointerleave", () => {
      this.hoverPx.x = -1;
    });
    ui.trackRelease.addEventListener("click", () => this.releaseTrack("RELEASED BY OPERATOR"));
    ui.ucClose.addEventListener("click", () => this.dismissUnitCard());
    // fly-to links in the message log
    ui.msgList.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest?.(".msg-fly") as HTMLElement | null;
      if (!btn) return;
      const x = parseFloat(btn.dataset.x ?? "");
      const y = parseFloat(btn.dataset.y ?? "");
      if (Number.isNaN(x) || Number.isNaN(y)) return;
      this.setPage("map");
      this.scene.flyTo(new THREE.Vector3(x, 0, -y), Math.min(2600, Math.max(1200, this.scene.distance)), 1000);
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this.track) this.releaseTrack("RELEASED BY OPERATOR");
        else this.dismissUnitCard();
      }
    });
  }

  // ---------- target tracking ----------
  /** Screen-space nearest-agent pick: robust for pixel-sized moving targets. */
  private tryAcquireTrack(clientX: number, clientY: number) {
    if (this.page !== "map") return;
    const el = this.scene.renderer.domElement;
    const rect = el.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const RADIUS = 16;
    let best: { kind: "agent" | "transit" | "liveTransit"; id: number; key?: string; label: string } | null = null;
    let bd = RADIUS * RADIUS;

    // Station vs. real vehicle: whichever is actually nearer the cursor wins.
    //
    // A blanket station priority reads well but fails against the data: OVapi
    // reports metro positions at stop granularity, so a live train is nearly
    // always sitting on top of a station marker. Giving stations the right of
    // way made every metro in the city unclickable.
    const stops = this.layers.stopsLayer;
    const liveLayer = this.layers.fixesLayer;
    let stationHit = -1;
    let stationD2 = 14 * 14;
    if (stops?.points.visible && this.live?.departures) {
      for (let i = 0; i < stops.stations.length; i++) {
        const st = stops.stations[i];
        if (!this.scene.project(st.x, 6, st.z, this.tmpPt)) continue;
        const d = (this.tmpPt.x - cx) ** 2 + (this.tmpPt.y - cy) ** 2;
        if (d < stationD2) {
          stationD2 = d;
          stationHit = i;
        }
      }
    }
    let liveD2 = Infinity;
    if (liveLayer?.group.visible) {
      for (const v of liveLayer.vehicles) {
        if (v.kind !== 0 && v.kind !== 1) continue;
        if (!this.scene.project(v.x, 2, v.z, this.tmpPt)) continue;
        const d = (this.tmpPt.x - cx) ** 2 + (this.tmpPt.y - cy) ** 2;
        if (d < liveD2) liveD2 = d;
      }
    }
    // ties go to the station: it is the larger, stationary target, and the
    // board answers the more common question
    if (stationHit >= 0 && stationD2 <= liveD2) {
      this.openBoard(stops!.stations[stationHit].key);
      return;
    }

    // a precise click on a sensor diamond wins over nearby moving agents
    if (this.layers.ndwLayer.points.visible && this.data.ndw) {
      let bi = -1;
      let bd2 = 9 * 9;
      for (let i = 0; i < this.data.ndw.stations.length; i++) {
        const s = this.data.ndw.stations[i];
        if (!this.scene.project(s.x, 4, -s.y, this.tmpPt)) continue;
        const d = (this.tmpPt.x - cx) ** 2 + (this.tmpPt.y - cy) ** 2;
        if (d < bd2) {
          bd2 = d;
          bi = i;
        }
      }
      if (bi >= 0) {
        this.stationIdx = bi;
        this.renderStationCard();
        return;
      }
    }

    const v = this.layers.vehicles;
    const f = this.lastFrame;
    if (f && v.cars.mesh.visible) {
      const MODE_LABEL = ["VEH", "BIKE", "PED", "TRK"];
      const visibleByMode = [v.cars.mesh.visible, v.bikes.mesh.visible, v.peds.mesh.visible, v.trucks.mesh.visible];
      for (let i = 0; i < f.count; i++) {
        const k = f.data[i * 4 + 3];
        const mode = k >= 12 ? 3 : k >= 8 ? 2 : k >= 4 ? 1 : 0;
        if (!visibleByMode[mode]) continue;
        if (!this.scene.project(f.data[i * 4], 1, -f.data[i * 4 + 1], this.tmpPt)) continue;
        const d = (this.tmpPt.x - cx) ** 2 + (this.tmpPt.y - cy) ** 2;
        if (d < bd) {
          bd = d;
          const id = f.ids[i];
          best = { kind: "agent", id, label: `${MODE_LABEL[mode]}-${String(id).padStart(4, "0")}` };
        }
      }
    }
    const t = this.layers.transit;
    if (t.group.visible) {
      for (let i = 0; i < t.vehicles.length; i++) {
        const info = t.vehicleInfo(i);
        if (!info || !this.scene.project(info.x, 2, info.z, this.tmpPt)) continue;
        const d = (this.tmpPt.x - cx) ** 2 + (this.tmpPt.y - cy) ** 2;
        if (d < bd) {
          bd = d;
          best = { kind: "transit", id: i, label: info.label };
        }
      }
    }
    // real vehicles are pickable too, and win ties against the simulated fleet
    // at the same spot — if both are under the cursor, the real one is the one
    // worth locking onto
    const lt = this.layers.fixesLayer;
    if (lt?.group.visible) {
      for (let i = 0; i < lt.vehicles.length; i++) {
        const v = lt.vehicles[i];
        if (v.kind !== 0 && v.kind !== 1) continue; // trams and metros carry identity
        if (!this.scene.project(v.x, 2, v.z, this.tmpPt)) continue;
        const d = (this.tmpPt.x - cx) ** 2 + (this.tmpPt.y - cy) ** 2;
        if (d <= bd) {
          bd = d;
          best = { kind: "liveTransit", id: i, key: v.key, label: `${v.label} · LIVE` };
        }
      }
    }

    if (!best) {
      this.stationIdx = null;
      this.stationCard.classList.remove("open");
      return;
    }
    this.stationIdx = null;
    this.stationCard.classList.remove("open");
    this.closeBoard();
    this.track = { ...best, missFrames: 0 };
    this.trailPts.length = 0;
    this.trail.geometry.setDrawRange(0, 0);
    this.ui.trackChip.classList.add("on");
    this.log("ok", `TARGET ACQUIRED — ${best.label} UNDER CAMERA LOCK`);
  }

  // ---------- live departure boards ----------

  /** Hand the app the newest live snapshot; refreshes an open board in place. */
  setLive(snap: import("../data/live").LiveSnapshot, fresh: boolean) {
    this.live = snap;
    this.liveFresh = fresh;
    if (this.boardKey) this.renderBoard();
  }

  closeBoard() {
    this.boardKey = null;
    this.boardCard.classList.remove("open");
  }

  private openBoard(key: string) {
    this.boardKey = key;
    this.stationIdx = null;
    this.stationCard.classList.remove("open");
    this.renderBoard();
  }

  /**
   * The platform display: what is coming, when, and how late.
   *
   * Times are the timetable projected by each trip's live running delay, which
   * is exactly how a real board works. Rows fed by a live delay are marked; a
   * row still on the published schedule says so instead of implying a
   * measurement that does not exist. If the whole feed has gone stale the
   * board refuses to show times at all — a five-hour-old "due in 2 min" is
   * worse than an empty board.
   */
  private renderBoard() {
    const key = this.boardKey;
    const dep = this.live?.departures;
    if (!key || !dep) return;
    const stop = dep.stops[key];
    if (!stop) return;
    const rows = dep.dep[key] ?? [];
    // the snapshot fixed these countdowns at capture time, so age them
    const drift = Math.max(0, (Date.now() - Date.parse(dep.t)) / 1000);
    const KIND = ["TRAM", "METRO", "BUS", "TRAIN"];

    const body = !this.liveFresh
      ? `<div class="bd-stale">FEED STALE — ARRIVAL TIMES WITHHELD</div>`
      : rows.length === 0
        ? `<div class="bd-stale">NO SERVICES DUE</div>`
        : rows
            .map((r) => {
              const [line, kind, dest, secs, delay, isLive] = r;
              const due = secs - drift;
              const mins = Math.round(due / 60);
              const when = due < 30 ? "NOW" : mins < 1 ? "<1'" : `${mins}'`;
              const late = Math.round(delay / 60);
              const delayTxt =
                !isLive
                  ? `<span class="bd-sched" title="No live position for this trip yet — published timetable">SCHED</span>`
                  : late > 0
                    ? `<span class="bd-late">+${late}'</span>`
                    : late < 0
                      ? `<span class="bd-early">${late}'</span>`
                      : `<span class="bd-ontime">ON TIME</span>`;
              return `<div class="bd-row">
                <span class="bd-line k${kind}">${String(line).toUpperCase()}</span>
                <span class="bd-kind">${KIND[kind] ?? ""}</span>
                <span class="bd-dest">${escapeHtml(dest || "—")}</span>
                <span class="bd-when">${when}</span>
                ${delayTxt}
              </div>`;
            })
            .join("");

    this.boardCard.innerHTML = `
      <div class="bd-head">
        <div>
          <div class="bd-eyebrow">DEPARTURES</div>
          <div class="bd-name">${escapeHtml(stop[0])}</div>
        </div>
        <button id="board-close" aria-label="Close departure board">✕</button>
      </div>
      <div class="bd-rows">${body}</div>
      <div class="bd-foot">RET · OVAPI GTFS-RT + TIMETABLE · SNAPSHOT ${Math.round(drift)}S AGO</div>`;
    this.boardCard.classList.add("open");
  }

  renderStationCard() {
    const idx = this.stationIdx;
    const ndw = this.data.ndw;
    if (idx === null || !ndw) return;
    const s = ndw.stations[idx];
    const cal = this.metrics?.calibration;
    const simFlow = cal?.stationFlows[idx] ?? 0;
    const expected = cal ? s.flow * cal.demandNorm : 0;
    const rel = cal && cal.ratio > 0 && expected > 0 ? simFlow / expected / cal.ratio : 0;
    const relTxt =
      expected < 200
        ? `<span style="color:var(--text-faint)">LOW SIGNAL</span>`
        : rel < 0.45
          ? `<span style="color:var(--red)">${rel.toFixed(2)} — UNDER-REPRESENTED</span>`
          : rel > 1.8
            ? `<span style="color:var(--amber)">${rel.toFixed(2)} — OVER-REPRESENTED</span>`
            : `<span style="color:var(--green)">${rel.toFixed(2)} — PROPORTIONAL</span>`;
    const row = (k: string, v: string) =>
      `<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:var(--text-dim)">${k}</span><b>${v}</b></div>`;
    this.stationCard.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:7px">
        <span style="font-size:9px;letter-spacing:.16em;color:var(--text-faint)">NDW STATION</span>
        <button id="station-close" style="color:var(--text-dim);font-size:11px;padding:0 2px">✕</button>
      </div>
      <div style="font-weight:700;font-size:11.5px;margin-bottom:8px">${(s.name || "UNNAMED SITE").toUpperCase()}</div>
      ${row("MEASURED @ CAPTURE", `${fmtInt(s.flow)} VEH/H`)}
      ${row("EXPECTED NOW", cal ? `${fmtInt(expected)} VEH/H` : "—")}
      ${row("SIMULATED NOW", cal ? `${fmtInt(simFlow)} VEH/H` : "MEASURING…")}
      ${row("REL. INDEX", relTxt)}
      ${row("MEASURED SPEED", s.speed > 0 ? `${s.speed.toFixed(0)} KM/H` : "—")}
      ${row("LANES · CLASS", `${s.lanes} · ${App.CLASS_LABEL[s.cls] ?? "?"}`)}`;
    this.stationCard.classList.add("open");
    (this.stationCard.querySelector("#station-close") as HTMLButtonElement).addEventListener("click", () => {
      this.stationIdx = null;
      this.stationCard.classList.remove("open");
    });
  }

  releaseTrack(reason: string) {
    if (!this.track) return;
    this.log("info", `TRACK ${this.track.label} ENDED — ${reason}`);
    this.track = null;
    this.ui.trackChip.classList.remove("on");
    this.trailPts.length = 0;
    this.trail.geometry.setDrawRange(0, 0);
  }

  /** Position/speed of the tracked entity in world coords, or null if gone. */
  private trackState(): { x: number; z: number; speed: number } | null {
    const tr = this.track;
    if (!tr) return null;
    if (tr.kind === "transit") {
      const info = this.layers.transit.vehicleInfo(tr.id);
      return info ? { x: info.x, z: info.z, speed: info.speed } : null;
    }
    if (tr.kind === "liveTransit") {
      // vehicles[] is rebuilt on every snapshot, so re-find the train by its
      // trip identity — an index would silently start following a different
      // service the moment the fleet list reshuffles
      const cur = this.layers.fixesLayer?.vehicles.find((v) => v.key === tr.key);
      return cur ? { x: cur.x, z: cur.z, speed: 0 } : null;
    }
    const f = this.lastFrame;
    if (!f) return null;
    for (let i = 0; i < f.count; i++) {
      if (f.ids[i] === tr.id) {
        return { x: f.data[i * 4], z: -f.data[i * 4 + 1], speed: f.speeds[i] };
      }
    }
    return null;
  }

  setUcTab(t: "perf" | "health") {
    this.ucTab = t;
    this.ui.ucTabPerf.classList.toggle("on", t === "perf");
    this.ui.ucTabHealth.classList.toggle("on", t === "health");
    this.startPerfLoading();
  }

  setPage(p: typeof this.page) {
    this.page = p;
    this.ui.navBtns.forEach((b) => b.classList.toggle("on", b.dataset.page === p));
    this.ui.pageBrief.classList.toggle("on", p === "brief");
    this.ui.pageSetup.classList.toggle("on", p === "setup");
    const mapUi = p === "map";
    this.ui.markers.style.display = mapUi ? "" : "none";
    (this.ui.tether as unknown as HTMLElement).style.display = mapUi ? "" : "none";
    this.ui.unitCard.style.visibility = mapUi ? "visible" : "hidden";
    this.ui.perfCard.style.visibility = mapUi ? "visible" : "hidden";
    (document.getElementById("dock") as HTMLElement).style.display = mapUi ? "" : "none";
    (document.getElementById("scale-switch") as HTMLElement).style.display = mapUi ? "" : "none";
    (document.getElementById("map-tools") as HTMLElement).style.display = mapUi ? "" : "none";
    if (p === "brief") this.renderBrief();
  }

  setDock(name: string) {
    this.ui.dockTabs.forEach((b) => b.classList.toggle("on", b.dataset.dock === name));
    this.ui.dockPages.forEach((p) => p.classList.toggle("on", p.dataset.dockpage === name));
    if (name === "perf") this.renderDistrictTable();
    if (name === "stats") this.renderStats();
  }

  applyLayer(layer: string, on: boolean) {
    switch (layer) {
      case "buildings": this.meshes.buildings.visible = on; break;
      case "roads":
        this.meshes.roads.visible = on;
        this.meshes.roadLines.visible = on;
        this.meshes.junctions.visible = on;
        break;
      case "water": this.meshes.water.visible = on; break;
      case "rail": this.meshes.rail.visible = on; break;
      case "transit": this.layers.transit.group.visible = on; break;
      case "bounds":
        this.layers.districtLines.visible = on;
        this.districtLabels.forEach((l) => (l.style.display = on ? "" : "none"));
        break;
      case "sensors": this.layers.ndwLayer.points.visible = on; break;
      case "air": if (this.layers.airLayer) this.layers.airLayer.points.visible = on; break;
      case "fixes":
        // one control for the whole real-transit picture: the vehicles and the
        // stations they are running to
        if (this.layers.fixesLayer) this.layers.fixesLayer.group.visible = on;
        if (this.layers.stopsLayer) this.layers.stopsLayer.points.visible = on;
        if (!on) this.closeBoard();
        break;
      case "signals": this.layers.signals.points.visible = on; break;
      case "vehicles":
        this.layers.vehicles.cars.mesh.visible = on;
        this.layers.vehicles.trucks.mesh.visible = on;
        break;
      case "bikes": this.layers.vehicles.bikes.mesh.visible = on; break;
      case "pedestrians": this.layers.vehicles.peds.mesh.visible = on; break;
      case "congestion":
        this.layers.congestion.lines.visible = on;
        this.worker.postMessage({ type: "params", congestionFeed: on });
        break;
      case "labels":
        this.units.forEach((u) => (u.tagEl.style.display = on ? "" : "none"));
        break;
    }
  }

  // ---------- worker feed ----------
  private onWorker(msg: WorkerToMain) {
    switch (msg.type) {
      case "frame": {
        const data = new Float32Array(msg.vehicles);
        const ids = new Int32Array(msg.ids);
        const speeds = new Float32Array(msg.speeds);
        this.lastFrame = { data, ids, speeds, count: msg.count };
        this.clockMin = msg.clockMin;
        this.layers.vehicles.update(data, msg.count, this.scene.distance / 950, ids);
        this.layers.signals.update(new Uint8Array(msg.signals));
        break;
      }
      case "metrics": {
        this.metrics = msg;
        this.incidentPts = msg.incidentPts ?? [];
        this.trialTick(msg);
        if (msg.calibration && msg.calibration.ratio > 0) {
          this.layers.ndwLayer.update(msg.calibration.stationFlows, msg.calibration.demandNorm, msg.calibration.ratio);
          if (this.stationIdx !== null) this.renderStationCard();
        }
        this.cityHistory.push({ active: msg.active, speed: msg.avgSpeedKmh, cong: msg.congestionIndex });
        if (this.cityHistory.length > 900) this.cityHistory.shift();
        msg.districts.forEach((d, i) => {
          const h = this.districtSpeedHist[i];
          if (h) {
            h.push(d.speedKmh);
            if (h.length > 240) h.shift();
          }
        });
        break;
      }
      case "congestion": {
        const per = new Float32Array(msg.perEdge);
        this.liveCong = per;
        if (this.replayIdx === null) this.layers.congestion.update(per);
        const now = performance.now();
        if (now - this.lastSnapAt > 9500) {
          this.lastSnapAt = now;
          const q = new Uint8Array(per.length);
          for (let i = 0; i < per.length; i++) q[i] = Math.min(255, Math.round(per[i] * 255));
          this.history.push({ t: Date.now(), clockMin: this.clockMin, cong: q });
          if (this.history.length > 240) this.history.shift();
          if (this.replayIdx === null && this.replayBar.classList.contains("open")) this.syncReplayRange(false);
        }
        break;
      }
      case "event":
        this.log(msg.level, msg.text, msg.x !== undefined && msg.y !== undefined ? { x: msg.x, y: msg.y, live: msg.live } : undefined);
        if (msg.level === "crit" || msg.level === "warn") this.toast(msg.level, msg.text);
        break;
      case "ready":
        this.log("ok", `SIM CORE ONLINE — ${fmtInt(msg.laneKm)} LANE-KM UNDER CONTROL`);
        break;
    }
  }

  // ---------- per-frame ----------
  private tmpPt = { x: 0, y: 0 };
  private trackVec = new THREE.Vector3();
  frame(now: number) {
    // dismiss the unit card once the camera has visited the unit and then
    // moved well away from it (manual pan or a track driving off)
    if (this.selected && this.ui.unitCard.classList.contains("open")) {
      const u = this.selected;
      const t = this.scene.controls.target;
      const dist = Math.hypot(t.x - u.x, t.z - -u.y);
      const far = Math.max(700, this.scene.distance * 0.6);
      if (dist < far * 0.45) this.unitCardArmed = true;
      else if (this.unitCardArmed && dist > far) this.dismissUnitCard();
    }

    // camera lock on tracked target
    if (this.track && this.page === "map") {
      const st = this.trackState();
      if (!st) {
        this.track.missFrames++;
        if (this.track.missFrames > 20) {
          const label = this.track.label;
          this.releaseTrack("TARGET LOST");
          this.toast("warn", `TARGET LOST — <b>${label}</b> LEFT THE GRID`);
        }
      } else {
        this.track.missFrames = 0;
        this.trackVec.set(st.x, 0, st.z).sub(this.scene.controls.target).multiplyScalar(0.16);
        this.scene.controls.target.add(this.trackVec);
        this.scene.camera.position.add(this.trackVec);
        const zone = this.zoneName(st.x, -st.z);
        // GTFS-RT carries no speed for rail, so a real vehicle reports how old
        // its position fix is instead of a speed it never measured
        if (this.track.kind === "liveTransit") {
          const cur = this.layers.fixesLayer?.vehicles.find((v) => v.key === this.track!.key);
          const age = cur && cur.fixAge >= 0 ? `FIX ${cur.fixAge}S AGO` : "FIX AGE UNKNOWN";
          this.ui.trackLabel.textContent =
            `TRACKING ${this.track.label} · ${cur?.berthed ? "AT PLATFORM" : "IN TRANSIT"} · ${age} · ${zone}`;
        } else {
          this.ui.trackLabel.textContent = `TRACKING ${this.track.label} · ${(st.speed * 3.6).toFixed(0)} KM/H · ${zone}`;
        }

        // breadcrumb trail
        const tp = this.trailPts;
        const n = tp.length / 2;
        if (n === 0 || Math.hypot(st.x - tp[(n - 1) * 2], st.z - tp[(n - 1) * 2 + 1]) > 2.5) {
          tp.push(st.x, st.z);
          if (tp.length > 600 * 2) tp.splice(0, 2);
          const pos = this.trail.geometry.getAttribute("position") as THREE.BufferAttribute;
          const col = this.trail.geometry.getAttribute("color") as THREE.BufferAttribute;
          const m = tp.length / 2;
          for (let i = 0; i < m; i++) {
            pos.setXYZ(i, tp[i * 2], 1.6, tp[i * 2 + 1]);
            const t = Math.pow(i / Math.max(1, m - 1), 1.6);
            col.setXYZ(i, t, t * 0.72, t * 0.34);
          }
          pos.needsUpdate = true;
          col.needsUpdate = true;
          this.trail.geometry.setDrawRange(0, m);
        }
      }
    }

    // street-intel readout: tracked target's street, else the hovered street
    if (this.page === "map") {
      let text = "";
      if (this.track) {
        const st = this.trackState();
        if (st) {
          const e = this.nearestEdge(st.x, -st.z, 40);
          if (e >= 0) text = this.streetInfo(e);
        }
      } else if (this.hoverPx.x >= 0 && this.scene.distance < 8000) {
        const el = this.scene.renderer.domElement;
        const ndcX = (this.hoverPx.x / el.clientWidth) * 2 - 1;
        const ndcY = -(this.hoverPx.y / el.clientHeight) * 2 + 1;
        this.trackVec.set(ndcX, ndcY, 0.5).unproject(this.scene.camera).sub(this.scene.camera.position).normalize();
        if (this.trackVec.y < -0.05) {
          const t = -this.scene.camera.position.y / this.trackVec.y;
          const wx = this.scene.camera.position.x + this.trackVec.x * t;
          const wz = this.scene.camera.position.z + this.trackVec.z * t;
          const e = this.nearestEdge(wx, -wz, 26);
          if (e >= 0) text = this.streetInfo(e);
        }
      }
      this.streetChip.textContent = text;
      this.streetChip.style.display = text ? "" : "none";
    } else {
      this.streetChip.style.display = "none";
    }

    // incident markers
    if (this.page === "map") {
      while (this.incidentEls.length < this.incidentPts.length) {
        const el = document.createElement("div");
        el.className = "incident-marker";
        el.textContent = "✕";
        el.title = "Traffic incident — segment closed";
        const idx = this.incidentEls.length;
        el.addEventListener("click", () => {
          const p = this.incidentPts[idx];
          if (p) this.scene.flyTo(new THREE.Vector3(p.x, 0, -p.y), 1600, 900);
        });
        this.ui.markers.appendChild(el);
        this.incidentEls.push(el);
      }
      this.incidentEls.forEach((el, i) => {
        const p = this.incidentPts[i];
        if (!p) {
          el.style.display = "none";
          return;
        }
        const vis = this.scene.project(p.x, 6, -p.y, this.tmpPt);
        el.style.display = vis ? "" : "none";
        if (vis) el.style.transform = `translate(${this.tmpPt.x.toFixed(1)}px, ${this.tmpPt.y.toFixed(1)}px) translate(-50%, -50%)`;
      });
    }

    // district labels (city/district zoom only)
    if (this.page === "map") {
      const showLabels = this.scene.distance > 2300;
      const boundsOn = this.ui.layerBoxes.find((b) => b.dataset.layer === "bounds")?.checked ?? true;
      for (const el of this.districtLabels) {
        if (!showLabels || !boundsOn) {
          el.style.display = "none";
          continue;
        }
        const lx = (el as unknown as { _x: number })._x;
        const ly = (el as unknown as { _y: number })._y;
        const vis = this.scene.project(lx, 2, -ly, this.tmpPt);
        el.style.display = vis ? "" : "none";
        if (vis) el.style.transform = `translate(${this.tmpPt.x.toFixed(1)}px, ${this.tmpPt.y.toFixed(1)}px) translate(-50%, -50%)`;
      }
    }

    // markers (units patrol a slow orbit around their hold point)
    if (this.page === "map") {
      const tOrbit = now * 0.000045;
      for (const u of this.units) {
        if (u.status === "active") {
          u.x = u.baseX + Math.cos(tOrbit + u.patrolPhase) * 240;
          u.y = u.baseY + Math.sin(tOrbit * 0.83 + u.patrolPhase) * 240;
        }
        const visible = this.scene.project(u.x, 120, -u.y, this.tmpPt);
        u.el.style.display = visible ? "" : "none";
        if (visible) {
          u.el.style.transform = `translate(${this.tmpPt.x.toFixed(1)}px, ${this.tmpPt.y.toFixed(1)}px) translate(-50%, -50%)`;
        }
      }
      // tether from card to selected marker
      const line = this.ui.tether.querySelector("line")!;
      if (this.selected && this.ui.unitCard.classList.contains("open")) {
        const cr = this.ui.unitCard.getBoundingClientRect();
        const hr = this.ui.hud.getBoundingClientRect();
        const sel = this.selected;
        const vis = this.scene.project(sel.x, 120, -sel.y, this.tmpPt);
        if (vis) {
          line.setAttribute("x1", String(cr.right - hr.left));
          line.setAttribute("y1", String(cr.top - hr.top + 120));
          line.setAttribute("x2", String(this.tmpPt.x - 9));
          line.setAttribute("y2", String(this.tmpPt.y));
          line.style.display = "";
        } else line.style.display = "none";
      } else line.style.display = "none";
    }

    // drone viewer
    if (this.ui.unitCard.classList.contains("open") && this.page === "map") {
      this.drone.render(now);
    }

    // perf loading animation
    if (this.perfState === "loading" && this.page === "map") {
      this.perfProgress = Math.min(1, this.perfProgress + 0.011);
      setMeter(this.ui.perfBars, this.perfProgress);
      this.ui.perfPct.textContent = `${Math.round(this.perfProgress * 100)}%`;
      if (this.perfProgress >= 1) {
        this.perfState = "live";
        this.ui.perfLoading.style.display = "none";
        this.ui.perfLive.classList.add("open");
        this.renderPerfLive();
      }
    }
  }

  // ---------- slow tick (1.5s): unit drift, live panels ----------
  private slowTick() {
    for (const u of this.units) {
      if (u.status === "active") {
        u.sessionSec += 1.5;
        u.power = Math.max(4, u.power - 0.006);
        u.linkPct = Math.max(20, Math.min(97, u.linkPct + (Math.random() - 0.5) * 4));
        u.signal = u.linkPct > 80 ? "STRONG" : u.linkPct > 55 ? "MODERATE" : "WEAK";
      }
    }
    if (this.selected) this.updateUnitCard();
    if (this.perfState === "live") this.renderPerfLive();
    this.renderStats();
    this.renderDistrictTable();
    if (this.page === "brief") this.renderBrief();
    this.updateDockClock();
  }

  private updateDockClock() {
    const m = this.metrics;
    const el = document.getElementById("sim-clock-chip");
    if (el && m) el.textContent = `SIM ${fmtSimClock(m.clockMin)}`;
    // live calibration readout on the SETUP page
    const live = document.getElementById("su-ndw-live");
    if (live && m?.calibration) {
      const c = m.calibration;
      if (c.ratio > 0) {
        const n = 1 / c.ratio;
        live.innerHTML =
          `LIVE: SIM <b style="color:var(--text)">${fmtInt(c.simVehH)}</b> VS EXPECTED <b style="color:var(--text)">${fmtInt(c.realVehH)}</b> VEH/H · ` +
          `<b style="color:${c.ratio > 0.85 && c.ratio < 1.18 ? "var(--green)" : "var(--amber)"}">${(c.ratio * 100).toFixed(1)}%</b> — SCALE 1:${n.toFixed(1)}`;
      } else {
        live.textContent = "LIVE: MEASURING…";
      }
    }
  }

  // ---------- perf/health live panel ----------
  private renderPerfLive() {
    const u = this.selected;
    if (!u) return;
    const di = DISTRICTS.findIndex((d) => d.key === u.def.district);
    const dm = this.metrics?.districts[di];
    const dName = DISTRICTS[di]?.name?.toUpperCase() ?? "ZONE";
    if (this.ucTab === "perf") {
      this.ui.perfLiveTitle.textContent = `${dName} — FLOW TELEMETRY`;
      drawSparkline(this.ui.perfSpark, this.districtSpeedHist[di] ?? [], { min: 0 });
      const cong = dm ? Math.round(dm.congestion * 100) : 0;
      this.ui.perfGrid.innerHTML = `
        ${cell("TRACKS", dm ? fmtInt(dm.vehicles) : "—")}
        ${cell("MEAN SPEED", dm ? `${dm.speedKmh.toFixed(1)}<span class="u"> KM/H</span>` : "—")}
        ${cell("QUEUE", dm ? fmtInt(dm.queued) : "—")}
        ${cell("CONGESTION", `${cong}<span class="u">%</span>`, cong > 55 ? "var(--amber)" : cong > 75 ? "var(--red)" : undefined)}
      `;
    } else {
      this.ui.perfLiveTitle.textContent = `${u.def.id} — AIRFRAME HEALTH`;
      const hist = this.healthHist(u);
      drawSparkline(this.ui.perfSpark, hist, { min: 0, max: 100 });
      this.ui.perfGrid.innerHTML = `
        ${cell("BATTERY", u.status === "disabled" ? "—" : `${Math.round(u.power)}<span class="u">%</span>`)}
        ${cell("LINK", u.status === "disabled" ? "—" : `${Math.round(u.linkPct)}<span class="u">%</span>`)}
        ${cell("ROTOR TEMP", u.status === "disabled" ? "—" : `${(34 + (hash(u.def.id) % 90) / 10).toFixed(1)}<span class="u">°C</span>`)}
        ${cell("ALTITUDE", u.status === "disabled" ? "—" : `${u.def.alt}<span class="u"> M</span>`)}
      `;
    }
  }

  // ---------- infrastructure trial (signal-program A/B/C) ----------
  private static TRIAL_PROGRAMS: ("actuated" | "coordinated" | "fixed")[] = ["actuated", "coordinated", "fixed"];
  private static TRIAL_LABEL = { actuated: "ACTUATED", coordinated: "GREEN WAVE", fixed: "FIXED-TIME" };
  private static TRIAL_STAGE_SIM_S = 240; // 4 sim-minutes per program

  startTrial() {
    if (this.trial) {
      this.toast("warn", "TRIAL ALREADY RUNNING");
      return;
    }
    const first = App.TRIAL_PROGRAMS[0];
    this.worker.postMessage({ type: "params", signalProgram: first });
    this.trial = {
      stage: 0,
      stageStartSim: this.metrics?.simTime ?? 0,
      acc: { n: 0, speed: 0, queued: 0, thr: 0, wait: 0 },
      results: [],
    };
    this.log("info", `INFRASTRUCTURE TRIAL STARTED — 3 SIGNAL PROGRAMS × ${App.TRIAL_STAGE_SIM_S / 60} SIM-MIN (RAISE PHYSICS RATE TO SHORTEN)`);
    this.toast("info", "<b>SIGNAL TRIAL RUNNING</b> — STAGE 1/3: ACTUATED");
  }

  private trialTick(m: MetricsMsg) {
    const t = this.trial;
    if (!t) return;
    // skip the first 45 sim-s of each stage (transition wash-out)
    if (m.simTime - t.stageStartSim > 45) {
      t.acc.n++;
      t.acc.speed += m.avgSpeedKmh;
      t.acc.queued += m.queued;
      t.acc.thr += m.throughputMin;
      t.acc.wait += m.avgWaitSec;
    }
    if (m.simTime - t.stageStartSim < App.TRIAL_STAGE_SIM_S) return;
    // stage complete
    const program = App.TRIAL_PROGRAMS[t.stage];
    const n = Math.max(1, t.acc.n);
    t.results.push({
      program: App.TRIAL_LABEL[program],
      speed: t.acc.speed / n,
      queued: t.acc.queued / n,
      thr: t.acc.thr / n,
      wait: t.acc.wait / n,
    });
    t.stage++;
    if (t.stage < App.TRIAL_PROGRAMS.length) {
      const next = App.TRIAL_PROGRAMS[t.stage];
      this.worker.postMessage({ type: "params", signalProgram: next });
      t.stageStartSim = m.simTime;
      t.acc = { n: 0, speed: 0, queued: 0, thr: 0, wait: 0 };
      this.toast("info", `SIGNAL TRIAL — STAGE ${t.stage + 1}/3: ${App.TRIAL_LABEL[next]}`);
      return;
    }
    // trial finished: report and restore actuated
    for (const r of t.results) {
      this.log(
        "info",
        `TRIAL ${r.program}: ${r.speed.toFixed(1)} KM/H MEAN · ${Math.round(r.queued)} QUEUED · ${Math.round(r.thr)} TRIPS/MIN · WAIT ${r.wait.toFixed(0)}S`
      );
    }
    const best = [...t.results].sort((a, b) => b.speed - a.speed)[0];
    this.log("ok", `TRIAL VERDICT — ${best.program} DELIVERS BEST FLOW (${best.speed.toFixed(1)} KM/H NETWORK MEAN)`);
    this.toast("info", `<b>TRIAL COMPLETE</b> — ${best.program} WINS · SEE MESSAGES FOR THE COMPARISON`);
    this.worker.postMessage({ type: "params", signalProgram: "actuated" });
    this.trial = null;
    this.setDock("messages");
  }

  // ---------- congestion replay ----------
  private syncReplayRange(jumpToEnd: boolean) {
    this.replayRange.max = String(Math.max(0, this.history.length - 1));
    if (jumpToEnd) this.replayRange.value = this.replayRange.max;
  }

  private enterReplay(idx: number) {
    const snap = this.history[idx];
    if (!snap) {
      this.replayTime.textContent = "NO HISTORY YET";
      return;
    }
    const wasLive = this.replayIdx === null;
    this.replayIdx = idx;
    const per = new Float32Array(snap.cong.length);
    for (let i = 0; i < per.length; i++) per[i] = snap.cong[i] / 255;
    this.layers.congestion.lines.visible = true;
    this.layers.congestion.update(per);
    // freeze the live picture: historical flux only
    for (const m of this.layers.vehicles.meshes) m.visible = false;
    this.layers.signals.points.visible = false;
    this.layers.transit.group.visible = false;
    const ageMin = Math.round((Date.now() - snap.t) / 60000);
    this.replayTime.textContent = `SIM ${fmtSimClock(snap.clockMin)} · T−${ageMin} MIN`;
    if (wasLive) this.log("info", "FLUX REPLAY ENGAGED — HISTORICAL CONGESTION OVERLAY");
  }

  private exitReplay() {
    if (this.replayIdx === null) return;
    this.replayIdx = null;
    const on = (layer: string) =>
      this.ui.layerBoxes.find((b) => b.dataset.layer === layer)?.checked ?? true;
    this.layers.vehicles.cars.mesh.visible = on("vehicles");
    this.layers.vehicles.trucks.mesh.visible = on("vehicles");
    this.layers.vehicles.bikes.mesh.visible = on("bikes");
    this.layers.vehicles.peds.mesh.visible = on("pedestrians");
    this.layers.signals.points.visible = on("signals");
    this.layers.transit.group.visible = on("transit");
    this.layers.congestion.lines.visible = on("congestion");
    this.log("info", "FLUX REPLAY RELEASED — LIVE PICTURE RESTORED");
  }

  // ---------- street intelligence ----------
  private static CLASS_LABEL = ["MOTORWAY", "TRUNK", "PRIMARY", "SECONDARY", "TERTIARY", "STREET", "SERVICE", "PEDESTRIAN", "CYCLEWAY", "FOOTPATH"];

  private buildStreetGrid() {
    const g = this.data.graph;
    const CELL = 72;
    const ext = this.data.meta.extent;
    const minX = ext.minX, minY = ext.minY;
    const nx = Math.ceil((ext.maxX - minX) / CELL) + 1;
    const ny = Math.ceil((ext.maxY - minY) / CELL) + 1;
    // sample every 2nd geometry point per edge (plus endpoints)
    const xs: number[] = [];
    const ys: number[] = [];
    const es: number[] = [];
    for (let e = 0; e < g.edges.count; e++) {
      const off = g.edges.geoOff[e];
      const n = g.edges.geoCount[e];
      for (let k = 0; k < n; k += 2) {
        xs.push(g.geo[(off + k) * 2]);
        ys.push(g.geo[(off + k) * 2 + 1]);
        es.push(e);
      }
    }
    const cellOf = (x: number, y: number) =>
      Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / CELL))) * nx +
      Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / CELL)));
    const counts = new Int32Array(nx * ny + 1);
    for (let i = 0; i < xs.length; i++) counts[cellOf(xs[i], ys[i]) + 1]++;
    for (let i = 0; i < nx * ny; i++) counts[i + 1] += counts[i];
    const list = new Int32Array(xs.length);
    const cursor = counts.slice(0, nx * ny);
    for (let i = 0; i < xs.length; i++) list[cursor[cellOf(xs[i], ys[i])]++] = i;
    this.streetGrid = {
      cellOff: counts,
      list,
      xy: Float32Array.from(xs.flatMap((x, i) => [x, ys[i]])),
      edge: Uint32Array.from(es),
      minX,
      minY,
      nx,
      ny,
    };
  }

  /** Nearest routable edge to a data-coords point, within maxDist meters. */
  nearestEdge(x: number, y: number, maxDist = 30): number {
    if (!this.streetGrid) this.buildStreetGrid();
    const gr = this.streetGrid!;
    const CELL = 72;
    const cx = Math.floor((x - gr.minX) / CELL);
    const cy = Math.floor((y - gr.minY) / CELL);
    let best = -1;
    let bd = maxDist * maxDist;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx, gy = cy + dy;
        if (gx < 0 || gy < 0 || gx >= gr.nx || gy >= gr.ny) continue;
        const c = gy * gr.nx + gx;
        for (let i = gr.cellOff[c]; i < gr.cellOff[c + 1]; i++) {
          const s = gr.list[i];
          const d = (gr.xy[s * 2] - x) ** 2 + (gr.xy[s * 2 + 1] - y) ** 2;
          if (d < bd) {
            bd = d;
            best = gr.edge[s];
          }
        }
      }
    }
    return best;
  }

  streetInfo(edge: number): string {
    const g = this.data.graph;
    const name = g.names[g.edges.nameIdx[edge]] ?? "UNKNOWN";
    const cls = App.CLASS_LABEL[g.edges.cls[edge]] ?? "";
    const speed = g.edges.speed[edge];
    const district = DISTRICTS[g.edges.district[edge]]?.name ?? "";
    const speedPart = g.edges.cls[edge] <= 6 ? ` · ${speed} KM/H` : "";
    let flux = "";
    if (this.liveCong && g.edges.cls[edge] <= 6 && edge < this.liveCong.length) {
      flux = ` · FLUX ${Math.round(this.liveCong[edge] * 100)}%`;
    }
    return `${name.toUpperCase()} · ${cls}${speedPart}${flux} · ${district.toUpperCase()}`;
  }

  private zoneName(x: number, y: number): string {
    let best = "";
    let bd = Infinity;
    for (const d of this.data.meta.districts) {
      const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (dd < bd) {
        bd = dd;
        best = d.name;
      }
    }
    return best.toUpperCase();
  }

  private healthHistCache = new Map<string, number[]>();
  private healthHist(u: UnitRuntime): number[] {
    let h = this.healthHistCache.get(u.def.id);
    if (!h) {
      h = [];
      this.healthHistCache.set(u.def.id, h);
    }
    h.push(u.linkPct);
    if (h.length > 120) h.shift();
    return h;
  }

  // ---------- dock: stats ----------
  private renderStats() {
    const m = this.metrics;
    if (!m || !this.ui.statsRow.isConnected) return;
    const cards: [string, string, string?][] = [
      ["Active tracks", fmtInt(m.active), `PEAK TARGET ${fmtInt(this.density)}`],
      ["Freight", fmtInt(m.trucks)],
      ["Bike tracks", fmtInt(m.bikes)],
      ["Pedestrians", fmtInt(m.walkers)],
      ["Transit units", fmtInt(this.layers.transit.vehicleCount), `${fmtInt(this.data.transit.length)} ROUTES`],
      ["Flow rate", `${fmtInt(m.throughputMin)}<span class="u"> TRIPS/MIN</span>`],
      ["Mean speed", `${m.avgSpeedKmh.toFixed(1)}<span class="u"> KM/H</span>`],
      ["Queued", fmtInt(m.queued), `${((m.queued / Math.max(1, m.active)) * 100).toFixed(0)}% OF TRACKS`],
      ["Signals green", fmtInt(m.greensNow), `OF ${fmtInt(this.data.meta.counts.signalsInventory)} HEADS`],
      ["Congestion idx", `${Math.round(m.congestionIndex * 100)}<span class="u">%</span>`],
      ["Incidents", fmtInt(m.incidents)],
      ...(m.calibration && m.calibration.ratio > 0
        ? [["NDW match", `${(m.calibration.ratio * 100).toFixed(0)}<span class="u">%</span>`, `${fmtInt(m.calibration.stations)} STATIONS · 1:${(1 / m.calibration.ratio).toFixed(1)}`] as [string, string, string]]
        : []),
      ["Sim clock", fmtSimClock(m.clockMin), `DAY COMPRESSION 72×`],
      ["Completed trips", fmtInt(m.completed)],
    ];
    const SPARKS: Record<string, () => number[]> = {
      "Active tracks": () => this.cityHistory.map((h) => h.active),
      "Mean speed": () => this.cityHistory.map((h) => h.speed),
      "Congestion idx": () => this.cityHistory.map((h) => h.cong),
    };
    this.ui.statsRow.innerHTML = cards
      .map(
        ([k, v, s]) =>
          `<div class="stat-card"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}${
            SPARKS[k] ? `<canvas class="stat-spark" data-spark="${k}"></canvas>` : ""
          }</div>`
      )
      .join("");
    this.ui.statsRow.querySelectorAll<HTMLCanvasElement>("canvas[data-spark]").forEach((cv) => {
      const series = SPARKS[cv.dataset.spark!]?.().slice(-160) ?? [];
      if (series.length > 2) drawSparkline(cv, series, { min: 0, grid: false });
    });
  }

  // ---------- dock: district table ----------
  private renderDistrictTable() {
    const m = this.metrics;
    const wrap = this.ui.districtTableWrap;
    if (!m || !wrap.closest(".dock-page")?.classList.contains("on")) return;
    const rows = m.districts
      .map((d, i) => ({ d, i }))
      .sort((a, b) => b.d.vehicles - a.d.vehicles);
    wrap.innerHTML = `<table class="district">
      <thead><tr><th>District</th><th>Tracks</th><th>Mean speed</th><th>Queue</th><th>Congestion</th><th>Status</th></tr></thead>
      <tbody>${rows
        .map(({ d, i }) => {
          const c = Math.round(d.congestion * 100);
          const cls = c > 65 ? "crit" : c > 40 ? "warn" : "";
          const status = c > 65 ? `<span style="color:var(--red)">CRITICAL</span>` : c > 40 ? `<span style="color:var(--amber)">ELEVATED</span>` : "NOMINAL";
          return `<tr><td>${DISTRICTS[i].name}</td><td>${fmtInt(d.vehicles)}</td><td>${d.speedKmh.toFixed(1)} km/h</td><td>${fmtInt(d.queued)}</td>
          <td><span class="cong-bar ${cls}"><i style="width:${Math.min(100, c)}%"></i></span> <span style="color:var(--text-faint);font-size:9px">${c}%</span></td><td>${status}</td></tr>`;
        })
        .join("")}</tbody></table>`;
  }

  // ---------- dock: overview ----------
  private buildOverview() {
    const c = this.data.meta.counts;
    const line = (k: string, v: string) => `<div class="ov-line"><span>${k}</span><b>${v}</b></div>`;
    this.ui.overviewPage.innerHTML = `
      <div class="ov-col">
        <div class="ov-title">Coverage — Rotterdam, NL</div>
        ${line("Roadway mapped", `${fmtInt(c.roadKm)} km`)}
        ${line("Cycle & foot paths", `${fmtInt(c.pathKm ?? 0)} km`)}
        ${line("Routable edges", fmtInt(c.graphEdges))}
        ${line("Graph nodes", fmtInt(c.graphNodes))}
      </div>
      <div class="ov-col">
        <div class="ov-title">Signal inventory</div>
        ${line("Signal heads", fmtInt(c.signalsInventory))}
        ${line("On drive network", fmtInt(c.signalsOnNetwork))}
        ${line("Controlled junctions", fmtInt(c.junctions))}
        ${line("Standalone crossings", fmtInt(c.crossings))}
      </div>
      <div class="ov-col">
        <div class="ov-title">Structures & hydro</div>
        ${line("Structures", fmtInt(c.buildings))}
        ${line("Hydro polygons", fmtInt(c.waterPolys))}
        ${line("Transit routes", fmtInt(this.data.transit.length))}
        ${line("NDW sensor stations", fmtInt(this.data.ndw?.stations.length ?? 0))}
      </div>
      <div class="ov-col">
        <div class="ov-title">Fleet</div>
        ${line("Units deployed", fmtInt(this.units.length))}
        ${line("Active", fmtInt(this.units.filter((u) => u.status === "active").length))}
        ${line("Inactive", fmtInt(this.units.filter((u) => u.status === "inactive").length))}
        ${line("Disabled", fmtInt(this.units.filter((u) => u.status === "disabled").length))}
      </div>
      <div class="ov-col">
        <div class="ov-title">Engine</div>
        ${line("Model", "IDM + FIFO lanes")}
        ${line("Modes", "Car · bike · foot")}
        ${line("Signal control", "Fixed-time 2-phase")}
        ${line("Routing", "A* time-cost")}
      </div>`;
  }

  // ---------- messages ----------
  log(level: "info" | "warn" | "crit" | "ok", text: string, loc?: { x: number; y: number; live?: boolean }) {
    const el = document.createElement("div");
    el.className = "msg";
    let links = "";
    if (loc) {
      // fly the camera to where it happened; live events also link the real
      // location on OpenStreetMap (the NDW feed has no per-incident page)
      links = ` <button class="msg-fly" data-x="${loc.x.toFixed(1)}" data-y="${loc.y.toFixed(1)}">◎ VIEW</button>`;
      if (loc.live) {
        const org = this.data.meta.origin;
        const lat = org.lat + loc.y / 110574;
        const lon = org.lon + loc.x / (111320 * Math.cos((org.lat * Math.PI) / 180));
        links += ` <a class="msg-src" href="https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=17/${lat.toFixed(5)}/${lon.toFixed(5)}" target="_blank" rel="noopener">MAP ↗</a>`;
      }
    }
    el.innerHTML = `<span class="t">${fmtTimestamp(new Date(), TIMEZONE)}</span><span class="lvl ${level}">${level.toUpperCase()}</span><span>${text}${links}</span>`;
    this.ui.msgList.prepend(el);
    while (this.ui.msgList.children.length > 220) this.ui.msgList.lastChild?.remove();
    this.msgCount++;
  }

  toast(level: "info" | "warn" | "crit", html: string) {
    const el = document.createElement("div");
    el.className = `toast ${level}`;
    el.innerHTML = html;
    this.ui.toasts.appendChild(el);
    while (this.ui.toasts.children.length > 3) this.ui.toasts.firstChild?.remove();
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 400ms";
      setTimeout(() => el.remove(), 420);
    }, 5200);
  }

  private flavorEvent() {
    const active = this.units.filter((u) => u.status === "active");
    if (!active.length) return;
    const u = active[Math.floor(Math.random() * active.length)];
    const msgs = [
      `${u.def.id}: OPTICAL SWEEP COMPLETE — SECTOR ${(hash(u.def.id + Date.now()) % 20) + 1}`,
      `${u.def.id}: LINK ${Math.round(u.linkPct)}% — ${u.signal}`,
      `${u.def.id}: HOLDING PATTERN OVER ${DISTRICTS.find((d) => d.key === u.def.district)?.name.toUpperCase()}`,
      `${u.def.id}: THERMAL ARRAY RECALIBRATED`,
      `${u.def.id}: FRAME BUFFER SYNCED — ${940 + (hash(u.def.id) % 50)} MB`,
    ];
    this.log("info", msgs[Math.floor(Math.random() * msgs.length)]);
  }

  // ---------- BRIEF ----------
  private buildBriefPage() {
    this.ui.pageBrief.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <h1>Intelligence Brief</h1>
          <div class="sub">ROTTERDAM METRO AREA — LIVE TRAFFIC POSTURE &amp; NETWORK INTEGRITY</div>
        </div>
        <button class="action-btn" id="brief-sitrep">Copy SITREP</button>
      </div>
      <div id="brief-grid"></div>
      <div id="brief-cols">
        <div class="panel">
          <div class="p-title">City flow — mean speed / active tracks</div>
          <canvas id="brief-chart-canvas"></canvas>
          <div style="display:flex;gap:18px;margin-top:8px;font-size:9px;color:var(--text-faint);letter-spacing:.12em">
            <span>— MEAN SPEED</span><span style="color:#666">— ACTIVE TRACKS (SCALED)</span>
          </div>
        </div>
        <div class="panel">
          <div class="p-title">Event feed</div>
          <div id="brief-events"></div>
        </div>
      </div>
      <div style="height:12px"></div>
      <div class="panel">
        <div class="p-title">District posture</div>
        <div id="brief-districts" style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px 22px"></div>
      </div>`;
    (this.ui.pageBrief.querySelector("#brief-sitrep") as HTMLButtonElement).addEventListener("click", () =>
      this.copySitrep()
    );
  }

  private copySitrep() {
    const m = this.metrics;
    if (!m) {
      this.toast("warn", "SITREP UNAVAILABLE — SIM WARMING UP");
      return;
    }
    const c = this.data.meta.counts;
    const cal = m.calibration;
    const topDistricts = m.districts
      .map((d, i) => ({ name: DISTRICTS[i].name, cong: d.congestion }))
      .sort((a, b) => b.cong - a.cong)
      .slice(0, 3)
      .map((d) => `${d.name} ${(d.cong * 100).toFixed(0)}%`)
      .join(" · ");
    const lines = [
      `SURVEILTRACK SITREP — ROTTERDAM, NL`,
      `${new Date().toISOString().slice(0, 16).replace("T", " ")}Z · SIM CLOCK ${fmtSimClock(m.clockMin)}`,
      `─────────────────────────────────────`,
      `TRACKS    ${fmtInt(m.active)} cars · ${fmtInt(m.trucks)} freight · ${fmtInt(m.bikes)} bikes · ${fmtInt(m.walkers)} pedestrians · ${fmtInt(this.layers.transit.vehicleCount)} transit`,
      `FLOW      ${fmtInt(m.throughputMin)} trips/min · mean ${m.avgSpeedKmh.toFixed(1)} km/h · ${fmtInt(m.queued)} queued (${((m.queued / Math.max(1, m.active)) * 100).toFixed(0)}%)`,
      `SIGNALS   ${fmtInt(m.greensNow)}/${fmtInt(c.signalsInventory)} heads green · ${fmtInt(c.junctions)} junctions under control`,
      cal && cal.ratio > 0
        ? `CALIB     ${(cal.ratio * 100).toFixed(1)}% of NDW measured flow · scale 1:${(1 / cal.ratio).toFixed(1)} · ${fmtInt(cal.stations)} stations`
        : `CALIB     no sensor lock`,
      `CONGEST   index ${(m.congestionIndex * 100).toFixed(0)}% · hottest: ${topDistricts}`,
      `INCIDENTS ${fmtInt(m.incidents)} active`,
      `GRID      ${fmtInt(c.roadKm)} km road · ${fmtInt(c.pathKm)} km paths · ${fmtInt(c.buildings)} structures`,
    ];
    const text = lines.join("\n");
    navigator.clipboard
      ?.writeText(text)
      .then(() => this.toast("info", "<b>SITREP COPIED</b> TO CLIPBOARD"))
      .catch(() => this.toast("warn", "CLIPBOARD BLOCKED — SITREP LOGGED TO MESSAGES"));
    for (const l of lines) this.log("info", l);
  }

  private renderBrief() {
    const m = this.metrics;
    const c = this.data.meta.counts;
    const grid = document.getElementById("brief-grid")!;
    const kpi = (k: string, v: string, s?: string) =>
      `<div class="panel kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s ?? ""}</div></div>`;
    grid.innerHTML = [
      kpi("Active tracks", m ? fmtInt(m.active) : "—", m ? `${fmtInt(m.bikes)} BIKES · ${fmtInt(m.walkers)} PEDS · ${fmtInt(this.layers.transit.vehicleCount)} TRANSIT` : ""),
      kpi("Network speed", m ? `${m.avgSpeedKmh.toFixed(1)}<span class="u"> KM/H</span>` : "—", m ? `${fmtInt(m.queued)} QUEUED` : ""),
      kpi("Congestion index", m ? `${Math.round(m.congestionIndex * 100)}<span class="u">%</span>` : "—", m && m.congestionIndex > 0.4 ? "ELEVATED" : "NOMINAL"),
      kpi("Signal grid", `${fmtInt(c.signalsInventory)}`, `${fmtInt(c.junctions)} JUNCTIONS · ${m ? fmtInt(m.greensNow) : "—"} GREEN`),
    ].join("");

    // chart
    const canvas = document.getElementById("brief-chart-canvas") as HTMLCanvasElement;
    const hist = this.cityHistory;
    if (canvas && hist.length > 2) {
      const dpr = Math.min(devicePixelRatio, 2);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      for (const f of [0.25, 0.5, 0.75]) {
        ctx.beginPath(); ctx.moveTo(0, h * f); ctx.lineTo(w, h * f); ctx.stroke();
      }
      const draw = (vals: number[], max: number, color: string) => {
        ctx.beginPath();
        vals.forEach((v, i) => {
          const x = (i / (vals.length - 1)) * w;
          const y = h - 3 - (Math.min(v, max) / max) * (h - 8);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke();
      };
      draw(hist.map((x) => x.speed), 60, "#dedede");
      draw(hist.map((x) => x.active), Math.max(2000, ...hist.map((x) => x.active)) * 1.15, "#666");
    }

    // events into brief
    const evWrap = document.getElementById("brief-events")!;
    evWrap.innerHTML = "";
    Array.from(this.ui.msgList.children)
      .slice(0, 9)
      .forEach((n) => evWrap.appendChild(n.cloneNode(true)));

    // districts posture
    const dWrap = document.getElementById("brief-districts")!;
    if (m) {
      dWrap.innerHTML = m.districts
        .map((d, i) => {
          const cg = Math.round(d.congestion * 100);
          const cls = cg > 65 ? "crit" : cg > 40 ? "warn" : "";
          return `<div style="display:flex;flex-direction:column;gap:3px">
            <div style="display:flex;justify-content:space-between;font-size:9.5px;color:var(--text-dim)"><span>${DISTRICTS[i].name.toUpperCase()}</span><span>${cg}%</span></div>
            <span class="cong-bar ${cls}" style="width:100%"><i style="width:${Math.min(100, cg)}%"></i></span>
          </div>`;
        })
        .join("");
    }
  }

  // ---------- SETUP ----------
  private buildSetupPage() {
    const p = this.ui.pageSetup;
    p.innerHTML = `
      <h1>Setup</h1>
      <div class="sub">SIMULATION CORE · OBSERVATION GRID · SYSTEM</div>
      <div id="setup-grid">
        <div class="panel">
          <div class="p-title">Simulation core</div>
          <div class="field"><div class="f-label"><span>Fleet density (peak)</span><b id="su-dens-v">5,200</b></div>
            <input id="su-dens" type="range" min="600" max="12000" step="200" value="5200"></div>
          <div class="field"><div class="f-label"><span>Physics rate</span></div>
            <div class="seg" id="su-speed">
              <button data-v="0">Pause</button><button data-v="1" class="on">1×</button><button data-v="2">2×</button><button data-v="4">4×</button><button data-v="8">8×</button>
            </div></div>
          <div class="field"><div class="f-label"><span>Signal program</span></div>
            <div class="seg" id="su-signal">
              <button data-v="actuated" class="on">Actuated</button><button data-v="coordinated">Green wave</button><button data-v="fixed">Fixed</button>
            </div></div>
          <div class="field"><div class="f-label"><span>Cycle / max-green scale</span><b id="su-cycle-v">1.00×</b></div>
            <input id="su-cycle" type="range" min="60" max="160" value="100"></div>
          <div class="field"><div class="f-label"><span>Sim time of day</span><b id="su-tod-v">08:12</b></div>
            <input id="su-tod" type="range" min="0" max="1439" value="492"></div>
          <label style="display:flex;gap:9px;align-items:center;font-size:10.5px;color:var(--text-dim);cursor:pointer;margin-bottom:12px">
            <input id="su-auto-inc" type="checkbox" checked style="display:none"><span class="box" style="width:11px;height:11px;border:1px solid var(--line-bright);display:grid;place-items:center"></span>
            AUTO INCIDENT INJECTION
          </label>
          <div style="display:flex;gap:8px">
            <button class="action-btn danger" id="su-incident">Inject incident</button>
            <button class="action-btn" id="su-clear">Clear all</button>
          </div>
        </div>
        <div class="panel">
          <div class="p-title">Observation grid</div>
          <div class="field"><div class="f-label"><span>Units deployed</span><b>${this.unitsCountLabel()}</b></div></div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button class="action-btn" id="su-retask">Re-task fleet positions</button>
            <button class="action-btn" id="su-home">Reset camera — city frame</button>
          </div>
          <div style="margin-top:14px;font-size:9.5px;line-height:1.7;color:var(--text-faint);letter-spacing:.06em">
            UNITS HOLD STATION OVER ASSIGNED DISTRICTS AND STREAM FLOW TELEMETRY INTO THE SIM CORE. RE-TASKING RANDOMIZES HOLD POINTS WITHIN EACH DISTRICT.
          </div>
        </div>
        <div class="panel">
          <div class="p-title">System</div>
          <div class="field"><div class="f-label"><span>Render scale</span></div>
            <div class="seg" id="su-dpr"><button data-v="0">Auto</button><button data-v="1">1×</button><button data-v="2" class="on">2×</button></div></div>
          <div style="font-size:9.5px;line-height:1.8;color:var(--text-faint);letter-spacing:.05em;margin-top:6px" id="su-sysinfo"></div>
        </div>
      </div>
      <div style="height:12px"></div>
      <div class="panel">
        <div class="p-title">Calibration — NDW real traffic counts</div>
        <div style="display:flex;gap:26px;align-items:center;flex-wrap:wrap">
          <div id="su-ndw-info" style="font-size:10px;letter-spacing:.08em;color:var(--text-dim);line-height:1.9">NO SENSOR SNAPSHOT LOADED</div>
          <div id="su-ndw-live" style="font-size:10px;letter-spacing:.08em;color:var(--text-dim);line-height:1.9"></div>
          <button class="action-btn" id="su-calibrate" style="border-color:#1e4a2a;color:var(--green)">Auto-calibrate demand</button>
        </div>
        <div style="font-size:8.5px;letter-spacing:.06em;color:var(--text-faint);margin-top:9px;line-height:1.7">
          THE SIM COUNTS ITS OWN VEHICLES PASSING EVERY NDW STATION AND COMPARES AGAINST THE MEASURED VEH/H (NORMALIZED TO THE SIM CLOCK VIA THE DEMAND CURVE). AUTO-CALIBRATE SCALES FLEET DENSITY TOWARD PARITY; THE RESIDUAL IS REPORTED AS A 1:N REPRESENTATION FACTOR. SOURCE: NDW OPEN DATA.
        </div>
      </div>
      <div style="height:12px"></div>
      <div class="panel">
        <div class="p-title">Scenario library — city operations</div>
        <div id="su-scenarios" style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
          <div class="sc">
            <button class="action-btn" data-sc="bridge" style="width:100%">Erasmusbrug raised</button>
            <div class="sc-d">DECK OPENS FOR SHIPPING — SPAN CLOSED ~4 MIN, ALL TRAFFIC REROUTES VIA WILLEMSBRUG / MAASTUNNEL</div>
          </div>
          <div class="sc">
            <button class="action-btn" data-sc="stadium" style="width:100%">De Kuip egress</button>
            <div class="sc-d">MATCH ENDS AT STADIONPARK — 2,200 CARS AND PEDESTRIANS SURGE OUT OVER ~7 MIN</div>
          </div>
          <div class="sc">
            <button class="action-btn" data-sc="roadworks" style="width:100%">'s-Gravendijkwal works</button>
            <div class="sc-d">CAPACITY CUT TO ONE LANE FOR 10 MIN — WATCH SPILLBACK ON THE FLUX OVERLAY</div>
          </div>
          <div class="sc">
            <button class="action-btn" data-sc="freight" style="width:100%">Waalhaven surge</button>
            <div class="sc-d">HEAVY FREIGHT CONVOY RELEASES FROM THE PORT ONTO THE RING</div>
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:12px;align-items:center">
          <button class="action-btn" id="su-sc-clear">Clear scenario</button>
          <button class="action-btn" id="su-trial" style="border-color:#1e4a2a;color:var(--green)">Run signal trial — A/B/C</button>
          <span style="font-size:9px;color:var(--text-faint);letter-spacing:.08em">TRIAL SEQUENCES ACTUATED → GREEN WAVE → FIXED (4 SIM-MIN EACH) AND REPORTS THE BEST-FLOWING PROGRAM</span>
        </div>
      </div>`;

    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const dens = $<HTMLInputElement>("su-dens");
    dens.addEventListener("input", () => {
      $("su-dens-v").textContent = fmtInt(+dens.value);
      this.density = +dens.value;
      this.worker.postMessage({ type: "params", density: +dens.value });
      this.saveSetting("density", +dens.value);
    });
    $("su-speed").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        $("su-speed").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        const v = +b.dataset.v!;
        this.paused = v === 0;
        this.simSpeed = Math.max(1, v);
        this.worker.postMessage({ type: "params", running: v > 0, simSpeed: Math.max(1, v) });
        this.log("info", v === 0 ? "SIM CORE PAUSED BY OPERATOR" : `PHYSICS RATE SET TO ${v}×`);
      })
    );
    $("su-signal").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        $("su-signal").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        const program = b.dataset.v as "actuated" | "coordinated" | "fixed";
        this.worker.postMessage({ type: "params", signalProgram: program });
        this.saveSetting("program", program);
        const desc =
          program === "actuated"
            ? "DEMAND-RESPONSIVE GREEN EXTENSION"
            : program === "coordinated"
              ? "ARTERIAL GREEN-WAVE OFFSETS @ 45 KM/H"
              : "FIXED-TIME TWO-PHASE";
        this.log("info", `SIGNAL PROGRAM SET TO ${program.toUpperCase()} — ${desc}`);
      })
    );
    const cyc = $<HTMLInputElement>("su-cycle");
    cyc.addEventListener("input", () => {
      const v = +cyc.value / 100;
      $("su-cycle-v").textContent = `${v.toFixed(2)}×`;
      this.worker.postMessage({ type: "params", cycleScale: v });
    });
    const tod = $<HTMLInputElement>("su-tod");
    tod.addEventListener("input", () => {
      $("su-tod-v").textContent = fmtSimClock(+tod.value);
      this.worker.postMessage({ type: "params", timeOfDayMin: +tod.value });
    });
    const autoInc = $<HTMLInputElement>("su-auto-inc");
    const autoIncBox = autoInc.nextElementSibling as HTMLElement;
    const syncBox = () => (autoIncBox.innerHTML = autoInc.checked ? `<span style="width:5px;height:5px;background:var(--text)"></span>` : "");
    autoInc.parentElement!.addEventListener("click", (e) => {
      e.preventDefault();
      autoInc.checked = !autoInc.checked;
      syncBox();
      this.worker.postMessage({ type: "params", autoIncidents: autoInc.checked });
    });
    syncBox();
    $("su-incident").addEventListener("click", () => this.worker.postMessage({ type: "incident", action: "random" }));
    $("su-clear").addEventListener("click", () => this.worker.postMessage({ type: "incident", action: "clearAll" }));
    $("su-retask").addEventListener("click", () => {
      const distByKey = new Map(this.data.meta.districts.map((d) => [d.key, d]));
      for (const u of this.units) {
        const d = distByKey.get(u.def.district)!;
        u.x = d.x + (Math.random() - 0.5) * 1100;
        u.y = d.y + (Math.random() - 0.5) * 1100;
      }
      this.log("ok", "FLEET RE-TASKED — NEW HOLD POINTS ASSIGNED");
    });
    $("su-home").addEventListener("click", () => {
      this.setPage("map");
      this.scene.flyTo(new THREE.Vector3(0, 0, 0), 13500, 1200);
    });
    $("su-dpr").querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        $("su-dpr").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
        const v = +b.dataset.v!;
        this.scene.pixelRatioOverride = v === 0 ? null : v;
        this.scene.resize();
      })
    );
    $("su-sysinfo").innerHTML = `ENGINE: THREE.JS WEBGL2 · SIM: DEDICATED WORKER<br>DATA: OPENSTREETMAP (ODBL) — PROCESSED ${new Date().toISOString().slice(0, 10)}<br>PROJECTION: LOCAL TANGENT PLANE @ 51.9200N 4.4800E`;

    // scenario library
    const SC_VIEW: Record<string, [number, number, number]> = {
      bridge: [481, 1216, 1500],
      stadium: [2960, 2886, 1900],
      roadworks: [-920, 498, 1500],
      freight: [-4258, 3317, 2600],
    };
    p.querySelectorAll<HTMLButtonElement>("#su-scenarios button[data-sc]").forEach((b) =>
      b.addEventListener("click", () => {
        const kind = b.dataset.sc as "bridge" | "stadium" | "roadworks" | "freight";
        this.worker.postMessage({ type: "scenario", kind });
        this.setPage("map");
        const [x, z, d] = SC_VIEW[kind];
        this.scene.flyTo(new THREE.Vector3(x, 0, z), d, 1300);
      })
    );
    $("su-sc-clear").addEventListener("click", () => this.worker.postMessage({ type: "scenario", kind: "clear" }));

    // calibration panel
    const ndw = this.data.ndw;
    if (ndw) {
      const cap = new Date(ndw.capturedAt);
      $("su-ndw-info").innerHTML =
        `SNAPSHOT: <b style="color:var(--text)">${ndw.stations.length}</b> STATIONS · CAPTURED ${cap.toISOString().slice(0, 16).replace("T", " ")}Z (${fmtSimClock(ndw.todMin)} NL)<br>` +
        `MEASURED FLOW OVER STATIONS: <b style="color:var(--text)">${fmtInt(ndw.stations.reduce((a, s) => a + s.flow, 0))}</b> VEH/H`;
    }
    $("su-calibrate").addEventListener("click", () => {
      const cal = this.metrics?.calibration;
      if (!cal || cal.ratio <= 0) {
        this.toast("warn", "CALIBRATION NOT READY — LET THE SIM MEASURE FOR A MINUTE");
        return;
      }
      const factor = Math.min(3, 1 / cal.ratio);
      const newDensity = Math.round(Math.min(12000, Math.max(600, this.density * factor)));
      this.density = newDensity;
      const slider = document.getElementById("su-dens") as HTMLInputElement | null;
      if (slider) {
        slider.value = String(newDensity);
        const label = document.getElementById("su-dens-v");
        if (label) label.textContent = fmtInt(newDensity);
      }
      this.worker.postMessage({ type: "params", density: newDensity });
      this.log(
        "ok",
        `AUTO-CALIBRATION APPLIED — FLEET DENSITY → ${fmtInt(newDensity)} (SIM WAS AT ${(cal.ratio * 100).toFixed(1)}% OF MEASURED FLOW)`
      );
    });
    $("su-trial").addEventListener("click", () => {
      this.startTrial();
      this.setPage("map");
    });
  }

  private unitsCountLabel() {
    return `${this.units.length} — ${this.units.filter((u) => u.status === "active").length} ACTIVE`;
  }

  // ---------- settings persistence ----------
  saveSetting(key: string, value: unknown) {
    try {
      localStorage.setItem(`rtm.${key}`, JSON.stringify(value));
    } catch {
      /* private mode */
    }
  }

  private loadSetting<T>(key: string): T | null {
    try {
      const v = localStorage.getItem(`rtm.${key}`);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  }

  private restoreSettings() {
    const density = this.loadSetting<number>("density");
    if (density && density >= 600 && density <= 12000) {
      this.density = density;
      const slider = document.getElementById("su-dens") as HTMLInputElement | null;
      if (slider) slider.value = String(density);
      const label = document.getElementById("su-dens-v");
      if (label) label.textContent = fmtInt(density);
      this.worker.postMessage({ type: "params", density });
    }
    const program = this.loadSetting<string>("program");
    if (program === "actuated" || program === "coordinated" || program === "fixed") {
      this.worker.postMessage({ type: "params", signalProgram: program });
      document.querySelectorAll<HTMLButtonElement>("#su-signal button").forEach((b) =>
        b.classList.toggle("on", b.dataset.v === program)
      );
    }
    const layers = this.loadSetting<Record<string, boolean>>("layers");
    if (layers) {
      for (const box of this.ui.layerBoxes) {
        const k = box.dataset.layer!;
        if (k in layers && box.checked !== layers[k]) {
          box.checked = layers[k];
          this.applyLayer(k, layers[k]);
        }
      }
    }
  }

  persistLayerStates() {
    const map: Record<string, boolean> = {};
    for (const box of this.ui.layerBoxes) map[box.dataset.layer!] = box.checked;
    this.saveSetting("layers", map);
  }
}

const _replayIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 7.5V12l3 2"/></svg>`;

function cell(k: string, v: string, color?: string) {
  return `<div class="pl-cell"><div class="k">${k}</div><div class="v" ${color ? `style="color:${color}"` : ""}>${v}</div></div>`;
}

function hash(s: string | number): number {
  const str = String(s);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
