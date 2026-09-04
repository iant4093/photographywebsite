import json
import unittest
from unittest.mock import patch

import test_support  # noqa: F401
import original_match


CAPTURE = "2026:03:14 14:40:46"
MODEL = "Canon EOS R7"


def candidate(file_id="original", *, name="4K1A1019.JPG", capture=CAPTURE, model=MODEL, checksum="a" * 32):
    return {
        "id": file_id, "name": name, "mimeType": "image/jpeg", "parents": ["shoot"],
        "md5Checksum": checksum, "size": "1234", "version": "1",
        "imageMediaMetadata": {"time": capture, "cameraModel": model},
    }


def evidence(**updates):
    return {"filenames": ["4k1a1019"], "captureTime": CAPTURE, "cameraModel": MODEL, **updates}


class OriginalMatchTests(unittest.TestCase):
    def test_recycled_filename_requires_timestamp_and_camera(self):
        rows = [candidate("wrong-time", capture="2025:03:14 14:40:46"), candidate("wrong-camera", model="Canon EOS R6"), candidate()]
        result = original_match.match_original(evidence(), original_match.build_match_index(rows))
        self.assertEqual(result["status"], "matched")
        self.assertEqual(result["source"]["id"], "original")
        self.assertEqual(result["method"], "filename_capture_time_camera")
        self.assertEqual(original_match.match_original(evidence(), original_match.build_match_index(rows[:2])), {"status": "unavailable"})

    def test_each_required_part_is_mandatory(self):
        index = original_match.build_match_index([candidate()])
        for missing in ({"filenames": []}, {"captureTime": ""}, {"cameraModel": ""}, {"filenames": ["unrelated"]}):
            with self.subTest(missing=missing):
                self.assertEqual(original_match.match_original(evidence(**missing), index), {"status": "unavailable"})
        for row in (candidate(capture=""), candidate(model=""), {**candidate(), "mimeType": "video/mp4"}):
            self.assertFalse(original_match.build_match_index([row]))

    def test_normalizes_camera_extension_case_and_only_known_export_prefix(self):
        index = original_match.build_match_index([candidate()])
        for name in ("4K1A1019.CR3", "20260314-4K1A1019.JPG", "20260314_4K1A1019.jpg", r"C:\exports\4K1A1019.JPG"):
            self.assertEqual(original_match.match_original(evidence(filenames=[name]), index)["status"], "matched")
        for name in ("copy-4K1A1019.JPG", "20261340-4K1A1019.jpg", "4K1A1019-2.jpg"):
            self.assertEqual(original_match.match_original(evidence(filenames=[name]), index)["status"], "unavailable")

    def test_conflicting_burst_candidates_are_ambiguous(self):
        index = original_match.build_match_index([candidate("first"), candidate("second", checksum="b" * 32)])
        self.assertEqual(original_match.match_original(evidence(), index), {"status": "ambiguous"})
        missing_checksum = candidate("second")
        del missing_checksum["md5Checksum"]
        self.assertEqual(original_match.match_original(evidence(), original_match.build_match_index([candidate(), missing_checksum])), {"status": "ambiguous"})

    def test_identical_duplicate_checksums_resolve_deterministically(self):
        index = original_match.build_match_index([candidate("z-copy"), candidate("a-copy")])
        result = original_match.match_original(evidence(), index)
        self.assertEqual(result["status"], "matched")
        self.assertEqual(result["source"]["id"], "a-copy")
        self.assertIn("identical_duplicates", result["method"])
        json.dumps(result)

    def test_subseconds_disambiguate_only_when_both_sides_supply_them(self):
        first = candidate("first", capture=CAPTURE + ".480")
        second = candidate("second", capture=CAPTURE + ".49", checksum="b" * 32)
        index = original_match.build_match_index([first, second])
        self.assertEqual(original_match.match_original(evidence(), index), {"status": "ambiguous"})
        self.assertEqual(original_match.match_original(evidence(subsecond="48"), index)["source"]["id"], "first")
        self.assertEqual(original_match.match_original(evidence(subsecond="50"), index), {"status": "unavailable"})
        self.assertEqual(original_match.match_original(evidence(subsecond="48"), original_match.build_match_index([candidate()]))["status"], "matched")

    def test_exif_and_xmp_recover_randomized_export_filename(self):
        header = b'<rdf:Description crs:RawFileName="4K1A1019.CR3" xmpMM:PreservedFileName="4K1A1019.CR3" />'
        tags = {"EXIF DateTimeOriginal": CAPTURE, "Image Model": MODEL, "EXIF SubSecTimeOriginal": "480"}
        with patch.object(original_match.exifread, "process_file", return_value=tags):
            result = original_match.extract_evidence(header, "randomized-uuid.jpg")
        self.assertEqual(result, evidence(filenames=["4k1a1019", "randomized-uuid"], subsecond="48"))
        self.assertEqual(original_match.match_original(result, original_match.build_match_index([candidate()]))["status"], "matched")
        json.dumps(result)

    def test_xmp_element_single_quote_and_entities_supported_without_xml_expansion(self):
        header = b"<crs:RawFileName>4K1A1019.CR3</crs:RawFileName><rdf:Description xmpMM:PreservedFileName='A&amp;B.JPG' irrelevant:RawFileName='wrong.jpg'/>"
        with patch.object(original_match.exifread, "process_file", return_value={}):
            result = original_match.extract_evidence(header)
        self.assertEqual(result["filenames"], ["4k1a1019", "a&b"])

    def test_malformed_exif_is_unavailable_even_with_filename(self):
        with patch.object(original_match.exifread, "process_file", side_effect=ValueError("untrusted metadata")):
            result = original_match.extract_evidence(b"bad header", "4K1A1019.JPG")
        self.assertEqual(result["filenames"], ["4k1a1019"])
        self.assertEqual(original_match.match_original(result, original_match.build_match_index([candidate()])), {"status": "unavailable"})

    def test_exact_capture_time_normalization_rejects_invalid_dates(self):
        index = original_match.build_match_index([candidate()])
        self.assertEqual(original_match.match_original(evidence(captureTime="2026-03-14T14:40:46-06:00"), index)["status"], "matched")
        self.assertEqual(original_match.match_original(evidence(captureTime="2026:02:31 14:40:46"), index)["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
