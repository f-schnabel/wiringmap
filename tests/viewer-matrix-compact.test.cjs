const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { join } = require("node:path");

const app = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.js"), "utf8");
const css = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.css"), "utf8");

test("matrix column labels rotate without changing the row labels", () => {
  assert.match(app, /class="matrix-column-label"/);
  assert.match(app, /class="matrix-row-name"/);
  assert.match(css, /writing-mode: vertical-rl;\s*transform: rotate\(180deg\)/);
  assert.match(css, /\.matrix-table thead \.matrix-column-label \.matrix-tree-toggle/);
});

test("matrix columns are narrow and do not stretch to fill the viewport", () => {
  assert.match(css, /\.matrix-table thead th\.matrix-column-head\s*\{/);
  assert.match(css, /width: 30px;\s*min-width: 30px;\s*max-width: 30px/);
  assert.match(css, /width: max-content;\s*font-size: 11px/);
  assert.doesNotMatch(css, /width: max-content;\s*min-width: 100%/);
});

test("counts and click targets use the compact dimensions", () => {
  assert.match(css, /min-width: 26px;\s*min-height: 19px;\s*padding: 0 1px/);
  assert.match(css, /font: 650 11px\/1\.1 var\(--mono\)/);
  assert.match(app, /onClick=\$\{\(\) => onCell\(\{/);
});

test("hierarchy indicators and title tooltips remain available", () => {
  assert.match(app, /aria-expanded=\$\{entry\.expanded\}/);
  assert.match(app, /class="matrix-tree-toggle" title=\$\{entry\.path\}/);
  assert.match(app, /class="matrix-leaf" title=\$\{entry\.path\}/);
});

test("depth colors and heatmap are preserved with compact cells", () => {
  assert.match(css, /\.matrix-table td\.matrix-diagonal \.matrix-value/);
  assert.match(css, /\.matrix-value\.heat-5/);
  assert.match(css, /background: var\(--matrix-depth-bg, var\(--panel\)\)/);
});
