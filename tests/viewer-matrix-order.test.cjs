const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.js"), "utf8");
const anchor = '  const mount = document.getElementById("app");';
assert.ok(source.includes(anchor));
const N = (id, kind) => ({ id, kind, name: id, attrs: {} });
const E = (source, target, kind = "imports") => ({ source, target, kind });
function matrixFor(modules, imports, architecture = null) {
  const graph = {
    root_name: "project", nodes: [
      N("dir:.", "directory"),
      ...modules.map((id) => N(id, "module")),
    ],
    edges: [
      ...modules.map((id) => E("dir:.", id, "contains")),
      ...imports.map(([a, b]) => E(a, b)),
    ],
  };
  const window = {};
  const document = { getElementById: () => ({
    textContent: JSON.stringify({ graph, architecture }),
  }) };
  const htmPreact = { html: () => null, render: () => null };
  vm.runInNewContext(source.replace(anchor,
    '  window.result = MATRIX;\n' + anchor), { window, document, htmPreact });
  return window.result;
}

test("without Import Linter, dependency topology puts importers above their imports", () => {
  const m = matrixFor(["pkg.zulu", "pkg.middle", "pkg.alpha", "pkg"],
    [["pkg.zulu", "pkg.middle"], ["pkg.middle", "pkg.alpha"],
     ["pkg.zulu", "pkg.alpha"]]);
  assert.equal(m.orderSource, "dependency topology");
  const order = [...m.packages];
  assert.ok(order.indexOf("zulu") < order.indexOf("middle"));
  assert.ok(order.indexOf("middle") < order.indexOf("alpha"));
  const indices = new Map(order.map((name, i) => [name, i]));
  for (const cell of m.cells.values())
    if (cell.from !== cell.to)
      assert.ok(indices.get(cell.from) < indices.get(cell.to));
});

test("declared architecture layers take precedence, and unlisted root modules fit by dependency", () => {
  const architecture = {
    root_packages: ["demo"],
    contracts: [{ type: "layers", name: "Layers", containers: ["demo"],
      layers: ["cli : server", "analysis", "types"] }],
  };
  const m = matrixFor(["demo", "demo.cli", "demo.server", "demo.analysis", "demo.types"],
    [["demo.cli", "demo.analysis"], ["demo.analysis", "demo.types"],
     ["demo", "demo.analysis"]], architecture);
  assert.equal(m.orderSource, "Import Linter layers");
  const order = [...m.packages];
  assert.ok(order.indexOf("cli") < order.indexOf("analysis"));
  assert.ok(order.indexOf("server") < order.indexOf("analysis"));
  assert.ok(order.indexOf("analysis") < order.indexOf("types"));
  assert.ok(order.indexOf("(root)") < order.indexOf("analysis"));
});

test("static cycles do not prevent sorting or remove any imports", () => {
  const m = matrixFor(["pkg.one", "pkg.two", "pkg.three"],
    [["pkg.one", "pkg.two"], ["pkg.two", "pkg.one"],
     ["pkg.two", "pkg.three"]]);
  assert.equal(m.total, 3);
  assert.ok(m.packages.indexOf("one") < m.packages.indexOf("three"));
  assert.ok(m.packages.indexOf("two") < m.packages.indexOf("three"));
});

test("diagonal import cells have a separate class and accessible drill-down buttons", () => {
  assert.match(source, /class=\$\{diagonal \? "matrix-diagonal"/);
  assert.match(source, /matrix-self/);
  assert.match(source, /matrix\.orderSource/);
  assert.match(source, /onClick=\$\{\(\) => onCell\(\{ from, to \}\)\}/);
});
