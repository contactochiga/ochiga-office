"""No database, credentials or network. Exercise fail-closed release planning."""
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("planner", ROOT / "release/commerce/plan-forward-migrations.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / "release/commerce/migration-manifest.json").read_text())
        first = self.manifest["steps"][0]
        self.state = {"project_id": module.OFFICE_PROJECT, "installed": {
            first["file"]: {"sha256": first["sha256"], "version": "20261102114627"}}}

    def test_installed_package_never_reapplies(self):
        out = module.plan(self.manifest, self.state)
        self.assertFalse(out["execution_enabled"])
        self.assertEqual(out["steps"][0]["action"], "SKIP_VERIFIED_INSTALLED")
        # derived from the manifest: every step except the installed package baseline (step 1) is pending, in manifest order
        self.assertEqual([s["file"] for s in out["steps"] if s["action"] == "PENDING_SEPARATE_AUTHORIZATION"],
                         [s["file"] for s in self.manifest["steps"][1:]])

    def test_resume_same_inventory_same_plan(self):
        self.assertEqual(module.plan(self.manifest, self.state), module.plan(self.manifest, self.state))

    def test_resume_committed_prefix(self):
        for s in self.manifest["steps"][1:4]:
            self.state["installed"][s["file"]] = {"sha256": s["sha256"], "version": "isolated-test-" + str(s["position"])}
        self.assertEqual(module.plan(self.manifest, self.state)["steps"][4]["action"], "PENDING_SEPARATE_AUTHORIZATION")

    def test_fully_installed_never_reexecutes(self):
        for s in self.manifest["steps"]:
            self.state["installed"][s["file"]] = {"sha256": s["sha256"], "version": "isolated-test-" + str(s["position"])}
        self.assertTrue(all(s["action"] == "SKIP_VERIFIED_INSTALLED" for s in module.plan(self.manifest, self.state)["steps"]))

    def test_wrong_database(self):
        self.state["project_id"] = "resident-wallet"
        with self.assertRaisesRegex(ValueError, "wrong_office_project"): module.plan(self.manifest, self.state)

    def test_unknown_installed(self):
        self.state["installed"]["unreviewed.sql"] = {}
        with self.assertRaisesRegex(ValueError, "unknown_commerce_migration"): module.plan(self.manifest, self.state)

    def test_missing_package(self):
        self.state["installed"] = {}
        with self.assertRaisesRegex(ValueError, "package_baseline_not_verified"): module.plan(self.manifest, self.state)

    def test_installed_hash_drift(self):
        next(iter(self.state["installed"].values()))["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "installed_identity_mismatch"): module.plan(self.manifest, self.state)

    def test_gap_in_installed_prefix(self):
        s = self.manifest["steps"][2]
        self.state["installed"][s["file"]] = {"sha256": s["sha256"], "version": "isolated-test"}
        with self.assertRaisesRegex(ValueError, "noncontiguous"): module.plan(self.manifest, self.state)

    def test_source_tampering(self):
        self.manifest["steps"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "source_hash_mismatch"): module.plan(self.manifest, self.state)

    def test_no_auto_execution(self):
        self.manifest["automatic_application"] = True
        with self.assertRaisesRegex(ValueError, "automatic_application_forbidden"): module.plan(self.manifest, self.state)

    def test_order(self):
        self.manifest["steps"].reverse()
        with self.assertRaisesRegex(ValueError, "unexpected_step_order"): module.plan(self.manifest, self.state)


if __name__ == "__main__": unittest.main()
