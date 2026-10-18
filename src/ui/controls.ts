import GUI, { type Controller } from "lil-gui";
import type { World } from "../sim/world";

// All knobs are bound directly to live World state, so changes apply on the next tick.
// `onResetView`, if provided, snaps the camera back to its default frame.
export function createControls(
  world: World,
  onReset: () => void,
  onResetView?: () => void,
) {
  const gui = new GUI({ title: "Advanced controls", container: document.getElementById("simulation-settings") ?? undefined });

  const sim = gui.addFolder("Simulation");
  sim.add(world, "paused").name("Pause").listen();
  sim.add(world, "timeScale", 0.1, 10, 0.1).name("Sim speed (x)").listen();
  sim.add({ reset: onReset }, "reset").name("Reset");
  if (onResetView) {
    sim.add({ resetView: onResetView }, "resetView").name("Reset view");
  }

  const traffic = gui.addFolder("Traffic demand");
  const demand = {
    get carsPerHour() { return world.spawner.carsPerHour; },
    set carsPerHour(value: number) { world.spawner.carsPerHour = value; },
  };
  traffic.add(demand, "carsPerHour", 0, 4000, 50).name("Cars / hour (total)");
  traffic.add(world, "maxVehicles", 50, 2000, 50).name("Max active cars");

  const signal = gui.addFolder("Signal control");
  // Yellow is shared between both controllers — keep the value mirrored so swapping mode
  // doesn't change the inter-phase clearance the user just dialed in.
  const yellowProxy = {
    get yellow() { return world.fixedLights.yellow; },
    set yellow(value: number) {
      world.fixedLights.yellow = value;
      world.actuatedLights.yellow = value;
    },
  };
  signal
    .add(yellowProxy, "yellow", 1, 6, 0.5)
    .name("Yellow (s)");

  const fixed = gui.addFolder("Fixed-time");
  // Preference slider is the headline knob. It interpolates cycle length:
  //   0  -> shorter cycles, lower wait but more startup loss (lower max throughput)
  //   1  -> longer cycles, higher max throughput but worse worst-case wait
  const fixedProxy = {
    get preference() { return world.fixedLights.preference; },
    set preference(value: number) { world.fixedLights.preference = value; },
    get cycleMin() { return world.fixedLights.cycleMin; },
    set cycleMin(value: number) { world.fixedLights.cycleMin = value; },
    get cycleMax() { return world.fixedLights.cycleMax; },
    set cycleMax(value: number) { world.fixedLights.cycleMax = value; },
  };
  const fixedControls: Controller[] = [
    fixed.add(fixedProxy, "preference", 0, 1, 0.01).name("Throughput ↔ wait pref."),
    fixed.add(fixedProxy, "cycleMin", 10, 60, 1).name("Cycle min (s)"),
    fixed.add(fixedProxy, "cycleMax", 30, 180, 1).name("Cycle max (s)"),
  ];

  const actuated = gui.addFolder("Actuated");
  const actuatedProxy = {
    get minGreen() { return world.actuatedLights.minGreen; },
    set minGreen(value: number) { world.actuatedLights.minGreen = value; },
    get maxGreen() { return world.actuatedLights.maxGreen; },
    set maxGreen(value: number) { world.actuatedLights.maxGreen = value; },
    get passageTime() { return world.actuatedLights.passageTime; },
    set passageTime(value: number) { world.actuatedLights.passageTime = value; },
  };
  const actuatedControls: Controller[] = [
    actuated.add(actuatedProxy, "minGreen", 1, 15, 0.5).name("Min green (s)"),
    actuated.add(actuatedProxy, "maxGreen", 10, 60, 1).name("Max green (s)"),
    actuated.add(actuatedProxy, "passageTime", 0.5, 5, 0.1).name("Passage time (s)"),
  ];

  function applyEnabled() {
    const isFixed = world.mode === "fixed";
    for (const c of fixedControls) (isFixed ? c.enable() : c.disable());
    for (const c of actuatedControls) (isFixed ? c.disable() : c.enable());
  }

  signal
    .add(world, "mode", { "Fixed-time": "fixed", "Actuated": "actuated" })
    .name("Mode")
    .onChange(() => applyEnabled());
  applyEnabled();

  // Open the most-used folders.
  traffic.open();
  signal.open();
  fixed.open();
  actuated.open();

  return gui;
}
