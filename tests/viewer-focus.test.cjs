const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.js"), "utf8");
const anchor = '  const mount = document.getElementById("app");';
const N = (id, kind, name = id) => ({ id, kind, name, path: id + ".py", attrs: {} });
const E = (kind, source, target) => ({ kind, source, target });
const graph = {
  root_name: "test",
  nodes: [
    N("dir:.", "directory"), N("dir:pkg", "directory"),
    N("dir:pkg/sub", "directory"), N("dir:pkg/other", "directory"),
    N("pkg.a", "module"), N("pkg.b", "module"),
    N("pkg.c", "module"), N("pkg.unrelated", "module"),
    N("pkg.a:run", "function"), N("pkg.unrelated:run", "function"),
  ],
  edges: [
    E("contains", "dir:.", "dir:pkg"),
    E("contains", "dir:pkg", "dir:pkg/sub"),
    E("contains", "dir:pkg", "dir:pkg/other"),
    E("contains", "dir:pkg/sub", "pkg.a"),
    E("contains", "dir:pkg/sub", "pkg.b"),
    E("contains", "dir:pkg/other", "pkg.c"),
    E("contains", "dir:pkg/other", "pkg.unrelated"),
    E("contains", "pkg.a", "pkg.a:run"),
    E("contains", "pkg.unrelated", "pkg.unrelated:run"),
    E("imports", "pkg.a", "pkg.b"),
    E("imports", "pkg.c", "pkg.a"),
    E("calls", "pkg.a:run", "pkg.unrelated:run"),
  ],
};
const window = {};
const document = { getElementById: () => ({ textContent: JSON.stringify({ graph }) }) };
const htmPreact = { html: () => null, render: () => null };
vm.runInNewContext(source.replace(anchor,
  '  window.focusTest = { buildView, focusModules };\n' + anchor), {
  window, document, htmPreact,
});
const { buildView, focusModules } = window.focusTest;
const expanded = ["dir:pkg", "dir:pkg/sub", "dir:pkg/other"];
const view = (scope, mode = "imports") =>
  buildView(new Set(expanded), mode, false, new Set(), false, false, true, scope);
const ids = (v) => [...v.elements.filter((e) => e.group === "nodes")
  .map((e) => e.data.id)].sort();
const links = (v) => [...v.elements.filter((e) => e.group === "edges")
  .map((e) => e.data.source + "->" + e.data.target)].sort();

test("folder focus includes descendants only, excluding all outside imports", () => {
  assert.deepEqual([...focusModules("dir:pkg/sub", "imports")].sort(), ["pkg.a", "pkg.b"]);
  const v = view("dir:pkg/sub");
  assert.deepEqual(ids(v), ["dir:pkg", "dir:pkg/sub", "pkg.a", "pkg.b"]);
  assert.deepEqual(links(v), ["pkg.a->pkg.b"]);
});

test("module focus includes incoming and outgoing direct imports but not their neighbors", () => {
  assert.deepEqual([...focusModules("pkg.a", "imports")].sort(), ["pkg.a", "pkg.b", "pkg.c"]);
  const v = view("pkg.a");
  assert.ok(ids(v).includes("pkg.c"));
  assert.ok(!ids(v).includes("pkg.unrelated"));
  assert.deepEqual(links(v), ["pkg.a->pkg.b", "pkg.c->pkg.a"]);
});

test("module focus switches relationships with Calls mode", () => {
  assert.deepEqual([...focusModules("pkg.a", "calls")].sort(), ["pkg.a", "pkg.unrelated"]);
  const v = view("pkg.a", "calls");
  assert.deepEqual(links(v), ["pkg.a->pkg.unrelated"]);
  assert.ok(!ids(v).includes("pkg.b"));
});

test("clearing focus restores all original modules and import links", () => {
  const v = view(null);
  assert.ok(ids(v).includes("pkg.unrelated"));
  assert.ok(ids(v).includes("pkg.c"));
  assert.deepEqual(links(v), ["pkg.a->pkg.b", "pkg.c->pkg.a"]);
});

test("focus is a browser-side graph filter and provides an explicit Show all control", () => {
  assert.match(source, /function focusModules\(scope, mode\)/);
  assert.match(source, /Focus folder/);
  assert.match(source, /Focus module/);
  assert.match(source, /Show all<\/button>/);
  assert.match(source, /setFocusScope\(null\)/);
  assert.match(source, /!hasLaidOut\.current \|\| scopeChanged/);
});
