"""Import Linter integration reads declarations and delegates checking to the tool."""

from __future__ import annotations

import json
import re
import subprocess

from typer.testing import CliRunner

from wiringmap import architecture
from wiringmap.cli import app
from wiringmap.render import render_report

runner = CliRunner()
EMBEDDED = re.compile(r'<script type="application/json" id="wiringmap-data">(.*?)</script>', re.S)


def test_toml_contracts_load_without_import_linter_installed(tmp_path):
    (tmp_path / "pyproject.toml").write_text(
        '[tool.importlinter]\n'
        'root_package = "demo"\n'
        '\n'
        '[[tool.importlinter.contracts]]\n'
        'name = "Layers"\n'
        'type = "layers"\n'
        'containers = ["demo"]\n'
        'exhaustive = true\n'
        'layers = ["cli : server", "analysis", "types"]\n'
        '\n'
        '[[tool.importlinter.contracts]]\n'
        'name = "Protect API"\n'
        'type = "protected"\n'
        'protected_modules = ["demo.analysis.*"]\n',
        encoding="utf-8",
    )
    data = architecture.read_importlinter(tmp_path)
    assert data["source"] == "pyproject.toml"
    assert data["root_packages"] == ["demo"]
    assert len(data["contracts"]) == 2
    assert data["contracts"][0]["layers"] == ["cli : server", "analysis", "types"]
    assert data["contracts"][0]["exhaustive"] is True
    assert data["contracts"][1]["protected_modules"] == ["demo.analysis.*"]
    assert "check" not in data


def test_ini_contracts_load(tmp_path):
    (tmp_path / ".importlinter").write_text(
        "[importlinter]\nroot_package = demo\n"
        "[importlinter:contract:no-upward]\n"
        "name = No upward imports\ntype = layers\n"
        "layers = cli\n    analysis\n    types\n",
        encoding="utf-8",
    )
    data = architecture.read_importlinter(tmp_path)
    assert data["root_packages"] == ["demo"]
    assert data["contracts"][0]["id"] == "no-upward"
    assert data["contracts"][0]["layers"] == ["cli", "analysis", "types"]


def test_missing_and_invalid_configuration_do_not_break_reports(tmp_path):
    assert architecture.read_importlinter(tmp_path) is None
    (tmp_path / "pyproject.toml").write_text("[tool.importlinter\n", encoding="utf-8")
    assert "error" in architecture.read_importlinter(tmp_path)


def test_linter_is_only_run_on_explicit_request(tmp_path, monkeypatch):
    config = {"source": "pyproject.toml", "root_packages": ["demo"], "contracts": []}
    calls = []
    monkeypatch.setattr(
        architecture.shutil,
        "which",
        lambda name: "/usr/bin/lint-imports" if name == "lint-imports" else None,
    )

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 1, stdout="1 broken contract", stderr="")

    monkeypatch.setattr(architecture.subprocess, "run", fake_run)
    result = architecture.check_importlinter(tmp_path, config)
    assert result["status"] == "failed"
    assert result["exit_code"] == 1
    assert result["output"] == "1 broken contract"
    assert calls[0][0] == ["lint-imports", "--config", "pyproject.toml", "--no-logo"]
    assert calls[0][1]["cwd"] == tmp_path


def test_report_embeds_contracts_as_data_not_as_html(sample_graph):
    data = {
        "source": "pyproject.toml",
        "root_packages": ["shop"],
        "contracts": [
            {"name": "Layer <script>test</script>", "type": "layers", "layers": ["service", "repo"]}
        ],
    }
    page = render_report(sample_graph, architecture=data)
    embedded = json.loads(EMBEDDED.search(page).group(1))
    assert embedded["architecture"] == data
    assert page.count("</script>") == 3  # no script breakout


def test_build_embeds_importlinter_config_but_does_not_check_by_default(make_repo, monkeypatch):
    root = make_repo(
        {
            "demo/__init__.py": "",
            "demo/api.py": "from demo import util\n",
            "demo/util.py": "",
        }
    )
    (root / "pyproject.toml").write_text(
        '[tool.importlinter]\nroot_package = "demo"\n'
        '[[tool.importlinter.contracts]]\n'
        'name = "Layers"\ntype = "layers"\nlayers = ["api", "util"]\n',
        encoding="utf-8",
    )

    def check_called(*args, **kwargs):
        raise AssertionError("Opt-in checker ran without --check-imports")

    monkeypatch.setattr("wiringmap.cli.check_importlinter", check_called)
    result = runner.invoke(app, ["build", str(root), "-q"])
    assert result.exit_code == 0, result.output
    page = (root / ".wiringmap" / "report.html").read_text(encoding="utf-8")
    arch = json.loads(EMBEDDED.search(page).group(1))["architecture"]
    assert arch["contracts"][0]["name"] == "Layers"
    assert "check" not in arch


def test_build_check_imports_embeds_authoritative_result(make_repo, monkeypatch):
    root = make_repo({"demo/__init__.py": "", "demo/api.py": ""})
    (root / "pyproject.toml").write_text(
        '[tool.importlinter]\nroot_package = "demo"\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "wiringmap.cli.check_importlinter",
        lambda *_: {"status": "passed", "output": "All kept."},
    )
    result = runner.invoke(app, ["build", str(root), "--check-imports", "-q"])
    assert result.exit_code == 0, result.output
    page = (root / ".wiringmap" / "report.html").read_text(encoding="utf-8")
    arch = json.loads(EMBEDDED.search(page).group(1))["architecture"]
    assert arch["check"]["status"] == "passed"
