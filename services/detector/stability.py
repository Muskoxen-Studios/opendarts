"""Bounded temporal stabilization for noisy live camera frames."""


class StableFrames:
    def __init__(self, threshold=12, changed_limit=64, required=3, width=None, height=None):
        self.threshold, self.changed_limit, self.required = threshold, changed_limit, required
        self.width, self.height = width, height
        self.reset()
        try:
            import numpy
            self.np = numpy
        except ImportError:
            self.np = None

    def reset(self):
        self.reference = None
        self.rgb = None
        self.count = 0

    def differs(self, a, b):
        if len(a) != len(b):
            return True
        if self.np is not None:
            np = self.np
            aa = np.frombuffer(a, dtype=np.uint8).astype(np.int16)
            bb = np.frombuffer(b, dtype=np.uint8).astype(np.int16)
            difference = aa-bb
            if self.width and self.height and len(a) == self.width*self.height:
                # Average neighbouring signed differences to suppress independent
                # sensor noise while retaining coherent movement and lighting changes.
                d = difference.reshape(self.height, self.width)
                difference = (d[:-1, :-1] + d[1:, :-1] + d[:-1, 1:] + d[1:, 1:]) / 4
            return int(np.count_nonzero(np.abs(difference) > self.threshold)) >= self.changed_limit
        count = 0
        for x, y in zip(a, b):
            if abs(x-y) > self.threshold:
                count += 1
                if count >= self.changed_limit:
                    return True
        return False

    def observe(self, gray, rgb):
        if (self.reference is None or set(gray) != set(self.reference) or
                any(self.differs(gray[k], self.reference[k]) for k in gray)):
            self.reference, self.rgb, self.count = dict(gray), dict(rgb), 1
        else:
            self.count += 1
        if self.count < self.required:
            return None
        return self.reference, self.rgb
