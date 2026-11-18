"""Small architecture/loader regressions for the isolated spatial presence experiment."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    import torch
except ImportError:  # Training dependencies are optional for the detector runtime.
    torch = None

import training_presence_data as experiment
import training_localizer as baseline


@unittest.skipIf(torch is None, 'optional PyTorch training dependency is not installed')
class SpatialPresenceModelTests(unittest.TestCase):
    def setUp(self):
        self.model = experiment.model_class(torch)()
        self.old = baseline.model_class(torch)()

    def test_v2_checkpoint_load_preserves_existing_weights(self):
        old_state = {k: v.clone() for k, v in self.old.state_dict().items()}
        loaded = experiment.load_model(torch, {'state_dict': old_state})
        for key, value in old_state.items():
            self.assertTrue(torch.equal(loaded.state_dict()[key], value), key)
        self.assertIn('presenceSpatial.0.weight', loaded.state_dict())

    def test_spatial_model_returns_frozen_localizer_shape_and_presence_logit(self):
        self.model.eval()
        x = torch.zeros(2, 6, 360, 640)
        heat, presence = self.model(x)
        self.assertEqual(tuple(heat.shape), (2, 180 * 320))
        self.assertEqual(tuple(presence.shape), (2,))
        self.assertTrue(torch.isfinite(heat).all())
        self.assertTrue(torch.isfinite(presence).all())

    def test_trained_checkpoint_round_trips_through_public_loader(self):
        state = self.model.state_dict()
        restored = experiment.load_model(torch, {'state_dict': state})
        for key, value in state.items():
            self.assertTrue(torch.equal(restored.state_dict()[key], value), key)


if __name__ == '__main__':
    unittest.main()
