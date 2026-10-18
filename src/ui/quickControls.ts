import type { World } from "../sim/world";

export function createQuickControls(world: World, resetView: () => void, topView: () => void) {
  const bar = document.createElement("div");
  bar.className = "map-toolbar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Map and simulation controls");
  const pause = document.createElement("button");
  pause.className = "primary";
  pause.addEventListener("click", () => { world.paused = !world.paused; update(); });
  const speed = document.createElement("select");
  speed.setAttribute("aria-label", "Simulation speed");
  for (const value of [1, 2, 5, 10]) {
    const option = document.createElement("option");
    option.value = String(value);
    option.textContent = `${value}× speed`;
    speed.append(option);
  }
  speed.addEventListener("change", () => { world.timeScale = Number(speed.value); });
  const home = document.createElement("button");
  home.textContent = "Reset view";
  home.addEventListener("click", resetView);
  const plan = document.createElement("button");
  plan.textContent = "Top view";
  plan.addEventListener("click", topView);
  const state = document.createElement("span");
  state.id = "sim-state";
  bar.append(pause, speed, home, plan, state);
  document.body.append(bar);
  function update() {
    pause.textContent = world.paused ? "Resume" : "Pause";
    pause.setAttribute("aria-label", world.paused ? "Resume simulation" : "Pause simulation");
    state.textContent = world.paused ? "Simulation paused" : "Simulation running";
    // Advanced controls may select speeds other than the quick presets.
    const value = String(world.timeScale);
    if (![...speed.options].some((option) => option.value === value)) {
      speed.querySelector("[data-custom]")?.remove();
      const option = document.createElement("option");
      option.value = value; option.textContent = `${value}× speed`; option.dataset.custom = "true";
      speed.append(option);
    }
    speed.value = value;
  }
  update();
  return update;
}
