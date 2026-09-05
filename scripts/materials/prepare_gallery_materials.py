#!/usr/bin/env python3
"""Prepare bounded gallery PBR assets. Requires Pillow; performs no runtime work.

Usage: python scripts/materials/prepare_gallery_materials.py --source-dir /tmp/museum-material-sources
Missing source files are downloaded from Poly Haven's official CDN, then verified
against pinned SHA-256s. Existing artwork / generated wallpaper is never modified.
Albedo stays sRGB; normal and roughness bytes are linear data with no ICC profile.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import tempfile
from urllib.request import urlretrieve

from PIL import Image, ImageChops, ImageStat, JpegImagePlugin


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'public/assets/museum/textures'
PLASTER_WAVES = [(3, 5, .28, .3), (9, -7, .22, 1.7), (21, 31, .18, 2.2), (59, -41, .12, .8), (97, 83, .07, 2.7)]
SOURCES = (
    ('wood_floor', 'diff', '2a1c07687b6dbb214c4b9213739c6d92d425f1f0fc8ab3ac157f105d78240789', 'wood_floor_diff_1024.jpg', 1024, 88),
    ('wood_floor', 'nor_gl', '452247f0d0d1b7fc7f8324ff3b6ed60bcc6de1405f4284eeb8d9bce90d4939c2', 'wood_floor_nor_gl_1024.jpg', 1024, 93),
    ('wood_floor', 'rough', '061f1e1293251b2d28c76e3fac1ea9452b0e8648bb8f9b3728e09db386166e5c', 'wood_floor_rough_1024.jpg', 1024, 86),
    ('american_walnut_veneer', 'diff', '10d983003bb686db4af3d35d91197fdb6144dcd15d3dcea2ef315600f51b1af5', 'joinery_wood_albedo_512.jpg', 512, 89),
    ('american_walnut_veneer', 'nor_gl', 'f54890d8dd352c8668d643adaa0ad66bd5a3b62995198b7dfb518fa59efebca2', 'joinery_wood_normal_512.jpg', 512, 93),
    ('american_walnut_veneer', 'rough', 'a13cd23228a4cb1bf0e342b4602d636123699cde61a2ff16bec1ce45a33ac62e', 'joinery_wood_roughness_512.jpg', 512, 87),
)


def byte(value):
    return round(max(0, min(255, value)))


def source_maps(source_dir):
    """Resize every matching PBR channel identically; never sharpen/bake light."""
    for asset, channel, expected_hash, filename, size, quality in SOURCES:
        source_name = f'{asset}_{channel}_1k.jpg'
        source = source_dir / source_name
        if not source.exists():
            urlretrieve(f'https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/{asset}/{source_name}', source)
        if hashlib.sha256(source.read_bytes()).hexdigest() != expected_hash:
            raise ValueError(f'Unexpected source bytes: {source_name}')
        with Image.open(source) as original:
            if original.size != (1024, 1024):
                raise ValueError(f'Unexpected source dimensions: {source_name}')
            image = original.convert('L' if channel == 'rough' else 'RGB')
            image = image.resize((size, size), Image.Resampling.LANCZOS)
            # No chroma subsampling for data normals: red and green are slopes.
            image.save(OUTPUT / filename, quality=quality, subsampling=0, optimize=True)


def periodic_field(size, waves):
    """Analytic integer-frequency noise: identical values and slopes at seams."""
    tau = math.tau
    coords = [i / (size - 1) for i in range(size)]
    values = [0.0] * (size * size)
    for fx, fy, amplitude, phase in waves:
        xs = [tau * fx * x + phase for x in coords]
        ys = [tau * fy * y for y in coords]
        for y, y_angle in enumerate(ys):
            offset = y * size
            for x, x_angle in enumerate(xs):
                values[offset + x] += amplitude * math.sin(x_angle + y_angle)
    return values


def save_gray(filename, values, size, mean, amplitude):
    image = Image.new('L', (size, size))
    image.putdata([byte(mean + amplitude * value) for value in values])
    image.save(OUTPUT / filename, optimize=True)


def normal_image(heights, size, strength):
    # +Y/OpenGL convention. The duplicated seam sample is excluded from wrap.
    period = size - 1
    pixels = []
    for y in range(size):
        for x in range(size):
            dx = (heights[y * size + (x + 1) % period] - heights[y * size + (x - 1) % period]) * strength
            dy = (heights[((y + 1) % period) * size + x] - heights[((y - 1) % period) * size + x]) * strength
            length = math.sqrt(dx * dx + dy * dy + 1)
            pixels.append((byte(127.5 - 127.5 * dx / length), byte(127.5 + 127.5 * dy / length), byte(127.5 + 127.5 / length)))
    image = Image.new('RGB', (size, size))
    image.putdata(pixels)
    return image


def save_normal(filename, heights, size, strength):
    image = normal_image(heights, size, strength)
    if filename.endswith('.jpg'):
        # Shallow plaster slopes compress well without chroma subsampling. The
        # decoded result is checked against this same analytic lossless source.
        image.save(OUTPUT / filename, quality=92, subsampling=0, optimize=True)
    else:
        image.save(OUTPUT / filename, optimize=True)


def procedural_maps():
    # Fine mineral pores only; albedo comes from an even warm-white material tint.
    plaster = periodic_field(512, PLASTER_WAVES)
    save_normal('fine_plaster_normal_512.jpg', plaster, 512, .22)
    save_gray('fine_plaster_roughness_512.png', plaster, 512, 224, 10)

    # Satin metal's brushing affects roughness, rather than carving deep grooves.
    brass = periodic_field(256, [(31, 0, .42, .1), (79, 1, .22, 1.1), (7, -1, .18, 2.2), (3, 5, .10, .7)])
    save_gray('brushed_brass_roughness_256.png', brass, 256, 222, 19)

    # Low-amplitude glaze variation; no fake mottled color or dirt overlay.
    ceramic = periodic_field(256, [(3, 5, .38, 1.1), (11, -7, .26, 2.1), (29, 31, .15, .6), (67, -53, .10, 2.9)])
    save_gray('ceramic_roughness_256.png', ceramic, 256, 229, 11)

    # A quiet warp/weft response, kept in data maps so the weave catches actual
    # light without high-contrast albedo stripes or painted shadows. Mipmaps
    # average the weave when distant. Repeat over ~12cm, use low normalScale.
    fabric = periodic_field(256, [(40, 0, .28, 0), (0, 40, .28, 0), (3, 7, .12, .4), (13, -9, .08, 1.7)])
    save_normal('fabric_weave_normal_256.png', fabric, 256, .16)
    save_gray('fabric_weave_roughness_256.png', fabric, 256, 239, 10)


def verify():
    filenames = [item[3] for item in SOURCES] + [
        'fine_plaster_normal_512.jpg', 'fine_plaster_roughness_512.png',
        'brushed_brass_roughness_256.png', 'ceramic_roughness_256.png',
        'fabric_weave_normal_256.png', 'fabric_weave_roughness_256.png',
    ]
    report = []
    for filename in filenames:
        path = OUTPUT / filename
        with Image.open(path) as image:
            size = 1024 if '_1024.' in filename else 512 if '_512.' in filename else 256
            assert image.size == (size, size), filename
            assert 'icc_profile' not in image.info, filename
            is_normal = 'normal' in filename or 'nor_gl' in filename
            if is_normal:
                assert image.mode == 'RGB', filename
                means = ImageStat.Stat(image).mean
                assert abs(means[0] - 127.5) < 3 and abs(means[1] - 127.5) < 3, filename
                assert means[2] > 235, filename
                pixels = image.tobytes()
                length_error = sum(
                    abs(math.sqrt(sum((value / 127.5 - 1) ** 2 for value in pixels[index:index + 3])) - 1)
                    for index in range(0, len(pixels), 3)
                ) / (size * size)
                assert length_error < .02, f'Normal encoding is not close to unit length: {filename}'
            if path.suffix == '.png':
                # Periodic generated maps have exact equal seam samples.
                assert image.crop((0, 0, 1, size)).tobytes() == image.crop((size - 1, 0, size, size)).tobytes(), filename
                assert image.crop((0, 0, size, 1)).tobytes() == image.crop((0, size - 1, size, size)).tobytes(), filename
            if filename == 'fine_plaster_normal_512.jpg':
                assert JpegImagePlugin.get_sampling(image) == 0, 'Normal JPEG must use 4:4:4 sampling'
                original = normal_image(periodic_field(size, PLASTER_WAVES), size, .22)
                difference = ImageStat.Stat(ImageChops.difference(image, original))
                assert max(difference.rms) < 2.5, 'Plaster normal detail lost during compression'
                starts = image.crop((0, 0, 1, size)).tobytes() + image.crop((0, 0, size, 1)).tobytes()
                ends = image.crop((size - 1, 0, size, size)).tobytes() + image.crop((0, size - 1, size, size)).tobytes()
                seam_errors = [abs(start - end) for start, end in zip(starts, ends)]
                assert max(seam_errors) <= 12 and sum(seam_errors) / len(seam_errors) < 2, 'Plaster normal seam exceeds compression tolerance'
                assert path.stat().st_size < 70 * 1024, 'Plaster normal transfer budget exceeded'
            report.append({'file': filename, 'size': size, 'bytes': path.stat().st_size, 'mean': [round(v, 2) for v in ImageStat.Stat(image).mean]})
    total = sum(entry['bytes'] for entry in report)
    # Entire new family, before crediting the old floor/plaster downloads.
    assert total < 1024 * 1024, f'Transfer budget exceeded: {total}'
    # Conservative RGBA8 with a complete mip chain, shared across repeat clones.
    gpu = sum(entry['size'] ** 2 * 4 * 4 / 3 for entry in report)
    assert gpu < 26 * 1024 * 1024, f'Texture memory budget exceeded: {gpu}'
    print(json.dumps({'assets': report, 'transferBytes': total, 'rgbaMipMiB': round(gpu / 1024 / 1024, 2)}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, default=Path(tempfile.gettempdir()) / 'museum-material-sources')
    parser.add_argument('--check', action='store_true', help='Verify existing delivery files without downloading or writing.')
    args = parser.parse_args()
    if not args.check:
        args.source_dir.mkdir(parents=True, exist_ok=True)
        OUTPUT.mkdir(parents=True, exist_ok=True)
        source_maps(args.source_dir)
        procedural_maps()
    verify()


if __name__ == '__main__':
    main()
