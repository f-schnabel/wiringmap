const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "../src/wiringmap/render/static/app.js"), "utf8");
const anchor = '  const mount = document.getElementById("app");';
assert.ok(source.includes(anchor));
const window = {};
const graph = { root_name: "test", nodes: [{ id: "dir:.", kind: "directory", name: "root" }], edges: [] };
const document = { getElementById: () => ({ textContent: JSON.stringify({ graph }) }) };
const htmPreact = { html: () => null, render: () => null };
vm.runInNewContext(source.replace(anchor,
  '  window.interactionTest = { configureInteraction, attachRightDrag };\n' + anchor), {
  window, document, htmPreact,
});
const { configureInteraction, attachRightDrag } = window.interactionTest;

function collection() {
  return {
    pannable: false, selectable: true,
    panify() { this.pannable = true; return this; },
    unselectify() { this.selectable = false; return this; },
  };
}
function makeNode(x = 100, y = 50) {
  let position = { x, y };
  return {
    position(value) { if (value) position = value; return position; },
    removed: () => false,
    isParent: () => false,
  };
}
function makeGraph() {
  const listeners = new Map();
  const events = [];
  const nodes = collection();
  let edges = collection();
  const canvas = {
    addEventListener(name, fn) { events.push(["add", name]); listeners.set("canvas:" + name, fn); },
    removeEventListener(name, fn) { events.push(["remove", name]); },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const cy = {
    nodes: () => nodes,
    edges: () => edges,
    replaceEdges: () => { edges = collection(); },
    container: () => canvas,
    on(name, selector, fn) { listeners.set(name, fn || selector); },
    zoom: () => 2,
    batch(fn) { fn(); },
  };
  return { cy, listeners, events };
}

test("left-drag is always pan; edges are unselectable and pannable", () => {
  const { cy } = makeGraph();
  configureInteraction(cy);
  assert.equal(cy.nodes().pannable, true);
  assert.equal(cy.edges().pannable, true);
  assert.equal(cy.edges().selectable, false);
  cy.replaceEdges();
  configureInteraction(cy);
  assert.equal(cy.edges().selectable, false);
});

test("edges never receive hit-testing events, so underlying nodes stay clickable", () => {
  assert.match(source, /selector: "edge", style: \{ "events": "no", "text-events": "no" \}/);
  assert.match(source, /cy\.on\("tap", "node"/);
  assert.match(source, /cy\.on\("dbltap", "node\[kind = 'folder'\]/);
});

test("right-drag moves a module in model units, respecting canvas zoom", () => {
  const { cy, listeners } = makeGraph();
  const node = makeNode();
  attachRightDrag(cy);
  listeners.get("cxttapstart")({
    target: node, renderedPosition: { x: 10, y: 20 }, originalEvent: { button: 2 },
  });
  listeners.get("cxtdrag")({ renderedPosition: { x: 50, y: 40 } });
  assert.equal(node.position().x, 120);
  assert.equal(node.position().y, 60);
  listeners.get("cxttapend")({});
  listeners.get("cxtdrag")({ renderedPosition: { x: 80, y: 80 } });
  assert.equal(node.position().x, 120, "mouse release must stop movement");
});

test("right-drag on an expanded folder moves its child modules together", () => {
  const { cy, listeners } = makeGraph();
  const a = makeNode(10, 20), b = makeNode(50, 60);
  const group = {
    isParent: () => true,
    descendants: () => ({
      filter: (predicate) => ({
        toArray: () => [a, b].filter(predicate),
      }),
    }),
  };
  attachRightDrag(cy);
  listeners.get("cxttapstart")({
    target: group, renderedPosition: { x: 2, y: 3 }, originalEvent: { button: 2 },
  });
  listeners.get("cxtdrag")({ renderedPosition: { x: 22, y: 23 } });
  assert.equal(a.position().x, 20);
  assert.equal(a.position().y, 30);
  assert.equal(b.position().x, 60);
  assert.equal(b.position().y, 70);
});

test("context menu is suppressed only on the graph and cleaned up on unmount", () => {
  const { cy, listeners, events } = makeGraph();
  const cleanup = attachRightDrag(cy);
  const event = { preventDefault() { this.prevented = true; } };
  listeners.get("canvas:contextmenu")(event);
  assert.equal(event.prevented, true);
  cleanup();
  assert.ok(events.some(([action, name]) => action === "remove" && name === "contextmenu"));
});

test("there is no Pan/Move nodes interaction switch anymore", () => {
  assert.doesNotMatch(source, /aria-label="Map interaction mode"/);
  assert.match(source, /<b>right-drag a box<\/b>/);
});
