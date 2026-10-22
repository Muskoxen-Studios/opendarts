"""Generate deterministic image-only replay; no ground-truth coordinates in manifest."""

import argparse
import json
from pathlib import Path

from rig import CALIBRATIONS, HEIGHT, WIDTH, SyntheticRig


def generate(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    rig = SyntheticRig()
    def save(name, images):
        paths = {}
        for camera, pixels in images.items():
            filename = f'{name}-{camera}.pgm'
            (directory / filename).write_bytes(f'P5\n{WIDTH} {HEIGHT}\n255\n'.encode()+pixels)
            paths[camera] = filename
        return paths
    reference = save('empty', rig.capture())
    frames = [reference] * 3
    for name, point in [('first', (0, 102)), ('second', (60, 45)), ('third', (-80, -60))]:
        rig.throw(*point)
        frame = save(name, rig.capture())
        frames.extend([frame]*3)
    rig.takeout(1)
    frames.extend([save('partial', rig.capture())]*3)
    rig.takeout()
    frames.extend([reference]*3)
    (directory / 'sequence.json').write_text(json.dumps({
        'width': WIDTH, 'height': HEIGHT, 'calibrations': CALIBRATIONS,
        'reference': reference, 'frames': frames}, indent=2)+'\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?', default='testdata/vision')
    generate(parser.parse_args().directory)
