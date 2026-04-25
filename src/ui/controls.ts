import GUI from "lil-gui";
import type { World } from "../sim/world";

// All knobs are bound directly to live World state, so changes apply on the next tick.
export function createControls(world: World, onReset: () => void) {
  const gui = new GUI({ title: "Rotterdam Twin · Controls" });

  const sim = gui.addFolder("Simulation");
  sim.add(world, "paused").name("Pause");
  sim.add(world, "timeScale", 0.1, 10, 0.1).name("Sim speed (x)");
  sim.add({ reset: onReset }, "reset").name("Reset");

  const traffic = gui.addFolder("Traffic demand");
  traffic.add(world.spawner, "carsPerHour", 0, 4000, 50).name("Cars / hour (total)");
  traffic.add(world, "maxVehicles", 50, 2000, 50).name("Max active cars");

  const lights = gui.addFolder("Traffic lights");
  // Preference slider is the headline knob. It interpolates cycle length:
  //   0  -> shorter cycles, lower wait but more startup loss (lower max throughput)
  //   1  -> longer cycles, higher max throughput but worse worst-case wait
  lights
    .add(world.lights, "preference", 0, 1, 0.01)
    .name("Throughput ↔ wait pref.");
  lights.add(world.lights, "cycleMin", 10, 60, 1).name("Cycle min (s)");
  lights.add(world.lights, "cycleMax", 30, 180, 1).name("Cycle max (s)");
  lights.add(world.lights, "yellow", 1, 6, 0.5).name("Yellow (s)");

  // Open the most-used folders.
  traffic.open();
  lights.open();

  return gui;
}
