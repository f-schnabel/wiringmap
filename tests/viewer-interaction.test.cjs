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
vm.runInNewContext(source.replace(anchor, '  window.configureInteractionTest = configureInteraction;\n' + anchor), {
  window, document, htmPreact,
});
const configureInteraction = window.configureInteractionTest;

// Model the collection operations exposed by Cytoscape. New graph rebuilds
// replace the edge collection, which must receive the same configuration.
function collection() {
  return {
    pannable: false, selectable: true,
    panify() { this.pannable = true; return this; },
    unpanify() { this.pannable = false; return this; },
    unselectify() { this.selectable = false; return this; },
  };
}
function graphView() {
  const nodes = collection();
  let edges = collection();
  return {
    nodes: () => nodes,
    edges: () => edges,
    replaceEdges: () => { edges = collection(); },
  };
}

test("Pan mode lets the user pan by dragging nodes or edges, without selecting edges", () => {
  const cy = graphView();
  configureInteraction(cy, "pan");
  assert.equal(cy.nodes().pannable, true);
  assert.equal(cy.edges().pannable, true);
  assert.equal(cy.edges().selectable, false);
});

test("Move nodes mode only allows nodes to be dragged, while lines still pan", () => {
  const cy = graphView();
  configureInteraction(cy, "pan");
  configureInteraction(cy, "move");
  assert.equal(cy.nodes().pannable, false);
  assert.equal(cy.edges().pannable, true);
  assert.equal(cy.edges().selectable, false);
});

test("switching back to Pan restores node panning without rebuilding or relayout", () => {
  const cy = graphView();
  configureInteraction(cy, "move");
  configureInteraction(cy, "pan");
  assert.equal(cy.nodes().pannable, true);
});

test("newly generated edges are non-selectable and pannable in either mode", () => {
  const cy = graphView();
  configureInteraction(cy, "move");
  cy.replaceEdges();
  configureInteraction(cy, "move");
  assert.equal(cy.edges().pannable, true);
  assert.equal(cy.edges().selectable, false);
});

test("node click and folder double click navigation remain registered", () => {
  assert.match(source, /cy\.on\("tap", "node"/);
  assert.match(source, /cy\.on\("dbltap", "node\[kind = 'folder'\]/);
  assert.match(source, /\[view, interactionMode\]/);
  assert.match(source, /useState\("pan"\)/);
});
