"""Inference architecture for the selected v6 checkpoint."""


def model_class(torch):
    nn = torch.nn
    class PresenceV6(nn.Module):
        def __init__(self):
            super().__init__()
            self.enc1 = nn.Sequential(nn.Conv2d(9, 16, 5, 2, 2), nn.ReLU(inplace=True), nn.Conv2d(16, 16, 3, padding=1), nn.ReLU(inplace=True))
            self.enc2 = nn.Sequential(nn.Conv2d(16, 32, 3, 2, 1), nn.ReLU(inplace=True))
            self.enc3 = nn.Sequential(nn.Conv2d(32, 48, 3, 2, 1), nn.ReLU(inplace=True), nn.Conv2d(48, 48, 3, padding=1), nn.ReLU(inplace=True))
            self.up2 = nn.Sequential(nn.Conv2d(80, 32, 3, padding=1), nn.ReLU(inplace=True))
            self.up1 = nn.Sequential(nn.Conv2d(48, 16, 3, padding=1), nn.ReLU(inplace=True))
            self.heat = nn.Conv2d(16, 1, 1)
            self.presenceFeatures = nn.Sequential(nn.Conv2d(48, 24, 1), nn.ReLU(inplace=True))
            self.presence = nn.Linear(48, 1)
            self.presenceEvidence = nn.Sequential(nn.Conv2d(48, 48, 3, padding=1), nn.ReLU(inplace=True),
                                                  nn.Dropout2d(.10), nn.Conv2d(48, 48, 1))
            self.presenceCorrection = nn.Sequential(nn.Linear(48 * (2 + 2 * 3 * 5), 64), nn.ReLU(inplace=True),
                                                    nn.Dropout(.20), nn.Linear(64, 1))

        def forward(self, x):
            cur, ref = x[:, :3], x[:, 3:6]
            inp = torch.cat((cur, ref, cur-ref), dim=1)
            a = self.enc1(inp); b = self.enc2(a); c = self.enc3(b)
            evidence = c + self.presenceEvidence(c)
            pooled = torch.cat((torch.nn.functional.adaptive_max_pool2d(evidence, 1).flatten(1),
                torch.nn.functional.adaptive_avg_pool2d(evidence, 1).flatten(1),
                torch.nn.functional.adaptive_max_pool2d(evidence, (3, 5)).flatten(1),
                torch.nn.functional.adaptive_avg_pool2d(evidence, (3, 5)).flatten(1)), 1)
            base = self.presenceFeatures(c)
            base_pool = torch.cat((torch.nn.functional.adaptive_max_pool2d(base, 1).flatten(1),
                                   torch.nn.functional.adaptive_avg_pool2d(base, 1).flatten(1)), 1)
            presence = self.presence(base_pool)[:, 0] + self.presenceCorrection(pooled)[:, 0]
            d = self.up2(torch.cat((torch.nn.functional.interpolate(c, size=b.shape[-2:], mode='bilinear', align_corners=False), b), 1))
            d = self.up1(torch.cat((torch.nn.functional.interpolate(d, size=a.shape[-2:], mode='bilinear', align_corners=False), a), 1))
            return self.heat(d).flatten(1), presence
    return PresenceV6
