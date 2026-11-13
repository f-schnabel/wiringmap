const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { join } = require("node:path");

const script = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.js"), "utf8");
const anchor = '  const mount = document.getElementById("app");';
const N = (id, kind, name = id) => ({ id, kind, name, attrs: {} });
const C = (source, target) => ({ kind: "contains", source, target });
const I = (source, target, typeOnly = false) => ({ kind: "imports", source, target, attrs: { type_only: typeOnly } });
const graph = {
  root_name: "test",
  nodes: [
    N("dir:.", "directory"), N("dir:pkg", "directory"),
    N("a", "module", "a.py"), N("b", "module", "b.py"),
    N("c", "module", "c.py"), N("d", "module", "d.py"),
  ],
  edges: [
    C("dir:.", "dir:pkg"), C("dir:pkg", "a"), C("dir:pkg", "b"),
    C("dir:pkg", "c"), C("dir:.", "d"),
    I("a", "b"), I("b", "a", true), I("c", "a"),
    I("a", "d"), I("c", "d"),
  ],
};
const window = {};
const document = { getElementById: () => ({ textContent: JSON.stringify({ graph }) }) };
const htmPreact = { html: () => null, render: () => null };
vm.runInNewContext(script.replace(anchor,
  '  window.testFunctions = { buildView, IMPORT_CYCLES, arrange };\n' + anchor), {
  window, document, htmPreact,
});
const { buildView, IMPORT_CYCLES, arrange } = window.testFunctions;
const view = (expanded = ["dir:pkg"], { size = false, cycles = true, transitive = false } = {}) =>
  buildView(new Set(expanded), "imports", false, new Set(), transitive, size, cycles);
const box = (v, id) => v.elements.find((e) => e.group === "nodes" && e.data.id === id)?.data;
const links = (v) => v.elements.filter((e) => e.group === "edges").map((e) => e.data);

test("import cycle detection includes TYPE_CHECKING edges, excludes other importers", () => {
  assert.equal(IMPORT_CYCLES.groups.length, 1);
  assert.equal(Array.from(IMPORT_CYCLES.groups[0]).join(","), "a,b");
  assert.equal(IMPORT_CYCLES.byModule.has("c"), false);
  assert.equal(IMPORT_CYCLES.edges.has("a\nb"), true);
  assert.equal(IMPORT_CYCLES.edges.has("c\na"), false);
});

test("cyclic modules and arrows are marked; unrelated nodes are not", () => {
  const v = view();
  assert.equal(box(v, "a").cycle, true);
  assert.equal(box(v, "b").cycle, true);
  assert.equal(box(v, "c").cycle, false);
  assert.equal(links(v).filter((e) => e.cycle).length, 2);
});

test("a collapsed folder with an internal cycle is highlighted", () => {
  const v = view([]);
  assert.equal(box(v, "dir:pkg").cycle, true);
  assert.equal(Boolean(box(v, "d").cycle), false);
});

test("hiding cycle highlighting changes no actual graph edges", () => {
  const withCycles = view(["dir:pkg"], { cycles: true });
  const withoutCycles = view(["dir:pkg"], { cycles: false });
  assert.equal(links(withCycles).length, links(withoutCycles).length);
  assert.equal(box(withoutCycles, "a").cycle, false);
  assert.equal(links(withoutCycles).some((e) => e.cycle), false);
});

test("connection-based sizing emphasizes hubs without unbounded growth", () => {
  const normal = view();
  const sized = view(["dir:pkg"], { size: true });
  assert.ok(box(sized, "a").w > box(normal, "a").w);
  assert.ok(box(sized, "a").h > 28);
  assert.equal(box(sized, "a").connections, 3);
  assert.equal(box(sized, "b").connections, 1);
  assert.ok(box(sized, "a").h < 60);
});

test("transitive hiding does not change the size of a node", () => {
  const full = view(["dir:pkg"], { size: true });
  const reduced = view(["dir:pkg"], { size: true, transitive: true });
  assert.equal(box(full, "a").w, box(reduced, "a").w);
  assert.equal(box(full, "a").h, box(reduced, "a").h);
});

function cameraGraph() {
  let position = { x: 0, y: 0 };
  const events = [];
  const item = {
    id: () => "a", isParent: () => false,
    data: (key) => ({ w: 80, kind: "module" })[key],
    position: (value) => value ? (position = value) : position,
    animate: (value) => events.push(["node animate", value]),
  };
  return {
    events,
    nodes: () => ({
      filter: (predicate) => [item].filter(predicate),
      orphans: () => ({ toArray: () => [item] }),
    }),
    edges: () => ({ map: () => [] }),
    viewport: (viewport) => events.push(["viewport", viewport]),
    animate: () => events.push(["viewport animate"]),
    width: () => 1000, height: () => 700, minZoom: () => 0.05,
    elements: () => ({ boundingBox: () => ({ x1: -40, x2: 40, y1: -20, y2: 20, w: 80, h: 40 }) }),
  };
}

test("the initial graph render fits automatically", () => {
  const cy = cameraGraph();
  let finished = false;
  arrange(cy, true, () => { finished = true; }, "layers", true);
  assert.equal(finished, true);
  assert.equal(cy.events.filter(([name]) => name === "viewport").length, 1);
});

test("subsequent graph layouts preserve zoom and pan", () => {
  const cy = cameraGraph();
  arrange(cy, false, () => {}, "layers", false);
  assert.equal(cy.events.some(([name]) => name.startsWith("viewport")), false);
  assert.equal(cy.events.some(([name]) => name === "node animate"), true);
});

test("selecting a node no longer forces a minimum zoom", () => {
  assert.match(script, /cy\.animate\(\{ center: \{ eles: node \} \}/);
  assert.doesNotMatch(script, /zoom: Math\.max\(cy\.zoom\(\), 0\.9\)/);
});
