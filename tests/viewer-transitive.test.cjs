const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { join } = require("node:path");

// The same offline viewer functions used by the generated HTML report.
const source = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.js"), "utf8");
const anchor = '  const mount = document.getElementById("app");';
assert.ok(source.includes(anchor));
const N = (id, kind, name = id) => ({ id, kind, name, attrs: {} });
const C = (source, target) => ({ kind: "contains", source, target });
const I = (source, target) => ({ kind: "imports", source, target });
const F = (source, target) => ({ kind: "calls", source, target });
const graph = {
  root_name: "sample", nodes: [
    N("dir:.", "directory"), N("dir:pkg", "directory"),
    N("dir:pkg/core", "directory"),
    N("pkg.a", "module", "a.py"), N("pkg.d", "module", "d.py"),
    N("pkg.core.b", "module", "b.py"), N("pkg.core.c", "module", "c.py"),
    N("pkg.a:f", "function"), N("pkg.core.b:f", "function"),
    N("pkg.core.c:f", "function"),
  ],
  edges: [
    C("dir:.", "dir:pkg"), C("dir:pkg", "dir:pkg/core"),
    C("dir:pkg", "pkg.a"), C("dir:pkg", "pkg.d"),
    C("dir:pkg/core", "pkg.core.b"), C("dir:pkg/core", "pkg.core.c"),
    C("pkg.a", "pkg.a:f"), C("pkg.core.b", "pkg.core.b:f"),
    C("pkg.core.c", "pkg.core.c:f"),
    I("pkg.a", "pkg.core.b"), I("pkg.a", "pkg.core.c"),
    I("pkg.core.b", "pkg.core.c"), I("pkg.core.b", "pkg.d"),
    I("pkg.core.c", "pkg.d"), I("pkg.a", "pkg.d"),
    F("pkg.a:f", "pkg.core.b:f"),
    F("pkg.core.b:f", "pkg.core.c:f"),
    F("pkg.a:f", "pkg.core.c:f"),
  ],
};
const window = {};
const document = { getElementById: () => ({ textContent: JSON.stringify({ graph }) }) };
const htmPreact = { html: () => null, render: () => null };
vm.runInNewContext(source.replace(anchor,
  '  window.transitiveTests = { buildView, reduceTransitiveLinks };\n' + anchor), {
  window, document, htmPreact,
});
const { buildView, reduceTransitiveLinks } = window.transitiveTests;
const view = (expanded, mode = "imports", muted = [], reduce = true) =>
  buildView(new Set(expanded), mode, false, new Set(muted), reduce);
const edges = (v) => [...v.elements.filter((e) => e.group === "edges")
  .map((e) => `${e.data.source}->${e.data.target}`)].sort();
const open = ["dir:pkg", "dir:pkg/core"];

test("direct A -> C is hidden only when another path A -> B -> C exists", () => {
  const full = view(open, "imports", [], false);
  const reduced = view(open);
  assert.equal(full.omittedLinks, 0);
  assert.equal(reduced.omittedLinks, 3);
  assert.deepEqual(edges(reduced), [
    "pkg.a->pkg.core.b", "pkg.core.b->pkg.core.c", "pkg.core.c->pkg.d",
  ]);
  assert.equal(full.elements.filter((e) => e.group === "edges").length, 6);
});

test("collapsed folder aggregation is reduced using visible folder edges", () => {
  const reduced = view(["dir:pkg"]);
  assert.deepEqual(edges(reduced), ["dir:pkg/core->pkg.d", "pkg.a->dir:pkg/core"]);
  assert.equal(reduced.omittedLinks, 1);
  const aggregated = reduced.elements.find((e) => e.data.source === "pkg.a");
  assert.equal(aggregated.data.n, 2, "retained arrow keeps its original import count");
});

test("hiding a node recomputes reachable edges without changing graph data", () => {
  assert.deepEqual(edges(view(open, "imports", ["pkg.core.b"])), [
    "pkg.a->pkg.core.c", "pkg.core.c->pkg.d",
  ]);
  assert.deepEqual(edges(view(open, "imports", [], false)), [
    "pkg.a->pkg.core.b", "pkg.a->pkg.core.c", "pkg.a->pkg.d",
    "pkg.core.b->pkg.core.c", "pkg.core.b->pkg.d", "pkg.core.c->pkg.d",
  ]);
});

test("Calls view always keeps direct calls even when transitive hiding is enabled", () => {
  assert.deepEqual(edges(view(open, "calls")), [
    "pkg.a->pkg.core.b", "pkg.a->pkg.core.c", "pkg.core.b->pkg.core.c",
  ]);
  assert.equal(view(open, "calls").omittedLinks, 0);
});

test("cycles preserve internal imports and one real bridge to each downstream group", () => {
  const data = [["a", "b"], ["b", "a"], ["a", "z"], ["b", "z"]];
  const keep = reduceTransitiveLinks(data.map(([s, t]) => ({ s, t })))
    .map((e) => `${e.s}->${e.t}`).sort();
  assert.deepEqual(keep, ["a->b", "a->z", "b->a"]);
});

test("alternate routes through cycles do not remove the only bridge", () => {
  const data = [["a", "b"], ["b", "a"], ["a", "z"]];
  const keep = reduceTransitiveLinks(data.map(([s, t]) => ({ s, t })))
    .map((e) => `${e.s}->${e.t}`).sort();
  assert.deepEqual(keep, ["a->b", "a->z", "b->a"]);
});

test("parallel diamond paths are retained while a shortcut is removed", () => {
  const data = [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"], ["a", "d"]];
  const keep = reduceTransitiveLinks(data.map(([s, t]) => ({ s, t })))
    .map((e) => `${e.s}->${e.t}`).sort();
  assert.deepEqual(keep, ["a->b", "a->c", "b->d", "c->d"]);
});
