#!/usr/bin/env python3
"""Inventory collaboration and harness evidence without modifying a project."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from typing import Any


IGNORED_DIRECTORIES = {
    ".agents",
    ".build",
    ".build-artifacts",
    ".cache",
    ".claude",
    ".expo",
    ".git",
    ".gradle",
    ".next",
    ".turbo",
    ".venv",
    "DerivedData",
    "Pods",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
}

MANIFEST_NAMES = {
    "Cargo.toml",
    "Package.swift",
    "build.gradle",
    "build.gradle.kts",
    "go.mod",
    "package.json",
    "pom.xml",
    "pyproject.toml",
    "settings.gradle",
    "settings.gradle.kts",
}

INSTRUCTION_NAMES = {"AGENTS.md", "CLAUDE.md"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="List harness-related documents, manifests, package scripts, and git state.",
    )
    parser.add_argument("root", nargs="?", default=".", help="project root (default: current directory)")
    parser.add_argument("--max-depth", type=int, default=8, help="maximum directory depth to scan")
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    return parser.parse_args()


def classify_document(relative: Path) -> str | None:
    name = relative.name.lower()
    stem = relative.stem.lower()
    path_text = relative.as_posix().lower()

    if relative.name in INSTRUCTION_NAMES:
        return "instructions"
    if name == "harness.md" or "harness" in stem:
        return "harness"
    if name == "context.md" or stem.endswith("context"):
        return "context"
    if "roadmap" in stem:
        return "roadmap"
    if stem.startswith("phase") and ("plan" in stem or re.match(r"phase[-_.]?\d", stem)):
        return "phase-plan"
    if "smoke" in stem or "runbook" in stem:
        return "smoke-runbook"
    if stem == "readme":
        return "test-readme" if "/test" in f"/{path_text}" else "readme"
    if "adr" in stem or "decision" in stem or stem == "implementation-notes":
        return "decision-record"
    if any(keyword in stem for keyword in ("endpoint", "observability", "otel", "telemetry")):
        return "specialized-reference"
    if "architecture" in stem or "design" in stem:
        return "architecture"
    if "protocol" in stem or stem.endswith("api") or "api-reference" in stem:
        return "api-protocol"
    return None


def scan_files(root: Path, max_depth: int) -> tuple[dict[str, list[str]], list[str]]:
    documents: dict[str, list[str]] = {}
    manifests: list[str] = []

    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        relative_dir = current_path.relative_to(root)
        depth = len(relative_dir.parts)
        directories[:] = sorted(
            directory
            for directory in directories
            if directory not in IGNORED_DIRECTORIES and depth < max_depth
        )
        if depth > max_depth:
            continue

        for filename in sorted(files):
            path = current_path / filename
            relative = path.relative_to(root)
            if filename in MANIFEST_NAMES:
                manifests.append(relative.as_posix())
            if path.suffix.lower() != ".md":
                continue
            role = classify_document(relative)
            if role is not None:
                documents.setdefault(role, []).append(relative.as_posix())

    return ({key: sorted(value) for key, value in sorted(documents.items())}, sorted(manifests))


def package_details(root: Path, manifests: list[str]) -> list[dict[str, Any]]:
    packages: list[dict[str, Any]] = []
    for manifest in manifests:
        if not manifest.endswith("package.json"):
            continue
        path = root / manifest
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            packages.append({"path": manifest, "error": str(error)})
            continue
        scripts = data.get("scripts")
        packages.append(
            {
                "path": manifest,
                "name": data.get("name"),
                "version": data.get("version"),
                "engines": data.get("engines"),
                "scripts": scripts if isinstance(scripts, dict) else {},
            },
        )
    return packages


def git_details(root: Path) -> dict[str, Any] | None:
    try:
        branch = subprocess.run(
            ["git", "-C", str(root), "branch", "--show-current"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "-C", str(root), "status", "--short"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.splitlines()
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    return {"branch": branch, "status": status}


def build_inventory(root: Path, max_depth: int) -> dict[str, Any]:
    documents, manifests = scan_files(root, max_depth)
    return {
        "root": str(root),
        "documents": documents,
        "manifests": manifests,
        "packages": package_details(root, manifests),
        "git": git_details(root),
    }


def render_markdown(inventory: dict[str, Any]) -> str:
    lines = [f"# Project evidence inventory: `{inventory['root']}`", ""]

    lines.extend(["## Documents", ""])
    documents = inventory["documents"]
    if documents:
        for role, paths in documents.items():
            lines.append(f"### {role}")
            lines.append("")
            lines.extend(f"- `{path}`" for path in paths)
            lines.append("")
    else:
        lines.extend(["No harness-related Markdown documents found.", ""])

    lines.extend(["## Manifests", ""])
    manifests = inventory["manifests"]
    lines.extend((f"- `{path}`" for path in manifests),)
    if not manifests:
        lines.append("No recognized manifests found.")
    lines.append("")

    lines.extend(["## Package scripts", ""])
    packages = inventory["packages"]
    if not packages:
        lines.extend(["No package.json files found.", ""])
    for package in packages:
        heading = package.get("name") or package["path"]
        version = package.get("version")
        suffix = "" if version is None else f" ({version})"
        lines.extend([f"### {heading}{suffix}", "", f"Manifest: `{package['path']}`", ""])
        if "error" in package:
            lines.extend([f"Could not parse: {package['error']}", ""])
            continue
        scripts = package.get("scripts", {})
        if scripts:
            lines.extend(f"- `npm run {name}` → `{command}`" for name, command in sorted(scripts.items()))
        else:
            lines.append("No scripts declared.")
        lines.append("")

    lines.extend(["## Git", ""])
    git = inventory["git"]
    if git is None:
        lines.append("Not a git worktree or git is unavailable.")
    else:
        lines.append(f"Branch: `{git['branch'] or '(detached)'}`")
        lines.append("")
        if git["status"]:
            lines.append("Existing changes:")
            lines.append("")
            lines.extend(f"- `{entry}`" for entry in git["status"])
        else:
            lines.append("Worktree clean.")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        raise SystemExit(f"project root is not a directory: {root}")
    if args.max_depth < 0:
        raise SystemExit("--max-depth must be non-negative")

    inventory = build_inventory(root, args.max_depth)
    if args.format == "json":
        print(json.dumps(inventory, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print(render_markdown(inventory), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
