"""Import Linter configuration and optional authoritative check for offline reports.

Wiringmap displays a project's declared contracts, but deliberately does not
reimplement their semantics. Only Import Linter can decide if a contract passes.
"""

from __future__ import annotations

import configparser
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib


def read_importlinter(root: Path) -> dict[str, Any] | None:
    """Read the same configuration filenames Import Linter supports.

    Keep the original contract options for display rather than interpreting
    `ignore_imports`, protected modules, or indirect import semantics ourselves.
    """
    for name in ("setup.cfg", ".importlinter", "pyproject.toml"):
        path = root / name
        if not path.is_file():
            continue
        try:
            if path.suffix == ".toml":
                raw = tomllib.loads(path.read_text(encoding="utf-8"))
                options = raw.get("tool", {}).get("importlinter")
                if not isinstance(options, dict):
                    continue
                contracts = options.get("contracts", [])
                if not isinstance(contracts, list):
                    contracts = []
            else:
                parser = configparser.ConfigParser(interpolation=None)
                parser.read(path, encoding="utf-8")
                if not parser.has_section("importlinter"):
                    continue
                options = dict(parser.items("importlinter"))
                contracts = []
                for section in parser.sections():
                    if not section.startswith("importlinter:contract:"):
                        continue
                    item = dict(parser.items(section))
                    item.setdefault("id", section.removeprefix("importlinter:contract:"))
                    for key in (
                        "layers",
                        "containers",
                        "source_modules",
                        "forbidden_modules",
                        "protected_modules",
                        "allowed_importers",
                        "modules",
                        "ignore_imports",
                    ):
                        if key in item:
                            item[key] = [v.strip() for v in item[key].splitlines() if v.strip()]
                    contracts.append(item)
        except (OSError, UnicodeError, ValueError, configparser.Error) as exc:
            return {"source": name, "error": f"Cannot read Import Linter configuration: {exc}"}

        roots = options.get("root_packages", options.get("root_package", []))
        if isinstance(roots, str):
            roots = [
                value.strip() for value in roots.replace(",", "\n").splitlines() if value.strip()
            ]
        if not isinstance(roots, list):
            roots = []
        return {
            "source": name,
            "root_packages": roots,
            "contracts": [c for c in contracts if isinstance(c, dict)],
            "excluded_type_only": options.get("exclude_type_checking_imports", False),
        }
    return None


def check_importlinter(root: Path, configuration: dict[str, Any]) -> dict[str, Any]:
    """Run Import Linter on demand; never guess which imports violate a contract.

    A checked result is embedded into the offline report unchanged. This is
    intentionally opt-in because checking may be slow or need project dependencies.
    """
    if configuration.get("error"):
        return {"status": "error", "output": configuration["error"]}
    config = configuration["source"]
    if shutil.which("lint-imports"):
        command = ["lint-imports", "--config", config, "--no-logo"]
    elif shutil.which("uv"):
        # The tool is often launched by uvx outside the target project's venv.
        # Use the project's existing venv, without modifying its dependencies.
        command = ["uv", "run", "--no-sync", "lint-imports", "--config", config, "--no-logo"]
    else:
        return {
            "status": "unavailable",
            "output": "Install Import Linter in the project environment and run lint-imports.",
        }
    try:
        result = subprocess.run(
            command,
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"status": "error", "output": str(exc)}
    output = "\n".join(part for part in (result.stdout.strip(), result.stderr.strip()) if part)
    return {
        "status": "passed" if result.returncode == 0 else "failed",
        "exit_code": result.returncode,
        "command": " ".join(command),
        "output": output[-12000:] or "(no output)",
    }
