import json
import tempfile
import unittest
from pathlib import Path

import report_real_keypoints as report


class ReportRealKeypointsTest(unittest.TestCase):
    def test_calibration_uses_raw_homography(self):
        with tempfile.TemporaryDirectory() as temp:
            calibration = Path(temp) / 'calibration.json'
            raw = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
            undistorted = [[2, 0, 0], [0, 2, 0], [0, 0, 1]]
            calibration.write_text(json.dumps({'cams': [
                {'homography': raw, 'homographyUndistorted': undistorted} for _ in range(3)]}))
            digest = report.sha256(calibration)
            row = {'sampleId': 'sample', 'calibration': {'path': str(calibration), 'sha256': digest}}
            self.assertEqual(report.calibration_homographies(row, {}), [raw] * 3)

    def test_validation_only_report_omits_test_split_claims(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            source = temp_path / 'source.json'
            source.write_text(json.dumps({'records': []}))
            source_digest = report.sha256(source)
            targets = temp_path / 'targets.json'
            targets.write_text(json.dumps({
                'sourceDatasetPath': str(source), 'sourceDatasetSHA256': source_digest,
                'samples': [], 'allowRetrospectiveCalibration': False,
            }))
            predictions = temp_path / 'predictions.json'
            predictions.write_text(json.dumps({
                'format': 'real-keypoint-predictions-v1',
                'targetsSHA256': report.sha256(targets), 'sourceDatasetSHA256': source_digest,
                'predictions': [{'split': 'validation', 'isPositive': False,
                                 'presenceProbability': 0.1}],
            }))
            output = temp_path / 'out'
            output.mkdir()
            (output / 'report.json').write_text(json.dumps({
                'testMetrics': {'should': 'not appear'}, 'testPresenceAccuracy': 0.99,
            }))

            result = report.run(predictions, targets, output)
            self.assertEqual(list(result['bySplit']), ['validation'])
            self.assertEqual(list(result['presenceConfusionAtHalf']), ['validation'])
            self.assertNotIn('test', result['presenceAccuracy'])
            self.assertTrue(any('consumed in earlier experiments' in limit for limit in result['limitations']))
            text = (output / 'REPORT.md').read_text()
            self.assertIn('consumed in earlier experiments', text)
            self.assertIn('TP=0, FN=0, FP=0, TN=1', text)

            target_data = json.loads(targets.read_text())
            target_data['sourceDatasetSHA256'] = '0' * 64
            targets.write_text(json.dumps(target_data))
            prediction_data = json.loads(predictions.read_text())
            prediction_data['targetsSHA256'] = report.sha256(targets)
            predictions.write_text(json.dumps(prediction_data))
            with self.assertRaisesRegex(ValueError, 'targets sourceDatasetSHA256'):
                report.run(predictions, targets, output)

    def test_rejects_target_pixel_that_disagrees_with_source_coordinates(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            calibration = temp_path / 'calibration.json'
            raw = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
            calibration.write_text(json.dumps({'cams': [
                {'homography': raw, 'homographyUndistorted': raw} for _ in range(3)]}))
            calibration_hash = report.sha256(calibration)
            source = temp_path / 'source.json'
            source.write_text(json.dumps({'records': [{
                'id': 'capture', 'label': {'coords': {'x': 0, 'y': 0}, 'segment': 'S20'}
            }]}))
            source_hash = report.sha256(source)
            targets = temp_path / 'targets.json'
            targets.write_text(json.dumps({
                'sourceDatasetPath': str(source), 'sourceDatasetSHA256': source_hash,
                'allowRetrospectiveCalibration': False,
            }))
            predictions = temp_path / 'predictions.json'
            predictions.write_text(json.dumps({
                'format': 'real-keypoint-predictions-v1',
                'targetsSHA256': report.sha256(targets),
                'predictions': [{
                    'sampleId': 'capture:cam0', 'captureId': 'capture', 'camera': 0,
                    'split': 'validation', 'isPositive': True, 'presenceProbability': 0.9,
                    'targetPixel': {'x': 501, 'y': 500}, 'predictedRawPixel': [501, 500],
                    'calibration': {'path': str(calibration), 'sha256': calibration_hash},
                }],
            }))
            with self.assertRaisesRegex(ValueError, 'target pixel projection disagrees'):
                report.run(predictions, targets, temp_path / 'out')


if __name__ == '__main__':
    unittest.main()
