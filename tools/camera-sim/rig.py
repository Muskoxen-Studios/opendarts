"""Image-only synthetic acquisition. Throw coordinates never leave this module."""
import math
import threading

WIDTH = HEIGHT = 480
CALIBRATIONS = {
    "cam0": [1, 0, 240, 0, -1, 240],
    "cam1": [0.8, 0.3, 240, 0.2, -0.9, 240],
    "cam2": [0.7, -0.4, 240, -0.3, -0.8, 240],
}


class SyntheticRig:
    def __init__(self, cameras=3):
        if type(cameras) is not int or cameras not in (2, 3):
            raise ValueError("need two or three cameras")
        self.calibrations = dict(list(CALIBRATIONS.items())[:cameras])
        self._darts = []
        self._lock = threading.Lock()
        self.reference = self._board_reference()

    @staticmethod
    def validate_throw(x_mm, y_mm):
        if not all(type(v) in (int, float) and abs(v) <= 200 and math.isfinite(v)
                   for v in (x_mm, y_mm)):
            raise ValueError("x_mm and y_mm must be finite numbers within +/-200")

    def throw(self, x_mm, y_mm):
        self.validate_throw(x_mm, y_mm)
        with self._lock:
            self._darts.append((x_mm, y_mm))

    def takeout(self, count=None):
        with self._lock:
            if count is not None and (type(count) is not int or count < 1):
                raise ValueError("count must be a positive integer")
            if count is None:
                self._darts.clear()
            else:
                del self._darts[:count]

    def capture(self):
        with self._lock:
            return self._render(self._darts)

    def _board_reference(self):
        images = {}
        for camera, (a, b, c, d, e, f) in self.calibrations.items():
            det = a*e-b*d
            pixels = bytearray(WIDTH * HEIGHT)
            for row in range(HEIGHT):
                for col in range(WIDTH):
                    u, v = col-c, row-f
                    x, y = (e*u-b*v)/det, (-d*u+a*v)/det
                    radius = math.hypot(x, y)
                    angle = math.degrees(math.atan2(x, y))
                    sector = int(((angle+9) % 360)//18)
                    shade = 235 if radius > 225 else 215
                    if radius <= 170:
                        shade = 145 if sector % 2 == 0 else 205
                        if 97 <= radius <= 107 or 160 <= radius <= 170:
                            shade = 130 if sector % 2 == 0 else 180
                        if radius <= 17:
                            shade = 185
                        if radius <= 7:
                            shade = 155
                        offset = abs((angle+9) % 18-9)
                        wire_distance = radius*math.sin(math.radians(9-offset))
                        if (any(abs(radius-r) <= .55 for r in (7, 17, 97, 107, 160, 170))
                                or (radius > 17 and wire_distance <= .45)):
                            shade = 120
                    # Every reference shade stays >100 above marker intensity so
                    # adding board artwork never splits the detected silhouette.
                    pixels[row*WIDTH+col] = shade
            images[camera] = bytes(pixels)
        return images

    def _render(self, darts):
        images = {}
        for camera, (a, b, c, d, e, f) in self.calibrations.items():
            pixels = bytearray(self.reference[camera])
            for x, y in darts:
                u, v = a*x + b*y + c, d*x + e*y + f
                for row in range(max(0, int(v)-4), min(HEIGHT, int(v)+5)):
                    for col in range(max(0, int(u)-4), min(WIDTH, int(u)+5)):
                        if (col-u)**2 + (row-v)**2 <= 3.2**2:
                            pixels[row*WIDTH+col] = 20
            images[camera] = bytes(pixels)
        return images
