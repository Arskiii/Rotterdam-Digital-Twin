// Builds the full SurveilTrack DOM chrome and returns element refs.

import { icons } from "./icons";
import { BRAND, LOCATION_LABEL, UNITS } from "../config";

const TICKS = `<i class="tick tl"></i><i class="tick tr"></i><i class="tick bl"></i><i class="tick br"></i>`;

function meterBars(n: number, cls = ""): string {
  return `<span class="meter-bars ${cls}">${"<i></i>".repeat(n)}</span>`;
}

export function buildChrome(root: HTMLElement) {
  root.innerHTML = `
  <aside id="rail">
    <button class="rail-btn" data-rail="menu" title="Modules">${icons.gridDots()}</button>
    <div class="rail-sep"></div>
    <button class="rail-btn on" data-rail="units" title="Units">${icons.drone()}</button>
    <button class="rail-btn" data-rail="integrity" title="Network integrity">${icons.shield()}</button>
    <button class="rail-btn" data-rail="incidents" title="Incidents">${icons.xCircle()}</button>
    <div class="rail-sep"></div>
    <button class="rail-btn" data-rail="secure" title="Secure feeds">${icons.lock()}</button>
    <button class="rail-btn" data-rail="crowd" title="Crowd flows">${icons.people()}</button>
    <button class="rail-btn" data-rail="comms" title="Comms">${icons.headset()}</button>
    <div class="rail-space"></div>
    <button class="rail-btn" data-rail="account" title="Operator">${icons.person()}</button>
    <button class="rail-btn" data-rail="prefs" title="Preferences">${icons.sliders()}</button>
  </aside>

  <div id="stage">
    <header id="topbar" class="brk">${TICKS}
      <div id="brand">${icons.logo()} <span>${BRAND}</span></div>
      <div id="mode-switch" title="What the map is showing">
        <button data-mode="live" class="on">Live</button>
        <button data-mode="sim">Simulation</button>
        <button data-mode="history">History</button>
      </div>
      <nav id="topnav">
        <button class="nav-btn" data-page="brief">Brief</button>
        <button class="nav-btn on" data-page="map">Unit&nbsp;Map</button>
        <button class="nav-btn" data-page="setup">Setup</button>
      </nav>
      <div id="topmeta">
        <span class="meta-item" id="live-chip" title="Live city feeds" style="display:none"><span id="live-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#3ddc84;margin-right:6px"></span><span id="live-text">LIVE</span></span>
        <span class="meta-item">${icons.pin()} <span>${LOCATION_LABEL}</span></span>
        <span class="meta-item">${icons.clock()} <span id="clock">--:--</span></span>
      </div>
    </header>

    <div id="viewport">
      <canvas id="scene-canvas"></canvas>
      <div id="vignette"></div>

      <div id="hud">
        <svg id="tether"><line x1="0" y1="0" x2="0" y2="0" /></svg>
        <div id="markers"></div>

        <div id="scale-switch" class="brk">${TICKS}
          <button data-scale="city" class="on">City</button>
          <button data-scale="district">District</button>
          <button data-scale="street">Street</button>
        </div>

        <div id="track-chip" class="brk">${TICKS}
          <span class="dot red"></span>
          <span id="track-label">TRACKING</span>
          <button id="track-release">Release</button>
        </div>

        <div id="unit-card" class="brk">${TICKS}
          <button class="uc-close" id="uc-close" aria-label="Dismiss unit card">✕</button>
          <div class="uc-image">
            <canvas id="drone-canvas"></canvas>
            <button class="uc-details-btn" id="uc-details">Details ${icons.arrowUpRight()}</button>
          </div>
          <div class="uc-status">
            <span class="status-chip" id="uc-chip"><span class="dot green"></span>ACTIVE</span>
            <span class="uc-id" id="uc-id">—</span>
          </div>
          <div class="uc-rows">
            <div class="uc-row"><span class="k">Power</span><span class="v" id="uc-power">—</span></div>
            <div class="uc-row"><span class="k">Session</span><span class="v" id="uc-session">—</span></div>
            <div class="uc-row"><span class="k">Signal</span><span class="v amber" id="uc-signal">—</span></div>
          </div>
          <div class="uc-tabs">
            <button id="uc-tab-perf" class="on">Performance</button>
            <button id="uc-tab-health">Health</button>
          </div>
        </div>

        <div id="perf-card" class="brk">${TICKS}
          <div id="perf-loading">
            <div class="meter-row">
              ${meterBars(30)}
              <span class="meter-pct" id="perf-pct">0%</span>
            </div>
            <div class="meter-caption" id="perf-caption" style="margin-top:8px">PREPARING PERFORMANCE DETAILS<span class="blink">…</span></div>
          </div>
          <div id="perf-live">
            <div class="pl-title" id="perf-live-title">ZONE PERFORMANCE — 30 MIN</div>
            <canvas id="perf-spark"></canvas>
            <div class="pl-grid" id="perf-grid"></div>
          </div>
        </div>

        <div id="map-tools">
          <button class="tool-btn" id="zoom-in" title="Zoom in">${icons.plus()}</button>
          <button class="tool-btn" id="zoom-out" title="Zoom out">${icons.minus()}</button>
          <div class="tool-gap"></div>
          <button class="tool-btn" id="layers-btn" title="Layers">${icons.layers()}</button>
        </div>

        <div id="layers-pop" class="brk">${TICKS}
          <div class="lp-title">Map layers</div>
          <label><input type="checkbox" data-layer="buildings" checked /><span class="box"></span>Structures</label>
          <label><input type="checkbox" data-layer="roads" checked /><span class="box"></span>Road network</label>
          <label><input type="checkbox" data-layer="signals" checked /><span class="box"></span>Signal units</label>
          <label><input type="checkbox" data-layer="vehicles" checked /><span class="box"></span>Vehicle tracks</label>
          <label><input type="checkbox" data-layer="bikes" checked /><span class="box"></span>Bike tracks</label>
          <label><input type="checkbox" data-layer="pedestrians" checked /><span class="box"></span>Pedestrians</label>
          <label><input type="checkbox" data-layer="congestion" /><span class="box"></span>Congestion flux</label>
          <label><input type="checkbox" data-layer="water" checked /><span class="box"></span>Hydro surface</label>
          <label><input type="checkbox" data-layer="rail" checked /><span class="box"></span>Rail grid</label>
          <label><input type="checkbox" data-layer="transit" checked /><span class="box"></span>Transit fleet</label>
          <label><input type="checkbox" data-layer="bounds" checked /><span class="box"></span>District bounds</label>
          <label><input type="checkbox" data-layer="sensors" checked /><span class="box"></span>Sensor net</label>
          <label><input type="checkbox" data-layer="air" /><span class="box"></span>Air quality</label>
          <label><input type="checkbox" data-layer="fixes" checked /><span class="box"></span>Transit RT fixes</label>
          <label><input type="checkbox" data-layer="labels" checked /><span class="box"></span>Unit labels</label>
          <div class="lp-note" id="lp-synthetic">Vehicle, bike and pedestrian tracks are modelled traffic on the real street graph, obeying the real signals. Volume follows Rotterdam's clock and the measured sensor flows; no individual car is a real one.</div>
        </div>

        <div id="toasts"></div>

        <section id="page-brief" class="page"></section>
        <section id="page-setup" class="page"></section>
      </div>

      <div id="attribution">MAP DATA © OPENSTREETMAP CONTRIBUTORS</div>

      <div id="dock">
        <div id="dock-tabs">
          <button data-dock="units" class="on">Unit list</button>
          <button data-dock="stats">Statistics</button>
          <button data-dock="perf">Performances</button>
          <button data-dock="overview">Overview</button>
          <button data-dock="messages">Messages</button>
          <span id="sim-clock-chip" style="margin-left:auto;align-self:center;padding:4px 10px;border:1px solid var(--line);background:rgba(13,13,13,0.9);font-size:10px;letter-spacing:0.12em;color:var(--text-dim)">SIM --:--</span>
        </div>
        <div id="dock-body">
          <div class="dock-page on" data-dockpage="units">
            <div id="unit-strip">
              ${UNITS.map(
                (u) => `
                <div class="unit-chip brk" data-unit="${u.id}">${TICKS}
                  <span class="status-chip"><span class="dot ${u.status === "active" ? "green" : u.status === "inactive" ? "red" : "gray"}"></span>${u.status.toUpperCase()}</span>
                  <span class="cid">${u.id}</span>
                  <span class="go">${icons.arrowUpRight()}</span>
                </div>`
              ).join("")}
            </div>
            <div id="strip-scroll">
              <button class="sbtn" id="strip-left">${icons.chevronLeft()}</button>
              <div class="track" id="strip-track"><div class="thumb" id="strip-thumb"></div></div>
              <button class="sbtn" id="strip-right">${icons.chevronRight()}</button>
            </div>
          </div>
          <div class="dock-page" data-dockpage="stats"><div id="stats-row"></div></div>
          <div class="dock-page" data-dockpage="perf"><div id="district-table-wrap"></div></div>
          <div class="dock-page" data-dockpage="overview"><div id="overview-page" class="on"></div></div>
          <div class="dock-page" data-dockpage="messages"><div id="msg-list"></div></div>
        </div>
      </div>
    </div>
  </div>

  <div id="boot">
    <div id="boot-inner">
      <div id="boot-brand">${icons.logo(26)} <span>${BRAND}</span><span class="bsub">RTM NODE 04</span></div>
      <div class="boot-stage" data-stage="grid">
        <div class="bs-label"><span>City grid</span><span class="pct">0%</span></div>
        <div class="meter-row">${meterBars(46)}</div>
      </div>
      <div class="boot-stage" data-stage="signals">
        <div class="bs-label"><span>Signal net</span><span class="pct">0%</span></div>
        <div class="meter-row">${meterBars(46)}</div>
      </div>
      <div class="boot-stage" data-stage="structures">
        <div class="bs-label"><span>Structures</span><span class="pct">0%</span></div>
        <div class="meter-row">${meterBars(46)}</div>
      </div>
      <div class="boot-stage" data-stage="sim">
        <div class="bs-label"><span>Sim core</span><span class="pct">0%</span></div>
        <div class="meter-row">${meterBars(46)}</div>
      </div>
      <div id="boot-foot">Establishing uplink — Rotterdam, NL<span class="blink">_</span></div>
      <div id="boot-error"></div>
    </div>
  </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T;

  return {
    rail: $("#rail"),
    clock: $("#clock"),
    liveChip: $("#live-chip"),
    liveDot: $("#live-dot"),
    liveText: $("#live-text"),
    navBtns: Array.from(root.querySelectorAll<HTMLButtonElement>("#topnav .nav-btn")),
    modeBtns: Array.from(root.querySelectorAll<HTMLButtonElement>("#mode-switch button")),
    sceneCanvas: $<HTMLCanvasElement>("#scene-canvas"),
    viewport: $("#viewport"),
    hud: $("#hud"),
    markers: $("#markers"),
    tether: $("#tether") as unknown as SVGSVGElement,
    scaleBtns: Array.from(root.querySelectorAll<HTMLButtonElement>("#scale-switch button")),
    trackChip: $("#track-chip"),
    trackLabel: $("#track-label"),
    trackRelease: $("#track-release"),
    unitCard: $("#unit-card"),
    ucClose: $<HTMLButtonElement>("#uc-close"),
    droneCanvas: $<HTMLCanvasElement>("#drone-canvas"),
    ucDetails: $("#uc-details"),
    ucChip: $("#uc-chip"),
    ucId: $("#uc-id"),
    ucPower: $("#uc-power"),
    ucSession: $("#uc-session"),
    ucSignal: $("#uc-signal"),
    ucTabPerf: $<HTMLButtonElement>("#uc-tab-perf"),
    ucTabHealth: $<HTMLButtonElement>("#uc-tab-health"),
    perfCard: $("#perf-card"),
    perfLoading: $("#perf-loading"),
    perfBars: Array.from($("#perf-loading").querySelectorAll<HTMLElement>(".meter-bars i")),
    perfPct: $("#perf-pct"),
    perfCaption: $("#perf-caption"),
    perfLive: $("#perf-live"),
    perfLiveTitle: $("#perf-live-title"),
    perfSpark: $<HTMLCanvasElement>("#perf-spark"),
    perfGrid: $("#perf-grid"),
    mapTools: $("#map-tools"),
    zoomIn: $("#zoom-in"),
    zoomOut: $("#zoom-out"),
    layersBtn: $("#layers-btn"),
    layersPop: $("#layers-pop"),
    layerBoxes: Array.from(root.querySelectorAll<HTMLInputElement>("#layers-pop input[data-layer]")),
    toasts: $("#toasts"),
    pageBrief: $("#page-brief"),
    pageSetup: $("#page-setup"),
    dockTabs: Array.from(root.querySelectorAll<HTMLButtonElement>("#dock-tabs button")),
    dockPages: Array.from(root.querySelectorAll<HTMLElement>(".dock-page")),
    unitStrip: $("#unit-strip"),
    unitChips: Array.from(root.querySelectorAll<HTMLElement>(".unit-chip")),
    stripLeft: $("#strip-left"),
    stripRight: $("#strip-right"),
    stripTrack: $("#strip-track"),
    stripThumb: $("#strip-thumb"),
    statsRow: $("#stats-row"),
    districtTableWrap: $("#district-table-wrap"),
    overviewPage: $("#overview-page"),
    msgList: $("#msg-list"),
    boot: $("#boot"),
    bootError: $("#boot-error"),
    bootStages: Object.fromEntries(
      Array.from(root.querySelectorAll<HTMLElement>(".boot-stage")).map((el) => [
        el.dataset.stage!,
        {
          bars: Array.from(el.querySelectorAll<HTMLElement>(".meter-bars i")),
          pct: el.querySelector(".pct") as HTMLElement,
        },
      ])
    ) as Record<string, { bars: HTMLElement[]; pct: HTMLElement }>,
  };
}

export type Chrome = ReturnType<typeof buildChrome>;

export function setMeter(bars: HTMLElement[], frac: number) {
  const lit = Math.round(bars.length * Math.max(0, Math.min(1, frac)));
  bars.forEach((b, i) => b.classList.toggle("lit", i < lit));
}

export function barGlyphHTML(frac: number, n = 10): string {
  let out = `<span class="bar-glyph">`;
  const lit = Math.round(n * Math.max(0, Math.min(1, frac)));
  for (let i = 0; i < n; i++) out += `<i class="${i < lit ? "lit" : ""}"></i>`;
  return out + `</span>`;
}
