"""Offline encoding only. Retain the lossless bake; encode only its sRGB color map."""
import argparse
import hashlib
import json
import os
import sys

import bpy

parser = argparse.ArgumentParser()
parser.add_argument("--sculpt", required=True)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
root = os.path.abspath(args.sculpt)
output = os.path.join(root, "insert-basecolor.jpg")
if os.path.exists(output):
    raise RuntimeError("Refusing to overwrite an existing encoded checkpoint")
source = os.path.join(root, "insert-basecolor.png")
image = bpy.data.images.load(source)
# Decode before changing filepath_raw: a lazy image otherwise loses its source.
image.pixels[0]
width, height = image.size
if (width, height) != (2048, 2048):
    raise RuntimeError("Expected the approved 2K color bake")
image.file_format = "JPEG"
image.filepath_raw = output
image.save()
with open(output, "rb") as handle:
    content = handle.read()
with open(source, "rb") as handle:
    original = handle.read()
receipt = {
    "processing": "Blender3.2.2 Image.save JPEG defaultencoder settings;original losslessPNGretained. No view/exposure/colorgrade applied.",
    "file": "insert-basecolor.jpg", "width": width, "height": height,
    "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
    "sourceSha256": hashlib.sha256(original).hexdigest(),
    "encoder": bpy.app.version_string,
}
with open(os.path.join(root, "basecolor-cook.json"), "w", encoding="utf8") as handle:
    json.dump(receipt, handle, indent=2)
print(json.dumps(receipt))
