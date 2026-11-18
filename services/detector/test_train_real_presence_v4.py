"""Small model contract checks for the isolated full-encoder presence experiment."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

try:
    import torch
except ImportError:
    torch = None

import training_presence_model as experiment
import training_localizer as baseline


@unittest.skipIf(torch is None, 'optional PyTorch training dependency is not installed')
class FullEncoderPresenceTests(unittest.TestCase):
    def test_zero_residual_starts_at_incumbent_and_loader_round_trips(self):
        original = baseline.model_class(torch)().eval()
        model = experiment.load_model(torch, {'state_dict': original.state_dict()}).eval()
        c = torch.rand(2, 48, 45, 80)
        old_evidence = original.presenceFeatures(c)
        old_pool = torch.cat((torch.nn.functional.adaptive_max_pool2d(old_evidence, 1).flatten(1),
                              torch.nn.functional.adaptive_avg_pool2d(old_evidence, 1).flatten(1)), 1)
        expected = original.presence(old_pool)[:, 0]
        self.assertTrue(torch.equal(model.forward_features(c), expected))
        restored = experiment.load_model(torch, {'state_dict': model.state_dict()})
        for key, value in model.state_dict().items():
            self.assertTrue(torch.equal(restored.state_dict()[key], value), key)

    def test_forward_keeps_heatmap_contract(self):
        model = experiment.model_class(torch)().eval()
        with torch.no_grad():
            heat, presence = model(torch.zeros(1, 6, 360, 640))
        self.assertEqual(tuple(heat.shape), (1, 180 * 320))
        self.assertEqual(tuple(presence.shape), (1,))
        self.assertTrue(torch.isfinite(heat).all())
        self.assertTrue(torch.isfinite(presence).all())

    def test_hidden_evidence_branch_receives_gradient_after_output_warmup(self):
        model = experiment.model_class(torch)()
        c = torch.rand(2, 48, 12, 20)
        optimizer = torch.optim.SGD(model.parameters(), lr=.01)
        for _ in range(3):
            optimizer.zero_grad(set_to_none=True)
            model.forward_features(c).sum().backward()
            optimizer.step()
        self.assertIsNotNone(model.presenceEvidence[0].weight.grad)
        self.assertGreater(float(model.presenceEvidence[0].weight.grad.abs().sum()), 0)


if __name__ == '__main__':
    unittest.main()
