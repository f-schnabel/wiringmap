const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.js"), "utf8");
const anchor = '  const mount = document.getElementById("app");';
assert.ok(source.includes(anchor));

const domListeners = new Map();
const window = {
  addEventListener(name, fn) { domListeners.set(name, fn); },
  removeEventListener(name, fn) {
    if (domListeners.get(name) === fn) domListeners.delete(name);
  },
};
const graph = { root_name: "test", nodes: [{ id: "dir:.", kind: "directory", name: "root" }], edges: [] };
const document = { getElementById: () => ({ textContent: JSON.stringify({ graph }) }) };
const htmPreact = { html: () => null, render: () => null };
vm.runInNewContext(source.replace(anchor,
  '  window.interactionTest = { configureInteraction, attachDoubleClickDrag };\n' + anchor), {
  window, document, htmPreact,
});
const { configureInteraction, attachDoubleClickDrag } = window.interactionTest;

function collection() {
  return {
    pannable: false, selectable: true,
    panify() { this.pannable = true; return this; },
    unselectify() { this.selectable = false; return this; },
  };
}
function node(id, kind = "module", x = 100, y = 50, children = []) {
  let pos = { x, y };
  return {
    id: () => id, data: (name) => name === "kind" ? kind : undefined,
    position(value) { if (value) pos = value; return pos; },
    removed: () => false,
    isParent: () => children.length > 0,
    descendants: () => ({
      filter: (predicate) => ({ toArray: () => children.filter(predicate) }),
    }),
  };
}
function graphView() {
  const listeners = new Map(), nodes = collection();
  let edges = collection(), panning = true;
  const toggled = [];
  const cy = {
    nodes: () => nodes,
    edges: () => edges,
    replaceEdges: () => { edges = collection(); },
    container: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    on(name, selector, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn || selector);
    },
    off(name, selector, fn) {
      const registered = listeners.get(name) || [];
      listeners.set(name, registered.filter((callback) => callback !== fn));
    },
    zoom: () => 2,
    userPanningEnabled(value) {
      if (value !== undefined) panning = value;
      return panning;
    },
    batch(fn) { fn(); },
  };
  const emit = (type, target, x = 10, y = 20, native = {}) => {
    for (const listener of listeners.get(type) || [])
      listener({
        target, renderedPosition: { x, y },
        originalEvent: { button: 0, type: "mousedown", ...native },
      });
  };
  const win = (type, value = {}) => {
    const fn = domListeners.get(type);
    if (fn) fn(value);
  };
  const cleanup = attachDoubleClickDrag(cy, (id) => toggled.push(id));
  return { cy, emit, win, cleanup, toggled, listeners, isPannable: () => panning };
}
function firstClick(view, target, x = 10, y = 20) {
  view.emit("tapstart", target, x, y);
  view.emit("tap", target, x, y);
}
function secondDown(view, target, x = 10, y = 20) {
  view.emit("tapstart", target, x, y);
}

test("regular left drag continues to pan and edges remain click-through", () => {
  const v = graphView();
  configureInteraction(v.cy);
  const a = node("a");
  v.emit("tapstart", a);
  assert.equal(v.isPannable(), true);
  assert.equal(v.cy.nodes().pannable, true);
  assert.equal(v.cy.edges().pannable, true);
  assert.equal(v.cy.edges().selectable, false);
  assert.equal(domListeners.has("mousemove"), false);
  v.cleanup();
  assert.match(source, /selector: "edge", style: \{ "events": "no", "text-events": "no" \}/);
});

test("double-click, hold second click, and drag moves a module without panning", () => {
  const v = graphView(), a = node("a");
  firstClick(v, a);
  secondDown(v, a);
  assert.equal(v.isPannable(), false);
  v.win("mousemove", { clientX: 50, clientY: 40, buttons: 1 });
  assert.equal(a.position().x, 120);
  assert.equal(a.position().y, 60);
  v.win("mouseup", { clientX: 70, clientY: 60, buttons: 0 });
  assert.equal(a.position().x, 130);
  assert.equal(a.position().y, 70);
  assert.equal(v.isPannable(), true);
  assert.equal(v.toggled.length, 0);
  v.cleanup();
});

test("double-click-and-drag moves all leaf modules in an expanded package", () => {
  const v = graphView();
  const a = node("a", "module", 10, 20), b = node("b", "module", 50, 60);
  const group = node("folder", "group", 0, 0, [a, b]);
  firstClick(v, group, 5, 5);
  secondDown(v, group, 5, 5);
  v.win("mousemove", { clientX: 25, clientY: 25, buttons: 1 });
  assert.equal(a.position().x, 20);
  assert.equal(a.position().y, 30);
  assert.equal(b.position().x, 60);
  assert.equal(b.position().y, 70);
  v.win("mouseup", { clientX: 25, clientY: 25, buttons: 0 });
  assert.equal(v.toggled.length, 0);
  v.cleanup();
});

test("quick double-click with no movement still expands or collapses a folder", () => {
  const v = graphView(), folder = node("folder", "folder");
  firstClick(v, folder);
  secondDown(v, folder);
  v.win("mouseup", { clientX: 10, clientY: 20, buttons: 0 });
  assert.deepEqual(v.toggled, ["folder"]);
  assert.equal(v.isPannable(), true);
  v.emit("tap", folder);
  assert.deepEqual(v.toggled, ["folder"], "must not toggle twice");
  v.cleanup();
});

test("a held second click without moving does not shift positions", () => {
  const v = graphView(), a = node("a");
  firstClick(v, a);
  secondDown(v, a);
  v.win("mousemove", { clientX: 12, clientY: 22, buttons: 1 });
  v.win("mouseup", { clientX: 12, clientY: 22, buttons: 0 });
  assert.equal(a.position().x, 100);
  assert.equal(a.position().y, 50);
  v.cleanup();
});

test("single clicks on different nodes don't trigger dragging", () => {
  const v = graphView(), a = node("a"), b = node("b");
  firstClick(v, a);
  secondDown(v, b);
  assert.equal(v.isPannable(), true);
  assert.equal(domListeners.has("mousemove"), false);
  v.cleanup();
});

test("right mouse button or touch cannot initiate the move gesture", () => {
  const v = graphView(), a = node("a");
  firstClick(v, a);
  v.emit("tapstart", a, 10, 20, { button: 2 });
  assert.equal(v.isPannable(), true);
  firstClick(v, a);
  v.emit("tapstart", a, 10, 20, { pointerType: "touch" });
  assert.equal(v.isPannable(), true);
  v.cleanup();
});

test("losing focus cancels the move and restores viewport panning", () => {
  const v = graphView(), a = node("a");
  firstClick(v, a);
  secondDown(v, a);
  assert.equal(v.isPannable(), false);
  v.win("blur");
  assert.equal(v.isPannable(), true);
  assert.equal(domListeners.has("mousemove"), false);
  v.cleanup();
});

test("cleanup during drag restores panning and removes event listeners", () => {
  const v = graphView(), a = node("a");
  firstClick(v, a);
  secondDown(v, a);
  v.cleanup();
  assert.equal(v.isPannable(), true);
  assert.equal(domListeners.has("mouseup"), false);
  assert.equal(domListeners.has("mousemove"), false);
  assert.equal(v.listeners.get("tapstart").length, 0);
});

test("the previous right-drag implementation and Pan/Move mode are gone", () => {
  assert.doesNotMatch(source, /attachRightDrag|cxtdrag|cxttapstart/);
  assert.doesNotMatch(source, /aria-label="Map interaction mode"/);
  assert.match(source, /Double-click and hold the second press/);
});
