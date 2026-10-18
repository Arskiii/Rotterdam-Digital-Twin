import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { after, test } from "node:test";
import { createServer } from "vite";

const vite = await createServer({ configFile: false,
  server: { middlewareMode: true, hmr: { server: createHttpServer() } } });
after(() => vite.close());
const { DEFAULT_SETUP, scenarioPair, setupFromPair, sameScenarioPair, timingPresets, matchingPreset, SetupValidationError } = await vite.ssrLoadModule("/src/lab/setup.ts");
const { nearestObservation } = await vite.ssrLoadModule("/src/lab/presentation.ts");

test("lab defaults and every timing preset reproduce the exact report settings", () => {
  for (const candidateMode of ["fixed", "actuated"]) {
    for (const preset of timingPresets(candidateMode)) {
      const setup = { ...DEFAULT_SETUP, ...preset, candidateMode, demandPerHour: 750, baselineMode: "actuated" };
      const pair = scenarioPair(setup);
      assert.equal(matchingPreset(setup), preset.id);
      assert.equal(pair[0].demandPerHour, 750);
      assert.equal(pair[1].demandPerHour, 750);
      assert.equal(pair[0].mode, "actuated");
      assert.equal(pair[0].preference, .5);
      assert.equal(pair[0].minGreen, 6);
      assert.ok(sameScenarioPair(pair, scenarioPair(setupFromPair(...pair))));
      if (candidateMode === "fixed") assert.equal(pair[1].cycleMin + (pair[1].cycleMax - pair[1].cycleMin) * pair[1].preference,
        { short: 50, standard: 65, long: 80 }[preset.id]);
    }
  }
  assert.equal(matchingPreset({ ...DEFAULT_SETUP, minGreen: 5 }), "custom");
});

test("settings comparison ignores inactive controls but detects every model input change", () => {
  const pair = scenarioPair(DEFAULT_SETUP);
  assert.ok(sameScenarioPair(pair, scenarioPair({ ...DEFAULT_SETUP, preference: NaN })));
  assert.ok(!sameScenarioPair(pair, scenarioPair({ ...DEFAULT_SETUP, minGreen: 5 })));
  assert.ok(!sameScenarioPair(pair, scenarioPair({ ...DEFAULT_SETUP, demandPerHour: 0 })));
  for (const [key, value] of Object.entries({ mode: "fixed", demandPerHour: 800, preference: .8, cycleMin: 41,
    cycleMax: 89, minGreen: 5, maxGreen: 31, passageTime: 3 })) {
    assert.ok(!sameScenarioPair(pair, [pair[0], { ...pair[1], [key]: value }]), key);
  }
  const fixed = scenarioPair({ ...DEFAULT_SETUP, candidateMode: "fixed", minGreen: NaN, maxGreen: NaN, passageTime: NaN });
  assert.equal(fixed[1].minGreen, 6);
  assert.equal(fixed[1].passageTime, 2.5);
});

test("invalid active inputs identify the field and zero demand remains valid", () => {
  for (const [change, field] of [
    [{ demandPerHour: NaN }, "scenario-demand"], [{ demandPerHour: -1 }, "scenario-demand"],
    [{ demandPerHour: 4001 }, "scenario-demand"], [{ minGreen: 16 }, "candidate-min-green"],
    [{ minGreen: 15, maxGreen: 10 }, "candidate-max-green"], [{ passageTime: 0 }, "candidate-passage"],
    [{ candidateMode: "fixed", preference: 1.1 }, "candidate-preference"],
    [{ baselineMode: "unknown" }, "baseline-mode"],
  ]) assert.throws(() => scenarioPair({ ...DEFAULT_SETUP, ...change }),
    (error) => error instanceof SetupValidationError && error.fieldId === field);
  assert.equal(scenarioPair({ ...DEFAULT_SETUP, demandPerHour: 0 })[1].demandPerHour, 0);
});

test("chart scrubbing selects real timestamps rather than inventing readings across gaps", () => {
  const samples = [0, 10, 1000].map((minute) => ({ observedAt: new Date(Date.UTC(2026, 9, 18, 0, minute)).toISOString() }));
  for (const [fraction, index] of [[-1, 0], [0, 0], [.005, 0], [.01, 1], [.5, 1], [.505, 1], [.506, 2], [1, 2], [2, 2]]) {
    assert.equal(nearestObservation(samples, fraction), index);
  }
  assert.equal(nearestObservation([], .5), -1);
  assert.equal(nearestObservation(samples, NaN), -1);
  assert.equal(nearestObservation([samples[1]], .8), 0);
  assert.equal(nearestObservation([{ observedAt: "invalid" }], .5), -1);
});
