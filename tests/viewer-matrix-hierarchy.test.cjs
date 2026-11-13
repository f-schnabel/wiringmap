const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.js"), "utf8");
const anchor = '  const mount = document.getElementById("app");';
assert.ok(source.includes(anchor));
const N = (id, name = id.split(".").at(-1) + ".py", isPackage = false) =>
  ({ id, kind: "module", name, attrs: { is_package: isPackage } });
const I = (source, target, typeOnly = false) =>
  ({ source, target, kind: "imports", attrs: { type_only: typeOnly } });
const ids = [
  "demo", "demo.analysis", "demo.analysis.engine",
  "demo.analysis.engine.base", "demo.analysis.engine.helpers",
  "demo.analysis.utils", "demo.rules", "demo.types",
];
const graph = {
  root_name: "demo",
  nodes: [{ id: "dir:.", kind: "directory", name: "root" },
    ...ids.map((id) => N(id,
      id.split(".").at(-1) + ".py",
      ["demo", "demo.analysis", "demo.analysis.engine"].includes(id)))],
  edges: [
    ...ids.map((id) => ({ kind: "contains", source: "dir:.", target: id })),
    I("demo.analysis.engine.base", "demo.types"),
    I("demo.analysis.engine.helpers", "demo.analysis.engine.base"),
    I("demo.analysis.utils", "demo.analysis.engine.base", true),
    I("demo.analysis", "demo.types"),
    I("demo.rules", "demo.analysis.engine.base"),
    I("demo", "demo.analysis"),
  ],
};
const architecture = {
  root_packages: ["demo"],
  contracts: [{
    name: "Layers", type: "layers", containers: ["demo"],
    layers: ["rules", "analysis", "types"],
  }],
};
const window = {};
const document = { getElementById: () => ({ textContent: JSON.stringify({ graph, architecture }) }) };
const htmPreact = { html: () => null, render: () => null };
vm.runInNewContext(source.replace(anchor,
  '  window.matrixHierarchy = { MATRIX, matrixVisible };\n' + anchor), {
  window, document, htmPreact,
});
const { MATRIX, matrixVisible } = window.matrixHierarchy;
const visible = (open = [], filter = "") => matrixVisible(MATRIX, new Set(open), filter);
const cell = (view, from, to) => view.cells.get(from + "\n" + to);
const idsOf = (view) => Array.from(view.entries, (entry) => entry.id);

test("collapsed view retains original top-level aggregation and declared layer order", () => {
  const data = visible();
  assert.equal(data.total, 6);
  assert.equal(data.total, MATRIX.total);
  assert.equal(cell(data, "analysis", "types").count, 2);
  assert.equal(cell(data, "analysis", "analysis").count, 2);
  assert.ok(MATRIX.packages.indexOf("rules") < MATRIX.packages.indexOf("analysis"));
  assert.ok(MATRIX.packages.indexOf("analysis") < MATRIX.packages.indexOf("types"));
  assert.equal(MATRIX.tree.nodes.get("types").kind, "module");
});

test("expanding a package reveals nested folders and __init__.py without duplicating counts", () => {
  const data = visible(["analysis"]);
  assert.equal(data.total, 6);
  assert.ok(idsOf(data).includes("analysis"));
  assert.ok(idsOf(data).includes("analysis.engine"));
  assert.ok(idsOf(data).includes("module:demo.analysis"));
  assert.ok(idsOf(data).includes("analysis.utils"));
  assert.equal(MATRIX.tree.nodes.get("module:demo.analysis").label, "__init__.py");
  assert.equal(MATRIX.tree.nodes.get("analysis.utils").label, "utils.py");
  assert.equal(data.rowTotals.has("analysis"), false);
  assert.equal(cell(data, "module:demo.analysis", "types").count, 1);
  assert.equal(cell(data, "analysis.engine", "types").count, 1);
  assert.equal(cell(data, "analysis.utils", "analysis.engine").typeOnly, 1);
});

test("expanding deeper moves aggregate edges into their concrete module cells", () => {
  const shallow = visible(["analysis"]);
  const deep = visible(["analysis", "analysis.engine"]);
  assert.equal(shallow.total, deep.total);
  assert.equal(deep.total, MATRIX.total);
  assert.ok(idsOf(deep).includes("module:demo.analysis.engine"));
  assert.ok(idsOf(deep).includes("analysis.engine.base"));
  assert.ok(idsOf(deep).includes("analysis.engine.helpers"));
  assert.equal(deep.rowTotals.has("analysis.engine"), false);
  assert.equal(cell(deep, "analysis.engine.base", "types").count, 1);
  assert.equal(cell(deep, "analysis.engine.helpers", "analysis.engine.base").count, 1);
  assert.equal(cell(deep, "analysis.utils", "analysis.engine.base").typeOnly, 1);
  assert.equal(cell(deep, "rules", "analysis.engine.base").count, 1);
  assert.equal(cell(deep, "analysis.engine", "analysis.engine"), undefined);
});

test("collapsing a nested package restores that package rollup exactly", () => {
  const before = visible(["analysis"]);
  const expanded = visible(["analysis", "analysis.engine"]);
  assert.ok(expanded.entries.length > before.entries.length);
  const restored = visible(["analysis"]);
  assert.equal(restored.total, before.total);
  assert.equal(restored.entries.length, before.entries.length);
  assert.equal(cell(restored, "analysis.engine", "analysis.engine").count, 1);
});

test("filtering nested names expands ancestors for navigation without double-counting", () => {
  const data = visible([], "engine");
  assert.ok(idsOf(data).includes("analysis"));
  assert.ok(idsOf(data).includes("analysis.engine"));
  assert.ok(!idsOf(data).includes("rules"));
  assert.ok(!idsOf(data).includes("types"));
  assert.equal(data.total, 1);
  const filtered = visible(["analysis.engine"], "engine");
  assert.ok(idsOf(filtered).includes("analysis.engine.base"));
  assert.equal(filtered.total, 1);
});

test("matrix keeps expansion state in the app and supports row/column toggles", () => {
  assert.match(source, /const \[matrixExpanded, setMatrixExpanded\] = useState/);
  assert.match(source, /aria-expanded=\$\{entry\.expanded\}/);
  assert.match(source, /class=\$\{"matrix-column-head matrix-depth-" \+ Math\.min\(5, entry\.depth\)/);
  assert.match(source, /Expand one level/);
  assert.match(source, /Collapse all/);
  assert.match(source, /onCell\(\{\s*from: from\.id, to: to\.id/);
});
