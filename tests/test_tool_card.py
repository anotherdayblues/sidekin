import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

module = Path(__file__).resolve().parents[1] / "skills/find-pet-tool/scripts/tool_card.py"
spec = importlib.util.spec_from_file_location("tool_card", module)
card = importlib.util.module_from_spec(spec)
spec.loader.exec_module(card)

class ToolCardTest(unittest.TestCase):
    def test_reason_is_a_plain_sentence_in_chinese_or_english(self):
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp) / "inbox"
            for ok in ["用于查公开资料。", "Looks up public docs."]:
                self.assertEqual(card.send(inbox, "ms-learn", ok, wait=0)["status"], "queued")
            for bad in ["See example.com", "https://example.com", "me@example.com", "Key sk-123", " "]:
                with self.assertRaises(ValueError):
                    card.send(inbox, "ms-learn", bad, wait=0)

    def test_only_catalogue_cards_and_separate_receipts(self):
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp) / "inbox"
            with self.assertRaises(ValueError):
                card.send(inbox, "unknown", "查公开资料。", wait=0)
            self.assertFalse(inbox.exists())
            result = card.send(inbox, "ms-learn", "查公开资料。", wait=0)
            ticket = result["ticket"]
            self.assertEqual(result["status"], "queued")
            self.assertEqual(sorted(p.name for p in (inbox/ticket).iterdir()), ["tool.json"])
            for prefix, status in [(".done-", "received"), (".decision-", "discarded")]:
                (inbox / (prefix+ticket+".json")).write_text(json.dumps({"ticket":ticket,"status":status}))
                self.assertEqual(card.receipt(inbox,ticket)["status"],status)
