"""Read-only release planner. Never connects to a database or executes SQL.

Input is a freshly reviewed, commerce-only installed-state inventory. Its hashes
must come from reviewed migration evidence, not inferred from a filename/table.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OFFICE_PROJECT = "metbajilbqclwjfsxfps"


def plan(manifest, installed, root=ROOT):
    if installed.get("project_id") != OFFICE_PROJECT:
        raise ValueError("wrong_office_project")
    if manifest.get("automatic_application") is not False:
        raise ValueError("automatic_application_forbidden")
    steps = manifest["steps"]
    if [s["position"] for s in steps] != list(range(1, 17)):
        raise ValueError("unexpected_step_order")
    names = [s["file"] for s in steps]
    if len(set(names)) != len(names):
        raise ValueError("duplicate_step")
    known = installed.get("installed", {})
    if set(known) - set(names):
        raise ValueError("unknown_commerce_migration")
    pending = False
    result = []
    for step in steps:
        relative = Path(step["file"])
        source = (root / relative).resolve()
        if not source.is_relative_to(root.resolve()):
            raise ValueError("source_outside_repository")
        if hashlib.sha256(source.read_bytes()).hexdigest() != step["sha256"]:
            raise ValueError("source_hash_mismatch")
        previous = known.get(step["file"])
        if previous is not None:
            if pending:
                raise ValueError("noncontiguous_installed_history")
            if previous.get("sha256") != step["sha256"] or not previous.get("version"):
                raise ValueError("installed_identity_mismatch")
            action = "SKIP_VERIFIED_INSTALLED"
        else:
            pending = True
            action = "PENDING_SEPARATE_AUTHORIZATION"
        result.append({**step, "action": action,
                       "installed_version": previous["version"] if previous else None})
    if result[0]["action"] != "SKIP_VERIFIED_INSTALLED":
        raise ValueError("package_baseline_not_verified")
    return {"project_id": OFFICE_PROJECT, "execution_enabled": False,
            "requires_fresh_database_recheck": True, "steps": result}


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("inventory", type=Path)
    args = cli.parse_args()
    manifest = json.loads(Path(__file__).with_name("migration-manifest.json").read_text())
    print(json.dumps(plan(manifest, json.loads(args.inventory.read_text())), indent=2))
