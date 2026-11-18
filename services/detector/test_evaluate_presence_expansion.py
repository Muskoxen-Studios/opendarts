import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import evaluate_presence_expansion as evaluator


class ReservedExpansionGateTests(unittest.TestCase):
    def test_unreviewed_partition_cannot_be_read_for_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, review = root/'manifest.json', root/'review.json'
            manifest.write_text('{}')
            review.write_text(json.dumps({'status': 'pending_visual_review'}))
            with self.assertRaisesRegex(ValueError, 'blind visual review'):
                evaluator.read_rows(manifest, review)

    def test_stale_freeze_rejected_before_torch_or_images_are_opened(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, review, freeze = (root/name for name in ['manifest.json', 'review.json', 'freeze.json'])
            manifest.write_text('{}')
            review.write_text('{}')
            freeze.write_text(json.dumps({'status': 'frozen_before_reserved_test_inference',
                                         'manifestSHA256': 'stale', 'reviewSHA256': 'stale'}))
            args = SimpleNamespace(output=root/'output', manifest=manifest, review=review,
                                   freeze=freeze, model=['candidate=missing-checkpoint'])
            with patch.object(evaluator.base, 'torch_modules') as load_torch:
                with self.assertRaisesRegex(ValueError, 'does not bind'):
                    evaluator.evaluate(args)
                load_torch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
