const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { join } = require("node:path");

const app = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.js"), "utf8");
const css = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.css"), "utf8");

test("leaf modules do not render a misleading expandability dot", () => {
  assert.match(app, /class="matrix-leaf"/);
  assert.doesNotMatch(app, /class="matrix-file-mark"/);
  assert.doesNotMatch(css, /\.matrix-file-mark/);
  assert.match(app, /class="matrix-chevron"/);
});

test("row and column headers carry the corresponding hierarchy depth", () => {
  assert.match(app, /"matrix-depth-" \+ Math\.min\(5, entry\.depth\)/);
  assert.match(app, /"matrix-depth-" \+ Math\.min\(5, from\.depth\)/);
});

test("cells use the deeper row or column level for consistent coloring", () => {
  assert.match(app, /Math\.min\(5, Math\.max\(from\.depth, to\.depth\)\)/);
  assert.match(app, /"matrix-depth-" \+ depth \+ \(diagonal \? " matrix-diagonal"/);
  assert.match(css, /background: var\(--matrix-depth-bg, var\(--panel\)\)/);
});

test("palette distinguishes levels zero through five", () => {
  for (let level = 0; level <= 5; level++)
    assert.match(css, new RegExp("\\.matrix-depth-" + level + "\\s*\\{"));
});

test("heatmap intensity and amber self-imports inherit nesting colors", () => {
  for (const shade of [15, 26, 38, 51, 65])
    assert.ok(css.includes(`var(--accent) ${shade}%, var(--matrix-depth-bg, var(--panel))`));
  assert.ok(css.includes("var(--usedby) 36%, var(--matrix-depth-bg, var(--panel))"));
  assert.match(css, /\.matrix-table td\.matrix-diagonal/);
});
