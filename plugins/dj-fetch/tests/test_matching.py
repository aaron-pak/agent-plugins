"""Matching rules, checked on cases the first John Summit run got wrong.

Run: uv run --with curl_cffi --with yt-dlp python -m unittest discover plugins/dj-fetch/tests
"""
import importlib.util, sys, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("djfetch", Path(__file__).parent.parent / "skills/dj-fetch/scripts/djfetch.py")
dj = importlib.util.module_from_spec(spec)
sys.modules["djfetch"] = dj
spec.loader.exec_module(dj)


def f(name, length=None, br=320):
    return {"filename": "Music\\Folder\\" + name, "length": length, "bitRate": br, "size": 1}


class RequestParsing(unittest.TestCase):
    def test_remix_label(self):
        r = dj.Request("Anyma ft. Ellie Goulding", "Hypnotized (John Summit Remix)")
        self.assertEqual(r.core_tokens, ["hypnotized"])
        self.assertEqual(r.remixer_tokens, ["john", "summit"])
        self.assertEqual(r.artists, ["Anyma", "Ellie Goulding"])

    def test_non_version_parenthetical_stays_in_title(self):
        r = dj.Request("John Summit", "Shadows (Now and Forever)")
        self.assertIn("forever", r.core_tokens)
        self.assertEqual(r.remixer_tokens, [])

    def test_censored_words_dropped(self):
        r = dj.Request("Virtual Riot", "Sh*t's On F*re")
        self.assertEqual(r.core_tokens, ["on"])


class Evaluate(unittest.TestCase):
    def test_radio_show_rip_rejected(self):
        r = dj.Request("John Summit", "Shadows")
        ok, _, notes = dj.evaluate(r, f("John Summit - Shadows (ASOT 1200 Rip).mp3", 250), None)
        self.assertFalse(ok, notes)

    def test_unrequested_remix_rejected(self):
        r = dj.Request("Rolling Stones", "Satisfaction")
        ok, _, _ = dj.evaluate(r, f("Rolling Stones - Satisfaction (RL Grime Remix).mp3", 240), None)
        self.assertFalse(ok)

    def test_unlabeled_file_accepted_when_length_matches_extended(self):
        r = dj.Request("John Summit", "In Chicago")
        ok, score, _ = dj.evaluate(r, f("John Summit - In Chicago.mp3", 362), 361)
        self.assertTrue(ok)
        self.assertGreaterEqual(score, 1000)

    def test_short_version_rejected_against_extended_length(self):
        r = dj.Request("John Summit", "Deep End")
        ok, _, notes = dj.evaluate(r, f("John Summit - Deep End.mp3", 170), 345)
        self.assertFalse(ok)
        self.assertIn("length", notes[0])

    def test_requested_remix_extended_accepted(self):
        r = dj.Request("Anyma ft. Ellie Goulding", "Hypnotized (John Summit Remix)")
        ok, _, _ = dj.evaluate(r, f("Anyma & Ellie Goulding - Hypnotized (John Summit Remix) (Extended Mix).mp3", 330), 331)
        self.assertTrue(ok)

    def test_dj_pool_intro_edit_rejected(self):
        r = dj.Request("John Summit", "Where You Are")
        ok, _, _ = dj.evaluate(r, f("John Summit - Where You Are (Intro Clean).mp3", 300), None)
        self.assertFalse(ok)

    def test_low_bitrate_rejected_and_lossless_preferred(self):
        r = dj.Request("John Summit", "Where You Are")
        self.assertFalse(dj.evaluate(r, f("John Summit - Where You Are (Extended Mix).mp3", 310, 192), 310)[0])
        _, mp3, _ = dj.evaluate(r, f("John Summit - Where You Are (Extended Mix).mp3", 310), 310)
        _, aiff, _ = dj.evaluate(r, f("John Summit - Where You Are (Extended Mix).aiff", 310, None), 310)
        self.assertGreater(aiff, mp3)

    def test_free_peer_beats_long_queue(self):
        r = dj.Request("John Summit", "Where You Are")
        file = f("John Summit - Where You Are (Extended Mix).mp3", 310)
        _, free, _ = dj.evaluate(r, file, 310, {"hasFreeUploadSlot": True, "queueLength": 0, "uploadSpeed": 2_000_000})
        _, busy, _ = dj.evaluate(r, file, 310, {"hasFreeUploadSlot": False, "queueLength": 40, "uploadSpeed": 2_000_000})
        self.assertGreater(free, busy)


class BeatportChoice(unittest.TestCase):
    hits = [
        {"track_name": "Where You Are", "mix_name": "Radio Edit", "length": 180000, "artists": [{"artist_name": "John Summit", "artist_type_name": "Artist"}], "track_id": 1},
        {"track_name": "Where You Are", "mix_name": "Extended Mix", "length": 310496, "artists": [{"artist_name": "John Summit", "artist_type_name": "Artist"}], "track_id": 2},
        {"track_name": "Where You Are", "mix_name": "Gorgon City Extended Remix", "length": 386500, "artists": [{"artist_name": "John Summit", "artist_type_name": "Artist"}, {"artist_name": "Gorgon City", "artist_type_name": "Remixer"}], "track_id": 3},
    ]

    def test_prefers_extended_and_ignores_remixes(self):
        best = dj.beatport_match(dj.Request("John Summit & HAYLA", "Where You Are"), self.hits)
        self.assertEqual(best["track_id"], 2)

    def test_requested_remix_found(self):
        best = dj.beatport_match(dj.Request("John Summit", "Where You Are (Gorgon City Remix)"), self.hits)
        self.assertEqual(best["track_id"], 3)


if __name__ == "__main__":
    unittest.main()
