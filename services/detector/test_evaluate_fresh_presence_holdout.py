import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import evaluate_fresh_presence_holdout as evaluator


class FreshHoldoutGateTests(unittest.TestCase):
    def test_pending_visual_review_rejects_before_any_model_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / 'manifest.json'
            review = root / 'review.json'
            manifest.write_text(json.dumps({'holdoutId': 'holdout', 'positivePairs': [],
                                             'negativeChallenge': {'pairs': []}, 'visits': []}))
            review.write_text(json.dumps({'holdoutId': 'holdout', 'status': 'pending_visual_review',
                                          'reviewBeforeInference': True, 'decisions': []}))
            with self.assertRaisesRegex(ValueError, 'not complete'):
                evaluator.review_rows(manifest, review)

    def test_manifest_or_review_hash_mismatch_rejects_candidate_freeze(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest, review, freeze, checkpoint = (root / name for name in
                                                     ('manifest.json', 'review.json', 'freeze.json', 'model.pt'))
            manifest.write_text(json.dumps({'holdoutId': 'holdout'}))
            review.write_text(json.dumps({'manifestSHA256': 'wrong', 'noHoldoutPredictionsSeen': True}))
            checkpoint.write_bytes(b'frozen-model')
            digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
            freeze.write_text(json.dumps({'holdoutId': 'holdout', 'status': 'frozen_before_inference',
                                          'manifestSHA256': digest(manifest), 'reviewSHA256': digest(review),
                                          'checkpointSHA256': {'v4': digest(checkpoint)}}))
            with self.assertRaisesRegex(ValueError, 'do not bind'):
                evaluator.validate_freeze(manifest, review, freeze, {'v4': checkpoint})


if __name__ == '__main__':
    unittest.main()
