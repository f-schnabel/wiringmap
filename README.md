# wiringmap

**See how your code is wired.** wiringmap turns any Python project into an interactive
map: what every file uses, what uses it, and what breaks if you change it. It runs
offline, produces one HTML file, and needs no AI.

[![PyPI](https://img.shields.io/pypi/v/wiringmap)](https://pypi.org/project/wiringmap/)
[![CI](https://github.com/Burnaviour/wiringmap/actions/workflows/ci.yml/badge.svg)](https://github.com/Burnaviour/wiringmap/actions/workflows/ci.yml)
[![Python 3.10–3.13](https://img.shields.io/badge/python-3.10%E2%80%933.13-blue)](https://pypi.org/project/wiringmap/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![Status: early](https://img.shields.io/badge/status-early%20preview-orange)

![wiringmap exploring a FastAPI app: the folder map, what login.py uses, the 16 files that depend on models.py, search, a function's callers and callees, and its source](docs/images/demo.gif)

<sub>Shown above: <a href="https://github.com/fastapi/full-stack-fastapi-template">fastapi/full-stack-fastapi-template</a>.</sub>

## Why

An AI agent wrote most of your code. It works, but you have never read most of it, and
now you need to change something. Which file does what? What calls this function? What
breaks if you touch it?

wiringmap answers those questions in seconds, and your code never leaves your machine.

## Try it

You need [uv](https://docs.astral.sh/uv/getting-started/installation/). Then, inside
any Python project:

```bash
uvx wiringmap build . --open
```

If running a moving Git branch instead of a release, use `uvx --refresh --from
git+https://github.com/OWNER/wiringmap.git@BRANCH wiringmap build . --open`
to pick up newly pushed changes. Regenerate the report and reload the page;
the generated HTML is static.

Or install it: `pip install wiringmap` (or `uv tool install wiringmap`), then run
`wiringmap build . --open`.

This writes `.wiringmap/report.html` and opens it in your browser. The `.wiringmap/`
folder ignores itself, so it is never committed by accident.

## What you get

- **Mouse navigation.** Left-drag anywhere to pan. To move a node or an expanded
  folder, double-click it and **hold the second press while dragging**. A quick
  double-click without dragging still opens or closes folders, and a normal click
  selects a node. Edges remain click-through, so they never block a node underneath.
  The double-click-and-hold gesture is intended for desktop mouse input.
- **A map of the whole project.** Files are boxes inside their folders, and arrows show
  imports. Switch to **Calls** to see which files call into which; thicker arrows mean
  more calls. Calls start in a **Top down** layout (callers above callees).
  Switch between **Free** and **Top down** for either view. Cyclic dependencies
  share a layer since no ordering can make every edge in a cycle point down. Large projects start with folders closed (double-click to open one), and
  tests, docs and migrations stay closed so you see the application first.
- **Stable camera.** Expanding folders and changing layouts or filters preserves
  the current zoom and pan. Initial load and an explicit **Focus/Show all** change
  reframe the graph; use **Fit** to reframe it any other time.
- **Focus without rescanning.** A folder's **Focus folder** action shows only
  modules inside that folder and their internal relationships. **Focus module**
  shows the selected file and its direct import/call neighbors. **Show all**
  restores the entire map, entirely from the data already in the HTML report.
- **Size by links.** An optional logarithmic overlay emphasizes nodes with many
  distinct direct incoming and outgoing connections. Sizes are capped and do not
  change when transitive arrows are hidden.
- **Static import cycles.** Highlight cyclic modules and cycle arrows in red,
  including a collapsed folder if it contains cyclic modules. Details list the
  other modules in the cycle. This uses static imports, including type-only
  `TYPE_CHECKING` references, so it does not imply a runtime circular-import
  failure.
- **Hide transitive imports** (on by default) to simplify the map without deleting
  underlying dependency data: if A imports B and C, and B imports C, the direct
  A → C arrow is omitted. The filter works on the visible graph, including collapsed
  folder edges, and preserves cycles. Disable it to show every direct import.
  Calls are never transitively reduced, since direct calls have distinct meaning.
- **Hide noisy connections** from a file, folder, or external package using its details panel.
  The node remains visible, and its arrows disappear in both Imports and Calls views.
  You can toggle multiple nodes and restore them with **Show all connections**.
- **Click a file** to see what it uses (indigo), what uses it (amber), its docstring,
  and the classes and functions inside it.
- **Click a function** to see what it calls and what calls it. Each link says how it
  was found: *resolved* from names and imports, *inferred* from type hints, or
  *guessed* from a unique method name.
- **"Start reading here"** lists where the program starts: commands, scripts, and web
  routes with their method and path (`POST /login/access-token`).
- **Search** every file, class and function with <kbd>/</kbd>, and **read the source**
  next to the map.
- **Big projects work too.** pandas (1,411 files) scans in under 8 seconds, and its
  report opens in under one.

## Dependency matrix and Import Linter

Switch from **Map** to **Matrix** in the report toolbar. Rows import columns,
and cells count **direct module imports**, including type-only imports. Packages start
collapsed: click the chevron beside a package in either the row or column header to
expand it into its nested packages and Python files, including `__init__.py`.
Rows and columns expand together; click again to collapse. Use **Expand one level**
or **Collapse all** to navigate larger projects, or filter by package/file name
to reveal matching paths automatically.

When expanded, a package heading becomes a structural header: its imports are
represented by its visible descendants instead, avoiding double-counting. Each
nesting depth has a different subtle background tint across rows, columns and cells;
the deeper of the two axes determines a cell's tint. Dependency heatmap intensity
and amber self-import diagonals remain visible. Only expandable packages have a
chevron; leaf modules have no decorative expansion marker. Column headings are
vertical so even deeply expanded matrices can keep compact cells; the full name is
available on hover. Click any non-empty cell to inspect the exact importer and
imported modules, then click a module in the inspector to return to its location
on the map. Expansion choices remain when switching between Map and Matrix.

Wiringmap automatically discovers Import Linter configuration from `setup.cfg`,
`.importlinter`, or `pyproject.toml`. When available, its **root package** scopes
the matrix and its **Layers** contract determines package ordering. Without
configured layers, the packages are sorted by dependency topology, with importers
before their imports (cycles are the unavoidable exception). Unlisted packages
are inserted to minimize arrows below the diagonal. The diagonal uses an amber
shade for imports within the same package. The inspector
shows the configured contracts, including protected interfaces, forbidden imports,
and independence constraints. The matrix does **not** independently implement
these contracts or claim that individual cells violate them; the heatmap indicates
import counts only.

To include an authoritative Import Linter check, run:

```bash
wiringmap build . --check-imports --open
```

This option runs `lint-imports` using the project environment and embeds its exit
status and diagnostic output in the offline report. It is opt-in: ordinary
`wiringmap build` does not run Import Linter or modify the project's environment.
If `lint-imports` is not on the path, wiringmap tries
`uv run --no-sync lint-imports`. Install Import Linter into the project's own
environment before using this option.

This is *architecture context plus actual checker output*, not a second implementation
of Import Linter's rules. A stale report reflects the state when it was generated.

## See what your AI agent changed

After an agent has edited your code, ask what changed in the *structure*, not just
which lines:

```bash
wiringmap diff            # your current files vs. your last commit
wiringmap diff --open     # the same, on the map
wiringmap diff --base main --head my-branch
```

It reports, in plain words:

- **What needs a look:** files that no longer parse, new import cycles, signature
  changes whose callers were not updated (and whether old calls will actually fail),
  logic copied from an existing function, functions that lost all their callers, and
  new third-party packages.
- **What changed, file by file:** added, changed, deleted, and renamed or moved
  functions and classes. Moves and renames are recognised from the code itself, even
  across files.
- **What depends on it:** the other files that import the changed ones.

`--markdown` prints the summary for a pull request or an AI agent, and `--json` gives
tools the full result. Nothing is checked out or changed: the old version is read
straight from git.

## Private by design

- wiringmap **reads** your code; it never runs it.
- Nothing is uploaded. The report is one self-contained file that makes no network
  requests, so you can open it offline or send it to a teammate.
- `--no-source` leaves your source code out of the report, keeping only its structure.

## Options

| Option | Meaning |
|---|---|
| `--open` | Open the report in your browser |
| `-o FILE` | Write the report somewhere else, leaving the project untouched |
| `-e PATTERN` | Skip extra paths, gitignore style (`-e "scripts/"`). `.gitignore` is always honoured |
| `--source / --no-source` | Include the source code in the report. By default it is included when the project has under 8 MB of Python |
| `-q` | No progress bar or summary |

`wiringmap scan .` writes only the data, `graph.json`: every file, class and function
plus the imports, calls, inheritance and decorators between them. Its format is
documented in [docs/graph-schema.md](docs/graph-schema.md), so you can build your own
tools on it.

## Roadmap

- [x] Code graph for Python, with call links that say how sure they are
- [x] Interactive offline map with search and source view
- [x] **`wiringmap diff`:** what an AI agent (or anyone) changed in the structure
- [ ] **Flow view:** follow a command or web request step by step through the code
- [ ] **Framework wiring:** FastAPI `Depends`, callbacks and overridden methods as links
- [ ] **Plain-English explanations** of files, folders and flows from a local model
      (Ollama), optional
- [ ] JavaScript and TypeScript

## Contributing

Bug reports and ideas are welcome: please [open an issue](https://github.com/Burnaviour/wiringmap/issues).
To work on the code, see [CONTRIBUTING.md](CONTRIBUTING.md) and
[how wiringmap works](docs/architecture.md).

If wiringmap helps you, a ⭐ helps other people find it.

## License

[MIT](LICENSE). Reports bundle [Preact](https://preactjs.com) (MIT),
[htm](https://github.com/developit/htm) (Apache-2.0),
[Cytoscape.js](https://js.cytoscape.org) and
[cytoscape-fcose](https://github.com/iVis-at-Bilkent/cytoscape.js-fcose) (MIT); see
[their licenses](src/wiringmap/render/static/vendor/licenses).
