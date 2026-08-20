#!/usr/bin/env node
// Fail the build if any workflow publishes a data branch without the Vercel
// guard.
//
//   node scripts/check-publish-guards.mjs        (npm run check-workflows)
//
// `live` and `archive` hold data, not an app. Vercel's git integration builds
// every branch it sees, so a push without a vercel.json disabling deployments
// for that branch produces a failed deployment — on 20 Aug that meant one
// failure per refresh tick, for hours, and it survived a first fix because a
// second workflow was publishing the same branch without the guard.
//
// The guard currently lives inside a shell block, which is easy to omit when
// adding a publisher later. This check makes omitting it a build failure
// instead of a surprise in the Vercel dashboard.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const GUARDED = ["live", "archive"];

/** Every `run:` block in a workflow file, as raw text with its step name. */
function runBlocks(text) {
  const out = [];
  const lines = text.split("\n");
  let cur = null;
  let indent = 0;
  let name = "";
  for (const line of lines) {
    const nameMatch = line.match(/^\s*-?\s*name:\s*(.+)$/);
    if (nameMatch && cur === null) name = nameMatch[1].trim();
    const runMatch = line.match(/^(\s*)run:\s*\|/);
    if (runMatch) {
      if (cur) out.push({ name, body: cur.join("\n") });
      cur = [];
      indent = runMatch[1].length;
      continue;
    }
    if (cur !== null) {
      // the block ends at the first non-blank line indented no further than `run:`
      if (line.trim() && line.search(/\S/) <= indent) {
        out.push({ name, body: cur.join("\n") });
        cur = null;
        name = "";
      } else {
        cur.push(line);
      }
    }
  }
  if (cur) out.push({ name, body: cur.join("\n") });
  return out;
}

let failures = 0;
for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(join(DIR, file), "utf8");
  for (const { name, body } of runBlocks(text)) {
    for (const branch of GUARDED) {
      // a push whose target ref is one of the data branches
      const pushes = new RegExp(`git\\s+push[^\\n]*\\s${branch}\\b`).test(body);
      if (!pushes) continue;
      const writesGuard =
        body.includes("vercel.json") &&
        new RegExp(`deploymentEnabled[^\\n]*${branch}`).test(body);
      if (!writesGuard) {
        console.error(
          `✗ ${file} — step "${name}" pushes the \`${branch}\` branch without writing a\n` +
            `  vercel.json that sets git.deploymentEnabled.${branch} = false.\n` +
            `  Vercel builds every branch it sees; \`${branch}\` has no app, so the build\n` +
            `  fails on every push. Add it to the same step, e.g.\n` +
            `    printf '{"git":{"deploymentEnabled":{"${branch}":false}}}' > .../vercel.json`
        );
        failures++;
      }
    }
  }
}

if (failures) {
  console.error(`\n${failures} unguarded data-branch publish(es).`);
  process.exit(1);
}
console.log("workflow publish guards OK — every data-branch push writes its vercel.json");
