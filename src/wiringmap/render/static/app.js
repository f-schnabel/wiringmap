/* wiringmap viewer: draws graph.json as an explorable map. Runs fully offline. */
(function () {
  "use strict";

  const { html, render, useState, useEffect, useMemo, useRef, useCallback } = htmPreact;

  const DATA = JSON.parse(document.getElementById("wiringmap-data").textContent);
  const G = DATA.graph;
  const SOURCES = DATA.sources || {};
  const ROOT = "dir:.";
  const INITIAL_LEAVES = 45; // boxes on the first screen before folders stay collapsed
  const MAX_EXPAND_ALL = 400; // modules; beyond this "Expand all" gets too slow to lay out
  const SYMBOL = new Set(["class", "function", "method"]);

  // Index ------------------------------------------------------------------------

  const nodes = new Map(G.nodes.map((n) => [n.id, n]));
  const kids = new Map();
  const parentOf = new Map();
  const out = { imports: new Map(), calls: new Map(), inherits: new Map(), decorates: new Map() };
  const inn = { imports: new Map(), calls: new Map(), inherits: new Map(), decorates: new Map() };
  const push = (map, key, value) => {
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(value);
  };
  for (const e of G.edges) {
    if (e.kind === "contains") {
      push(kids, e.source, e.target);
      parentOf.set(e.target, e.source);
    } else if (out[e.kind]) {
      push(out[e.kind], e.source, e);
      push(inn[e.kind], e.target, e);
    }
  }

  const kindOf = (id) => (nodes.get(id) || {}).kind;
  const isDir = (id) => kindOf(id) === "directory";
  const attrs = (id) => (nodes.get(id) || {}).attrs || {};

  function moduleOf(id) {
    const kind = kindOf(id);
    if (kind === "module") return id;
    if (SYMBOL.has(kind)) return id.slice(0, id.indexOf(":"));
    return null;
  }
  const qualOf = (id) => id.slice(id.indexOf(":") + 1);

  const pyCount = new Map();
  (function countModules(id) {
    let total = 0;
    for (const k of kids.get(id) || []) {
      if (kindOf(k) === "module") total += 1;
      else if (isDir(k)) total += countModules(k);
    }
    pyCount.set(id, total);
    return total;
  })(ROOT);
  const totalModules = pyCount.get(ROOT) || 0;

  const byName = (a, b) => nodes.get(a).name.localeCompare(nodes.get(b).name);
  const displayKidsCache = new Map();
  function displayKids(dirId) {
    let list = displayKidsCache.get(dirId);
    if (!list) {
      const all = kids.get(dirId) || [];
      const dirs = all.filter((k) => isDir(k) && pyCount.get(k) > 0).sort(byName);
      const mods = all.filter((k) => kindOf(k) === "module").sort(byName);
      displayKidsCache.set(dirId, (list = [...dirs, ...mods]));
    }
    return list;
  }

  // A folder whose only content is one folder is shown as a single box: "src/shop".
  const compactCache = new Map();
  function compact(dirId) {
    let found = compactCache.get(dirId);
    if (!found) {
      let id = dirId;
      const parts = [nodes.get(id).name];
      for (;;) {
        const ks = displayKids(id);
        if (ks.length !== 1 || !isDir(ks[0])) break;
        id = ks[0];
        parts.push(nodes.get(id).name);
      }
      compactCache.set(dirId, (found = { id, label: parts.join("/") }));
    }
    return found;
  }

  function forEachModule(dirId, fn) {
    for (const k of kids.get(dirId) || []) {
      if (kindOf(k) === "module") fn(k);
      else if (isDir(k)) forEachModule(k, fn);
    }
  }

  function ancestorsOf(id) {
    const chain = [];
    let p = parentOf.get(id);
    while (p) {
      chain.push(p);
      p = parentOf.get(p);
    }
    return chain;
  }
  const dirsAbove = (id) => ancestorsOf(id).filter((a) => isDir(a) && a !== ROOT);

  // Static import cycles include type-only references, which are not necessarily
  // import-time circularities. Inspect original module edges, not folder aggregates.
  function importCycles() {
    const modules = G.nodes.filter((n) => n.kind === "module").map((n) => n.id);
    const adjacent = new Map(modules.map((id) => [id, new Set()]));
    for (const e of G.edges)
      if (e.kind === "imports" && adjacent.has(e.source) && adjacent.has(e.target))
        adjacent.get(e.source).add(e.target);

    const indices = new Map(), low = new Map(), active = new Set(), stack = [], groups = [];
    let index = 0;
    function visit(id) {
      indices.set(id, index);
      low.set(id, index++);
      active.add(id);
      stack.push(id);
      for (const to of adjacent.get(id)) {
        if (!indices.has(to)) {
          visit(to);
          low.set(id, Math.min(low.get(id), low.get(to)));
        } else if (active.has(to)) low.set(id, Math.min(low.get(id), indices.get(to)));
      }
      if (low.get(id) === indices.get(id)) {
        const group = [];
        let member;
        do {
          member = stack.pop();
          active.delete(member);
          group.push(member);
        } while (member !== id);
        if (group.length > 1 || adjacent.get(id).has(id)) groups.push(group.sort());
      }
    }
    for (const id of modules) if (!indices.has(id)) visit(id);

    const byModule = new Map(), folders = new Set(), edges = new Set();
    for (const group of groups) for (const id of group) {
      byModule.set(id, group);
      for (const ancestor of ancestorsOf(id)) if (isDir(ancestor)) folders.add(ancestor);
    }
    for (const [from, targets] of adjacent)
      for (const to of targets)
        if (byModule.has(from) && byModule.get(from) === byModule.get(to))
          edges.add(from + "\n" + to);
    return { groups, byModule, folders, edges };
  }
  const IMPORT_CYCLES = importCycles();

  const labelWidth = (text) =>
    Math.max(56, Math.max(...String(text).split("\n").map((l) => l.length)) * 7.1 + 24);

  const firstLine = (doc) => (doc ? doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim() : "");
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  // Diff mode (wiringmap diff): what changed since another version -------------------

  const DIFF = DATA.diff || null;
  const STATUS = new Map(); // node id -> "added" | "changed" | "moved" | "broken"
  const GHOSTS = new Map(); // folder id -> deleted files that lived there
  const changedInside = new Map(); // module id -> changed classes and functions inside it
  const MARK = { added: "+ ", changed: "~ ", moved: "→ ", broken: "! ", removed: "× " };
  const STATUS_WORD = { added: "added", changed: "changed", moved: "renamed or moved", broken: "no longer parses", removed: "deleted" };
  const moduleIdOf = (id) => (id.includes(":") && !/^(dir|file|ext|ghost):/.test(id) ? id.slice(0, id.indexOf(":")) : null);
  if (DIFF) {
    for (const status of ["added", "changed", "moved"]) for (const item of DIFF[status]) STATUS.set(item.id, status);
    for (const item of DIFF.broken) STATUS.set(item.id, "broken");
    for (const item of [...DIFF.added, ...DIFF.changed, ...DIFF.moved, ...DIFF.removed]) {
      const mod = moduleIdOf(item.id);
      if (mod && nodes.has(mod)) changedInside.set(mod, (changedInside.get(mod) || 0) + 1);
    }
    for (const item of DIFF.removed) {
      if (item.kind !== "module" || !item.path) continue;
      const slash = item.path.lastIndexOf("/");
      const dir = slash < 0 ? ROOT : "dir:" + item.path.slice(0, slash);
      push(GHOSTS, nodes.has(dir) ? dir : ROOT, item);
    }
  }
  // A file's colour on the map: its own status, or "changed" when only its contents did.
  const moduleStatus = (id) => STATUS.get(id) || (changedInside.get(id) ? "changed" : null);
  const changesUnder = new Map(); // folder id -> changed or deleted files beneath it
  if (DIFF) {
    const bump = (from, by) => {
      for (const a of [from, ...ancestorsOf(from)]) if (isDir(a)) changesUnder.set(a, (changesUnder.get(a) || 0) + by);
    };
    for (const n of G.nodes) if (n.kind === "module" && moduleStatus(n.id)) bump(n.id, 1);
    for (const [dir, items] of GHOSTS) bump(dir, items.length);
  }
  const signatureChange = (id) => (DIFF ? DIFF.signature_changes.find((c) => c.id === id) : null);

  // The map: which boxes are visible ------------------------------------------------

  // Remove redundant imports only from the rendered view, preserving
  // reachability even in cyclic graphs. SCCs are atomic for this purpose:
  // all internal edges stay; between two SCCs, one representative is enough.
  function reduceTransitiveLinks(links) {
    if (links.length < 2) return links;
    const vertices = [...new Set(links.flatMap((l) => [l.s, l.t]))];
    const ranks = layerRanks(vertices, links.map((l) => [l.s, l.t]));
    const parent = new Map(vertices.map((id) => [id, id]));
    const find = (id) => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(id) !== root) {
        const next = parent.get(id);
        parent.set(id, root);
        id = next;
      }
      return root;
    };
    // Distinct SCCs connected by an edge must have different topological ranks.
    // Therefore equal-rank edges can only connect members of the same SCC.
    for (const l of links) if (ranks.get(l.s) === ranks.get(l.t))
      parent.set(find(l.s), find(l.t));

    const pairs = new Map(), adjacency = new Map();
    for (const l of links) {
      const source = find(l.s), target = find(l.t);
      if (source === target) continue;
      const key = source + "\n" + target;
      if (!pairs.has(key)) pairs.set(key, []);
      pairs.get(key).push(l);
      if (!adjacency.has(source)) adjacency.set(source, new Set());
      adjacency.get(source).add(target);
    }

    const kept = new Set(links.filter((l) => find(l.s) === find(l.t)));
    for (const group of pairs.values()) {
      const source = find(group[0].s), target = find(group[0].t);
      // Find a route via a *different* SCC, excluding all edges from this
      // source SCC to this target SCC. This prevents mutually dependent
      // parallel paths from being removed simultaneously.
      const visited = new Set([source]), queue = [source];
      let alternate = false;
      for (let i = 0; i < queue.length && !alternate; i++) {
        const current = queue[i];
        for (const next of adjacency.get(current) || []) {
          if (current === source && next === target) continue;
          if (next === target) {
            alternate = true;
            break;
          }
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      if (!alternate) {
        // One real source->target edge is sufficient between two SCCs;
        // deterministic selection prevents arrows jumping on rebuilds.
        kept.add(group.slice().sort((a, b) =>
          a.s.localeCompare(b.s) || a.t.localeCompare(b.t))[0]);
      }
    }
    return links.filter((l) => kept.has(l));
  }

  function buildView(expanded, mode, showExternal, mutedNodes, hideTransitive = false, sizeByConnections = false, markCycles = true) {
    // Suppress individual module relationships *before* folding them into folder edges.
    // This preserves unrelated arrows when a folder contains both muted and active files.
    const mutedModules = new Set();
    for (const id of mutedNodes) {
      if (isDir(id)) forEachModule(id, (moduleId) => mutedModules.add(moduleId));
      else if (kindOf(id) === "module") mutedModules.add(id);
    }
    const elements = [];
    const rep = new Map(); // module id -> id of the box that currently stands for it

    function addModule(id, parent) {
      const n = nodes.get(id);
      const entry = !!(n.attrs && n.attrs.entry_point);
      const st = DIFF ? moduleStatus(id) : null;
      const label = (st ? MARK[st] : "") + (entry ? "▶ " : "") + n.name;
      rep.set(id, id);
      elements.push({
        group: "nodes",
        data: { id, parent, label, kind: "module", entry, st, dim: !!DIFF && !st, muted: mutedModules.has(id), cycle: markCycles && mode === "imports" && IMPORT_CYCLES.byModule.has(id), error: !!(n.attrs && n.attrs.parse_error), w: labelWidth(label) },
      });
    }

    function addGhosts(dirId, parent) {
      for (const item of GHOSTS.get(dirId) || []) {
        const label = MARK.removed + item.path.slice(item.path.lastIndexOf("/") + 1);
        elements.push({ group: "nodes", data: { id: "ghost:" + item.id, parent, label, kind: "module", st: "removed", w: labelWidth(label) } });
      }
    }

    function addDir(dirId, parent) {
      const { id, label } = compact(dirId);
      const muted = mutedNodes.has(id) || ancestorsOf(id).some((a) => mutedNodes.has(a));
      if (expanded.has(id)) {
        elements.push({ group: "nodes", data: { id, parent, label: label + "/", kind: "group", muted } });
        for (const k of displayKids(id)) (isDir(k) ? addDir : addModule)(k, id);
        addGhosts(id, id);
        return;
      }
      const count = pyCount.get(id);
      const changes = changesUnder.get(id) || 0;
      const text = `${label}/\n${plural(count, "module")}${changes ? ` · ${changes} changed` : ""}`;
      elements.push({ group: "nodes", data: { id, parent, label: text, kind: "folder", chg: changes > 0, dim: !!DIFF && !changes, muted, cycle: markCycles && mode === "imports" && IMPORT_CYCLES.folders.has(id), w: labelWidth(text) } });
      forEachModule(id, (m) => rep.set(m, id));
    }

    for (const k of displayKids(ROOT)) (isDir(k) ? addDir : addModule)(k, undefined);
    addGhosts(ROOT, undefined);

    const links = new Map();
    const link = (s, t, typeOnly, cycle = false) => {
      if (!s || !t || s === t) return;
      const key = s + "\n" + t;
      let l = links.get(key);
      if (!l) links.set(key, (l = { s, t, n: 0, typeOnly: true, cycle: false }));
      l.n += 1;
      l.typeOnly = l.typeOnly && typeOnly;
      l.cycle = l.cycle || cycle;
    };

    if (mode === "imports") {
      for (const [src, list] of out.imports)
        for (const e of list)
          if (kindOf(e.target) === "module" && !mutedModules.has(src) && !mutedModules.has(e.target))
            link(rep.get(src), rep.get(e.target), !!(e.attrs && e.attrs.type_only),
              markCycles && IMPORT_CYCLES.edges.has(src + "\n" + e.target));
    } else {
      for (const [src, list] of out.calls)
        for (const e of list) {
          const source = moduleOf(src), target = moduleOf(e.target);
          if (!mutedModules.has(source) && !mutedModules.has(target)) link(rep.get(source), rep.get(target), false);
        }
    }

    if (showExternal) {
      const used = new Set();
      for (const [src, list] of out.imports)
        for (const e of list) {
          const target = nodes.get(e.target);
          if (target && target.kind === "external" && !(target.attrs && target.attrs.stdlib) && rep.get(src)) {
            if (!mutedModules.has(src) && !mutedNodes.has(e.target))
              link(rep.get(src), e.target, !!(e.attrs && e.attrs.type_only));
            used.add(e.target);
          }
        }
      for (const id of used) {
        const name = nodes.get(id).name;
        elements.push({ group: "nodes", data: { id, label: name, kind: "external", muted: mutedNodes.has(id), w: labelWidth(name) } });
      }
    }

    const visibleLinks = [...links.values()];
    // Importance is based on distinct direct neighbors, before transitive
    // reduction, so changing that visibility filter does not resize nodes.
    const neighbors = new Map();
    for (const l of visibleLinks) {
      if (!neighbors.has(l.s)) neighbors.set(l.s, new Set());
      if (!neighbors.has(l.t)) neighbors.set(l.t, new Set());
      neighbors.get(l.s).add(l.t);
      neighbors.get(l.t).add(l.s);
    }
    for (const item of elements) {
      if (item.group !== "nodes" || item.data.kind === "group" || item.data.id.startsWith("ghost:")) continue;
      const count = neighbors.get(item.data.id)?.size || 0;
      item.data.connections = count;
      if (sizeByConnections) {
        const growth = Math.min(40, Math.round(Math.log2(1 + count) * 7));
        item.data.w += growth;
        item.data.h = (item.data.kind === "folder" ? 44 : 28) + Math.min(24, Math.round(growth * 0.55));
      }
    }
    const renderedLinks = mode === "imports" && hideTransitive
      ? reduceTransitiveLinks(visibleLinks) : visibleLinks;
    for (const l of renderedLinks)
      elements.push({
        group: "edges",
        data: { id: `e:${l.s}->${l.t}`, source: l.s, target: l.t, n: l.n, typeOnly: l.typeOnly, cycle: l.cycle, w: Math.min(1 + Math.log2(l.n), 5) },
      });

    return {
      elements, rep, omittedLinks: visibleLinks.length - renderedLinks.length,
      nodeIds: new Set(elements.filter((e) => e.group === "nodes").map((e) => e.data.id)),
    };
  }

  // Folders that are rarely the first thing to read; they start closed.
  const SIDE_FOLDERS = /^(tests?|testing|fixtures|examples?|docs?|benchmarks?|__snapshots__|migrations?|alembic)$/i;

  // Open folders, shallowest first, while the map stays small enough to read.
  function initialExpanded() {
    const expanded = new Set();
    let leaves = displayKids(ROOT).length;
    const opens = (dirId) => !SIDE_FOLDERS.test(nodes.get(dirId).name);
    const frontier = displayKids(ROOT)
      .filter((d) => isDir(d) && opens(d))
      .map((d) => ({ id: compact(d).id, depth: 0 }));
    for (;;) {
      frontier.sort((a, b) => a.depth - b.depth || pyCount.get(b.id) - pyCount.get(a.id));
      const i = frontier.findIndex((f) => leaves - 1 + displayKids(f.id).length <= INITIAL_LEAVES);
      if (i < 0) return withChanges(expanded);
      const [f] = frontier.splice(i, 1);
      expanded.add(f.id);
      leaves += displayKids(f.id).length - 1;
      for (const k of displayKids(f.id)) if (isDir(k) && opens(k)) frontier.push({ id: compact(k).id, depth: f.depth + 1 });
    }
  }

  // In diff mode, also open every folder that holds a change, so changes are on screen.
  function withChanges(expanded) {
    if (!DIFF) return expanded;
    const open = new Set(expanded);
    const changed = G.nodes.filter((n) => n.kind === "module" && moduleStatus(n.id)).map((n) => n.id);
    if (changed.length > 80) return open; // too many to show at once; folders show counts
    for (const id of changed) for (const d of dirsAbove(id)) open.add(compact(d).id);
    for (const dir of GHOSTS.keys()) if (dir !== ROOT) for (const d of [dir, ...dirsAbove(dir)]) open.add(compact(d).id);
    return open;
  }

  function allFolders() {
    const all = new Set();
    for (const n of G.nodes) if (n.kind === "directory" && n.id !== ROOT && pyCount.get(n.id) > 0) all.add(n.id);
    return all;
  }

  // Cytoscape ------------------------------------------------------------------------

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function graphStyle() {
    const c = cssVar;
    const font = c("--sans");
    return [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "font-family": font,
          "font-size": 12,
          color: c("--text"),
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "min-zoomed-font-size": 6,
          shape: "round-rectangle",
          height: 28,
          "background-color": c("--node"),
          "border-width": 1,
          "border-color": c("--border-strong"),
        },
      },
      { selector: "node[w]", style: { width: "data(w)" } },
      {
        selector: "node[kind = 'folder']",
        style: { height: 44, "background-color": c("--folder"), "border-style": "dashed", "font-weight": 600, "line-height": 1.35 },
      },
      {
        selector: "node[kind = 'group']",
        style: {
          "background-color": c("--accent"),
          "background-opacity": 0.045,
          "border-color": c("--border-strong"),
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": -6,
          color: c("--muted"),
          "font-size": 12,
          "font-weight": 600,
          padding: 16,
        },
      },
      { selector: "node[kind = 'external']", style: { "background-opacity": 0, "border-style": "dotted", color: c("--muted") } },
      { selector: "node[h]", style: { height: "data(h)" } },
      { selector: "node[?entry]", style: { "border-color": c("--ok"), "border-width": 2 } },
      { selector: "node[?error]", style: { "border-color": c("--danger"), "border-style": "dashed", "border-width": 2 } },
      { selector: "node[st = 'added']", style: { "background-color": c("--add-bg"), "border-color": c("--add"), "border-width": 1.5 } },
      { selector: "node[st = 'changed']", style: { "background-color": c("--chg-bg"), "border-color": c("--chg"), "border-width": 1.5 } },
      { selector: "node[st = 'moved']", style: { "background-color": c("--mov-bg"), "border-color": c("--mov"), "border-width": 1.5 } },
      { selector: "node[st = 'broken']", style: { "background-color": c("--danger-weak"), "border-color": c("--danger"), "border-style": "dashed", "border-width": 2 } },
      { selector: "node[st = 'removed']", style: { "background-opacity": 0, "border-color": c("--danger"), "border-style": "dashed", color: c("--danger") } },
      { selector: "node[?chg]", style: { "border-color": c("--chg"), "border-width": 1.5 } },
      { selector: "node[?dim]", style: { opacity: 0.4 } },
      { selector: "node[?muted]", style: { "border-style": "dotted", "border-width": 2, "border-color": c("--faint") } },
      { selector: "node[?cycle]", style: { "border-color": c("--danger"), "border-width": 2.5 } },
      {
        selector: "edge",
        style: {
          width: "data(w)",
          "curve-style": "bezier",
          "line-color": c("--edge"),
          "target-arrow-color": c("--edge"),
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.75,
          opacity: 0.75,
        },
      },
      { selector: "edge[?typeOnly]", style: { "line-style": "dashed" } },
      { selector: "edge[?cycle]", style: { "line-color": c("--danger"), "target-arrow-color": c("--danger"), opacity: 0.95 } },
      { selector: ".faded", style: { opacity: 0.13 } },
      { selector: "edge.faded", style: { opacity: 0.06 } },
      { selector: "node.nb-out", style: { "border-color": c("--accent"), "border-width": 2 } },
      { selector: "node.nb-in", style: { "border-color": c("--usedby"), "border-width": 2 } },
      { selector: "node.sel, node.nb-out, node.nb-in", style: { opacity: 1 } },
      { selector: "node.sel", style: { "border-color": c("--accent"), "border-width": 3, "background-color": c("--accent-weak") } },
      { selector: "edge.hl-out", style: { "line-color": c("--accent"), "target-arrow-color": c("--accent"), opacity: 1, "z-index": 9 } },
      { selector: "edge.hl-in", style: { "line-color": c("--usedby"), "target-arrow-color": c("--usedby"), opacity: 1, "z-index": 9 } },
    ];
  }

  function layoutOptions(randomize, count) {
    return {
      name: "fcose",
      quality: count > 700 ? "draft" : "default",
      randomize,
      animate: false, // we animate ourselves after packing, see arrange()
      fit: false,
      nodeDimensionsIncludeLabels: true,
      packComponents: false, // fcose needs a heavy plugin for this; packComponents() below does it
      nodeRepulsion: 4000,
      idealEdgeLength: 60,
      edgeElasticity: 0.45,
      nestingFactor: 0.1,
      nodeSeparation: 50,
      gravity: 0.8,
      gravityCompound: 2.0,
      gravityRangeCompound: 1.0,
      tile: true,
      tilingPaddingVertical: 14,
      tilingPaddingHorizontal: 14,
    };
  }


  // Return a top-down rank for each node. Strongly connected cycles share a row.
  function layerRanks(ids, edges) {
    const adj = new Map(ids.map((id) => [id, new Set()]));
    for (const [src, dst] of edges) if (src !== dst && adj.has(src) && adj.has(dst)) adj.get(src).add(dst);
    const index = new Map(), low = new Map(), stack = [], active = new Set(), groups = [];
    let counter = 0;
    function visit(id) {
      index.set(id, counter);
      low.set(id, counter++);
      stack.push(id);
      active.add(id);
      for (const target of adj.get(id)) {
        if (!index.has(target)) {
          visit(target);
          low.set(id, Math.min(low.get(id), low.get(target)));
        } else if (active.has(target)) {
          low.set(id, Math.min(low.get(id), index.get(target)));
        }
      }
      if (low.get(id) === index.get(id)) {
        const members = [];
        let popped;
        do {
          popped = stack.pop();
          active.delete(popped);
          members.push(popped);
        } while (popped !== id);
        groups.push(members);
      }
    }
    for (const id of ids) if (!index.has(id)) visit(id);
    const owner = new Map();
    groups.forEach((group, i) => group.forEach((id) => owner.set(id, i)));
    const outgoing = groups.map(() => new Set()), indegree = groups.map(() => 0);
    for (const [src, destinations] of adj) for (const dst of destinations) {
      const a = owner.get(src), b = owner.get(dst);
      if (a !== b && !outgoing[a].has(b)) {
        outgoing[a].add(b);
        indegree[b]++;
      }
    }
    const ranks = groups.map(() => 0);
    const queue = indegree.map((n, i) => n === 0 ? i : -1).filter((n) => n >= 0);
    for (let i = 0; i < queue.length; i++) {
      const group = queue[i];
      for (const target of outgoing[group]) {
        ranks[target] = Math.max(ranks[target], ranks[group] + 1);
        if (--indegree[target] === 0) queue.push(target);
      }
    }
    return new Map(ids.map((id) => [id, ranks[owner.get(id)]]));
  }

  // Recursively layer direct children of each expanded folder and treat each
  // expanded folder as a single block in its parent. Only leaves need positions:
  // Cytoscape computes compound group bounds from their children.
  function layeredPositions(cy) {
    const links = cy.edges().map((e) => [e.source().id(), e.target().id()]);
    const H_GAP = 52, V_GAP = 85;

    function place(parent) {
      const children = parent ? parent.children().toArray() : cy.nodes().orphans().toArray();
      if (!children.length) return { width: 110, height: 32, positions: [] };
      const items = children.map((n) => {
        if (n.isParent()) return { id: n.id(), ...place(n) };
        const width = Math.max(70, Number(n.data("w")) || 110);
        const height = Number(n.data("h")) || (n.data("kind") === "folder" ? 44 : 32);
        return { id: n.id(), width, height, positions: [{ id: n.id(), x: width / 2, y: height / 2 }] };
      });
      const owner = new Map();
      for (const item of items) for (const pos of item.positions) owner.set(pos.id, item.id);
      const edges = [];
      for (const [src, dst] of links) {
        const a = owner.get(src), b = owner.get(dst);
        if (a && b && a !== b) edges.push([a, b]);
      }
      const ranks = layerRanks(items.map((item) => item.id), edges);
      const levels = new Map();
      for (const item of items) {
        const rank = ranks.get(item.id);
        if (!levels.has(rank)) levels.set(rank, []);
        levels.get(rank).push(item);
      }
      const rows = [...levels].sort((a, b) => a[0] - b[0]).map(([, row]) =>
        row.sort((a, b) => a.id.localeCompare(b.id)));
      const rowWidth = (row) => row.reduce((sum, item) => sum + item.width, 0) + H_GAP * (row.length - 1);
      const contentWidth = Math.max(...rows.map(rowWidth));
      const positions = [];
      let y = 0;
      for (const row of rows) {
        const height = Math.max(...row.map((item) => item.height));
        let x = (contentWidth - rowWidth(row)) / 2;
        for (const item of row) {
          const top = y + (height - item.height) / 2;
          for (const pos of item.positions)
            positions.push({ id: pos.id, x: x + pos.x, y: top + pos.y });
          x += item.width + H_GAP;
        }
        y += height + V_GAP;
      }
      const contentHeight = y - V_GAP;
      if (!parent) return { width: contentWidth, height: contentHeight, positions };
      const width = Math.max(contentWidth + 40, (parent.data("label") || "").length * 7 + 40);
      const dx = (width - contentWidth) / 2;
      return {
        width, height: contentHeight + 64,
        positions: positions.map((p) => ({ id: p.id, x: p.x + dx, y: p.y + 42 })),
      };
    }
    return new Map(place(null).positions.map((p) => [p.id, { x: p.x, y: p.y }]));
  }

  // Lay out the map and glide to new positions.
  function arrange(cy, randomize, done, layoutMode, autoFit = false) {
    const leaves = cy.nodes().filter((n) => !n.isParent());
    const start = new Map(leaves.map((n) => [n.id(), { ...n.position() }]));
    if (layoutMode === "layers") {
      const targets = layeredPositions(cy);
      leaves.forEach((n) => n.position(targets.get(n.id())));
      // Fitting is deliberately only automatic on the first render.
      // Expanding a folder or changing filters must not change zoom or pan.
      if (autoFit) cy.viewport(fittedViewport(cy));
      else if (!randomize && leaves.length <= 350) {
        leaves.forEach((n) => n.position(start.get(n.id())));
        leaves.forEach((n) => n.animate({ position: targets.get(n.id()) }, { duration: 360, easing: "ease-in-out-cubic" }));
      }
      done();
      return;
    }
    const layout = cy.layout(layoutOptions(randomize, leaves.length));
    layout.one("layoutstop", () => {
      separate(cy);
      packComponents(cy);
      if (autoFit) cy.viewport(fittedViewport(cy));
      else if (!randomize && leaves.length <= 350) {
        const end = new Map(leaves.map((n) => [n.id(), { ...n.position() }]));
        leaves.forEach((n) => n.position(start.get(n.id())));
        leaves.forEach((n) => n.animate({ position: end.get(n.id()) }, { duration: 360, easing: "ease-in-out-cubic" }));
      }
      done();
    });
    layout.run();
  }

  // fcose can stack boxes that are all pulled toward the same place (e.g. test files that
  // only import from src/). Push apart any boxes that still overlap within one folder.
  function separate(cy, gap = 12) {
    const groups = new Map();
    cy.nodes()
      .filter((n) => !n.isParent())
      .forEach((n) => {
        const key = n.parent().empty() ? "" : n.parent().id();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(n);
      });
    for (const members of groups.values()) {
      if (members.length < 2 || members.length > 600) continue;
      const boxes = members.map((n) => {
        const bb = n.boundingBox({ includeLabels: true });
        return { n, x: n.position("x"), y: n.position("y"), w: bb.w, h: bb.h };
      });
      for (let round = 0; round < 60; round++) {
        let moved = false;
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const dx = (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x);
            const dy = (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y);
            if (dx <= 0 || dy <= 0) continue;
            moved = true;
            if (dx < dy) {
              const s = a.x < b.x || (a.x === b.x && i < j) ? -1 : 1;
              a.x += (s * dx) / 2;
              b.x -= (s * dx) / 2;
            } else {
              const s = a.y < b.y || (a.y === b.y && i < j) ? -1 : 1;
              a.y += (s * dy) / 2;
              b.y -= (s * dy) / 2;
            }
          }
        if (!moved) break;
      }
      for (const b of boxes) b.n.position({ x: b.x, y: b.y });
    }
  }

  function packComponents(cy) {
    const tops = cy.nodes().orphans();
    if (tops.length < 2) return;
    const owner = new Map(tops.map((t) => [t.id(), t.id()]));
    const find = (id) => (owner.get(id) === id ? id : find(owner.get(id)));
    const topOf = (n) => (n.parent().empty() ? n.id() : n.ancestors().last().id());
    cy.edges().forEach((e) => owner.set(find(topOf(e.source())), find(topOf(e.target()))));
    const groups = new Map();
    tops.forEach((t) => {
      const root = find(t.id());
      groups.set(root, (groups.get(root) || cy.collection()).union(t).union(t.descendants()));
    });
    if (groups.size < 2) return;
    const parts = [...groups.values()].map((eles) => ({ eles, bb: eles.boundingBox() }));
    parts.sort((a, b) => b.bb.h - a.bb.h || b.bb.w - a.bb.w);
    const gap = 48;
    const area = parts.reduce((sum, p) => sum + (p.bb.w + gap) * (p.bb.h + gap), 0);
    const aspect = Math.max(cy.width() / Math.max(cy.height(), 1), 0.6);
    const rowWidth = Math.max(Math.sqrt(area * aspect), ...parts.map((p) => p.bb.w));
    let x = 0, y = 0, rowHeight = 0;
    for (const p of parts) {
      if (x > 0 && x + p.bb.w > rowWidth) (x = 0), (y += rowHeight + gap), (rowHeight = 0);
      p.eles.nodes().filter((n) => !n.isParent()).shift({ x: x - p.bb.x1, y: y - p.bb.y1 });
      x += p.bb.w + gap;
      rowHeight = Math.max(rowHeight, p.bb.h);
    }
  }

  // The zoom and pan that fit the whole map between the toolbar and the legend,
  // never zooming in past 140%.
  function fittedViewport(cy) {
    const bb = cy.elements().boundingBox();
    const side = 32, top = 64, bottom = cy.width() > 600 ? 84 : 24;
    const w = Math.max(cy.width() - 2 * side, 50), h = Math.max(cy.height() - top - bottom, 50);
    const z = Math.max(cy.minZoom(), Math.min(1.4, w / Math.max(bb.w, 1), h / Math.max(bb.h, 1)));
    return {
      zoom: z,
      pan: { x: side + (w - z * (bb.x1 + bb.x2)) / 2, y: top + (h - z * (bb.y1 + bb.y2)) / 2 },
    };
  }

  // Dragging arrows always pans; nodes pan by default and can be moved on demand.
  function configureInteraction(cy, interactionMode) {
    cy.edges().unselectify().panify();
    if (interactionMode === "pan") cy.nodes().panify();
    else cy.nodes().unpanify();
  }

  function GraphView({ view, focus, centerTick, theme, fitTick, layoutMode, interactionMode, onSelect, onToggle, onBusy }) {
    const box = useRef(null);
    const cyRef = useRef(null);
    const positions = useRef(new Map());
    const previousLayout = useRef(null);
    const hasLaidOut = useRef(false);
    const handlers = useRef({});
    handlers.current = { onSelect, onToggle };

    useEffect(() => {
      const cy = cytoscape({
        container: box.current,
        style: graphStyle(),
        minZoom: 0.05,
        maxZoom: 3,
        boxSelectionEnabled: false,
        autoungrabify: false,
      });
      cy.on("tap", "node", (ev) => handlers.current.onSelect(ev.target.id()));
      cy.on("tap", (ev) => ev.target === cy && handlers.current.onSelect(null));
      cy.on("dbltap", "node[kind = 'folder'], node[kind = 'group']", (ev) => handlers.current.onToggle(ev.target.id()));
      const scheme = window.matchMedia("(prefers-color-scheme: dark)");
      const restyle = () => cy.style(graphStyle());
      scheme.addEventListener("change", restyle);
      cyRef.current = cy;
      window.wiringmap = { cy, graph: G }; // handy in the browser console
      return () => (scheme.removeEventListener("change", restyle), cy.destroy());
    }, []);

    useEffect(() => {
      // A timer runs after the app has switched data-theme (parent effects run after
      // this one), so the CSS variables already hold the new colours.
      const timer = setTimeout(() => cyRef.current && cyRef.current.style(graphStyle()), 0);
      return () => clearTimeout(timer);
    }, [theme]);

    useEffect(() => {
      const cy = cyRef.current;
      if (!cy) return;
      const before = new Set(cy.nodes().map((n) => n.id()));
      cy.nodes().forEach((n) => {
        if (!n.isParent()) positions.current.set(n.id(), { ...n.position() });
      });
      const sameNodes = before.size === view.nodeIds.size && [...before].every((id) => view.nodeIds.has(id));
      const layoutChanged = previousLayout.current !== layoutMode;
      previousLayout.current = layoutMode;
      if (sameNodes) {
        const shown = new Map(view.elements.filter((e) => e.group === "nodes").map((e) => [e.data.id, e.data]));
        const resized = cy.nodes().toArray().some((n) =>
          n.data("w") !== shown.get(n.id())?.w || n.data("h") !== shown.get(n.id())?.h);
        const newEdges = view.elements.filter((e) => e.group === "edges");
        const oldKeys = cy.edges().map((e) => e.id()).sort();
        const newKeys = newEdges.map((e) => e.data.id).sort();
        const edgesChanged = oldKeys.length !== newKeys.length || oldKeys.some((id, i) => id !== newKeys[i]);
        cy.batch(() => {
          cy.edges().remove();
          cy.add(newEdges);
          cy.nodes().forEach((n) => {
            const changed = shown.get(n.id());
            if (changed) n.data({
              muted: !!changed.muted, cycle: !!changed.cycle,
              w: changed.w, h: changed.h, connections: changed.connections,
            });
          });
        });
        // Recoloring cycles does not move nodes. Edge changes only relayout the
        // top-down view; the free layout keeps manually adjusted positions.
        if (!layoutChanged && !resized && (layoutMode !== "layers" || !edgesChanged)) return;
        onBusy(true);
        const timer = setTimeout(() => arrange(cy, false, () => onBusy(false), layoutMode), 30);
        return () => clearTimeout(timer);
      }

      const known = positions.current;
      let placed = 0;
      const elements = view.elements.map((el) => {
        if (el.group !== "nodes" || el.data.kind === "group") return el;
        const pos = known.get(el.data.id);
        if (pos) return (placed += 1), { ...el, position: { ...pos } };
        const seed = seedPosition(el.data.id, known);
        if (!seed) return el;
        placed += 1;
        return { ...el, position: { x: seed.x + (Math.random() - 0.5) * 40, y: seed.y + (Math.random() - 0.5) * 40 } };
      });
      cy.batch(() => {
        cy.elements().remove();
        cy.add(elements);
      });
      onBusy(true);
      // A timer, not requestAnimationFrame: it lets "Arranging…" paint first, and it
      // still runs when the report was opened in a background tab.
      const timer = setTimeout(() => {
        const autoFit = !hasLaidOut.current;
        hasLaidOut.current = true;
        arrange(cy, placed === 0, () => onBusy(false), layoutMode, autoFit);
      }, 30);
      return () => clearTimeout(timer);
    }, [view, layoutMode]);

    useEffect(() => {
      const cy = cyRef.current;
      if (cy) configureInteraction(cy, interactionMode);
    }, [view, interactionMode]);

    useEffect(() => {
      const cy = cyRef.current;
      if (!cy) return;
      cy.batch(() => {
        cy.elements().removeClass("faded sel nb-out nb-in hl-out hl-in");
        if (!focus) return;
        const node = cy.getElementById(focus);
        if (node.empty()) return;
        cy.nodes().filter((n) => !n.isParent()).addClass("faded");
        cy.edges().addClass("faded");
        node.removeClass("faded").addClass("sel");
        // An open folder has no arrows of its own: use the arrows that cross its border.
        const inside = node.isParent() ? node.descendants() : node;
        inside.removeClass("faded");
        inside.edgesWith(inside).removeClass("faded");
        const edges = inside.connectedEdges();
        const outgoing = edges.filter((e) => inside.contains(e.source()) && !inside.contains(e.target()));
        const incoming = edges.filter((e) => inside.contains(e.target()) && !inside.contains(e.source()));
        outgoing.removeClass("faded").addClass("hl-out");
        incoming.removeClass("faded").addClass("hl-in");
        outgoing.targets().removeClass("faded").addClass("nb-out");
        incoming.sources().removeClass("faded").addClass("nb-in");
      });
    }, [focus, view]);

    useEffect(() => {
      const cy = cyRef.current;
      if (!cy || !centerTick || !focus) return;
      const node = cy.getElementById(focus);
      if (node.nonempty()) cy.animate({ center: { eles: node } }, { duration: 320 });
    }, [centerTick]);

    useEffect(() => {
      const cy = cyRef.current;
      if (cy && fitTick) cy.animate(fittedViewport(cy), { duration: 280 });
    }, [fitTick]);

    return html`<div class="canvas" ref=${box} role="application" aria-label="Code map"></div>`;
  }

  // A box that just appeared starts where its folder was, so the map does not jump.
  function seedPosition(id, known) {
    for (const a of ancestorsOf(id)) if (known.has(a)) return known.get(a);
    if (isDir(id)) {
      let x = 0, y = 0, n = 0;
      forEachModule(id, (m) => {
        const p = known.get(m);
        if (p) (x += p.x), (y += p.y), (n += 1);
      });
      if (n) return { x: x / n, y: y / n };
    }
    return null;
  }

  // Search -----------------------------------------------------------------------

  const searchIndex = G.nodes
    .filter((n) => n.kind === "module" || SYMBOL.has(n.kind))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      name: n.name,
      full: n.kind === "module" ? n.id : qualOf(n.id),
      where: n.path || "",
    }));

  function scoreText(q, text) {
    const t = text.toLowerCase();
    const at = t.indexOf(q);
    if (at === 0) return 100 - t.length * 0.2;
    if (at > 0) return 75 - at * 0.5 - t.length * 0.1;
    let from = 0, gaps = 0;
    for (const ch of q) {
      const j = t.indexOf(ch, from);
      if (j < 0) return -1;
      gaps += j - from;
      from = j + 1;
    }
    return 45 - gaps - t.length * 0.1;
  }

  const KIND_BONUS = { module: 6, class: 5, function: 3, method: 0 };

  function search(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const item of searchIndex) {
      const s = Math.max(scoreText(q, item.name), q.includes(".") ? scoreText(q, item.full) : -1);
      if (s >= 0) scored.push([s + KIND_BONUS[item.kind], item]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, 14).map(([, item]) => item);
  }

  const ICON = { module: ["M", "d"], class: ["C", "c"], function: ["ƒ", "f"], method: ["m", "m"], directory: ["/", "d"], external: ["E", "d"] };

  function SearchBox({ onPick }) {
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const input = useRef(null);
    const results = useMemo(() => search(query), [query]);

    useEffect(() => {
      const onKey = (e) => {
        const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
        if (e.key === "/" && !typing) {
          e.preventDefault();
          input.current.focus();
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, []);

    const pick = (item) => {
      onPick(item.id);
      setOpen(false);
      input.current.blur();
    };
    const onKeyDown = (e) => {
      if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, results.length - 1)));
      else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
      else if (e.key === "Enter" && results[active]) pick(results[active]);
      else if (e.key === "Escape") (setQuery(""), setOpen(false), input.current.blur());
    };

    return html`<div class="search">
      <svg class="glass" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input
        ref=${input}
        type="search"
        placeholder="Search files, classes, functions"
        aria-label="Search files, classes and functions"
        value=${query}
        onInput=${(e) => (setQuery(e.target.value), setActive(0), setOpen(true))}
        onFocus=${() => setOpen(true)}
        onBlur=${() => setTimeout(() => setOpen(false), 150)}
        onKeyDown=${onKeyDown}
      />
      ${!query && html`<kbd>/</kbd>`}
      ${open && query.trim() &&
      html`<ul class="results" role="listbox">
        ${results.length === 0 && html`<li class="empty">Nothing matches “${query}”</li>`}
        ${results.map(
          (item, i) => html`<li
            role="option"
            aria-selected=${i === active}
            onMouseDown=${(e) => (e.preventDefault(), pick(item))}
            onMouseEnter=${() => setActive(i)}
          >
            <span class=${"ic " + ICON[item.kind][1]} style="font:600 11px var(--mono);width:16px;text-align:center">${ICON[item.kind][0]}</span>
            <span class="mono">${item.kind === "module" ? item.name : item.full}</span>
            <span class="where">${item.where}</span>
          </li>`
        )}
      </ul>`}
    </div>`;
  }


  // Dependency matrix: group modules by direct child of the configured root.
  // We preserve concrete module import edges for cell drill-down; the matrix
  // never uses the display-only transitive-reduced graph.
  const ARCH = DATA.architecture || null;

  function dependencyMatrix() {
    const modules = G.nodes.filter((n) => n.kind === "module").map((n) => n.id);
    const candidates = (ARCH && ARCH.root_packages) || [];
    const counts = new Map();
    for (const id of modules) {
      const top = id.split(".")[0];
      counts.set(top, (counts.get(top) || 0) + 1);
    }
    const fallback = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
    const root = candidates.find((name) => modules.some((id) => id === name || id.startsWith(name + "."))) || fallback;

    const ofModule = (id) => {
      if (id === root) return "(root)";
      if (!id.startsWith(root + ".")) return null;
      return id.slice(root.length + 1).split(".")[0];
    };
    const groups = new Set();
    const owners = new Map();
    for (const id of modules) {
      const group = ofModule(id);
      if (group !== null) {
        owners.set(id, group);
        groups.add(group);
      }
    }
    const layerPositions = new Map();
    for (const contract of (ARCH && ARCH.contracts) || []) {
      if (contract.type !== "layers") continue;
      const containers = contract.containers || [];
      if (containers.length && !containers.includes(root)) continue;
      const layers = contract.layers || [];
      if (!Array.isArray(layers)) continue;
      for (const [level, expression] of layers.entries()) {
        // "|" and ":" both mean that these names occupy one declared layer.
        for (const name of String(expression).replace(/[()]/g, "").split(/[|:]/).map((n) => n.trim())) {
          if (name && !layerPositions.has(name)) layerPositions.set(name, level);
        }
      }
      break;
    }
    const packages = [...groups].sort((a, b) => {
      const x = layerPositions.get(a) ?? Infinity, y = layerPositions.get(b) ?? Infinity;
      return x - y || a.localeCompare(b);
    });
    const cells = new Map();
    let total = 0;
    for (const e of G.edges) {
      if (e.kind !== "imports") continue;
      const from = owners.get(e.source), to = owners.get(e.target);
      if (from === undefined || to === undefined) continue;
      const key = from + "\n" + to;
      if (!cells.has(key)) cells.set(key, { from, to, imports: [], count: 0, typeOnly: 0 });
      const cell = cells.get(key);
      cell.imports.push(e);
      cell.count++;
      if (e.attrs && e.attrs.type_only) cell.typeOnly++;
      total++;
    }
    for (const cell of cells.values()) cell.imports.sort((a, b) =>
      a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
    const maxCount = Math.max(1, ...[...cells.values()].map((v) => v.count));
    return { root, packages, cells, total, maxCount, layerPositions };
  }

  const MATRIX = dependencyMatrix();

  function MatrixView({ matrix, selected, onCell }) {
    const [filter, setFilter] = useState("");
    const query = filter.trim().toLowerCase();
    const packages = matrix.packages.filter((name) => !query || name.toLowerCase().includes(query));
    return html`<div class="matrix-view">
      <div class="matrix-head">
        <div>
          <h2>Dependency matrix</h2>
          <p>Rows import columns · direct module imports, including type-only imports.</p>
        </div>
        <input class="matrix-filter" type="search" aria-label="Filter packages"
          placeholder="Filter packages…" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
      </div>
      ${packages.length
        ? html`<div class="matrix-scroll"><table class="matrix-table" aria-label="Module import dependencies by package">
            <thead><tr><th class="matrix-corner" scope="col">Imports ↓ / →</th>
              ${packages.map((name) => html`<th scope="col" title=${matrix.root + "." + name}>${name}</th>`)}
              <th scope="col">Total</th>
            </tr></thead>
            <tbody>${packages.map((from) => {
              const rowTotal = matrix.packages.reduce((sum, to) =>
                sum + (matrix.cells.get(from + "\n" + to)?.count || 0), 0);
              return html`<tr>
                <th scope="row" title=${matrix.root + "." + from}>${from}</th>
                ${packages.map((to) => {
                  const cell = matrix.cells.get(from + "\n" + to);
                  const count = cell?.count || 0;
                  const level = count ? Math.min(5, Math.max(1, Math.ceil(Math.log1p(count) / Math.log1p(matrix.maxCount) * 5))) : 0;
                  const chosen = selected && selected.from === from && selected.to === to;
                  return html`<td>
                    ${count
                      ? html`<button class=${"matrix-value heat-" + level + (chosen ? " active" : "")}
                          aria-pressed=${!!chosen}
                          title=${from + " imports " + to + ": " + count + " module imports" + (cell.typeOnly ? " (" + cell.typeOnly + " type-only)" : "")}
                          aria-label=${from + " imports " + to + ": " + count + " module imports"}
                          onClick=${() => onCell({ from, to })}>${count}</button>`
                      : html`<span class="matrix-empty" aria-label="No imports">·</span>`}
                  </td>`;
                })}
                <td class="matrix-total">${rowTotal}</td>
              </tr>`;
            })}</tbody>
          </table></div>`
        : html`<p class="hint">No packages match this filter.</p>`}
      <div class="matrix-foot">Color intensity represents the number of direct module imports, not contract violations.
        ${matrix.packages.length} package groups · ${plural(matrix.total, "import")}.</div>
    </div>`;
  }

  function MatrixInspector({ matrix, selected, onModule }) {
    const [showAll, setShowAll] = useState(false);
    useEffect(() => setShowAll(false), [selected?.from, selected?.to]);
    if (!selected) {
      const check = ARCH?.check;
      return html`<div class="pad">
        <h2>Architecture</h2>
        <p class="hint">Select a matrix cell to inspect the direct module imports.</p>
        <div class="facts">
          <div class="fact"><b>${matrix.packages.length}</b><span>packages</span></div>
          <div class="fact"><b>${matrix.total}</b><span>direct imports</span></div>
        </div>
        ${ARCH
          ? html`<${Block} title="Import Linter contracts" count=${(ARCH.contracts || []).length}>
              ${ARCH.error && html`<p class="alert">${ARCH.error}</p>`}
              <p class="hint">Loaded from ${ARCH.source || "the project"}. Contract definitions are displayed, not reimplemented.</p>
              <ul class="list">${(ARCH.contracts || []).map((contract) =>
                html`<li class="matrix-contract"><b>${contract.name || "Unnamed contract"}</b>
                  <span class="meta">${contract.type || "custom"}</span>
                  ${contract.type === "layers" && html`<div class="matrix-layers">${(contract.layers || []).map((layer) => html`<div>${layer}</div>`)}</div>`}
                </li>`)}</ul>
              <p class="hint">Use <code>lint-imports</code> for authoritative contract results. This matrix does not independently flag violations.</p>
            </${Block}>`
          : html`<p class="hint">No Import Linter configuration found. Package ordering is alphabetical.</p>`}
        ${check && html`<${Block} title="Import Linter check">
          <p><b>${check.status}</b> ${check.command || ""}</p>
          <pre class="matrix-output">${check.output || ""}</pre>
        </${Block}>`}
      </div>`;
    }
    const cell = matrix.cells.get(selected.from + "\n" + selected.to);
    if (!cell) return null;
    const imports = showAll ? cell.imports : cell.imports.slice(0, 100);
    return html`<div class="pad">
      <h2>${selected.from} → ${selected.to}</h2>
      <p class="hint">${plural(cell.count, "direct module import")}; ${cell.typeOnly} type-only.</p>
      <button class="btn" onClick=${() => onModule(cell.imports[0].source)}>Show on map</button>
      <${Block} title="Module relationships" count=${cell.count}>
        <ul class="list">${imports.map((e) => html`<li class="matrix-import-row">
          <button class="matrix-module" title="View importer on map" onClick=${() => onModule(e.source)}>${e.source}</button>
          <span>→</span>
          <button class="matrix-module" title="View imported module on map" onClick=${() => onModule(e.target)}>${e.target}</button>
          ${e.attrs?.type_only && html`<span class="meta">types only</span>`}
        </li>`)}</ul>
        ${cell.imports.length > 100 && html`<button class="btn" onClick=${() => setShowAll(!showAll)}>
          ${showAll ? "Show fewer" : "Show all " + cell.imports.length}
        </button>`}
      </${Block}>
    </div>`;
  }

  // Inspector ------------------------------------------------------------------------

  function Row({ id, name, meta, kind, onSelect, badge }) {
    const [glyph, cls] = ICON[kind || kindOf(id)] || ["·", "d"];
    return html`<li>
      <button class="row" onClick=${() => onSelect(id)}>
        <span class=${"ic " + cls}>${glyph}</span>
        <span class="name">${name}</span>
        ${badge && html`<span class=${"badge " + badge}>${badge}</span>`}
        ${meta && html`<span class="meta">${meta}</span>`}
      </button>
    </li>`;
  }

  function Block({ title, count, dot, children, hint }) {
    return html`<section class="block">
      <h3>${dot && html`<span class=${"dot " + dot}></span>`}${title}${count !== undefined && html`<span class="n">${count}</span>`}</h3>
      ${hint ? html`<p class="hint">${hint}</p>` : children}
    </section>`;
  }

  function EdgeToggle({ id, mutedNodes, onToggleMuted }) {
    const target = isDir(id) ? compact(id).id : id;
    const inherited = ancestorsOf(target).some((a) => mutedNodes.has(a));
    const hidden = mutedNodes.has(target);
    return html`<button class="btn" disabled=${inherited}
      title=${inherited ? "Connections are hidden by a parent folder" : "Toggle this node's arrows without hiding the node"}
      onClick=${() => onToggleMuted(target)}>
      ${inherited ? "Hidden by parent folder" : hidden ? "Show connections" : "Hide connections"}
    </button>`;
  }

  function Crumbs({ id, onSelect }) {
    const dirs = dirsAbove(id).reverse();
    const mod = moduleOf(id);
    return html`<nav class="crumbs" aria-label="Location">
      <button onClick=${() => onSelect(null)}>${G.root_name}</button>
      ${dirs.map((d) => html`<span>/</span><button onClick=${() => onSelect(d)}>${nodes.get(d).name}</button>`)}
      ${mod && mod !== id && html`<span>/</span><button onClick=${() => onSelect(mod)}>${nodes.get(mod).name}</button>`}
    </nav>`;
  }

  const sortByLine = (ids) => ids.slice().sort((a, b) => (nodes.get(a).line || 0) - (nodes.get(b).line || 0));
  const symbolKids = (id) => sortByLine((kids.get(id) || []).filter((k) => SYMBOL.has(kindOf(k))));

  function moduleLabel(id) {
    const n = nodes.get(id);
    return n.kind === "module" ? n.path : id;
  }

  function SymbolTree({ id, onSelect, depth = 0 }) {
    return html`<ul class=${"list" + (depth ? " sub" : "")}>
      ${symbolKids(id).map((k) => {
        const n = nodes.get(k);
        const doc = firstLine(n.docstring);
        return html`<${Row} id=${k} name=${n.name} meta=${"L" + n.line} onSelect=${onSelect} />
          ${doc && depth === 0 && html`<div class="first-line">${doc}</div>`}
          ${n.kind === "class" && (kids.get(k) || []).length > 0 && html`<${SymbolTree} id=${k} onSelect=${onSelect} depth=${depth + 1} />`}`;
      })}
    </ul>`;
  }

  function Externals({ id }) {
    const ext = (out.imports.get(id) || []).filter((e) => kindOf(e.target) === "external");
    if (!ext.length) return null;
    const third = ext.filter((e) => !attrs(e.target).stdlib).map((e) => nodes.get(e.target).name);
    const std = ext.filter((e) => attrs(e.target).stdlib).map((e) => nodes.get(e.target).name);
    return html`<${Block} title="External packages">
      ${third.length > 0 && html`<div class="chips">${third.map((n) => html`<span class="chip">${n}</span>`)}</div>`}
      ${std.length > 0 && html`<p class="hint" style="margin-top:6px">Standard library: ${std.join(", ")}</p>`}
    </${Block}>`;
  }

  function ModuleCard({ id, onSelect, onCode, onCenter, mutedNodes, onToggleMuted }) {
    const n = nodes.get(id);
    const a = n.attrs || {};
    const uses = (out.imports.get(id) || []).filter((e) => kindOf(e.target) === "module");
    const usedBy = (inn.imports.get(id) || []).filter((e) => kindOf(e.source) === "module");
    const symbols = symbolKids(id);
    const cycle = IMPORT_CYCLES.byModule.get(id) || [];
    const classes = symbols.filter((k) => kindOf(k) === "class").length;
    let functions = 0;
    for (const n2 of G.nodes) if (SYMBOL.has(n2.kind) && n2.kind !== "class" && moduleOf(n2.id) === id) functions += 1;
    return html`<div class="pad">
      <${Crumbs} id=${id} onSelect=${onSelect} />
      <div class="title">
        <h2>${n.name}</h2>
        <span class="badge kind">${a.is_package ? "package" : "module"}</span>
        ${a.entry_point && html`<span class="badge entry">entry point · ${a.entry_point}</span>`}
        <${StatusBadge} id=${id} />
      </div>
      <div class="loc mono">${n.path} · ${id}</div>
      ${a.parse_error && html`<div class="alert">Not parsed: ${a.parse_error}</div>`}
      ${n.docstring ? html`<div class="doc">${n.docstring}</div>` : html`<div class="doc none">No docstring.</div>`}
      <div class="facts">
        <div class="fact"><b>${(n.loc || 0).toLocaleString()}</b><span>lines of code</span></div>
        <div class="fact"><b>${classes}</b><span>${classes === 1 ? "class" : "classes"}</span></div>
        <div class="fact"><b>${functions}</b><span>functions & methods</span></div>
      </div>
      <div class="actions">
        ${SOURCES[n.path] !== undefined && html`<button class="btn" onClick=${() => onCode(n.path, 1, 0)}>View source</button>`}
        <button class="btn" onClick=${onCenter}>Show on map</button>
        <${EdgeToggle} id=${id} mutedNodes=${mutedNodes} onToggleMuted=${onToggleMuted} />
      </div>
      ${cycle.length > 0 && html`<${Block} title="Static import cycle" count=${cycle.length}>
        <p class="hint">These modules are mutually reachable through imports (including type-only imports).</p>
        <ul class="list">${cycle.filter((member) => member !== id).map((member) =>
          html`<${Row} id=${member} name=${moduleLabel(member)} onSelect=${onSelect} />`)}</ul>
      </${Block}>`}
      <${Block} title="Uses" count=${uses.length} dot="out" hint=${uses.length ? null : "Imports no other file in this project."}>
        <ul class="list">${uses.map((e) => html`<${Row} id=${e.target} name=${moduleLabel(e.target)} meta=${e.attrs && e.attrs.type_only ? "types only" : ""} onSelect=${onSelect} />`)}</ul>
      </${Block}>
      <${Block} title="Used by" count=${usedBy.length} dot="in" hint=${usedBy.length ? null : "No file in this project imports it."}>
        <ul class="list">${usedBy.map((e) => html`<${Row} id=${e.source} name=${moduleLabel(e.source)} onSelect=${onSelect} />`)}</ul>
      </${Block}>
      <${Externals} id=${id} />
      <${Block} title="Contents" count=${symbols.length} hint=${symbols.length ? null : "No classes or functions."}>
        <${SymbolTree} id=${id} onSelect=${onSelect} />
      </${Block}>
      ${a.unresolved_imports && html`<${Block} title="Unresolved imports"><p class="hint">${a.unresolved_imports.join(", ")}</p></${Block}>`}
    </div>`;
  }

  function CallRows({ edges, side, onSelect }) {
    return html`<ul class="list">
      ${edges.map((e) => {
        const other = side === "out" ? e.target : e.source;
        const mod = moduleOf(other);
        const name = other === mod ? nodes.get(other).name + " (module code)" : qualOf(other);
        return html`<${Row} id=${other} name=${name} meta=${mod && mod !== moduleOf(side === "out" ? e.source : e.target) ? nodes.get(mod).name : ""} badge=${e.confidence} onSelect=${onSelect} />`;
      })}
    </ul>`;
  }

  function SymbolCard({ id, onSelect, onCode, onCenter }) {
    const n = nodes.get(id);
    const a = n.attrs || {};
    const calls = out.calls.get(id) || [];
    const calledBy = inn.calls.get(id) || [];
    const bases = (out.inherits.get(id) || []).map((e) => e.target);
    const subclasses = (inn.inherits.get(id) || []).map((e) => e.source);
    const decoratedBy = (inn.decorates.get(id) || []).map((e) => e.source);
    const decorates = (out.decorates.get(id) || []).map((e) => e.target);
    const internalBaseNames = new Set(bases.map((b) => nodes.get(b).name));
    const externalBases = (a.bases || []).filter((b) => !internalBaseNames.has(b.split(".").pop()));
    return html`<div class="pad">
      <${Crumbs} id=${id} onSelect=${onSelect} />
      <div class="title">
        <h2>${n.name}</h2>
        <span class="badge kind">${a.async ? "async " : ""}${n.kind}</span>
        ${a.entry_point && html`<span class="badge entry">entry point · ${a.entry_point}</span>`}
        <${StatusBadge} id=${id} />
      </div>
      ${n.signature && html`<div class="sig mono">${n.name}${n.signature}</div>`}
      ${signatureChange(id) && html`<div class="alert info">Signature changed. Before: <code>${signatureChange(id).before}</code></div>`}
      <div class="loc mono">${n.path}:${n.line}–${n.end_line} · ${plural(n.loc || 0, "line")}</div>
      ${a.decorators && html`<div class="chips" style="margin-top:8px">${a.decorators.map((d) => html`<span class="chip">@${d}</span>`)}</div>`}
      ${n.docstring ? html`<div class="doc">${n.docstring}</div>` : html`<div class="doc none">No docstring.</div>`}
      <div class="actions">
        ${SOURCES[n.path] !== undefined && html`<button class="btn" onClick=${() => onCode(n.path, n.line, n.end_line)}>View source</button>`}
        <button class="btn" onClick=${onCenter}>Show on map</button>
      </div>
      ${n.kind === "class" &&
      html`<${Block} title="Inherits from" count=${bases.length + externalBases.length} hint=${bases.length || externalBases.length ? null : "Nothing (a plain class)."}>
          <ul class="list">${bases.map((b) => html`<${Row} id=${b} name=${qualOf(b)} meta=${nodes.get(moduleOf(b)).name} onSelect=${onSelect} />`)}</ul>
          ${externalBases.length > 0 && html`<div class="chips" style="margin-top:6px">${externalBases.map((b) => html`<span class="chip">${b}</span>`)}</div>`}
        </${Block}>
        ${subclasses.length > 0 && html`<${Block} title="Subclasses" count=${subclasses.length}>
          <ul class="list">${subclasses.map((s) => html`<${Row} id=${s} name=${qualOf(s)} meta=${nodes.get(moduleOf(s)).name} onSelect=${onSelect} />`)}</ul>
        </${Block}>`}
        <${Block} title="Members" count=${symbolKids(id).length} hint=${symbolKids(id).length ? null : "No methods."}>
          <${SymbolTree} id=${id} onSelect=${onSelect} />
        </${Block}>`}
      <${Block} title="Calls" count=${calls.length} dot="out" hint=${calls.length ? null : "Calls nothing else in this project."}>
        <${CallRows} edges=${calls} side="out" onSelect=${onSelect} />
      </${Block}>
      <${Block} title=${n.kind === "class" ? "Created or called by" : "Called by"} count=${calledBy.length} dot="in" hint=${calledBy.length ? null : a.entry_point ? calledFromOutside(n) : "Nothing in this project calls it directly. It may still run through a framework or callback."}>
        <${CallRows} edges=${calledBy} side="in" onSelect=${onSelect} />
      </${Block}>
      ${decoratedBy.length > 0 && html`<${Block} title="Decorated by" count=${decoratedBy.length}>
        <ul class="list">${decoratedBy.map((d) => html`<${Row} id=${d} name=${qualOf(d)} onSelect=${onSelect} />`)}</ul>
      </${Block}>`}
      ${decorates.length > 0 && html`<${Block} title="Decorates" count=${decorates.length}>
        <ul class="list">${decorates.map((d) => html`<${Row} id=${d} name=${qualOf(d)} onSelect=${onSelect} />`)}</ul>
      </${Block}>`}
      ${a.external_calls && html`<${Block} title="Uses from other packages" count=${a.external_calls.length}>
        <div class="chips">${a.external_calls.map((c) => html`<span class="chip">${c}</span>`)}</div>
      </${Block}>`}
      ${a.unresolved_calls && html`<p class="hint" style="margin-top:14px">${plural(a.unresolved_calls, "more call")} could not be linked. Static analysis cannot follow dynamic code.</p>`}
      <p class="hint" style="margin-top:14px">Links are <span class="badge resolved">resolved</span> through names and imports, <span class="badge inferred">inferred</span> through types, or <span class="badge guessed">guessed</span> from a unique method name.</p>
    </div>`;
  }

  function FolderCard({ id, expanded, onSelect, onToggle, onCenter, mutedNodes, onToggleMuted }) {
    const n = nodes.get(id);
    const list = displayKids(id);
    const open = expanded.has(compact(id).id);
    let loc = 0;
    forEachModule(id, (m) => (loc += nodes.get(m).loc || 0));
    return html`<div class="pad">
      <${Crumbs} id=${id} onSelect=${onSelect} />
      <div class="title"><h2>${n.name}/</h2><span class="badge kind">folder</span></div>
      <div class="loc mono">${n.path}</div>
      <div class="facts">
        <div class="fact"><b>${pyCount.get(id)}</b><span>Python files</span></div>
        <div class="fact"><b>${loc.toLocaleString()}</b><span>lines of code</span></div>
        <div class="fact"><b>${list.length}</b><span>direct items</span></div>
      </div>
      <div class="actions">
        <button class="btn" onClick=${() => onToggle(compact(id).id)}>${open ? "Collapse on map" : "Open on map"}</button>
        <button class="btn" onClick=${onCenter}>Show on map</button>
        <${EdgeToggle} id=${id} mutedNodes=${mutedNodes} onToggleMuted=${onToggleMuted} />
      </div>
      <${Block} title="Inside" count=${list.length}>
        <ul class="list">${list.map((k) =>
          html`<${Row} id=${k} name=${nodes.get(k).name + (isDir(k) ? "/" : "")} meta=${isDir(k) ? plural(pyCount.get(k), "file") : (nodes.get(k).loc || 0) + " lines"} onSelect=${onSelect} />`
        )}</ul>
      </${Block}>
    </div>`;
  }

  function ExternalCard({ id, onSelect, mutedNodes, onToggleMuted }) {
    const n = nodes.get(id);
    const users = (inn.imports.get(id) || []).map((e) => e.source);
    return html`<div class="pad">
      <div class="title"><h2>${n.name}</h2><span class="badge kind">${n.attrs && n.attrs.stdlib ? "standard library" : "external package"}</span></div>
      <div class="actions"><${EdgeToggle} id=${id} mutedNodes=${mutedNodes} onToggleMuted=${onToggleMuted} /></div>
      <${Block} title="Imported by" count=${users.length}>
        <ul class="list">${users.map((u) => html`<${Row} id=${u} name=${moduleLabel(u)} onSelect=${onSelect} />`)}</ul>
      </${Block}>
    </div>`;
  }

  // Tests, fixtures, docs and examples: real code, but rarely where you start reading.
  const isSidePath = (path) => {
    const parts = (path || "").split("/");
    const file = parts.pop();
    return parts.some((p) => SIDE_FOLDERS.test(p)) || /^(test_.*|.*_test|conftest)\.py$/.test(file);
  };

  // "@router.post('/login/access-token')" -> "POST /login/access-token"
  function routeLabel(node) {
    for (const d of (node.attrs && node.attrs.decorators) || []) {
      const m = /\.(get|post|put|patch|delete|head|options|route|websocket|api_route)\(\s*(?:path\s*=\s*)?["']([^"']*)["']/.exec(d);
      if (m) return `${m[1] === "route" || m[1] === "api_route" ? "" : m[1].toUpperCase() + " "}${m[2] || "/"}`;
    }
    return null;
  }

  const ENTRY_ORDER = { script: 0, "main-module": 1, "main-guard": 2, cli: 3, http: 4, task: 5 };
  const entryKind = (n) => n.attrs.entry_point.split(":")[0];
  const ALL_ENTRY_POINTS = G.nodes.filter((n) => n.attrs && n.attrs.entry_point && (n.kind === "module" || SYMBOL.has(n.kind)));
  const ENTRY_POINTS = ALL_ENTRY_POINTS.filter((n) => !isSidePath(n.path)).sort(
    (a, b) => (ENTRY_ORDER[entryKind(a)] ?? 9) - (ENTRY_ORDER[entryKind(b)] ?? 9) || (a.path || "").localeCompare(b.path || "") || (a.line || 0) - (b.line || 0)
  );
  const SIDE_ENTRY_POINTS = ALL_ENTRY_POINTS.length - ENTRY_POINTS.length;

  function entryMeta(n) {
    const kind = entryKind(n);
    if (kind === "http") return routeLabel(n) || "web route";
    if (kind === "script") return "command: " + n.attrs.entry_point.slice("script:".length);
    return { "main-module": "python -m", "main-guard": "run as script", cli: "CLI command", task: "background task" }[kind] || kind;
  }

  function calledFromOutside(n) {
    const kind = entryKind(n);
    if (kind === "http") return `The web framework calls it for ${routeLabel(n) || "its route"}.`;
    if (kind === "cli" || kind === "script") return "Runs when you use this command from the terminal.";
    return "It is a starting point: it runs when the program starts.";
  }

  const MOST_USED = G.nodes
    .filter((n) => n.kind === "module" && !isSidePath(n.path))
    .map((n) => [n.id, (inn.imports.get(n.id) || []).filter((e) => kindOf(e.source) === "module").length])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  function StatusBadge({ id }) {
    if (!DIFF) return null;
    const st = STATUS.get(id) || (nodes.get(id) && nodes.get(id).kind === "module" ? moduleStatus(id) : null);
    if (!st) return null;
    const moved = st === "moved" ? DIFF.moved.find((m) => m.id === id) : null;
    const text = moved ? `renamed from ${qualOf(moved.note) || moved.note}` : STATUS_WORD[st];
    return html`<span class=${"badge st-" + st}>${text}</span>`;
  }

  function GhostCard({ id, onSelect }) {
    const item = DIFF.removed.find((r) => "ghost:" + r.id === id);
    const inside = DIFF.removed.filter((r) => r.path === item.path && r.id !== item.id);
    return html`<div class="pad">
      <div class="title"><h2>${item.path.split("/").pop()}</h2><span class="badge st-removed">deleted</span></div>
      <div class="loc mono">${item.path}</div>
      <p class="hint" style="margin-top:10px">This file existed in ${DIFF.base} and is gone in ${DIFF.head}.</p>
      ${inside.length > 0 && html`<${Block} title="What it contained" count=${inside.length}>
        <ul class="list">${inside.map((r) => html`<li><div class="row" style="cursor:default"><span class="ic d">×</span><span class="name">${qualOf(r.id)}</span></div></li>`)}</ul>
      </${Block}>`}
    </div>`;
  }

  // The panel shown in diff mode before anything is selected.
  function ChangesPanel({ onSelect }) {
    const d = DIFF;
    const breaking = d.signature_changes.filter((c) => c.callers.length && c.breaking !== false);
    const attention =
      d.broken.length + d.new_cycles.length + breaking.length + d.duplicates.length + d.lost_callers.length + d.new_packages.length;
    const files = new Map(); // module id -> { file: what happened to the file, parts: [...] }
    const entry = (mod) => files.get(mod) || files.set(mod, { file: null, parts: [] }).get(mod);
    for (const status of ["added", "changed", "moved"])
      for (const item of d[status]) {
        const mod = moduleIdOf(item.id) || item.id;
        if (!nodes.has(mod)) continue;
        if (item.kind === "module") entry(mod).file = { added: "new file", moved: "renamed", changed: "changed" }[status];
        else entry(mod).parts.push(`${status === "moved" ? "renamed" : status} ${qualOf(item.id)}`);
      }
    const broken = new Set(d.broken.map((i) => i.id));
    for (const id of broken) entry(id);
    const describe = (mod) => {
      if (broken.has(mod)) return "no longer parses";
      const { file, parts } = files.get(mod);
      // "changed" adds nothing when the changed functions are named.
      const words = [...(file && !(file === "changed" && parts.length) ? [file] : []), ...parts];
      return words.slice(0, 2).join(", ") + (words.length > 2 ? ", …" : "");
    };
    const deleted = d.removed.filter((r) => r.kind === "module");
    const order = [...files.keys()].sort((a, b) => isSidePath(nodes.get(a).path) - isSidePath(nodes.get(b).path) || nodes.get(a).path.localeCompare(nodes.get(b).path));
    return html`<div class="pad welcome">
      <h2>What changed</h2>
      <p class="mono" style="font-size:12.5px">${d.base} → ${d.head}</p>
      <p>Coloured boxes changed: <b style="color:var(--add)">+ added</b>, <b style="color:var(--chg)">~ changed</b>, <b style="color:var(--mov)">→ renamed</b>, <b style="color:var(--danger)">× deleted</b>. Unchanged files are faded.</p>
      ${attention > 0 && html`<${Block} title="Needs a look" count=${attention}>
        <ul class="list">
          ${d.broken.map((i) => html`<${Row} id=${i.id} name=${i.path} meta="no longer parses" onSelect=${onSelect} />`)}
          ${d.new_cycles.map((c) => html`<${Row} id=${c[0]} kind="module" name=${c.map((m) => (nodes.get(m) || {}).name || m).join(" ↔ ")} meta="new import cycle" onSelect=${onSelect} />`)}
          ${breaking.map((c) => html`<${Row} id=${c.id} name=${qualOf(c.id)} meta=${`signature changed · ${c.callers.length} caller(s) not updated`} onSelect=${onSelect} />`)}
          ${d.duplicates.map((g) => html`<${Row} id=${g.new[0]} name=${qualOf(g.new[0])} meta=${`same logic as ${g.members.filter((m) => !g.new.includes(m.id)).map((m) => qualOf(m.id)).join(", ") || "another new function"}`} onSelect=${onSelect} />`)}
          ${d.lost_callers.map((i) => html`<${Row} id=${i.id} name=${qualOf(i.id)} meta="lost all its callers" onSelect=${onSelect} />`)}
          ${d.new_packages.map((pkg) => html`<li><div class="row" style="cursor:default"><span class="ic d">E</span><span class="name">${pkg.name}</span><span class="meta">new package</span></div></li>`)}
        </ul>
      </${Block}>`}
      <${Block} title="Files" count=${order.length + deleted.length} hint=${order.length + deleted.length ? null : "No Python files changed."}>
        <ul class="list">
          ${order.map((m) => html`<${Row} id=${m} name=${nodes.get(m).path} meta=${describe(m)} onSelect=${onSelect} />`)}
          ${deleted.map((r) => html`<${Row} id=${"ghost:" + r.id} kind="module" name=${r.path} meta="deleted" onSelect=${onSelect} />`)}
        </ul>
      </${Block}>
      ${d.impacted.length > 0 && html`<p class="hint" style="margin-top:14px">${plural(d.impacted.length, "other file")} import the changed files.</p>`}
    </div>`;
  }

  function Welcome({ onSelect }) {
    const [showAll, setShowAll] = useState(false);
    const s = G.stats || {};
    const when = G.created_at ? new Date(G.created_at).toLocaleString() : "";
    return html`<div class="pad welcome">
      <h2>${G.root_name}</h2>
      <p>A map of how this code is wired, made by wiringmap ${G.generator.version}${when ? " on " + when : ""}.</p>
      <ol>
        <li><b>Pan</b> is the default: drag anywhere (including a node or an arrow) to pan. Switch to <b>Move nodes</b> to rearrange boxes. Arrows are never selectable.</li>
        <li><b>Boxes are Python files.</b> Dashed boxes are folders: double-click one to open it.</li>
        <li><b>Arrows point to what a file imports.</b> Switch to “Calls” for call relationships. Calls start in a top-down layout; select “Top down” for Imports too.</li>
        <li><b>Fit</b> reframes the entire graph; expanding or collapsing folders preserves the current camera.</li>
        <li><b>Size by links</b> makes heavily connected nodes larger, and <b>Cycles</b> highlights static import cycles in red.</li>
        <li><b>Hide transitive</b> in Imports mode to remove redundant arrows (A → C when A → B → C). The original dependencies remain available in the details.</li>
        <li><b>Hide connections</b> in a file or folder’s details to remove its arrows without removing the node.</li>
        <li><b>Click a file</b> to see what it <span style="color:var(--accent-text)">uses</span> and what <span style="color:var(--usedby)">uses it</span>, and what is inside.</li>
        <li><b>Press /</b> to search any file, class or function.</li>
      </ol>
      ${ENTRY_POINTS.length > 0 && html`<${Block} title="Start reading here" count=${ENTRY_POINTS.length}>
        <p class="hint" style="margin-bottom:6px">Where the program starts: commands, scripts and web routes.</p>
        <ul class="list">${ENTRY_POINTS.slice(0, showAll ? undefined : 15).map((n) => html`<${Row} id=${n.id} name=${n.kind === "module" ? n.path : qualOf(n.id)} meta=${entryMeta(n)} onSelect=${onSelect} />`)}</ul>
        ${ENTRY_POINTS.length > 15 && html`<button class="btn" style="margin-top:6px" onClick=${() => setShowAll(!showAll)}>${showAll ? "Show fewer" : `Show all ${ENTRY_POINTS.length}`}</button>`}
        ${SIDE_ENTRY_POINTS > 0 && html`<p class="hint" style="margin-top:6px">${plural(SIDE_ENTRY_POINTS, "more")} in tests, examples and docs.</p>`}
      </${Block}>`}
      ${MOST_USED.length > 0 && html`<${Block} title="Most imported files">
        <ul class="list">${MOST_USED.map(([id, c]) => html`<${Row} id=${id} name=${nodes.get(id).path} meta=${"used by " + c} onSelect=${onSelect} />`)}</ul>
      </${Block}>`}
      ${s.parse_errors > 0 && html`<p class="hint" style="margin-top:14px">${plural(s.parse_errors, "file")} could not be parsed and ${s.parse_errors === 1 ? "is" : "are"} drawn with a red dashed border.</p>`}
    </div>`;
  }

  function CodePanel({ path, line, end, onClose }) {
    const text = SOURCES[path] || "";
    const lines = useMemo(() => text.split("\n"), [text]);
    const ref = useRef(null);
    useEffect(() => {
      const target = ref.current && ref.current.querySelector(`[data-l="${Math.max(1, line - 3)}"]`);
      if (target) target.scrollIntoView({ block: "start" });
    }, [path, line]);
    useEffect(() => {
      const onKey = (e) => e.key === "Escape" && onClose();
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, []);
    return html`<div class="code-panel" role="dialog" aria-label=${"Source of " + path}>
      <div class="code-head">
        <button class="btn" onClick=${onClose}>← Back</button>
        <span class="path">${path}${end ? `:${line}–${end}` : ""}</span>
      </div>
      <pre class="code" ref=${ref}>${lines.map(
        (l, i) => html`<div class=${"l" + (end && i + 1 >= line && i + 1 <= end ? " hl" : "")} data-l=${i + 1}><span class="n">${i + 1}</span>${l || " "}</div>`
      )}</pre>
    </div>`;
  }

  // App ---------------------------------------------------------------------------------

  const THEMES = ["auto", "light", "dark"];
  function loadTheme() {
    try {
      return localStorage.getItem("wiringmap-theme") || "auto";
    } catch (e) {
      return "auto";
    }
  }

  function App() {
    const [expanded, setExpanded] = useState(initialExpanded);
    const [presentation, setPresentation] = useState("map");
    const [matrixCell, setMatrixCell] = useState(null);
    const [mode, setMode] = useState("imports");
    const [layouts, setLayouts] = useState({ imports: "free", calls: "layers" });
    const layoutMode = layouts[mode];
    const [interactionMode, setInteractionMode] = useState("pan");
    const [showExternal, setShowExternal] = useState(false);
    const [hideTransitive, setHideTransitive] = useState(true);
    const [sizeByConnections, setSizeByConnections] = useState(false);
    const [markCycles, setMarkCycles] = useState(true);
    const [mutedNodes, setMutedNodes] = useState(() => new Set());
    const [selected, setSelected] = useState(null);
    const [code, setCode] = useState(null);
    const [theme, setTheme] = useState(loadTheme);
    const [busy, setBusy] = useState(false);
    const [centerTick, setCenterTick] = useState(0);
    const [fitTick, setFitTick] = useState(0);
    const inspector = useRef(null);

    useEffect(() => {
      const root = document.documentElement;
      if (theme === "auto") delete root.dataset.theme;
      else root.dataset.theme = theme;
      try {
        localStorage.setItem("wiringmap-theme", theme);
      } catch (e) {}
    }, [theme]);

    const view = useMemo(
      () => buildView(expanded, mode, showExternal, mutedNodes, hideTransitive, sizeByConnections, markCycles),
      [expanded, mode, showExternal, mutedNodes, hideTransitive, sizeByConnections, markCycles]
    );

    const focus = useMemo(() => {
      if (!selected) return null;
      const mod = moduleOf(selected);
      if (mod) return view.rep.get(mod) || null;
      if (view.nodeIds.has(selected)) return selected;
      if (isDir(selected)) {
        const c = compact(selected).id;
        if (view.nodeIds.has(c)) return c;
        for (const a of ancestorsOf(selected)) if (view.nodeIds.has(a)) return a;
      }
      return null;
    }, [selected, view]);

    const select = useCallback((id, reveal) => {
      setCode(null);
      setSelected(id);
      if (inspector.current) inspector.current.scrollTop = 0;
      if (!id || !reveal) return;
      const path = dirsAbove(moduleOf(id) || id); // open the folders above it, not the item itself
      setExpanded((prev) => {
        const missing = path.filter((d) => !prev.has(d));
        return missing.length ? new Set([...prev, ...missing]) : prev;
      });
      setCenterTick((t) => t + 1);
    }, []);

    const onMapSelect = useCallback((id) => select(id, false), [select]);
    const onListSelect = useCallback((id) => {
      setPresentation("map");
      select(id, true);
    }, [select]);
    const onMatrixModule = useCallback((id) => {
      setPresentation("map");
      setMode("imports");
      select(id, true);
    }, [select]);

    const toggle = useCallback((id) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }, []);

    const toggleMuted = useCallback((id) => {
      setMutedNodes((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }, []);

    const setLayout = (value) => setLayouts((prev) => ({ ...prev, [mode]: value }));
    const kind = selected && kindOf(selected);
    const center = () => setCenterTick((t) => t + 1);
    const stats = G.stats || { nodes: {}, edges: {} };
    const functions = (stats.nodes.function || 0) + (stats.nodes.method || 0);
    const callLinks = stats.edges.calls || 0;

    return html`<div class="app">
      <header class="topbar">
        <div class="brand"><h1>${G.root_name}</h1><span class="by">wiringmap</span></div>
        <div class="stats">
          <span class="stat"><b>${totalModules.toLocaleString()}</b> files</span>
          <span class="stat"><b>${(stats.nodes.class || 0).toLocaleString()}</b> classes</span>
          <span class="stat"><b>${functions.toLocaleString()}</b> functions</span>
          <span class="stat"><b>${callLinks.toLocaleString()}</b> call links</span>
        </div>
        <div class="spacer"></div>
        <${SearchBox} onPick=${onListSelect} />
        <div class="controls">
          <div class="seg" role="group" aria-label="Visualization">
            <button aria-pressed=${presentation === "map"} onClick=${() => setPresentation("map")}>Map</button>
            <button aria-pressed=${presentation === "matrix"} onClick=${() => setPresentation("matrix")}>Matrix</button>
          </div>
          <div class="seg" role="group" aria-label="Arrows show">
            <button aria-pressed=${mode === "imports"} onClick=${() => setMode("imports")}>Imports</button>
            <button aria-pressed=${mode === "calls"} onClick=${() => setMode("calls")}>Calls</button>
          </div>
          ${mutedNodes.size > 0 && html`<button class="btn" title="Restore all hidden arrows" onClick=${() => setMutedNodes(new Set())}>Show all connections (${mutedNodes.size})</button>`}
          <div class="seg" role="group" aria-label="Graph layout">
            <button aria-pressed=${layoutMode === "free"} onClick=${() => setLayout("free")}>Free</button>
            <button aria-pressed=${layoutMode === "layers"} onClick=${() => setLayout("layers")}
              title="Callers above callees, importers above their imports">Top down</button>
          </div>
          ${mode === "imports" && html`<label class="check" title="Hide direct import arrows when another visible import path connects the same nodes. The underlying imports remain unchanged.">
            <input type="checkbox" checked=${hideTransitive} onChange=${(e) => setHideTransitive(e.target.checked)} />
            Hide transitive ${hideTransitive && view.omittedLinks > 0 ? `(${view.omittedLinks})` : ""}
          </label>`}
          <label class="check" title="Enlarge boxes with more distinct direct incoming and outgoing connections, before transitive reduction.">
            <input type="checkbox" checked=${sizeByConnections} onChange=${(e) => setSizeByConnections(e.target.checked)} /> Size by links
          </label>
          ${mode === "imports" && html`<label class="check" title="Highlight strongly connected modules, including TYPE_CHECKING imports. Collapsed folders are marked if they contain a cycle.">
            <input type="checkbox" checked=${markCycles} onChange=${(e) => setMarkCycles(e.target.checked)} /> Cycles (${IMPORT_CYCLES.groups.length})
          </label>`}
          <label class="check"><input type="checkbox" checked=${showExternal} onChange=${(e) => setShowExternal(e.target.checked)} /> Packages</label>
          <button class="btn icon" title=${"Theme: " + theme} aria-label=${"Theme: " + theme} onClick=${() => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])}>
            ${theme === "dark"
              ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`
              : theme === "light"
              ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`
              : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>`}
          </button>
        </div>
      </header>
      <div class="main">
        <div class="canvas-wrap">
          <div class="graph-layer" style=${presentation === "matrix" ? "visibility:hidden;pointer-events:none" : ""}>
          ${totalModules === 0
            ? html`<div class="empty-map">No Python files were found in this repository.</div>`
            : html`<${GraphView}
                view=${view}
                focus=${focus}
                centerTick=${centerTick}
                fitTick=${fitTick}
                layoutMode=${layoutMode}
                interactionMode=${interactionMode}
                theme=${theme}
                onSelect=${onMapSelect}
                onToggle=${toggle}
                onBusy=${setBusy}
              />`}
          </div>
          ${presentation === "matrix" && html`<${MatrixView} matrix=${MATRIX} selected=${matrixCell} onCell=${setMatrixCell} />`}
          <div class="overlay tools" hidden=${presentation === "matrix"}>
            <div class="seg" role="group" aria-label="Map interaction mode">
              <button aria-pressed=${interactionMode === "pan"}
                title="Drag anywhere, including nodes and lines, to pan. Click nodes for details."
                onClick=${() => setInteractionMode("pan")}>Pan</button>
              <button aria-pressed=${interactionMode === "move"}
                title="Drag nodes to reposition them. Drag the background or lines to pan."
                onClick=${() => setInteractionMode("move")}>Move nodes</button>
            </div>
            <button class="btn" onClick=${() => setFitTick((t) => t + 1)} title="Fit the whole map on screen">Fit</button>
            <button class="btn" disabled=${totalModules > MAX_EXPAND_ALL} title=${totalModules > MAX_EXPAND_ALL ? "Too many files to show at once; open folders one by one" : "Open every folder"} onClick=${() => setExpanded(allFolders())}>Expand all</button>
            <button class="btn" onClick=${() => setExpanded(new Set())}>Collapse all</button>
          </div>
          ${presentation === "map" && busy && html`<div class="busy">Arranging…</div>`}
          ${presentation === "map" && DIFF
            ? html`<div class="legend" aria-label="Legend">
                <span><i class="sw st-added"></i>+ Added</span>
                <span><i class="sw st-changed"></i>~ Changed</span>
                <span><i class="sw st-moved"></i>→ Renamed</span>
                <span><i class="sw st-removed"></i>× Deleted</span>
                <span><i class="sw" style="opacity:.4"></i>Unchanged</span>
              </div>`
            : null}
          <div class="legend" aria-label="Legend" hidden=${presentation !== "map" || !!DIFF}>
            <span><i class="sw"></i>Python file</span>
            <span><i class="sw folder"></i>Folder (double-click)</span>
            <span><i class="sw entry"></i>Entry point</span>
            <span><i class="sw error"></i>Not parsed</span>
            ${mode === "imports" && markCycles && html`<span><i class="sw error"></i>Import cycle</span>`}
            <span><i class="ln"></i>Uses</span>
            <span><i class="ln in"></i>Used by</span>
          </div>
        </div>
        <aside class="inspector" ref=${inspector} aria-label="Details">
          ${presentation === "matrix" && html`<${MatrixInspector} matrix=${MATRIX} selected=${matrixCell} onModule=${onMatrixModule} />`}
          ${presentation === "map" && !selected && (DIFF ? html`<${ChangesPanel} onSelect=${onListSelect} />` : html`<${Welcome} onSelect=${onListSelect} />`)}
          ${presentation === "map" && selected && selected.startsWith("ghost:") && html`<${GhostCard} id=${selected} onSelect=${onListSelect} />`}
          ${presentation === "map" && kind === "module" && html`<${ModuleCard} id=${selected} onSelect=${onListSelect} onCode=${(p, l, e) => setCode({ path: p, line: l, end: e })} onCenter=${center} mutedNodes=${mutedNodes} onToggleMuted=${toggleMuted} />`}
          ${presentation === "map" && SYMBOL.has(kind) && html`<${SymbolCard} id=${selected} onSelect=${onListSelect} onCode=${(p, l, e) => setCode({ path: p, line: l, end: e })} onCenter=${center} />`}
          ${presentation === "map" && kind === "directory" && html`<${FolderCard} id=${selected} expanded=${expanded} onSelect=${onListSelect} onToggle=${toggle} onCenter=${center} mutedNodes=${mutedNodes} onToggleMuted=${toggleMuted} />`}
          ${presentation === "map" && kind === "external" && html`<${ExternalCard} id=${selected} onSelect=${onListSelect} mutedNodes=${mutedNodes} onToggleMuted=${toggleMuted} />`}
          ${presentation === "map" && code && html`<${CodePanel} ...${code} onClose=${() => setCode(null)} />`}
        </aside>
      </div>
    </div>`;
  }

  const mount = document.getElementById("app");
  mount.textContent = "";
  render(html`<${App} />`, mount);
})();
