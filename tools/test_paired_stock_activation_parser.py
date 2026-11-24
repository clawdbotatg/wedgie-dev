"""Ensure the combined manifest parser does not decode whole envelopes."""

from hashlib import sha256
import unittest

from paired_update_boot import Pair, _hash
from test_paired_update import APP, APP_FILES, CORE, release_pair, wedgie


class RequiresStreaming(bytes):
    def decode(self, *args, **kwargs):
        raise AssertionError("unexpected whole-envelope decode")


class RequiresBoundedEncoding(str):
    def encode(self, *args, **kwargs):
        raise AssertionError("unexpected whole-text encode")


class ManifestParserTests(unittest.TestCase):
    def test_disposable_signed_manifest_and_sizes_require_only_line_decodes(self):
        contents = {**CORE, **APP_FILES}
        sizes = "".join("%d  %s\n" % (len(body), name) for name, body in sorted(contents.items())).encode()
        release, signature, shelf = release_pair(CORE, APP, APP_FILES,
            extra="@sizes  " + sha256(sizes).hexdigest() + "\n")
        pair = Pair.parse(RequiresStreaming(release), signature, RequiresStreaming(shelf), wedgie.release_ok)
        self.assertEqual(pair.files, {name: sha256(body).hexdigest() for name, body in contents.items()})
        self.assertEqual(pair.sizes(RequiresStreaming(sizes)), {name: len(body) for name, body in contents.items()})

    def test_utf8_chunks_hash_to_the_same_digest_without_a_whole_text_copy(self):
        text = "realm 🌱 ward" * 256
        self.assertEqual(_hash(RequiresBoundedEncoding(text)), sha256(text.encode()).digest())

    def test_cross_core_and_app_source_twin_is_rejected(self):
        envelope = release_pair({**CORE, "safe.py": b"unrelated source"}, APP, APP_FILES)
        with self.assertRaisesRegex(ValueError, "colliding payload module"):
            Pair.parse(*envelope, wedgie.release_ok)


if __name__ == "__main__":
    unittest.main(verbosity=2)
