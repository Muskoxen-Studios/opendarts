import unittest
from stability import StableFrames


class StabilityTests(unittest.TestCase):
    def test_noise_stabilizes_but_impact_restarts_window(self):
        stable = StableFrames(threshold=12, changed_limit=4, required=3)
        gray = {'cam0': bytes([100]*100)}
        rgb = {'cam0': bytes([100]*300)}
        self.assertIsNone(stable.observe(gray, rgb))
        noisy = {'cam0': bytes([105]*100)}
        self.assertIsNone(stable.observe(noisy, rgb))
        result = stable.observe(noisy, rgb)
        self.assertEqual(result, (gray, rgb))
        impact = {'cam0': bytes([150]*4+[105]*96)}
        self.assertIsNone(stable.observe(impact, rgb))
        self.assertIsNone(stable.observe(impact, rgb))
        self.assertEqual(stable.observe(impact, rgb)[0], impact)

    def test_camera_loss_invalidates_window(self):
        stable = StableFrames(required=2)
        stable.observe({'cam0': b'abc'}, {'cam0': b'abc'})
        self.assertIsNone(stable.observe({'cam1': b'abc'}, {'cam1': b'abc'}))


if __name__ == '__main__': unittest.main()
