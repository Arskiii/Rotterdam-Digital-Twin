// Application controller: pages, units, dock, markers, events — everything
// that reacts to user input and simulation telemetry.

import * as THREE from "three";
import type { Chrome } from "./chrome";
import { setMeter, barGlyphHTML } from "./chrome";
import type { SceneCtx, ScaleName } from "../render/scene";
import type { CityMeshes } from "../render/city";
import type { SignalsLayer, VehiclesLayer, CongestionLayer } from "../render/dynamic";
import { DroneViewer } from "../render/drone";
import type { CityData } from "../data/loader";
import type { MetricsMsg, WorkerToMain } from "../sim/protocol";
import { DISTRICTS, UNITS, TIMEZONE, type UnitDef } from "../config";
import { fmtClockAmPm, fmtSimClock, fmtSession, fmtInt, fmtTimestamp, drawSparkline } from "./format";

interface UnitRuntime {
  def: UnitDef;
  x: number; // data coords (east)
  y: number; // north
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

  constructor(
    public ui: Chrome,
    public scene: SceneCtx,
    public data: CityData,
    public meshes: CityMeshes,
    public layers: { signals: SignalsLayer; vehicles: VehiclesLayer; congestion: CongestionLayer },
    public worker: Worker
  ) {
    this.drone = new DroneViewer(ui.droneCanvas);
    this.buildUnits();
    this.buildBriefPage();
    this.buildSetupPage();
    this.buildOverview();
    this.wire();
    this.log("info", "UPLINK ESTABLISHED — SURVEILTRACK NODE 04 ONLINE");
    this.log("info", `CITY GRID LOADED — ${fmtInt(this.data.meta.counts.roadKm)} KM ROADWAY / ${fmtInt(this.data.meta.counts.signalsInventory)} SIGNAL UNITS`);
    this.selectUnit(this.units[0], false);
    setInterval(() => this.slowTick(), 1500);
    setInterval(() => this.flavorEvent(), 26000);
  }

  // ---------- units ----------
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
    this.units.forEach((x) => x.el.classList.toggle("sel", x === u));
    this.ui.unitChips.forEach((c) => c.classList.toggle("sel", c.dataset.unit === u.def.id));
    this.ui.unitCard.classList.add("open");
    this.updateUnitCard();
    this.startPerfLoading();
    if (fly) this.scene.flyTo(new THREE.Vector3(u.x, 0, -u.y), Math.max(2600, Math.min(5200, this.scene.distance)), 1100);
    this.positionPerfCard();
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
      box.addEventListener("change", () => this.applyLayer(box.dataset.layer!, box.checked))
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

    // click empty map: deselect
    this.ui.viewport.addEventListener("pointerdown", (e) => {
      if (e.target === this.scene.renderer.domElement) {
        ui.layersPop.classList.remove("open");
        ui.layersBtn.classList.remove("on");
      }
    });
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
      case "signals": this.layers.signals.points.visible = on; break;
      case "vehicles": this.layers.vehicles.cars.mesh.visible = on; break;
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
        this.layers.vehicles.update(new Float32Array(msg.vehicles), msg.count, this.scene.distance / 950);
        this.layers.signals.update(new Uint8Array(msg.signals));
        break;
      }
      case "metrics": {
        this.metrics = msg;
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
      case "congestion":
        this.layers.congestion.update(new Float32Array(msg.perEdge));
        break;
      case "event":
        this.log(msg.level, msg.text);
        if (msg.level === "crit" || msg.level === "warn") this.toast(msg.level, msg.text);
        break;
      case "ready":
        this.log("ok", `SIM CORE ONLINE — ${fmtInt(msg.laneKm)} LANE-KM UNDER CONTROL`);
        break;
    }
  }

  // ---------- per-frame ----------
  private tmpPt = { x: 0, y: 0 };
  frame(now: number) {
    // markers
    if (this.page === "map") {
      for (const u of this.units) {
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
      ["Bike tracks", fmtInt(m.bikes)],
      ["Pedestrians", fmtInt(m.walkers)],
      ["Flow rate", `${fmtInt(m.throughputMin)}<span class="u"> TRIPS/MIN</span>`],
      ["Mean speed", `${m.avgSpeedKmh.toFixed(1)}<span class="u"> KM/H</span>`],
      ["Queued", fmtInt(m.queued), `${((m.queued / Math.max(1, m.active)) * 100).toFixed(0)}% OF TRACKS`],
      ["Signals green", fmtInt(m.greensNow), `OF ${fmtInt(this.data.meta.counts.signalsInventory)} HEADS`],
      ["Congestion idx", `${Math.round(m.congestionIndex * 100)}<span class="u">%</span>`],
      ["Incidents", fmtInt(m.incidents)],
      ["Sim clock", fmtSimClock(m.clockMin), `DAY COMPRESSION 72×`],
      ["Completed trips", fmtInt(m.completed)],
    ];
    this.ui.statsRow.innerHTML = cards
      .map(
        ([k, v, s]) =>
          `<div class="stat-card"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`
      )
      .join("");
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
        ${line("Rail segments", fmtInt(c.railWays))}
        ${line("Observation districts", fmtInt(this.data.meta.districts.length))}
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
  log(level: "info" | "warn" | "crit" | "ok", text: string) {
    const el = document.createElement("div");
    el.className = "msg";
    el.innerHTML = `<span class="t">${fmtTimestamp(new Date(), TIMEZONE)}</span><span class="lvl ${level}">${level.toUpperCase()}</span><span>${text}</span>`;
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
      <h1>Intelligence Brief</h1>
      <div class="sub">ROTTERDAM METRO AREA — LIVE TRAFFIC POSTURE &amp; NETWORK INTEGRITY</div>
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
  }

  private renderBrief() {
    const m = this.metrics;
    const c = this.data.meta.counts;
    const grid = document.getElementById("brief-grid")!;
    const kpi = (k: string, v: string, s?: string) =>
      `<div class="panel kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s ?? ""}</div></div>`;
    grid.innerHTML = [
      kpi("Active tracks", m ? fmtInt(m.active) : "—", m ? `${fmtInt(m.completed)} TRIPS COMPLETED` : ""),
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
          <div class="field"><div class="f-label"><span>Signal cycle scale</span><b id="su-cycle-v">1.00×</b></div>
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
      </div>`;

    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const dens = $<HTMLInputElement>("su-dens");
    dens.addEventListener("input", () => {
      $("su-dens-v").textContent = fmtInt(+dens.value);
      this.density = +dens.value;
      this.worker.postMessage({ type: "params", density: +dens.value });
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
        this.scene.renderer.setPixelRatio(v === 0 ? Math.min(devicePixelRatio, 2) : v);
        this.scene.resize();
      })
    );
    $("su-sysinfo").innerHTML = `ENGINE: THREE.JS WEBGL2 · SIM: DEDICATED WORKER<br>DATA: OPENSTREETMAP (ODBL) — PROCESSED ${new Date().toISOString().slice(0, 10)}<br>PROJECTION: LOCAL TANGENT PLANE @ 51.9200N 4.4800E`;
  }

  private unitsCountLabel() {
    return `${this.units.length} — ${this.units.filter((u) => u.status === "active").length} ACTIVE`;
  }
}

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
