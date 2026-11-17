import tempfile
import unittest
from pathlib import Path

import compare_real_presence as compare


class CompareRealPresenceTests(unittest.TestCase):
    def test_filters_real_empty_rows_touching_contaminated_reference(self):
        rows = [
            {'kind': 'real-empty', 'baselineA': 'clean-a', 'baselineB': 'clean-b'},
            {'kind': 'real-empty', 'baselineA': 'dirty-a', 'baselineB': 'clean-b'},
            {'kind': 'positive', 'captureId': 'kept-positive'},
        ]
        kept = compare.filter_real_empty_rows(rows, {'dirty-a'})
        self.assertEqual([row['kind'] for row in kept], ['real-empty', 'positive'])
        self.assertEqual(kept[0]['baselineA'], 'clean-a')

    def test_requires_exact_shared_clean_validation_cohort(self):
        rows = ([{'kind': 'positive', 'captureId': f'throw-{i}', 'camera': c}
                 for i in range(35) for c in range(3)] +
                [{'kind': 'synthetic-empty'} for _ in range(75)] +
                [{'kind': 'real-empty'} for _ in range(18)])
        counts, captures = compare.validate_clean_cohort(rows)
        self.assertEqual(counts, {'positive': 105, 'synthetic-empty': 75, 'real-empty': 18})
        self.assertEqual(len(captures), 35)
        with self.assertRaises(ValueError):
            compare.validate_clean_cohort(rows[:-1])

    def test_threshold_boundary_and_three_camera_coverage(self):
        self.assertTrue(compare.presence_accepts(.5))
        self.assertFalse(compare.presence_accepts(.499999))
        self.assertTrue(compare.presence_triplet_accepted([.5, .51, 1.0]))
        self.assertFalse(compare.presence_triplet_accepted([.5, .499, 1.0]))
        self.assertFalse(compare.presence_triplet_accepted([.5, .51]))

    def test_stale_checkpoint_hash_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'model.pt'
            path.write_bytes(b'checkpoint')
            self.assertEqual(compare.require_checkpoint_hash(path, compare.sha256(path)), compare.sha256(path))
            with self.assertRaises(ValueError):
                compare.require_checkpoint_hash(path, '0' * 64)


if __name__ == '__main__':
    unittest.main()
