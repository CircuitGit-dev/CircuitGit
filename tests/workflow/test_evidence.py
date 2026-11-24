"""Checks for the static public workflow evidence, never a live workflow run."""
import hashlib
import json
import math
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "apps/web/workflow/data"


def read(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


class WorkflowEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.overview = read("overview.json")
        self.evidence = read("sources/bootstrap-evidence.publication.json")
        self.manifest = read("sources/source-manifest.json")

    def test_both_walkthroughs_have_ten_complete_steps(self):
        self.assertEqual(self.overview["schema"], "ic.workflow.overview.v1")
        self.assertEqual([c["id"] for c in self.overview["cases"]],
                         ["bootstrap-sample-hold", "cmos-inverter"])
        for case in self.overview["cases"]:
            self.assertEqual([s["number"] for s in case["stages"]], list(range(1, 11)))
            for step in case["stages"]:
                for key in ("summary", "userActions", "agentActions", "engineChecks",
                            "contracts", "evidence", "boundaries", "recovery", "sources"):
                    self.assertTrue(step[key], (case["id"], step["id"], key))

    def test_execution_is_not_implied_by_preparation(self):
        bootstrap, inverter = self.overview["cases"]
        self.assertEqual([s["status"] for s in bootstrap["stages"]],
                         ["verified"] * 7 + ["review", "planned", "planned"])
        self.assertEqual([s["status"] for s in inverter["stages"]],
                         ["verified"] + ["planned"] * 9)
        self.assertEqual(self.evidence["status"]["revision"], 10)
        self.assertEqual(self.evidence["status"]["state"], "awaiting_human_review")
        self.assertEqual(self.evidence["status"]["humanReview"], "pending")
        for flag in ("solverStarted", "jobPresent", "waveformDataPresent", "fftResultsPresent"):
            self.assertIs(self.evidence["status"][flag], False)
        for case in self.overview["cases"]:
            self.assertIs(case["provenance"]["simulationExecuted"], False)
        self.assertIs(self.overview["publication"]["historicalResultsReused"], False)

    def test_source_hashes_describe_real_bodies_and_separate_publication(self):
        expected = {
            "bootstrap-dut": "lib/pipetisar-real/RS9_L5_9bit_Bootstrap/schematic/RS9_L5_9bit_Bootstrap.scs",
            "inverter-dut": "lib/basics/cmos-inverter/schematic/cmos-inverter.scs",
        }
        for row in self.manifest["files"]:
            path = ROOT / "apps/web/workflow" / row["path"]
            raw = path.read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), row["publicationSha256"])
            self.assertIs(row["submitted"], False)
            if row["id"] in expected or row["id"] == "bootstrap-tb":
                self.assertTrue(raw.startswith(b"// PUBLICATION EXCERPT"))
                body = raw.split(b"\n", 2)[2]
                self.assertEqual(hashlib.sha256(body).hexdigest(), row["originalSourceSha256"])
                self.assertNotEqual(row["originalSourceSha256"], row["publicationSha256"])
                if row["id"] in expected:
                    self.assertEqual(body, (ROOT / expected[row["id"]]).read_bytes())
                    self.assertIn(b"@RNL", body)
            if row["id"] == "bootstrap-tb":
                self.assertIsNone(row["sourceRepositoryPath"])
        self.assertFalse(list((DATA / "sources").glob("*.rnl")))

    def test_sampling_contract_is_coherent_and_matches_published_testbench(self):
        t = self.evidence["testbench"]
        self.assertEqual(t["sampleCount"], 4096)
        self.assertEqual(t["sampleRateHz"], 1e9)
        self.assertEqual(t["coherentBin"], 1811)
        self.assertEqual(math.gcd(t["coherentBin"], t["sampleCount"]), 1)
        self.assertAlmostEqual(t["inputHz"], t["sampleRateHz"] * t["coherentBin"] / t["sampleCount"])
        self.assertAlmostEqual(t["lastSampleS"], t["firstSampleS"] +
                               (t["sampleCount"] - 1) * t["samplePeriodS"], places=15)
        self.assertEqual(t["spectrumSignal"], "VOUT")
        self.assertEqual(t["referenceSignal"], "VIN")
        self.assertIs(t["interpolationAllowed"], False)
        self.assertIs(t["transientNoiseEnabled"], False)
        self.assertEqual(t["numericalAcceptanceTargets"], [])
        tb = (DATA / "sources/bootstrap-tb.publication.scs").read_text()
        for literal in ("FIN=442138671.875", "MSAMPLE (VIN VBST VOUT 0)",
                        "CHOLD (VOUT 0) capacitor c=100f", "RLEAK (VOUT 0) resistor r=1G",
                        "stop=4.15975u", "maxstep=5p", "skipstart=64n",
                        "strobedelay=750p", "strobeperiod=1n", "outputstart=64.75n",
                        "save CLK VIN VOUT VBST VDD VDD0:p"):
            self.assertIn(literal, tb)

    def test_static_audit_is_not_process_or_solver_qualification(self):
        self.assertEqual(self.evidence["requiredModels"],
                         ["cfmom_2t", "nch_lvt_mac", "nch_ulvt_mac", "pch_ulvt_mac"])
        self.assertEqual(self.evidence["selection"]["sections"],
                         ["pre_simu", "TTMacro_MOS_MOSCAP", "TT_MOM"])
        audit = self.evidence["freshStaticAudit"]
        self.assertEqual([audit[k] for k in ("files", "scopes", "namespaceModelsFromSelectedCatalog",
                                           "requiredModelsMatched")], [4, 108, 91, 4])
        self.assertIs(audit["staticOnly"], True)
        self.assertIs(audit["readyToRun"], False)
        self.assertIs(audit["dynamicLoaderExecutionProven"], False)
        self.assertEqual(audit["scientificCompatibility"], "not_evaluated")
        self.assertIsNone(self.evidence["resources"]["memoryHardLimitBytes"])
        self.assertIsNone(self.evidence["resources"]["wallTimeHardLimitSeconds"])

    def test_publication_has_no_private_paths_credentials_or_receipt_ids(self):
        patterns = [r"/Users/", r"/home/", r"/var/folders/", r"\.local/",
                    r"\bintake_[a-f0-9]{32}\b", r"\bprobe_[a-f0-9]{32}\b",
                    r"\bdiscovery_[a-f0-9]{32}\b", r"\brequest-[a-f0-9]{64}\b",
                    r"-----BEGIN .*PRIVATE KEY", r'"ssh_target"\s*:',
                    r'"(?:api_key|token|password|private_key)"\s*:']
        for path in DATA.rglob("*"):
            if path.is_file():
                content = path.read_text(encoding="utf-8")
                for pattern in patterns:
                    self.assertIsNone(re.search(pattern, content), (path.name, pattern))

    def test_all_source_links_are_local_publication_files(self):
        for case in self.overview["cases"]:
            for step in case["stages"]:
                for source in step["sources"]:
                    self.assertEqual(source["path"], source["href"])
                    self.assertTrue(source["path"].startswith("data/sources/"))
                    self.assertNotIn("..", source["path"])
                    self.assertTrue((ROOT / "apps/web/workflow" / source["path"]).is_file())

    def test_host_modes_responsibilities_and_optional_va_are_explained(self):
        modes = json.dumps(self.overview["architecture"]["modes"], ensure_ascii=False)
        for token in ("codex app-server", "dynamicTools", "SSE", "embedded_in_circuitgit",
                      "AI 会话", "MCP"):
            self.assertIn(token, modes)
        matrix = self.overview["responsibilityMatrix"]
        self.assertEqual(len(matrix["rows"]), 10)
        self.assertEqual(len(matrix["columns"]), 5)
        self.assertTrue(all(len(row) == 5 for row in matrix["rows"]))
        va = json.dumps(self.overview["cases"][0]["stages"][4], ensure_ascii=False)
        for token in ("not_applicable", "constants.vams", "disciplines.vams", "staging"):
            self.assertIn(token, va)
        dc = json.dumps(self.overview["analysisBoundaries"], ensure_ascii=False)
        self.assertIn("unswept", dc)
        self.assertIn("axis=null", dc)


if __name__ == "__main__":
    unittest.main()
