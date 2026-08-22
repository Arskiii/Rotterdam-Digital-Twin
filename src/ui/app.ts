// Application controller: pages, units, dock, markers, events — everything
// that reacts to user input and simulation telemetry.

import * as THREE from "three";
import type { Chrome } from "./chrome";
import { setMeter, barGlyphHTML } from "./chrome";
import type { SceneCtx, ScaleName } from "../render/scene";
import type { CityMeshes } from "../render/city";
import type { SignalsLayer, VehiclesLayer, CongestionLayer, NdwLayer } from "../render/dynamic";
import type { TransitLayer } from "../render/transit";
import { LiveTransitLayer } from "../render/transit";
import { DroneViewer } from "../render/drone";
import type { CityData } from "../data/loader";
import type { MetricsMsg, WorkerToMain } from "../sim/protocol";
import { DISTRICTS, UNITS, TIMEZONE, type UnitDef } from "../config";
import { fmtClockAmPm, fmtSimClock, fmtSession, fmtInt, fmtTimestamp, drawSparkline, escapeHtml, fmtAge } from "./format";
import { ArchiveReader, type ArchiveRecord, type ArchiveEvent } from "../data/archive";
import { congestionPatterns, eventImpacts, impactByType } from "./patterns";
import { buildSearchIndex, stopEntries, searchIndex, type SearchEntry, type SearchHit } from "./search";
import { transitHealth, KIND_LABEL, type LineHealth } from "../data/transit-health";

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
  private liveClockTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Whether this is a phone-sized screen, decided once at boot.
   *
   * Two things follow from it and they have to agree: the simulation core is
   * never started (iOS refuses it anyway, and starting it costs the boot a
   * worker's worth of memory for nothing), and the controls that only drive a
   * simulation — the SIMULATION mode and the SETUP page — are not shown.
   * Offering a mode that cannot run is worse than not offering it.
   *
   * Decided once rather than on resize because the worker is started during
   * boot: a window widened afterwards cannot retroactively have had one.
   *
   * Kept character-for-character in step with the phone media query in
   * style.css, so the markup and the behaviour cannot drift apart. Note what
   * the query does *not* test: width alone called a phone in landscape —
   * 844x390, wider than most laptops are tall — a desktop, and handed it a
   * layout it has no room for. The short side is what stays small when a
   * device is rotated, so that is what decides.
   */
  static readonly PHONE_MQ = "(max-width: 780px), (max-height: 520px) and (pointer: coarse)";
  static readonly PHONE = typeof matchMedia === "function" && matchMedia(App.PHONE_MQ).matches;
  /**
   * Whether the pointer is a fingertip rather than a cursor.
   *
   * Separate from PHONE on purpose: an iPad is not a phone (it gets the
   * simulation and the full layout) but it is still driven by a finger, and a
   * phone plugged into a mouse is the reverse. Anything sized for the *hand*
   * keys off this; anything sized for the *screen* keys off PHONE.
   */
  static readonly COARSE = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  /**
   * How much bigger every screen-space pick radius gets under a finger.
   *
   * A fingertip covers roughly 44 CSS px, and the contact point the browser
   * reports drifts several px from where the user believes they pressed — so a
   * radius tuned for a cursor asks for an accuracy nobody has. Widening it is
   * close to free: picking is nearest-wins, so a larger radius only changes
   * what happens when the nearest target is *far*. Between two adjacent
   * targets the nearer one still wins, exactly as before.
   */
  static readonly PICK = App.COARSE ? 1.9 : 1;
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
  private patternsCard!: HTMLElement;
  private patternsOpen = false;
  /** station key whose departure board is open */
  private boardKey: string | null = null;
  mode: "live" | "sim" | "history" = "live";
  /** false when the sim worker refused to start; LIVE and HISTORY still work */
  // false on a phone from the start: main.ts never starts the worker there, so
  // a true here would be a flag describing a core that does not exist
  simAvailable = !App.PHONE;
  /** the operator's congestion-flux choice, remembered across mode switches */
  private simCongestion = false;
  private historyBar!: HTMLElement;
  private archive = new ArchiveReader();
  private historyRecords: ArchiveRecord[] = [];
  private historyHours = 24;
  private historyIdx = 0;
  private historyLoading = false;
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
  // ---- search ----
  /** the static half of the index (streets, sensors, districts), built lazily */
  private searchStatic: SearchEntry[] | null = null;
  /** the static half plus this snapshot's stops, rebuilt when the snapshot moves */
  private searchMerged: SearchEntry[] | null = null;
  /** the stops object the merged index was built from, by identity */
  private searchStopsFrom: unknown = null;
  private searchHits: SearchHit[] = [];
  private searchSel = 0;
  /** transit panel: every line, rather than only the ones worth looking at */
  private trShowAll = false;

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
    this.patternsCard = document.createElement("div");
    this.patternsCard.id = "patterns-card";
    ui.hud.appendChild(this.patternsCard);
    this.boardCard.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("#board-close")) this.closeBoard();
    });

    this.buildHistoryBar();
    ui.modeBtns.forEach((b) =>
      b.addEventListener("click", () => {
        this.setMode(b.dataset.mode as "live" | "sim" | "history");
        this.saveSetting("mode", this.mode);
      })
    );

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
    // before restoreSettings, which calls setMode and touches the same boxes
    this.withdrawPhoneControls();
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
    if (fly || !App.PHONE) this.ui.unitCard.classList.add("open");
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
    const markScale = (match: (b: HTMLButtonElement) => boolean) =>
      ui.scaleBtns.forEach((x) => {
        const on = match(x);
        x.classList.toggle("on", on);
        x.setAttribute("aria-pressed", String(on));
      });
    ui.scaleBtns.forEach((b) =>
      b.addEventListener("click", () => {
        this.scene.setScale(b.dataset.scale as ScaleName);
        markScale((x) => x === b);
      })
    );
    this.scene.onScaleChange = (s) => markScale((x) => x.dataset.scale === s);

    // zoom / layers
    ui.zoomIn.addEventListener("click", () => this.scene.zoomBy(0.55));
    ui.zoomOut.addEventListener("click", () => this.scene.zoomBy(1.8));
    const setLayersOpen = (open: boolean) => {
      ui.layersPop.classList.toggle("open", open);
      ui.layersBtn.classList.toggle("on", open);
    };
    ui.layersBtn.addEventListener("click", () =>
      setLayersOpen(!ui.layersPop.classList.contains("open"))
    );
    // On a phone the panel is far too big to sit beside the button that opened
    // it, so it goes where there is room — which means that button is no longer
    // a way back out. Its own ✕ is.
    ui.lpClose.addEventListener("click", () => setLayersOpen(false));
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
    // How far the pointer may travel between press and release and still count
    // as a tap rather than a drag. A mouse held still moves 0px; a finger
    // pressed and lifted routinely slides 8-15px without its owner intending
    // any motion, so a 6px budget rejected most real taps on a phone — the map
    // simply did not respond. Panning is a continuous gesture and easily clears
    // the larger budget, so nothing is lost at the other end.
    const TAP_SLOP = App.COARSE ? 16 : 6;
    this.ui.viewport.addEventListener("pointerup", (e) => {
      if (e.target !== this.scene.renderer.domElement) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > TAP_SLOP) return;
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
    // ---- search ----
    ui.searchBtn.addEventListener("click", () => this.setSearchOpen(!ui.searchPop.classList.contains("open")));
    ui.searchClose.addEventListener("click", () => {
      this.setSearchOpen(false);
      ui.searchBtn.focus();
    });
    ui.searchInput.addEventListener("input", () => this.renderSearch());
    ui.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.moveSearchSel(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.moveSearchSel(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.commitSearch(this.searchSel);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.setSearchOpen(false);
        ui.searchBtn.focus();
      }
    });
    ui.searchResults.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".sr-row");
      if (row) this.commitSearch(+(row.dataset.i ?? "-1"));
    });

    window.addEventListener("keydown", (e) => this.onKey(e));
  }

  /**
   * Keyboard shortcuts for the things an operator does constantly.
   *
   * Everything here is reachable by mouse as well; this is a second route, not
   * the only one. Anything with a modifier is left alone so the browser's own
   * shortcuts keep working, and typing into a field is never intercepted —
   * except by Escape, which means "get me out of this" everywhere.
   */
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const typing =
      !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

    if (e.key === "Escape") {
      if (this.ui.searchPop.classList.contains("open")) this.setSearchOpen(false);
      else if (this.ui.layersPop.classList.contains("open")) {
        this.ui.layersPop.classList.remove("open");
        this.ui.layersBtn.classList.remove("on");
      } else if (this.track) this.releaseTrack("RELEASED BY OPERATOR");
      else this.dismissUnitCard();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case "/":
        e.preventDefault(); // Firefox binds this to quick-find
        this.setSearchOpen(true);
        break;
      case "1":
        this.setMode("live");
        this.saveSetting("mode", this.mode);
        break;
      case "2":
        this.setMode("sim");
        this.saveSetting("mode", this.mode);
        break;
      case "3":
        this.setMode("history");
        this.saveSetting("mode", this.mode);
        break;
      case "l":
      case "L": {
        const open = !this.ui.layersPop.classList.contains("open");
        this.ui.layersPop.classList.toggle("open", open);
        this.ui.layersBtn.classList.toggle("on", open);
        if (open) this.setSearchOpen(false);
        break;
      }
      case "?":
        this.toast(
          "info",
          "<b>KEYS</b> — / FIND · 1 LIVE · 2 SIMULATION · 3 HISTORY · L LAYERS · ESC RELEASE"
        );
        break;
    }
  }

  /**
   * Withdraw the controls a phone cannot honour.
   *
   * `main.ts` never starts the simulation worker on a phone, so no frame and
   * no congestion message ever arrives: the modelled fleet has nothing to
   * draw and the flux replay has nothing to replay. The same reasoning already
   * removes SIMULATION and SETUP there — "offering a mode that cannot run is
   * worse than not offering it" — and it applies just as well to four switches
   * and a button that can only ever report NO HISTORY YET.
   *
   * Hidden rather than removed, so `layerBoxes`, the saved layer states and
   * `setBox` all keep working on the same elements they always did.
   */
  private withdrawPhoneControls() {
    if (!App.PHONE) return;
    for (const layer of ["vehicles", "bikes", "pedestrians", "congestion"]) {
      const box = this.ui.layerBoxes.find((b) => b.dataset.layer === layer);
      const label = box?.closest("label") as HTMLElement | null;
      if (label) label.style.display = "none";
    }
    const replay = this.ui.hud.querySelector<HTMLElement>("#replay-btn");
    if (replay) {
      // the gap that spaced it from the zoom buttons goes with it
      (replay.previousElementSibling as HTMLElement | null)?.style.setProperty("display", "none");
      replay.style.display = "none";
    }
  }

  // ---------- target tracking ----------
  /** Screen-space nearest-agent pick: robust for pixel-sized moving targets. */
  private tryAcquireTrack(clientX: number, clientY: number) {
    if (this.page !== "map") return;
    const el = this.scene.renderer.domElement;
    const rect = el.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const RADIUS = 16 * App.PICK;
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
    let stationD2 = (14 * App.PICK) ** 2;
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
        if (!LiveTransitLayer.PICKABLE.has(v.kind)) continue;
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
      let bd2 = (9 * App.PICK) ** 2;
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
        if (!LiveTransitLayer.PICKABLE.has(v.kind)) continue; // carries a line
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
      // Tapping empty map releases the camera lock. Without this the only way
      // out was the Release button or Escape — and a phone has no Escape.
      if (this.track) this.releaseTrack("RELEASED BY OPERATOR");
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

  // ---------- search ----------

  /**
   * The index, built on first use and kept current with the live stops.
   *
   * The street half walks every edge in the graph, which is not something to
   * do during boot for a panel nobody may open — so it waits for the first
   * keystroke. The stop half arrives with the snapshot and changes every two
   * minutes, so it is rebuilt when the snapshot's `stops` object changes
   * identity rather than on every keystroke: a search runs on every character
   * typed, and re-indexing 700 stops each time would be felt.
   */
  private searchAll(): SearchEntry[] {
    if (!this.searchStatic) {
      this.searchStatic = buildSearchIndex(this.data, this.data.meta.districts.map((d) => d.name));
    }
    const stops = this.live?.departures?.stops;
    if (!this.searchMerged || stops !== this.searchStopsFrom) {
      this.searchStopsFrom = stops;
      this.searchMerged = this.searchStatic.concat(stopEntries(stops));
    }
    return this.searchMerged;
  }

  setSearchOpen(open: boolean) {
    this.ui.searchPop.classList.toggle("open", open);
    this.ui.searchBtn.classList.toggle("on", open);
    this.ui.searchInput.setAttribute("aria-expanded", String(open));
    if (!open) {
      this.ui.searchResults.innerHTML = "";
      this.searchHits = [];
      this.ui.searchInput.removeAttribute("aria-activedescendant");
      return;
    }
    // both panels want the same corner
    this.ui.layersPop.classList.remove("open");
    this.ui.layersBtn.classList.remove("on");
    this.setPage("map");
    this.ui.searchInput.focus();
    this.ui.searchInput.select();
    this.renderSearch();
  }

  /**
   * The second series on the brief chart, and the legend swatch that names it.
   *
   * One constant for both because they have to agree — and #666, which they
   * used to share, measured 3.41:1 as legend text. Lifting only the words
   * would have left the legend pointing at a line of a different grey.
   */
  private static readonly TRACKS_INK = "#8a8a8a";

  private static SEARCH_KIND: Record<string, string> = {
    street: "ST",
    station: "NDW",
    stop: "RET",
    district: "DIS",
  };

  private renderSearch() {
    const q = this.ui.searchInput.value;
    this.searchHits = searchIndex(this.searchAll(), q, 8);
    this.searchSel = 0;
    const list = this.ui.searchResults;
    if (!this.searchHits.length) {
      list.innerHTML = q.trim().length >= 2 ? `<div class="sr-empty">NOTHING MATCHES “${escapeHtml(q)}”</div>` : "";
      this.ui.searchInput.removeAttribute("aria-activedescendant");
      return;
    }
    list.innerHTML = this.searchHits
      .map((h, i) => {
        // the matched letters, marked up in place — a result reads as an answer
        // to what was typed rather than a list that happens to contain it
        const [a, b] = h.at;
        const name =
          b > a
            ? `${escapeHtml(h.label.slice(0, a))}<b>${escapeHtml(h.label.slice(a, b))}</b>${escapeHtml(h.label.slice(b))}`
            : escapeHtml(h.label);
        return `<div class="sr-row${i === 0 ? " sel" : ""}" id="sr-opt-${i}" role="option" aria-selected="${i === 0}" data-i="${i}">
          <span class="sr-kind">${App.SEARCH_KIND[h.kind] ?? ""}</span>
          <span class="sr-name">${name}</span>
          <span class="sr-sub">${escapeHtml(h.sub)}</span>
        </div>`;
      })
      .join("");
    this.ui.searchInput.setAttribute("aria-activedescendant", "sr-opt-0");
  }

  private moveSearchSel(delta: number) {
    if (!this.searchHits.length) return;
    const n = this.searchHits.length;
    this.searchSel = (this.searchSel + delta + n) % n;
    const rows = this.ui.searchResults.querySelectorAll<HTMLElement>(".sr-row");
    rows.forEach((r, i) => {
      const on = i === this.searchSel;
      r.classList.toggle("sel", on);
      r.setAttribute("aria-selected", String(on));
      if (on) r.scrollIntoView({ block: "nearest" });
    });
    this.ui.searchInput.setAttribute("aria-activedescendant", `sr-opt-${this.searchSel}`);
  }

  private commitSearch(i: number) {
    const h = this.searchHits[i];
    if (!h) return;
    this.setSearchOpen(false);
    this.setPage("map");
    this.scene.flyTo(new THREE.Vector3(h.x, 0, -h.y), h.dist, 1100);
    this.log("ok", `MOVED TO ${escapeHtml(h.label.toUpperCase())} — ${escapeHtml(h.sub.toUpperCase())}`);
  }

  // ---------- live departure boards ----------

  /**
   * True age of a live position fix, in seconds.
   *
   * The snapshot records how old each fix was *when it was captured*. Shown
   * raw, that number never moves: a vehicle reported 74 s old still claimed
   * 74 s ten minutes later, so the display under-stated staleness by the
   * entire age of the snapshot. The age of the snapshot has to be added back.
   */
  liveFixAge(v: { fixAge: number }): number {
    const captured = this.live?.vehicles?.t;
    const since = captured ? Math.max(0, (Date.now() - Date.parse(captured)) / 1000) : 0;
    return (v.fixAge >= 0 ? v.fixAge : 0) + since;
  }

  /** Hand the app the newest live snapshot; refreshes an open board in place. */
  setLive(snap: import("../data/live").LiveSnapshot, fresh: boolean) {
    this.live = snap;
    this.liveFresh = fresh;
    // Same reasoning as slowTick, and it matters more here: this runs from the
    // poll, whose caller records the snapshot's timestamp before handing it on
    // — so an exception escaping here is not retried, and the app sits on old
    // data with the map still moving around it.
    this.guard("departure board", () => this.boardKey && this.renderBoard());
    this.guard("brief", () => this.page === "brief" && this.mode === "live" && this.renderBrief());
    this.guard("transit", () => this.renderTransit());
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
        <button id="station-close" aria-label="Close station card">✕</button>
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

  // ---------- live / simulation / history ----------

  /**
   * Which city you are looking at.
   *
   *   live      what the sensors and feeds actually report, right now
   *   sim       a model of the city you can push on: fleet size, demand,
   *             signal timing, injected incidents
   *   history   what the city did earlier, replayed from the archive
   *
   * The distinction is the point, and it is drawn per layer rather than per
   * mode. Everything in LIVE that claims to be a particular thing — this tram,
   * that bridge, this sensor's speed — is measured. The cars, bikes and
   * pedestrians claim to be nobody: they are modelled agents on the real
   * street graph, obeying the real signals, at a volume set by Rotterdam's
   * clock and the measured sensor flows. Nothing publishes real road-vehicle
   * positions for this city, so the alternative was an empty street network,
   * which is honest and dead. The layer panel says which is which.
   *
   * SIMULATION is where those same agents can be pushed on — fleet size,
   * demand, signal timing, injected incidents — and where the clock runs at
   * 72x so a day passes in twenty minutes.
   */
  /**
   * Carry on without a simulation core.
   *
   * The worker is refused often enough on phones — where the graph and its
   * derived tables are a lot to hold beside a 3D scene — that losing the whole
   * app to it is the wrong trade. Nothing the live map shows comes from the
   * sim, so LIVE and HISTORY keep working; only SIMULATION is withdrawn, and
   * it says why rather than sitting there dead.
   */
  disableSim(reason: string) {
    this.simAvailable = false;
    const btn = this.ui.modeBtns.find((b) => b.dataset.mode === "sim");
    if (btn) {
      btn.disabled = true;
      btn.classList.add("unavailable");
      btn.title = `Simulation unavailable on this device — ${reason}`;
    }
    if (this.mode === "sim") this.setMode("live");
    this.log("warn", `SIM CORE UNAVAILABLE — ${reason.toUpperCase()} · MEASURED FEEDS UNAFFECTED`);
    const note = document.getElementById("smn-text");
    if (note) {
      note.textContent =
        `The simulation core could not start on this device (${reason}). ` +
        `Everything measured still works — real trams and metros, departure boards, ` +
        `sensor congestion, incidents, weather and the archive. What is missing is ` +
        `modelled: the cars, bikes and pedestrians on the live map, and Simulation mode itself.`;
    }
    // there is no simulation to switch to
    const go = document.getElementById("smn-go");
    if (go) go.style.display = "none";
  }

  /** Minutes since midnight in Rotterdam, from the viewer's own clock. */
  private static rotterdamTodMin(): number {
    const p = new Intl.DateTimeFormat("nl-NL", {
      timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    return +p.find((x) => x.type === "hour")!.value * 60 + +p.find((x) => x.type === "minute")!.value;
  }

  /**
   * Point the model's clock at Rotterdam, or hand it back to the simulation.
   *
   * The hour comes from the viewer's own device rather than from the snapshot.
   * The snapshot's time of day belongs to the NDW calibration — it is the hour
   * those flows were measured in and must stay pinned to them — but as a
   * display clock it is whatever the feed last managed to publish. Reading it
   * that way put the streets at rush hour at 02:45 whenever the shipped
   * fallback snapshot was in use, which is exactly the kind of quietly wrong
   * that nobody reports.
   *
   * Re-synced on a timer as well as on the mode switch: a backgrounded tab has
   * its frames throttled, so the 1x clock would otherwise fall behind the city
   * it is meant to be following.
   */
  private syncLiveClock(live: boolean) {
    clearInterval(this.liveClockTimer);
    this.worker.postMessage(
      live
        ? { type: "params", liveClock: true, running: true, simSpeed: 1, timeOfDayMin: App.rotterdamTodMin() }
        : { type: "params", liveClock: false, running: !this.paused, simSpeed: this.simSpeed }
    );
    if (!live || !this.simAvailable) return;
    this.liveClockTimer = setInterval(
      () => this.worker.postMessage({ type: "params", timeOfDayMin: App.rotterdamTodMin() }),
      60_000
    );
  }

  setMode(m: "live" | "sim" | "history") {
    // a mode that cannot run is not a mode
    if (m === "sim" && (!this.simAvailable || App.PHONE)) m = "live";
    const prevMode = this.mode;
    this.mode = m;
    this.ui.modeBtns.forEach((b) => {
      const on = b.dataset.mode === m;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    document.body.dataset.mode = m;

    const sim = m === "sim";
    const live = m === "live";
    const history = m === "history";

    // Cars, bikes and pedestrians run in LIVE as well as SIMULATION.
    //
    // Nobody publishes vehicle positions for Rotterdam's roads — the sensor
    // net gives flows at 610 points, not cars — so an empty road network was
    // the honest picture and a dead one. These are modelled agents on the real
    // street graph, obeying the real signals, and the layer panel says so in
    // LIVE. What keeps them from being a lie is that they claim nothing about
    // any individual vehicle; the numbers they move by are measured.
    //
    // The simulated transit fleet stays out: LIVE already draws the real
    // trams and metros, and running both would put two of every tram on the
    // same track.
    const road = sim || live;
    this.setBox("vehicles", road);
    this.setBox("bikes", road);
    this.setBox("pedestrians", road);
    this.setBox("transit", sim);
    // In LIVE the model runs on Rotterdam's clock at 1x, so the streets are
    // empty at 03:00 and full at 08:30 for the same reason the real ones are.
    // Speed and pause are simulation controls with no meaning against it.
    this.syncLiveClock(live);
    // real transit is the live picture; in the model it would be two fleets
    // of the same trams on the same track
    this.setBox("fixes", live);
    // measured congestion is the whole content of the live map
    this.setBox("sensors", live || sim);
    // Congestion flux is the simulation's own output, edge by edge — so it
    // belongs to SIMULATION and nowhere else. Switching it on for LIVE drew
    // modelled congestion across the measured city, which is the exact
    // confusion this mode split exists to remove, and it painted the whole
    // network green (the free-flowing end of the ramp) over roads nobody had
    // measured. In LIVE the honest equivalent is the sensor net above, which
    // colours the 610 stations that actually report. It stays the opt-in
    // choice it has always been in SIM, and that choice survives a trip
    // through LIVE instead of being silently cleared.
    const congBox = this.ui.layerBoxes.find((b) => b.dataset.layer === "congestion");
    if (prevMode === "sim" && congBox) this.simCongestion = congBox.checked;
    this.setBox("congestion", sim && this.simCongestion);

    if (!live) this.closeBoard();
    if (history) {
      this.releaseTrack("HISTORY MODE");
      void this.openHistory();
    } else {
      this.closeHistory();
    }

    // SETUP alters model variables; in LIVE and HISTORY there is nothing to
    // alter, and pretending otherwise would imply the sliders change the city
    this.ui.pageSetup.classList.toggle("mode-locked", !sim);
    this.lockSetupControls(!sim);
    const noteText = document.getElementById("smn-text");
    const noteGo = document.getElementById("smn-go") as HTMLButtonElement | null;
    if (noteText && this.simAvailable) {
      noteText.textContent = sim
        ? ""
        : `Variables are a simulation control. Fleet density, demand, signal timing, scenarios, calibration and the signal trial all move the model, not the city.`;
    }
    if (noteGo) noteGo.style.display = !sim && this.simAvailable ? "" : "none";
    // the brief leads with a different set of figures per mode
    if (this.page === "brief") this.renderBrief();
    this.log(
      "info",
      live
        ? "LIVE MODE — REAL TRANSIT, SENSOR CONGESTION, REAL INCIDENTS · ROAD TRAFFIC MODELLED"
        : sim
          ? "SIMULATION MODE — MODELLED CITY: VARIABLES UNLOCKED"
          : "HISTORY MODE — REPLAYING THE ARCHIVE"
    );
  }

  /**
   * Disable every SETUP control that moves a model variable.
   *
   * The stylesheet dims and un-clicks the panels, but that lock was a single
   * `#setup-grid` selector and the Calibration and Scenario Library panels are
   * siblings of that grid, not children — so both stayed fully live outside
   * SIMULATION. Pressing "Erasmusbrug raised" in LIVE really did raise it: a
   * CRIT event about a bridge that was not open, written into the same feed
   * that carries the real NDW bridge openings.
   *
   * Belt as well as braces, deliberately. The CSS is the thing anyone will see;
   * `disabled` is the thing that holds if a future selector stops matching,
   * and it is also what tells a screen reader these controls are unavailable —
   * which `pointer-events: none` never did.
   *
   * The note is excluded by scoping rather than by name: it is neither inside
   * the grid nor a `.panel`, so the button that switches to SIMULATION stays
   * pressable, which is the whole point of it being there.
   */
  private lockSetupControls(locked: boolean) {
    this.ui.pageSetup
      .querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        "#setup-grid button, #setup-grid input, :scope > .panel button, :scope > .panel input"
      )
      .forEach((el) => {
        el.disabled = locked;
      });
  }

  // ---------- history: replaying the archive ----------

  private buildHistoryBar() {
    this.historyBar = document.createElement("div");
    this.historyBar.id = "history-bar";
    this.historyBar.innerHTML = `
      <div class="hb-top">
        <span class="hb-title">ARCHIVE</span>
        <div class="hb-windows">
          <button data-hours="24" class="on">24H</button>
          <button data-hours="168">7D</button>
          <button data-hours="720">30D</button>
        </div>
        <button id="hb-patterns" title="What keeps happening, across the whole window">PATTERNS</button>
        <span class="hb-cover" id="hb-cover"></span>
        <span class="hb-at" id="hb-at">—</span>
      </div>
      <canvas id="hb-canvas"></canvas>
      <input id="hb-range" type="range" min="0" max="0" value="0" />
      <div class="hb-read" id="hb-read"></div>`;
    this.ui.hud.appendChild(this.historyBar);
    this.historyBar.querySelectorAll<HTMLButtonElement>(".hb-windows button").forEach((b) =>
      b.addEventListener("click", () => {
        this.historyHours = +(b.dataset.hours ?? "24");
        this.historyBar.querySelectorAll(".hb-windows button").forEach((o) => o.classList.toggle("on", o === b));
        void this.openHistory();
      })
    );
    (this.historyBar.querySelector("#hb-patterns") as HTMLButtonElement).addEventListener("click", () => {
      this.patternsOpen = !this.patternsOpen;
      this.patternsCard.classList.toggle("open", this.patternsOpen);
      (this.historyBar.querySelector("#hb-patterns") as HTMLElement).classList.toggle("on", this.patternsOpen);
      if (this.patternsOpen) void this.renderPatterns();
    });
    (this.historyBar.querySelector("#hb-range") as HTMLInputElement).addEventListener("input", (e) => {
      this.historyIdx = +(e.target as HTMLInputElement).value;
      this.paintHistory();
    });
  }

  /**
   * Load the selected window from the archive and show it.
   *
   * A window with no data is a normal outcome, not an error: the archive only
   * contains what the refresh loop actually captured, so an empty result says
   * so plainly rather than drawing a flat line that looks like measured calm.
   */
  private async openHistory() {
    this.historyBar.classList.add("open");
    this.historyLoading = true;
    this.renderHistoryMessage("READING ARCHIVE…");
    const to = new Date();
    const from = new Date(to.getTime() - this.historyHours * 3_600_000);
    let recs: ArchiveRecord[] = [];
    try {
      recs = await this.archive.range(from, to);
    } catch {
      recs = [];
    }
    this.historyLoading = false;
    this.historyRecords = recs;
    const range = this.historyBar.querySelector("#hb-range") as HTMLInputElement;
    range.max = String(Math.max(0, recs.length - 1));
    range.value = String(Math.max(0, recs.length - 1));
    this.historyIdx = Math.max(0, recs.length - 1);
    if (this.patternsOpen) void this.renderPatterns();
    this.paintCoverage(recs, this.historyHours);
    if (!recs.length) {
      this.renderHistoryMessage("NOTHING WAS ARCHIVED IN THIS WINDOW — TRY A SHORTER ONE");
      return;
    }
    this.paintHistory();
  }

  /**
   * Say how much of the requested window the archive actually holds.
   *
   * The buttons offer 24H, 7D and 30D; the archive holds whatever the refresh
   * loop has captured since it started, which right now is a couple of days.
   * Asking for 30D and getting a timeline drawn from two days of readings
   * across a month-wide axis is not an error and does not look like one — the
   * chart is simply flat and empty for 93% of its width, which reads as a
   * quiet city rather than an absent record.
   *
   * So the bar says what it has. Same rule as everywhere else here: the sample
   * travels with the average, and an unmeasured stretch is never drawn as calm.
   */
  private paintCoverage(recs: ArchiveRecord[], hours: number) {
    const el = this.historyBar.querySelector("#hb-cover") as HTMLElement | null;
    if (!el) return;
    if (!recs.length) {
      el.textContent = "NO COVERAGE";
      el.className = "hb-cover thin";
      return;
    }
    const spanH = (recs[recs.length - 1].t - recs[0].t) / 3_600_000;
    const frac = Math.min(1, spanH / hours);
    // One decimal under ten days rather than a rounded whole: 60 hours is 2.5
    // days, and rounding it to "3D" overstates coverage — the wrong direction
    // for the one label whose job is to stop the chart being over-read.
    const days = spanH / 24;
    const span = spanH < 48 ? `${Math.round(spanH)}H` : days < 10 ? `${days.toFixed(1)}D` : `${Math.round(days)}D`;
    el.textContent = `${span} ARCHIVED · ${fmtInt(recs.length)} READINGS`;
    // Under two thirds of the asked-for window is worth flagging rather than
    // leaving the reader to infer it from the shape of the line.
    el.className = frac < 0.66 ? "hb-cover thin" : "hb-cover";
  }

  // ---------- patterns: what the archive says keeps happening ----------

  /**
   * Six steps of one hue, dark surface upward.
   *
   * Congestion is a magnitude, so it gets a sequential ramp rather than the
   * green-amber-red of a live gauge: on this scale "not very congested" is not
   * a different state deserving a different hue, it is less of the same thing.
   * Red because that is already what this product means by slow.
   */
  private static CONG_RAMP = ["#1b1113", "#3d191c", "#6d2327", "#9d2d31", "#c8383c", "#ee4444"];

  private static congColor(v: number): string {
    const r = App.CONG_RAMP;
    return r[Math.min(r.length - 1, Math.max(0, Math.floor(v * r.length)))];
  }

  /**
   * Read the whole window at once instead of one moment at a time.
   *
   * Everything here carries its sample count. With an archive this young most
   * hours are backed by a handful of readings, and an average over two samples
   * presented like an average over two hundred is the kind of chart that gets
   * believed. Cells nobody measured are drawn as absent, never as free-flowing
   * — the archive stores zero congestion for a district with no reporting
   * station, which is the same number as an empty motorway.
   */
  /** Close the patterns card and un-press the button that opened it. */
  private closePatterns() {
    this.patternsOpen = false;
    this.patternsCard.classList.remove("open");
    this.historyBar.querySelector("#hb-patterns")?.classList.remove("on");
  }

  private async renderPatterns() {
    const el = this.patternsCard;
    const recs = this.historyRecords;
    const names = this.data.meta.districts.map((d) => d.name);
    // The empty state needs its ✕ as much as the full one — more, in fact,
    // since an empty archive window is the first thing a new visitor opens.
    // Without it the panel was a dead end on a phone.
    const closeBtn = `<button id="pc-close" title="Close">×</button>`;
    const wireClose = () =>
      (el.querySelector("#pc-close") as HTMLButtonElement | null)?.addEventListener("click", () =>
        this.closePatterns()
      );
    if (!recs.length) {
      el.innerHTML = `<div class="pc-head"><span class="pc-eyebrow">PATTERNS</span>${closeBtn}</div>
        <div class="pc-empty">NOTHING ARCHIVED IN THIS WINDOW YET</div>`;
      wireClose();
      return;
    }

    const p = congestionPatterns(recs);
    const hours = p.coveredHours;
    const ranked = [...p.districts].sort((a, b) => b.mean - a.mean);
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const hh = (h: number) => `${String(h).padStart(2, "0")}`;

    const rows = ranked
      .filter((d) => d.samples > 0)
      .map((d) => {
        const cells = hours
          .map((h) => {
            const c = d.byHour[h];
            if (!c.samples) return `<i class="pc-cell pc-none" title="${escapeHtml(names[d.index] ?? "")} ${hh(h)}:00 — not measured"></i>`;
            return `<i class="pc-cell" style="background:${App.congColor(c.mean)}" title="${escapeHtml(names[d.index] ?? "")} ${hh(h)}:00 — ${pct(c.mean)} congested, ${c.samples} sample${c.samples === 1 ? "" : "s"}"></i>`;
          })
          .join("");
        const worst = d.worstHour ? `${hh(d.worstHour.hour)}:00` : "—";
        return `<tr>
          <th>${escapeHtml(names[d.index] ?? `D${d.index}`)}</th>
          <td class="pc-grid">${cells}</td>
          <td class="pc-num">${pct(d.mean)}</td>
          <td class="pc-num pc-dim">${pct(d.peak)}</td>
          <td class="pc-num pc-dim">${worst}</td>
        </tr>`;
      })
      .join("");

    const legend = App.CONG_RAMP.map((c) => `<i style="background:${c}"></i>`).join("");
    const span =
      p.span
        ? `${new Date(p.span.from).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} → ${new Date(p.span.to).toLocaleString("nl-NL", { timeZone: "Europe/Amsterdam", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`
        : "";

    el.innerHTML = `
      <div class="pc-head">
        <div>
          <div class="pc-eyebrow">PATTERNS · CONGESTION BY DISTRICT AND HOUR</div>
          <div class="pc-span">${escapeHtml(span)}</div>
        </div>
        ${closeBtn}
      </div>
      <table class="pc-table">
        <thead><tr><th></th><th class="pc-grid">${hours.map((h) => `<i class="pc-hh">${hh(h)}</i>`).join("")}</th><th class="pc-num">MEAN</th><th class="pc-num">PEAK</th><th class="pc-num">WORST</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="pc-legend"><span>FREE</span>${legend}<span>STOPPED</span><span class="pc-none-key"><i class="pc-cell pc-none"></i> not measured</span></div>
      <div class="pc-foot" id="pc-foot">${p.records} archived readings · ${p.samples} measured district-samples · ${hours.length} of 24 hours covered</div>
      <div class="pc-events" id="pc-events"></div>`;
    wireClose();

    // Events come from their own monthly file, so they arrive after the grid
    // rather than holding it up.
    const target = el.querySelector("#pc-events") as HTMLElement | null;
    if (!target) return;
    let events: ArchiveEvent[] = [];
    try {
      const months = new Set<string>();
      for (const r of [recs[0], recs[recs.length - 1]]) {
        const d = new Date(r.t);
        months.add(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
      }
      for (const m of months) {
        const [y, mo] = m.split("-").map(Number);
        events.push(...(await this.archive.events(y, mo)));
      }
    } catch {
      events = [];
    }
    if (!events.length) {
      target.innerHTML = `<div class="pc-empty">NO INCIDENTS OR BRIDGE OPENINGS ARCHIVED IN THIS WINDOW</div>`;
      return;
    }
    const impacts = eventImpacts(recs, events, this.data.meta.districts);
    const byType = impactByType(impacts).filter((t) => t.measured > 0);
    if (!byType.length) {
      target.innerHTML = `<div class="pc-empty">${events.length} EVENTS ARCHIVED, NONE OVERLAPPING A MEASURED READING</div>`;
      return;
    }
    const signed = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 100).toFixed(1)}`;
    target.innerHTML = `
      <div class="pc-eyebrow">WHAT EACH KIND COSTS ITS OWN DISTRICT</div>
      <table class="pc-table pc-ev">
        <tbody>${byType
          .map(
            (t) => `<tr>
              <th>${escapeHtml(t.type.replace("-", " ").toUpperCase())}</th>
              <td class="pc-num">${signed(t.meanDelta)} pts</td>
              <td class="pc-num pc-dim">${t.measured} of ${t.events} measured</td>
            </tr>`
          )
          .join("")}</tbody>
      </table>
      <div class="pc-foot">Against the same district's own congestion while nothing was open there — not against the city, because a busy district is not an incident.</div>`;
  }

  private closeHistory() {
    this.historyBar?.classList.remove("open");
    this.patternsCard?.classList.remove("open");
    this.patternsOpen = false;
    this.historyBar?.querySelector("#hb-patterns")?.classList.remove("on");
  }

  private renderHistoryMessage(msg: string) {
    const read = this.historyBar.querySelector("#hb-read") as HTMLElement;
    read.innerHTML = `<span class="hb-empty">${escapeHtml(msg)}</span>`;
    const at = this.historyBar.querySelector("#hb-at") as HTMLElement;
    at.textContent = "—";
    const cv = this.historyBar.querySelector("#hb-canvas") as HTMLCanvasElement;
    const ctx = cv.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
  }

  /** Draw the congestion timeline and read out the scrubbed moment. */
  private paintHistory() {
    const recs = this.historyRecords;
    if (!recs.length || this.historyLoading) return;
    const cv = this.historyBar.querySelector("#hb-canvas") as HTMLCanvasElement;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 520;
    const h = cv.clientHeight || 46;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
    }
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cityCong = (r: ArchiveRecord) => {
      // districts with no reporting station contribute nothing rather than a
      // zero, which would read as "free flowing" when it means "unmeasured"
      const seen = r.districts.filter((d) => d.speed > 0);
      return seen.length ? seen.reduce((p, c) => p + c.congestion, 0) / seen.length : 0;
    };

    // congestion area
    ctx.beginPath();
    ctx.moveTo(0, h);
    recs.forEach((r, i) => {
      const x = (i / Math.max(1, recs.length - 1)) * w;
      ctx.lineTo(x, h - cityCong(r) * h * 0.92);
    });
    ctx.lineTo(w, h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "rgba(238,68,68,0.55)");
    grad.addColorStop(1, "rgba(238,68,68,0.05)");
    ctx.fillStyle = grad;
    ctx.fill();

    // incident ticks along the bottom
    ctx.fillStyle = "rgba(210,160,24,0.85)";
    recs.forEach((r, i) => {
      if (!r.incidents) return;
      const x = (i / Math.max(1, recs.length - 1)) * w;
      ctx.fillRect(x, h - 3, 1, 3);
    });

    // scrub head
    const sx = (this.historyIdx / Math.max(1, recs.length - 1)) * w;
    ctx.strokeStyle = "#7abeff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx + 0.5, 0);
    ctx.lineTo(sx + 0.5, h);
    ctx.stroke();

    const r = recs[Math.min(this.historyIdx, recs.length - 1)];
    const at = this.historyBar.querySelector("#hb-at") as HTMLElement;
    at.textContent = fmtTimestamp(new Date(r.t), TIMEZONE);

    const worst = r.districts
      .map((d, i) => ({ d, name: DISTRICTS[i]?.name ?? `D${i}` }))
      .filter((x) => x.d.speed > 0)
      .sort((a, b) => b.d.congestion - a.d.congestion)
      .slice(0, 3);
    const cell = (k: string, v: string) => `<span class="hb-cell"><i>${k}</i><b>${v}</b></span>`;
    const read = this.historyBar.querySelector("#hb-read") as HTMLElement;
    read.innerHTML =
      cell("CONGESTION", `${Math.round(cityCong(r) * 100)}%`) +
      cell("INCIDENTS", String(r.incidents)) +
      cell("BRIDGES", String(r.bridges)) +
      cell("TRANSIT", String(r.transit)) +
      cell("TEMP", `${r.temp.toFixed(1)}°C`) +
      cell("RAIN", `${r.rain.toFixed(1)}MM/H`) +
      cell("MAAS", `${r.waterCm >= 0 ? "+" : ""}${r.waterCm}CM`) +
      (worst.length
        ? `<span class="hb-cell hb-worst"><i>WORST</i><b>${worst
            .map((x) => `${escapeHtml(x.name)} ${Math.round(x.d.congestion * 100)}%`)
            .join(" · ")}</b></span>`
        : "");
  }

  /** Flip a layer checkbox and apply it, keeping the UI honest about state. */
  private setBox(layer: string, on: boolean) {
    const box = this.ui.layerBoxes.find((b) => b.dataset.layer === layer);
    if (!box) return;
    if (box.checked !== on) {
      box.checked = on;
      this.applyLayer(layer, on);
    } else {
      this.applyLayer(layer, on);
    }
  }

  /**
   * Say that this tab is running old code, and offer the one fix.
   *
   * A chip rather than a toast: a toast that fades has told nobody anything,
   * and this is the difference between watching the city and watching a
   * recording of it. Only ever raised for a visible tab — a hidden one has
   * already reloaded itself.
   */
  offerReload() {
    if (document.getElementById("stale-build")) return;
    const el = document.createElement("button");
    el.id = "stale-build";
    el.innerHTML = `<span class="dot"></span>NEW BUILD — TAP TO RELOAD`;
    el.addEventListener("click", () => location.reload());
    this.ui.hud.appendChild(el);
    this.log("warn", "THIS TAB IS RUNNING AN OLDER BUILD — RELOAD TO PICK UP THE CURRENT ONE");
    // If they background it before tapping, take the reload then: coming back
    // to a fresh app is less disruptive than the page changing under them.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) location.reload();
    });
  }

  setPage(p: typeof this.page) {
    // SETUP only moves simulation variables, and a phone has no simulation
    if (p === "setup" && App.PHONE) p = "map";
    this.page = p;
    // The stylesheet needs to know which page is up: the toast stack and the
    // top-right of a page both want the same corner, and only one of them can
    // have it. Mirrors body[data-mode], which already does this for the modes.
    document.body.dataset.page = p;
    this.ui.navBtns.forEach((b) => {
      const on = b.dataset.page === p;
      b.classList.toggle("on", on);
      if (on) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
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
    // both are simulation readouts and both are hidden on a phone; keep the
    // behaviour with the markup, the same way sim and setup are kept
    if (App.PHONE && (name === "stats" || name === "perf")) name = "units";
    this.ui.dockTabs.forEach((b) => b.classList.toggle("on", b.dataset.dock === name));
    this.ui.dockPages.forEach((p) => p.classList.toggle("on", p.dataset.dockpage === name));
    if (name === "perf") this.renderDistrictTable();
    if (name === "stats") this.renderStats();
    if (name === "transit") this.renderTransit();
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
        // GTFS-RT carries no speed for rail. A vehicle running to a known
        // timetable can still report the speed that timetable implies —
        // labelled SCHED, because it is arithmetic, not a measurement — and
        // every one of them reports how old its last real fix is.
        if (this.track.kind === "liveTransit") {
          const cur = this.layers.fixesLayer?.vehicles.find((v) => v.key === this.track!.key);
          const age = cur ? `FIX ${fmtAge(this.liveFixAge(cur))} AGO` : "FIX AGE UNKNOWN";
          const state = !cur
            ? "IN TRANSIT"
            : cur.plan
              ? cur.speed < 0.5 ? "AT PLATFORM" : `${(cur.speed * 3.6).toFixed(0)} KM/H SCHED`
              : cur.berthed ? "AT PLATFORM" : "IN TRANSIT";
          // A phone fits about three fields. Rather than ellipsing the end —
          // which eats the fix age, the one number that says whether any of
          // this is current — the label drops what it can spare: the word
          // TRACKING (the pulsing dot and the RELEASE button already say it),
          // "· LIVE" (a fix age in seconds says it better), the SCHED
          // qualifier, and the district.
          const speed = cur?.plan && cur.speed >= 0.5 ? `${(cur.speed * 3.6).toFixed(0)} KM/H` : null;
          this.ui.trackLabel.textContent = App.PHONE
            ? `${cur?.label ?? this.track.label} · ${speed ?? state} · ${age}`
            : `TRACKING ${cur?.label ?? this.track.label} · ${state} · ${age} · ${zone}`;
        } else {
          const kmh = `${(st.speed * 3.6).toFixed(0)} KM/H`;
          this.ui.trackLabel.textContent = App.PHONE
            ? `${this.track.label} · ${kmh}`
            : `TRACKING ${this.track.label} · ${kmh} · ${zone}`;
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

  /** panels that have already reported a fault, so the log is not flooded */
  private faulted = new Set<string>();

  /**
   * Run one panel's render without letting it take the tick down with it.
   *
   * Both of this app's heartbeats used to be all-or-nothing: `slowTick` renders
   * six panels in a row every 1.5 seconds and `setLive` three more on every
   * snapshot, and an exception anywhere in either stopped everything after it —
   * a malformed departure row would silently freeze the dock clock, which is
   * the one thing on screen that looks like proof the app is alive.
   *
   * The boundary sanitiser upstream is the real fix for the shapes we know
   * about. This is for the ones we do not: a panel that fails takes itself out
   * and says so once, and the other eight keep running.
   */
  private guard(what: string, fn: () => void) {
    try {
      fn();
    } catch (err) {
      if (this.faulted.has(what)) return;
      this.faulted.add(what);
      const msg = (err as Error)?.message ?? String(err);
      console.error(`[${what}]`, err);
      this.log("crit", `${escapeHtml(what.toUpperCase())} PANEL FAULTED — ${escapeHtml(msg)} · OTHER READOUTS UNAFFECTED`);
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
    // Each panel on its own footing: one that throws must not stop the five
    // behind it, least of all the clock that is the operator's proof the app
    // is still running.
    this.guard("unit card", () => this.selected && this.updateUnitCard());
    this.guard("zone telemetry", () => this.perfState === "live" && this.renderPerfLive());
    this.guard("statistics", () => this.renderStats());
    this.guard("district table", () => this.renderDistrictTable());
    this.guard("transit", () => this.renderTransit());
    this.guard("brief", () => this.page === "brief" && this.renderBrief());
    this.guard("clock", () => this.updateDockClock());
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

  // ---------- dock: transit health ----------

  /**
   * How the network is running, line by line — the aggregate the map cannot
   * show you.
   *
   * The live map draws every vehicle and the boards answer "what is coming
   * here"; neither answers "is anything wrong tonight, and where". This is the
   * only panel in the dock whose every figure is measured, and it needs no
   * simulation, so it is the one that works on a phone.
   *
   * Two states are deliberately different and neither is "fine": a line with
   * vehicles out but no trip reporting a delay is RUNNING with no measurement,
   * and a line the timetable lists with nothing reporting at all is NOT
   * REPORTING. At 05:30 every rail line in the city is the second of those,
   * and a rollup that averaged the zeroes would have called it a perfect
   * network.
   */
  private renderTransit() {
    const wrap = this.ui.transitWrap;
    if (!wrap.closest(".dock-page")?.classList.contains("on")) return;
    const h = transitHealth(this.live);

    if (!this.live) {
      wrap.innerHTML = `<div class="tr-empty">NO LIVE SNAPSHOT HAS REACHED THIS TAB YET</div>`;
      return;
    }
    if (!h.lines.length) {
      wrap.innerHTML = `<div class="tr-empty">NOTHING IN SERVICE AND NOTHING ON THE BOARDS</div>`;
      return;
    }

    const mins = (s: number) => `${s > 0 ? "+" : s < 0 ? "−" : ""}${(Math.abs(s) / 60).toFixed(1)}′`;
    // The boards withhold times on a stale feed for the same reason: a delay
    // measured hours ago is not this line's delay now.
    const fresh = this.liveFresh;
    const ageSec = h.at ? Math.max(0, (Date.now() - Date.parse(h.at)) / 1000) : 0;

    // One render path, two lengths. The dock body is 118px tall and this
    // summary wrapped to four lines on a 390px screen, leaving 18px for the
    // table it is summarising — so the prose is marked up and the stylesheet
    // drops it where there is no room, rather than a second branch here that
    // could drift from this one.
    const both = (long: string, short: string) => `<i class="lg">${long}</i><i class="sm">${short}</i>`;
    const head =
      `<div class="tr-head">` +
      `<span class="src measured">MEASURED</span>` +
      `<span><b>${fmtInt(h.vehicles)}</b>${both(" VEHICLES REPORTING", " VEH")}</span> · ` +
      `<span><b>${fmtInt(h.linesRunning)}</b>${both(" LINES OUT", " LINES")}</span> · ` +
      (fresh && h.medianDelaySec !== null
        ? `<span>${both("NETWORK MEDIAN ", "MED ")}<b>${mins(h.medianDelaySec)}</b>${both(` OVER ${fmtInt(h.linesMeasured)} MEASURED LINE${h.linesMeasured === 1 ? "" : "S"}`, ` /${fmtInt(h.linesMeasured)}`)}</span>`
        : fresh
          ? `<span class="tr-none">${both("NO RUNNING DELAY REPORTED BY ANY TRIP", "NO DELAY REPORTED")}</span>`
          : `<span class="tr-none">${both("FEED STALE — DELAYS WITHHELD", "STALE — WITHHELD")}</span>`) +
      `<span class="tr-age">FIX ${fmtAge(ageSec)} AGO</span></div>`;

    // The dock gives this about three rows, and at rush hour sixty of the
    // eighty-four lines are running to time. Listing them all buries the two
    // that are not, so the default is the exceptions: anything not reporting,
    // anything with no delay data, and anything more than two minutes off.
    // A line running to time is the one thing here nobody needs to read.
    //
    // At night this filter is a no-op — nothing is measured, so nothing is
    // nominal, and the whole "not reporting" picture shows, which is the story
    // at that hour.
    const NOMINAL_SEC = 120;
    const nominal = (l: LineHealth) =>
      fresh && l.state === "measured" && l.medianDelaySec !== null && Math.abs(l.medianDelaySec) < NOMINAL_SEC;
    const hidden = this.trShowAll ? 0 : h.lines.filter(nominal).length;
    const shown = this.trShowAll ? h.lines : h.lines.filter((l) => !nominal(l));
    const filterNote = this.trShowAll
      ? `<button class="tr-filter" id="tr-toggle">SHOW EXCEPTIONS ONLY</button>`
      : hidden
        ? `<span class="tr-nominal">${fmtInt(hidden)} LINE${hidden === 1 ? "" : "S"} WITHIN 2′ OF THE TIMETABLE</span><button class="tr-filter" id="tr-toggle">SHOW ALL</button>`
        : `<button class="tr-filter" id="tr-toggle">SHOW ALL</button>`;

    const rows = shown
      .map((l) => {
        const late = l.medianDelaySec;
        const cls = late === null ? "" : late >= 300 ? "bd-late" : late >= 120 ? "tr-warn" : late <= -60 ? "bd-early" : "bd-ontime";
        const delay =
          !fresh || late === null
            ? `<span class="bd-sched">—</span>`
            : `<span class="${cls}">${mins(late)}</span>`;
        const worst = !fresh || l.worstDelaySec === null ? "—" : mins(l.worstDelaySec);
        // On a stale feed nothing here is a claim about now — the snapshot was
        // true when it was captured and the header says how long ago that was.
        // "MEASURED" in the present tense would be the same mistake the boards
        // avoid by withholding times outright.
        const state =
          l.state === "not-reporting"
            ? `<span class="tr-state tr-off">NOT REPORTING</span>`
            : !fresh
              ? `<span class="tr-state bd-sched">AS OF FIX</span>`
              : l.state === "running"
                ? `<span class="tr-state">RUNNING · NO DELAY DATA</span>`
                : `<span class="tr-state tr-ok">MEASURED</span>`;
        // the sample travels with the average, as it does everywhere else here
        const sample = l.trips ? `${fmtInt(l.trips)} TRIP${l.trips === 1 ? "" : "S"}` : l.scheduled ? `${fmtInt(l.scheduled)} SCHED` : "—";
        return `<tr>
          <td><span class="bd-line k${l.kind}">${escapeHtml(l.line.toUpperCase())}</span></td>
          <td class="tr-kind">${KIND_LABEL[l.kind] ?? ""}</td>
          <td>${l.vehicles ? fmtInt(l.vehicles) : "—"}</td>
          <td>${delay}</td>
          <td class="tr-dim">${worst}</td>
          <td class="tr-dim">${sample}</td>
          <td>${state}</td>
        </tr>`;
      })
      .join("");

    wrap.innerHTML =
      head +
      `<div class="tr-scroll"><table class="district tr-table">
        <thead><tr><th>Line</th><th>Mode</th><th>Out</th><th>Median delay</th><th>Worst</th><th>Sample</th><th>State</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="tr-foot" title="A line's delay is the median of its own trips that reported one. Nothing is inferred from the timetable, and a line with nothing reporting is not a line on time.">${filterNote}<span class="tr-src">RET · OVAPI GTFS-RT — MEDIAN OVER EACH LINE'S OWN REPORTING TRIPS</span></div>`;
    (wrap.querySelector("#tr-toggle") as HTMLButtonElement | null)?.addEventListener("click", () => {
      this.trShowAll = !this.trShowAll;
      this.renderTransit();
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

  /** live toasts by kind, so a burst of the same thing is one line and a count */
  private toastGroups = new Map<string, { el: HTMLElement; n: number; timer: ReturnType<typeof setTimeout> }>();

  /**
   * A short-lived notification, grouped by what it is.
   *
   * Boot fires one of these per live NDW situation, which in practice means
   * five or six identical-shaped warnings in the same second — and stacked
   * three-deep they covered whatever happened to be under them. Grouping is
   * the fix rather than moving them: five obstructions are one fact about the
   * city, not five things to read.
   *
   * The key is the text before the first em dash — the kind of event, without
   * the street. So five obstructions in five districts collapse to the newest
   * one with a ×5 beside it, while an obstruction and a bridge opening stay
   * apart. Each new member restarts the group's clock, so a run of them stays
   * up until it stops rather than expiring while it is still arriving.
   */
  toast(level: "info" | "warn" | "crit", html: string) {
    const key = `${level}:${(html.split("—")[0] ?? html).trim()}`;
    const arm = (g: { el: HTMLElement; n: number; timer: ReturnType<typeof setTimeout> }) => {
      clearTimeout(g.timer);
      g.timer = setTimeout(() => {
        g.el.style.opacity = "0";
        g.el.style.transition = "opacity 400ms";
        setTimeout(() => {
          g.el.remove();
          if (this.toastGroups.get(key) === g) this.toastGroups.delete(key);
          this.syncToastFlag();
        }, 420);
      }, 5200);
    };

    const open = this.toastGroups.get(key);
    if (open && open.el.isConnected) {
      open.n++;
      open.el.innerHTML = `${html}<span class="toast-n">×${open.n}</span>`;
      arm(open);
      this.syncToastFlag(); // a longer line can wrap, and the lane follows it
      return;
    }

    const el = document.createElement("div");
    el.className = `toast ${level}`;
    el.innerHTML = html;
    this.ui.toasts.appendChild(el);
    const group = { el, n: 1, timer: setTimeout(() => {}, 0) };
    this.toastGroups.set(key, group);
    arm(group);
    while (this.ui.toasts.children.length > 3) this.ui.toasts.firstChild?.remove();
    this.syncToastFlag();
  }

  /**
   * Reserve exactly as much of the page as the stack is currently using.
   *
   * Measured rather than guessed: a toast wraps to two lines when its text is
   * long, so any fixed reservation is either wrong for one toast or wasteful
   * for the common case of one. There is no feedback loop to worry about —
   * the stack is positioned against the HUD, not against the page whose
   * padding this sets.
   */
  private syncToastFlag() {
    const n = this.ui.toasts.children.length;
    if (n) {
      document.body.dataset.toasts = "1";
      const h = Math.ceil(this.ui.toasts.getBoundingClientRect().height);
      document.body.style.setProperty("--toast-lane", `${h}px`);
    } else {
      delete document.body.dataset.toasts;
      document.body.style.removeProperty("--toast-lane");
    }
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
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
        <div>
          <h1>Intelligence Brief</h1>
          <div class="sub" id="brief-sub">ROTTERDAM METRO AREA</div>
        </div>
        <button class="action-btn" id="brief-sitrep">Copy SITREP</button>
      </div>
      <div id="brief-grid"></div>
      <div id="brief-cols">
        <div class="panel">
          <div class="p-title" id="brief-chart-title">City flow</div>
          <div id="brief-chart-wrap"><canvas id="brief-chart-canvas"></canvas></div>
          <div id="brief-chart-legend" style="display:flex;gap:18px;margin-top:8px;font-size:9px;color:var(--text-faint);letter-spacing:.12em"></div>
        </div>
        <div class="panel">
          <div class="p-title">Event feed</div>
          <div id="brief-events"></div>
        </div>
      </div>
      <div style="height:12px;flex:none"></div>
      <div class="panel">
        <div class="p-title" id="brief-districts-title">District posture</div>
        <div id="brief-districts" style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px 22px"></div>
      </div>`;
    (this.ui.pageBrief.querySelector("#brief-sitrep") as HTMLButtonElement).addEventListener("click", () =>
      this.copySitrep()
    );
  }

  /**
   * What the sensors actually reported, rolled up for the brief.
   *
   * Every figure here comes off the live snapshot: the NDW station rows, the
   * situation feed, the GTFS-RT fleet. Nothing modelled reaches it. Congestion
   * is measured speed against the posted limit on the edge each station sits
   * on, which is the same arithmetic the sensor-net layer colours itself with —
   * and stations that reported no speed are counted as absent rather than as
   * free-flowing, for the reason the archive already does the same.
   */
  private liveSummary() {
    const snap = this.live;
    const ndw = this.data.ndw;
    if (!snap || !ndw) return null;
    const nd = this.data.meta.districts.length;
    const byDistrict = Array.from({ length: nd }, () => ({ cong: 0, speed: 0, n: 0 }));
    let reporting = 0;
    let speedSum = 0;
    let congSum = 0;
    let flowSum = 0;
    for (const [i, flow, speed] of snap.traffic?.s ?? []) {
      const st = ndw.stations[i];
      if (!st) continue;
      flowSum += flow;
      if (!(speed > 0)) continue;
      const limit = this.data.graph.edges.speed[st.edge] || 50;
      const cong = Math.max(0, Math.min(1, 1 - speed / limit));
      reporting++;
      speedSum += speed;
      congSum += cong;
      const d = byDistrict[this.data.graph.edges.district[st.edge]];
      if (d) {
        d.cong += cong;
        d.speed += speed;
        d.n++;
      }
    }
    const inc = snap.incidents ?? [];
    return {
      stations: ndw.stations.length,
      reporting,
      meanSpeed: reporting ? speedSum / reporting : 0,
      congestion: reporting ? congSum / reporting : 0,
      flow: flowSum,
      incidents: inc.filter((i) => i.kind !== 4).length,
      works: inc.filter((i) => i.kind === 4).length,
      bridges: snap.bridges?.length ?? 0,
      transit: snap.vehicles?.v.length ?? 0,
      at: snap.t,
      districts: byDistrict.map((d) => ({
        congestion: d.n ? d.cong / d.n : 0,
        speed: d.n ? d.speed / d.n : 0,
        stations: d.n,
      })),
    };
  }

  /** The archive record currently under the scrub head, if any. */
  private historyRecord(): ArchiveRecord | null {
    return this.historyRecords[Math.min(this.historyIdx, this.historyRecords.length - 1)] ?? null;
  }

  /**
   * A pasteable summary of what is on screen — of *this* city, not another.
   *
   * It used to refuse outright without simulation metrics ("SITREP UNAVAILABLE
   * — SIM WARMING UP"), which meant the button never worked at all on a phone,
   * where the simulation core is never started and the measured feeds are the
   * entire point. Each mode now reports what it actually has, and every block
   * is labelled MEASURED or MODELLED so the text cannot be read as the wrong
   * kind of claim once it has been pasted somewhere else.
   */
  private copySitrep() {
    const m = this.metrics;
    const c = this.data.meta.counts;
    const lines: string[] = [`SURVEILTRACK SITREP — ROTTERDAM, NL`];

    if (this.mode === "history") {
      const rec = this.historyRecord();
      if (!rec) {
        this.toast("warn", "NOTHING ARCHIVED AT THIS MOMENT — SCRUB TO A RECORDED ONE");
        return;
      }
      const seen = rec.districts.filter((d) => d.speed > 0);
      const cong = seen.length ? seen.reduce((p, d) => p + d.congestion, 0) / seen.length : 0;
      const worst = rec.districts
        .map((d, i) => ({ d, name: DISTRICTS[i]?.name ?? `D${i}` }))
        .filter((x) => x.d.speed > 0)
        .sort((a, b) => b.d.congestion - a.d.congestion)
        .slice(0, 3)
        .map((x) => `${x.name} ${(x.d.congestion * 100).toFixed(0)}%`)
        .join(" · ");
      lines.push(
        `ARCHIVED  ${new Date(rec.t).toISOString().slice(0, 16).replace("T", " ")}Z`,
        `─────────────────────────────────────`,
        `MEASURED  congestion ${(cong * 100).toFixed(0)}% over ${seen.length} reporting district${seen.length === 1 ? "" : "s"}`,
        `HOTTEST   ${worst || "none reporting"}`,
        `EVENTS    ${fmtInt(rec.incidents)} incidents · ${fmtInt(rec.bridges)} bridges open`,
        `TRANSIT   ${fmtInt(rec.transit)} vehicles in service`,
        `WEATHER   ${rec.temp.toFixed(1)}°C · ${rec.rain.toFixed(1)} mm/h · Maas ${rec.waterCm >= 0 ? "+" : ""}${rec.waterCm} cm`
      );
    } else if (this.mode === "live") {
      const live = this.liveSummary();
      if (!live) {
        this.toast("warn", "NO LIVE SNAPSHOT HAS REACHED THIS TAB YET");
        return;
      }
      const worst = live.districts
        .map((d, i) => ({ d, name: DISTRICTS[i]?.name ?? `D${i}` }))
        .filter((x) => x.d.stations > 0)
        .sort((a, b) => b.d.congestion - a.d.congestion)
        .slice(0, 3)
        .map((x) => `${x.name} ${(x.d.congestion * 100).toFixed(0)}%`)
        .join(" · ");
      lines.push(
        `${new Date().toISOString().slice(0, 16).replace("T", " ")}Z · SNAPSHOT ${live.at}${this.liveFresh ? "" : " (STALE)"}`,
        `─────────────────────────────────────`,
        `MEASURED  ${fmtInt(live.reporting)}/${fmtInt(live.stations)} NDW stations reporting · ${fmtInt(live.flow)} veh/h summed`,
        `SPEED     ${live.meanSpeed.toFixed(1)} km/h mean · congestion ${(live.congestion * 100).toFixed(0)}% vs posted limits`,
        `HOTTEST   ${worst || "no district reporting"}`,
        `EVENTS    ${fmtInt(live.incidents)} incidents · ${fmtInt(live.works)} roadworks · ${fmtInt(live.bridges)} bridges open`,
        `TRANSIT   ${fmtInt(live.transit)} vehicles reporting a position (OVapi GTFS-RT)`,
        `GRID      ${fmtInt(c.roadKm)} km road · ${fmtInt(c.pathKm)} km paths · ${fmtInt(c.signalsInventory)} signal heads`
      );
      if (m) {
        lines.push(
          `─────────────────────────────────────`,
          `MODELLED  ${fmtInt(m.active)} tracks · ${m.avgSpeedKmh.toFixed(1)} km/h mean · ${fmtInt(m.queued)} queued`,
          `          (agents on the real graph — no individual vehicle is a real one)`
        );
      }
    } else {
      if (!m) {
        this.toast("warn", "SITREP UNAVAILABLE — SIM WARMING UP");
        return;
      }
      const cal = m.calibration;
      const topDistricts = m.districts
        .map((d, i) => ({ name: DISTRICTS[i].name, cong: d.congestion }))
        .sort((a, b) => b.cong - a.cong)
        .slice(0, 3)
        .map((d) => `${d.name} ${(d.cong * 100).toFixed(0)}%`)
        .join(" · ");
      lines.push(
        `MODELLED · ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z · SIM CLOCK ${fmtSimClock(m.clockMin)}`,
        `─────────────────────────────────────`,
        `TRACKS    ${fmtInt(m.active)} cars · ${fmtInt(m.trucks)} freight · ${fmtInt(m.bikes)} bikes · ${fmtInt(m.walkers)} pedestrians · ${fmtInt(this.layers.transit.vehicleCount)} transit`,
        `FLOW      ${fmtInt(m.throughputMin)} trips/min · mean ${m.avgSpeedKmh.toFixed(1)} km/h · ${fmtInt(m.queued)} queued (${((m.queued / Math.max(1, m.active)) * 100).toFixed(0)}%)`,
        `SIGNALS   ${fmtInt(m.greensNow)}/${fmtInt(c.signalsInventory)} heads green · ${fmtInt(c.junctions)} junctions under control`,
        cal && cal.ratio > 0
          ? `CALIB     ${(cal.ratio * 100).toFixed(1)}% of NDW measured flow · scale 1:${(1 / cal.ratio).toFixed(1)} · ${fmtInt(cal.stations)} stations`
          : `CALIB     no sensor lock`,
        `CONGEST   index ${(m.congestionIndex * 100).toFixed(0)}% · hottest: ${topDistricts}`,
        `INCIDENTS ${fmtInt(m.incidents)} active`,
        `GRID      ${fmtInt(c.roadKm)} km road · ${fmtInt(c.pathKm)} km paths · ${fmtInt(c.buildings)} structures`
      );
    }

    const text = lines.join("\n");
    navigator.clipboard
      ?.writeText(text)
      .then(() => this.toast("info", "<b>SITREP COPIED</b> TO CLIPBOARD"))
      .catch(() => this.toast("warn", "CLIPBOARD BLOCKED — SITREP LOGGED TO MESSAGES"));
    for (const l of lines) this.log("info", escapeHtml(l));
  }

  private renderBrief() {
    const m = this.metrics;
    const c = this.data.meta.counts;
    const live = this.liveSummary();
    const rec = this.historyRecord();
    const mode = this.mode;
    const grid = document.getElementById("brief-grid")!;
    const kpi = (k: string, v: string, s?: string) =>
      `<div class="panel kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s ?? ""}</div></div>`;
    const pct = (v: number) => `${Math.round(v * 100)}<span class="u">%</span>`;

    // Which city this page is about, said out loud.
    //
    // It used to read `this.metrics` and nothing else — so under a header that
    // said LIVE, and a chip that said the feed was hours stale, it presented
    // the simulation's numbers beneath the words "LIVE TRAFFIC POSTURE". That
    // is the exact confusion the mode switch exists to remove, on the page most
    // likely to be screenshotted. Each mode now leads with the figures that
    // mode actually has, and every panel says which kind it is showing.
    const sub = document.getElementById("brief-sub")!;
    const asOf =
      mode === "live"
        ? live
          ? `${fmtTimestamp(new Date(live.at), TIMEZONE)} · ${this.liveFresh ? `${fmtAge((Date.now() - Date.parse(live.at)) / 1000)} OLD` : "FEED STALE"}`
          : "NO SNAPSHOT YET"
        : mode === "history"
          ? rec
            ? fmtTimestamp(new Date(rec.t), TIMEZONE)
            : "NOTHING ARCHIVED IN THIS WINDOW"
          : m
            ? `SIM CLOCK ${fmtSimClock(m.clockMin)}`
            : "WARMING UP";
    sub.innerHTML =
      mode === "live"
        ? `<span class="src measured">MEASURED</span> NDW SENSOR NET · OVAPI TRANSIT · NDW SITUATIONS — ${escapeHtml(asOf)}`
        : mode === "history"
          ? `<span class="src measured">ARCHIVED</span> READING THE SCRUBBED MOMENT — ${escapeHtml(asOf)}`
          : `<span class="src modelled">MODELLED</span> AGENTS ON THE REAL STREET GRAPH — ${escapeHtml(asOf)}`;

    if (mode === "live") {
      grid.innerHTML = live
        ? [
            kpi(
              "Sensor network",
              fmtInt(live.reporting),
              `OF ${fmtInt(live.stations)} STATIONS REPORTING A SPEED`
            ),
            kpi(
              "Measured speed",
              `${live.meanSpeed.toFixed(1)}<span class="u"> KM/H</span>`,
              "MEAN OVER REPORTING STATIONS"
            ),
            kpi(
              "Measured congestion",
              pct(live.congestion),
              "AGAINST THE POSTED LIMIT ON EACH STATION'S EDGE"
            ),
            kpi(
              "Transit in service",
              fmtInt(live.transit),
              "TRAMS · METROS · BUSES · FERRIES REPORTING A POSITION"
            ),
            kpi(
              "Live incidents",
              fmtInt(live.incidents),
              `${fmtInt(live.works)} ROADWORKS · ${fmtInt(live.bridges)} BRIDGE${live.bridges === 1 ? "" : "S"} OPEN`
            ),
            kpi("Signal grid", fmtInt(c.signalsInventory), `${fmtInt(c.junctions)} JUNCTIONS MAPPED`),
          ].join("")
        : `<div class="panel kpi"><div class="k">Sensor network</div><div class="v">—</div><div class="s">NO LIVE SNAPSHOT REACHED THIS TAB YET</div></div>`;
    } else if (mode === "history") {
      const cityCong = rec
        ? (() => {
            const seen = rec.districts.filter((d) => d.speed > 0);
            return seen.length ? seen.reduce((p, d) => p + d.congestion, 0) / seen.length : 0;
          })()
        : 0;
      const seen = rec ? rec.districts.filter((d) => d.speed > 0) : [];
      grid.innerHTML = rec
        ? [
            kpi("Archived congestion", pct(cityCong), `MEAN OVER ${seen.length} MEASURED DISTRICT${seen.length === 1 ? "" : "S"}`),
            kpi(
              "District speed",
              `${(seen.length ? seen.reduce((p, d) => p + d.speed, 0) / seen.length : 0).toFixed(1)}<span class="u"> KM/H</span>`,
              "MEAN OF THE DISTRICTS THAT REPORTED"
            ),
            kpi("Incidents", fmtInt(rec.incidents), `${fmtInt(rec.bridges)} BRIDGE${rec.bridges === 1 ? "" : "S"} OPEN`),
            kpi("Transit in service", fmtInt(rec.transit), `${rec.temp.toFixed(1)}°C · ${rec.rain.toFixed(1)} MM/H RAIN`),
          ].join("")
        : `<div class="panel kpi"><div class="k">Archive</div><div class="v">—</div><div class="s">SCRUB THE ARCHIVE BAR TO A MOMENT THAT WAS RECORDED</div></div>`;
    } else {
      grid.innerHTML = [
        kpi(
          "Active tracks",
          m ? fmtInt(m.active) : "—",
          m ? `${fmtInt(m.bikes)} BIKES · ${fmtInt(m.walkers)} PEDS · ${fmtInt(this.layers.transit.vehicleCount)} TRANSIT` : ""
        ),
        kpi("Network speed", m ? `${m.avgSpeedKmh.toFixed(1)}<span class="u"> KM/H</span>` : "—", m ? `${fmtInt(m.queued)} QUEUED` : ""),
        kpi("Congestion index", m ? pct(m.congestionIndex) : "—", m && m.congestionIndex > 0.4 ? "ELEVATED" : "NOMINAL"),
        kpi("Signal grid", fmtInt(c.signalsInventory), `${fmtInt(c.junctions)} JUNCTIONS · ${m ? fmtInt(m.greensNow) : "—"} GREEN`),
      ].join("");
    }

    // ---- chart ----
    // In HISTORY the series is the archive's own measured congestion; in the
    // other two it is the model's. The panel title carries which, because two
    // unlabelled lines on an unlabelled axis are indistinguishable.
    const chartTitle = document.getElementById("brief-chart-title")!;
    const chartLegend = document.getElementById("brief-chart-legend")!;
    const canvas = document.getElementById("brief-chart-canvas") as HTMLCanvasElement;
    const historySeries = mode === "history" ? this.historyRecords : null;
    chartTitle.innerHTML =
      historySeries
        ? `<span class="src measured">MEASURED</span> Archived congestion across the window`
        : `<span class="src modelled">MODELLED</span> City flow — mean speed / active tracks`;
    chartLegend.innerHTML = historySeries
      ? `<span>— CONGESTION, 0–100%</span>`
      : `<span>— MEAN SPEED, 0–60 KM/H</span><span style="color:${App.TRACKS_INK}">— ACTIVE TRACKS (SCALED TO PEAK)</span>`;
    if (canvas) {
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
        if (vals.length < 2) return;
        ctx.beginPath();
        vals.forEach((v, i) => {
          const x = (i / (vals.length - 1)) * w;
          const y = h - 3 - (Math.min(v, max) / max) * (h - 8);
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.stroke();
      };
      if (historySeries) {
        draw(
          historySeries.map((r) => {
            const seen = r.districts.filter((d) => d.speed > 0);
            return seen.length ? seen.reduce((p, d) => p + d.congestion, 0) / seen.length : 0;
          }),
          1,
          "#ee4444"
        );
      } else {
        const hist = this.cityHistory;
        draw(hist.map((x) => x.speed), 60, "#dedede");
        draw(hist.map((x) => x.active), Math.max(2000, ...hist.map((x) => x.active)) * 1.15, App.TRACKS_INK);
      }
    }

    // ---- events into brief ----
    // Thirty rather than nine: the panel used to be 150px tall whatever the
    // screen, so nine was all that fitted. It now takes the height the page has
    // spare, and nine left most of it blank on anything but a laptop. The panel
    // scrolls, so a short screen is no worse off than before.
    const evWrap = document.getElementById("brief-events")!;
    evWrap.innerHTML = "";
    Array.from(this.ui.msgList.children)
      .slice(0, 30)
      .forEach((n) => evWrap.appendChild(n.cloneNode(true)));

    // ---- district posture ----
    // Measured per-district congestion in LIVE, the archive's in HISTORY, the
    // model's in SIMULATION. A district with no reporting station says so
    // rather than drawing an empty bar that reads as free-flowing.
    const dTitle = document.getElementById("brief-districts-title")!;
    const dWrap = document.getElementById("brief-districts")!;
    const bar = (name: string, cg: number | null, note: string) => {
      const pctv = cg === null ? 0 : Math.round(cg * 100);
      const cls = cg === null ? "" : pctv > 65 ? "crit" : pctv > 40 ? "warn" : "";
      return `<div style="display:flex;flex-direction:column;gap:3px">
        <div style="display:flex;justify-content:space-between;gap:8px;font-size:9.5px;color:var(--text-dim)"><span>${escapeHtml(name.toUpperCase())}</span><span>${cg === null ? note : `${pctv}%`}</span></div>
        <span class="cong-bar ${cls}${cg === null ? " unmeasured" : ""}" style="width:100%"><i style="width:${cg === null ? 0 : Math.min(100, pctv)}%"></i></span>
      </div>`;
    };
    if (mode === "live") {
      dTitle.innerHTML = `<span class="src measured">MEASURED</span> District posture — sensor speed against the limit`;
      dWrap.innerHTML = live
        ? live.districts
            .map((d, i) =>
              bar(DISTRICTS[i]?.name ?? `D${i}`, d.stations ? d.congestion : null, "NO STATION")
            )
            .join("")
        : "";
    } else if (mode === "history") {
      dTitle.innerHTML = `<span class="src measured">ARCHIVED</span> District posture at the scrubbed moment`;
      dWrap.innerHTML = rec
        ? rec.districts
            .map((d, i) => bar(DISTRICTS[i]?.name ?? `D${i}`, d.speed > 0 ? d.congestion : null, "NOT MEASURED"))
            .join("")
        : "";
    } else {
      dTitle.innerHTML = `<span class="src modelled">MODELLED</span> District posture`;
      dWrap.innerHTML = m
        ? m.districts.map((d, i) => bar(DISTRICTS[i]?.name ?? `D${i}`, d.congestion, "")).join("")
        : "";
    }
  }

  // ---------- SETUP ----------
  private buildSetupPage() {
    const p = this.ui.pageSetup;
    p.innerHTML = `
      <h1>Setup</h1>
      <div class="sub">SIMULATION CORE · OBSERVATION GRID · SYSTEM</div>
      <div id="setup-mode-note"><span id="smn-text"></span><button class="action-btn" id="smn-go">Switch to Simulation</button></div>
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
    // The note said "switch to SIMULATION" and left you to find the switch.
    $("smn-go").addEventListener("click", () => {
      this.setMode("sim");
      this.saveSetting("mode", this.mode);
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
    // Mode last, and deliberately after the saved layers: it owns only the
    // seven layers that distinguish a measured city from a modelled one, so
    // personal choices about buildings, water, labels and the rest survive.
    const saved = this.loadSetting<string>("mode");
    this.setMode(saved === "sim" || saved === "history" ? saved : "live");
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
