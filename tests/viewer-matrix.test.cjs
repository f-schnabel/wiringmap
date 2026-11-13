const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.js"), "utf8");
const anchor = '  const mount = document.getElementById("app");';
assert.ok(source.includes(anchor));

const N = (id, kind, name = id) => ({ id, kind, name, attrs: {} });
const E = (source, target, kind = "imports", typeOnly = false) => ({
  source, target, kind, attrs: { type_only: typeOnly },
});
const graph = { root_name: "project", nodes: [
  N("dir:.", "directory"),
  N("demo", "module", "__init__.py"),
  N("demo.cli", "module", "cli.py"),
  N("demo.analysis", "module", "__init__.py"),
  N("demo.analysis.engine", "module", "engine.py"),
  N("demo.types", "module", "types.py"),
  N("utils.helper", "module", "helper.py"),
], edges: [
  E("dir:.", "demo", "contains"),
  E("dir:.", "demo.cli", "contains"),
  E("dir:.", "demo.analysis", "contains"),
  E("dir:.", "demo.analysis.engine", "contains"),
  E("dir:.", "demo.types", "contains"),
  E("dir:.", "utils.helper", "contains"),
  E("demo.cli", "demo.analysis.engine"),
  E("demo.cli", "demo.types"),
  E("demo.analysis.engine", "demo.types", "imports", true),
  E("demo.cli", "utils.helper"),
]};
const architecture = {
  source: "pyproject.toml",
  root_packages: ["demo"],
  contracts: [{ name: "Layers", type: "layers", containers: ["demo"],
    layers: ["cli : server", "analysis", "types"] }],
  check: { status: "passed", output: "All contracts kept." },
};
const window = {};
const document = { getElementById: () => ({ textContent: JSON.stringify({ graph, architecture }) }) };
const htmPreact = { html: () => null, render: () => null };
vm.runInNewContext(source.replace(anchor, '  window.matrixTest = { MATRIX, dependencyMatrix };\n' + anchor), {
  window, document, htmPreact,
});
const matrix = window.matrixTest.MATRIX;

test("matrix uses configured root and declared layer ordering", () => {
  assert.equal(matrix.root, "demo");
  assert.equal(Array.from(matrix.packages).join(","), "cli,analysis,types,(root)");
});

test("matrix includes direct imports but excludes other root packages", () => {
  assert.equal(matrix.total, 3);
  assert.equal(matrix.cells.get("cli\nanalysis").count, 1);
  assert.equal(matrix.cells.get("cli\ntypes").count, 1);
  assert.equal(matrix.cells.get("analysis\ntypes").count, 1);
  assert.equal(matrix.cells.get("analysis\ntypes").typeOnly, 1);
  assert.ok(!matrix.cells.has("cli\nutils"));
});

test("each matrix cell preserves module-level relationships for drilldown", () => {
  const pair = matrix.cells.get("cli\nanalysis").imports[0];
  assert.equal(pair.source, "demo.cli");
  assert.equal(pair.target, "demo.analysis.engine");
});

test("matrix retains edges independently of map transitive filtering", () => {
  assert.equal(matrix.cells.get("cli\ntypes").count, 1);
  assert.match(source, /for \(const e of G\.edges\)/);
  assert.match(source, /function reduceTransitiveLinks/);
});

test("viewer has explicit matrix navigation and contract-status labels", () => {
  assert.match(source, /aria-label="Visualization"/);
  assert.match(source, /setPresentation\("matrix"\)/);
  assert.match(source, /function MatrixInspector/);
  assert.match(source, /Contract definitions are displayed, not reimplemented/);
  assert.match(source, /select\(id, true\)/);
});
