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

    def test_spatial_filter_ignores_sensor_noise_but_detects_coherent_change(self):
        stable = StableFrames(width=128, height=128, required=2)
        if stable.np is None:
            self.skipTest('numpy required for live camera filtering')
        np = stable.np
        rng = np.random.default_rng(42)
        base = np.full((128, 128), 100, dtype=np.uint8)
        noise = np.clip(base.astype(np.int16) + rng.normal(0, 7, base.shape), 0, 255).astype(np.uint8)
        self.assertFalse(stable.differs(base.tobytes(), noise.tobytes()))
        noise[30:42, 40:52] = 180
        self.assertTrue(stable.differs(base.tobytes(), noise.tobytes()))

    def test_camera_loss_invalidates_window(self):
        stable = StableFrames(required=2)
        stable.observe({'cam0': b'abc'}, {'cam0': b'abc'})
        self.assertIsNone(stable.observe({'cam1': b'abc'}, {'cam1': b'abc'}))


if __name__ == '__main__': unittest.main()
