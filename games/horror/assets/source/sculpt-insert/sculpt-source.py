"""Offline Blender 3.2 authoring/baking only; the game runtime remains Node.

One voxel-fused, surface-sculpted colony, divided into three existing bone-local
pieces. No generated model, external texture, annular injury patch or tube mesh
is used. The high-poly source and low-poly UV/bake result are both retained.
"""
import argparse
import hashlib
import json
import math
import os
import shutil
import sys
import time

import bpy
import bmesh
from mathutils import Vector
from mathutils import noise

parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True)
parser.add_argument("--size", type=int, default=2048)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
OUT = os.path.abspath(args.out)
if os.path.exists(OUT):
    raise RuntimeError("Refusing to overwrite an existing sculpt/bake checkpoint")
os.makedirs(OUT)
shutil.copyfile(os.path.abspath(__file__), os.path.join(OUT, "sculpt-source.py"))
if args.size != 2048:
    raise RuntimeError("The approved checkpoint uses 2K bakes")

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.cycles.use_denoising = False
scene.render.threads_mode = "FIXED"
scene.render.threads = 8
scene.render.image_settings.color_depth = "8"
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "Medium High Contrast"
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.render.bake.margin = 12
scene.render.bake.use_selected_to_active = True
scene.render.bake.use_clear = False
scene.render.bake.cage_extrusion = 0.006
scene.render.bake.max_ray_distance = 0.014

def active(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

def shader(name, colors, roughness, scale, stretch, bump_distance):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = nodes.get("Principled BSDF")
    principled.inputs["Metallic"].default_value = 0
    principled.inputs["Specular"].default_value = 0.25
    texcoord = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeVectorMath")
    mapping.operation = "MULTIPLY"
    mapping.inputs[1].default_value = stretch
    links.new(texcoord.outputs["Object"], mapping.inputs[0])
    field = nodes.new("ShaderNodeTexNoise")
    field.inputs["Scale"].default_value = scale
    field.inputs["Detail"].default_value = 4.0
    field.inputs["Roughness"].default_value = 0.72
    field.inputs["Distortion"].default_value = 0.30
    links.new(mapping.outputs["Vector"], field.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements.remove(ramp.color_ramp.elements[1])
    for i, (position, color) in enumerate(colors):
        element = ramp.color_ramp.elements[0] if i == 0 else ramp.color_ramp.elements.new(position)
        element.position = position
        element.color = (*color, 1)
    links.new(field.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], principled.inputs["Base Color"])
    rough = nodes.new("ShaderNodeMapRange")
    rough.inputs["From Min"].default_value = 0
    rough.inputs["From Max"].default_value = 1
    rough.inputs["To Min"].default_value = roughness[0]
    rough.inputs["To Max"].default_value = roughness[1]
    links.new(field.outputs["Fac"], rough.inputs["Value"])
    links.new(rough.outputs["Result"], principled.inputs["Roughness"])
    fine = nodes.new("ShaderNodeTexNoise")
    fine.inputs["Scale"].default_value = scale * 4.5
    fine.inputs["Detail"].default_value = 3
    links.new(mapping.outputs["Vector"], fine.inputs["Vector"])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.38
    bump.inputs["Distance"].default_value = bump_distance
    links.new(fine.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], principled.inputs["Normal"])
    material["authorship"] = "Original spatial pigment/fiber/roughness field, not a photographed or generated image"
    return material

root_mat = shader("root-hide", [
    (0.18, (0.016, 0.018, 0.011)), (0.42, (0.054, 0.048, 0.027)),
    (0.65, (0.105, 0.092, 0.058)), (0.83, (0.19, 0.17, 0.11)),
], (0.55, 0.88), 82, (1.4, 0.55, 1.8), 0.0015)
tissue_mat = shader("injured-interface", [
    (0.12, (0.028, 0.009, 0.007)), (0.43, (0.093, 0.024, 0.017)),
    (0.65, (0.17, 0.054, 0.038)), (0.88, (0.22, 0.12, 0.077)),
], (0.48, 0.78), 115, (1.8, 0.65, 1.2), 0.0009)
rind_mat = shader("fractured-rind", [
    (0.14, (0.050, 0.047, 0.029)), (0.39, (0.13, 0.13, 0.091)),
    (0.68, (0.25, 0.24, 0.17)), (0.87, (0.37, 0.35, 0.25)),
], (0.74, 0.98), 160, (1.0, 0.8, 1.0), 0.0018)
fabric_mat = shader("torn-pressure-fiber", [
    (0.15, (0.025, 0.021, 0.014)), (0.47, (0.10, 0.080, 0.049)),
    (0.78, (0.18, 0.15, 0.095)),
], (0.88, 0.99), 380, (1.0, 3.1, 1.2), 0.0006)
MATS = [root_mat, tissue_mat, rind_mat, fabric_mat]

# Irregular overlapping volume samples fuse before any surface detail is sculpted.
# Radii deliberately change through attachments: the source does not contain tube meshes.
SITES = {
    "thorax": [
        ((0.106, -0.054, 0.191), 0.062, (1.02, 1.27, 0.59)),
        ((0.148, 0.027, 0.196), 0.071, (0.79, 1.37, 0.80)),
        ((0.154, 0.123, 0.172), 0.061, (0.98, 1.11, 0.63)),
        ((0.210, 0.207, 0.102), 0.068, (0.86, 1.08, 0.72)),
        ((0.261, 0.282, 0.033), 0.070, (0.85, 1.45, 0.73)),
        ((0.276, 0.365, -0.018), 0.047, (0.78, 1.15, 1.03)),
        ((0.065, 0.006, 0.199), 0.041, (1.24, 0.92, 0.47)),
        ((0.056, 0.082, 0.188), 0.036, (0.90, 1.36, 0.50)),
        ((0.043, 0.152, 0.160), 0.025, (0.88, 1.80, 0.44)),
        ((0.143, -0.133, 0.160), 0.038, (0.86, 1.50, 0.62)),
        ((0.170, -0.190, 0.135), 0.019, (0.80, 1.55, 0.56)),
    ],
    "shoulder-right": [
        ((0.015, -0.061, 0.088), 0.059, (0.87, 1.78, 0.61)),
        ((0.046, 0.020, 0.064), 0.040, (0.84, 1.26, 0.85)),
        ((0.024, -0.146, 0.083), 0.033, (1.10, 1.61, 0.46)),
        ((-0.026, -0.192, 0.065), 0.017, (1.1, 1.26, 0.45)),
    ],
    "helmet": [
        ((0.151, -0.122, 0.129), 0.027, (0.86, 1.44, 0.72)),
        ((0.170, -0.070, 0.115), 0.024, (0.68, 1.37, 0.61)),
        ((0.116, -0.178, 0.104), 0.018, (1.4, 0.9, 0.66)),
    ],
}
BRANCHES = {
    "thorax": [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (0, 6), (6, 7), (7, 8), (0, 9), (9, 10)],
    "shoulder-right": [(0, 1), (0, 2), (2, 3)],
    "helmet": [(0, 1), (0, 2)],
}

def component_count(mesh):
    links = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        a, b = edge.vertices
        links[a].append(b)
        links[b].append(a)
    visited = set()
    counts = []
    for start in range(len(links)):
        if start in visited:
            continue
        pending = [start]
        count = 0
        while pending:
            vertex = pending.pop()
            if vertex in visited:
                continue
            visited.add(vertex)
            count += 1
            pending.extend(links[vertex])
        counts.append(count)
    return sorted(counts, reverse=True)

def make_volume(name, sites, offset, seed):
    data = bpy.data.metaballs.new(name + "-implicit-source")
    data.resolution = 0.0018
    data.render_resolution = 0.0018
    data.threshold = 0.58
    obj = bpy.data.objects.new(name + "-volume", data)
    scene.collection.objects.link(obj)
    samples = list(sites)
    for a, b in BRANCHES[name]:
        pa, ra, _ = sites[a]
        pb, rb, _ = sites[b]
        pa, pb = Vector(pa), Vector(pb)
        steps = math.ceil((pb - pa).length / 0.007)
        for step in range(1, steps):
            t = step / steps
            radius = (ra + (rb - ra) * t) * (0.61 + 0.06 * math.sin(t * math.pi * 2))
            samples.append((pa.lerp(pb, t), radius, (1, 1, 1)))
    for center, radius, stretch in samples:
        e = data.elements.new()
        e.type = "ELLIPSOID"
        e.co = center
        e.radius = radius
        e.size_x, e.size_y, e.size_z = stretch
        e.stiffness = 2.0
    active(obj)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    obj.name = name + "-high"
    remesh = obj.modifiers.new("Fused continuous colony", "REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = 0.0017
    remesh.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=remesh.name)
    components = component_count(obj.data)
    if len(components) != 1:
        raise RuntimeError("Colony must be one fused volume before sculpt/bake: " + name + str(components))
    smooth = obj.modifiers.new("Relax fused junctions", "SMOOTH")
    smooth.factor = 0.35
    smooth.iterations = 3
    bpy.ops.object.modifier_apply(modifier=smooth.name)
    sub = obj.modifiers.new("Sculpt surface resolution", "SUBSURF")
    sub.subdivision_type = "CATMULL_CLARK"
    sub.levels = 1
    bpy.ops.object.modifier_apply(modifier=sub.name)
    obj.data.update()
    # Multiscale folds and pitted rind are in real high-poly geometry, not a color-outline mask.
    for vertex in obj.data.vertices:
        p = vertex.co.copy()
        coarse = noise.multi_fractal(p * 32 + Vector((seed, 4.7, 1.3)), 1.1, 2.0, 3) - 0.65
        fine = noise.noise(p * 175 + Vector((1.7, seed, 8.1)))
        crease = math.sin(p.y * 131 + noise.noise(p * 27) * 5 + p.x * 49)
        ridge = math.copysign(abs(crease) ** 0.35, crease)
        amount = 0.0019 * coarse + 0.00075 * fine + 0.0010 * ridge
        vertex.co += vertex.normal * max(-0.0038, min(0.0038, amount))
    obj.data.update()
    for material in MATS:
        obj.data.materials.append(material)
    for face in obj.data.polygons:
        c = face.center
        variation = noise.noise(c * 56 + Vector((seed, 3.4, 2.6)))
        if name == "thorax":
            injured = c.y < 0.12 and c.z > 0.205 and c.x < 0.119 and variation > -0.12
            mineral = c.y > 0.16 and variation > -0.23
        else:
            injured = c.y < -0.06 and c.z > (0.107 if name == "shoulder-right" else 0.145) and variation > 0.05
            mineral = c.y > -0.04 and variation > -0.1
        face.material_index = 1 if injured else 2 if mineral else 0
        face.use_smooth = True
    obj["bone_local_target"] = name
    obj["construction"] = "Voxel-fused connected volume with multiscale surface sculpt; not annular surfaces or tube meshes"
    obj.location.x = offset
    return obj

def torn_contact(name, offset):
    # One irregular thin pressure-liner remnant embedded along the ruptured shell edge.
    if name != "thorax":
        return None
    points = [
        (0.021, -0.155, 0.195), (0.003, -0.097, 0.193), (0.026, -0.051, 0.192),
        (0.006, 0.016, 0.187), (0.033, 0.083, 0.175), (0.027, 0.132, 0.164),
        (0.053, 0.182, 0.159), (0.086, 0.177, 0.145), (0.061, 0.097, 0.169),
        (0.075, 0.038, 0.182), (0.051, -0.032, 0.197), (0.065, -0.105, 0.197),
        (0.047, -0.169, 0.182),
    ]
    mesh = bpy.data.meshes.new("targeted-torn-liner")
    mesh.from_pydata(points, [], [list(range(len(points)))])
    obj = bpy.data.objects.new("thorax-contact-high", mesh)
    scene.collection.objects.link(obj)
    obj.data.materials.append(fabric_mat)
    active(obj)
    triangulate = obj.modifiers.new("Fracture tessellation", "TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=triangulate.name)
    subdivide = obj.modifiers.new("Fiber substrate tessellation", "SUBSURF")
    subdivide.subdivision_type = "SIMPLE"
    subdivide.levels = 3
    bpy.ops.object.modifier_apply(modifier=subdivide.name)
    solid = obj.modifiers.new("Actual torn cloth thickness", "SOLIDIFY")
    solid.thickness = 0.0016
    bpy.ops.object.modifier_apply(modifier=solid.name)
    obj.location.x = offset
    return obj

highs, lows, census = [], [], []
targets = {"thorax": 22000, "shoulder-right": 8500, "helmet": 3500}
for i, (name, sites) in enumerate(SITES.items()):
    high = make_volume(name, sites, i * 1.25, i * 7 + 3)
    contact = torn_contact(name, i * 1.25)
    if contact:
        bpy.ops.object.select_all(action="DESELECT")
        high.select_set(True)
        contact.select_set(True)
        bpy.context.view_layer.objects.active = high
        bpy.ops.object.join()
    high.data.calc_loop_triangles()
    count = len(high.data.loop_triangles)
    low = high.copy()
    low.data = high.data.copy()
    low.name = name + "-low"
    scene.collection.objects.link(low)
    active(low)
    decimate = low.modifiers.new("Measured insert-only reduction", "DECIMATE")
    decimate.ratio = min(1.0, targets[name] / max(1, count))
    decimate.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=decimate.name)
    low.data.materials.clear()
    low.data.calc_loop_triangles()
    bounds_min = [min(vertex.co[axis] for vertex in low.data.vertices) for axis in range(3)]
    bounds_max = [max(vertex.co[axis] for vertex in low.data.vertices) for axis in range(3)]
    offsets = {"thorax": (0, 1.4, -0.035), "shoulder-right": (0.286, 1.629, -0.038), "helmet": (0, 1.845, -0.037)}
    for axis, origin in enumerate(offsets[name]):
        if bounds_min[axis] + origin < (-0.3941689, -0.00001, -0.3180001)[axis] or bounds_max[axis] + origin > (0.3994805, 2.0290001, 0.2677026)[axis]:
            raise RuntimeError("Insert exceeds accepted body envelope before baking: " + name + " axis" + str(axis))
    expected_components = 2 if name == "thorax" else 1
    low_components = component_count(low.data)
    if len(low_components) != expected_components:
        raise RuntimeError("Decimation changed insert connectivity: " + name + str(low_components))
    census.append({"target": name, "high_triangles": count, "low_triangles": len(low.data.loop_triangles), "connected_components": low_components, "local_bounds": {"min": bounds_min, "max": bounds_max}})
    highs.append(high)
    lows.append(low)
    print("SCULPT_PART=" + json.dumps(census[-1]), flush=True)
assert sum(part["low_triangles"] for part in census) <= 35000

# Front/back seams follow the fused growth's backbone rather than every noisy face normal.
for low, name in zip(lows, SITES):
    mesh = bmesh.new()
    mesh.from_mesh(low.data)
    def front(face):
        center = face.calc_center_median()
        nearest = min((Vector(site[0]) for site in SITES[name]), key=lambda point: (center - point).length_squared)
        return center.z >= nearest.z
    for edge in mesh.edges:
        edge.seam = len(edge.link_faces) != 2 or front(edge.link_faces[0]) != front(edge.link_faces[1])
    mesh.to_mesh(low.data)
    mesh.free()
bpy.ops.object.select_all(action="DESELECT")
for low in lows:
    low.select_set(True)
bpy.context.view_layer.objects.active = lows[0]
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.unwrap(method="ANGLE_BASED", margin=0.008)
bpy.ops.uv.pack_islands(rotate=True, margin=0.018)
bpy.ops.object.mode_set(mode="OBJECT")
uv_area = 0.0
for low in lows:
    low.data.calc_loop_triangles()
    layer = low.data.uv_layers.active
    for triangle in low.data.loop_triangles:
        a, b, c = [layer.data[loop].uv.copy() for loop in triangle.loops]
        uv_area += abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5
if uv_area < 0.25 or uv_area > 1.001:
    raise RuntimeError("Shared UV atlas has inadequate occupancy or overlapping area: " + str(uv_area))
print("UV_ATLAS_AREA=" + str(uv_area), flush=True)

def image(name, color):
    result = bpy.data.images.new(name, width=args.size, height=args.size, alpha=True)
    result.generated_color = color
    return result

base = image("insert-basecolor", (0.04, 0.035, 0.026, 1))
normal = image("insert-normal", (0.5, 0.5, 1, 1))
rough = image("insert-roughness", (0.8, 0.8, 0.8, 1))
ao = image("insert-ao", (1, 1, 1, 1))
normal.colorspace_settings.name = "Non-Color"
rough.colorspace_settings.name = "Non-Color"
ao.colorspace_settings.name = "Non-Color"
low_material = bpy.data.materials.new("baked-infestation-insert")
low_material.use_nodes = True
target_node = low_material.node_tree.nodes.new("ShaderNodeTexImage")
for low in lows:
    low.data.materials.append(low_material)

bake_records = []
for label, target, bake_type in [("basecolor", base, "DIFFUSE"), ("normal", normal, "NORMAL"), ("roughness", rough, "ROUGHNESS"), ("occlusion", ao, "AO")]:
    target_node.image = target
    low_material.node_tree.nodes.active = target_node
    for i, (high, low) in enumerate(zip(highs, lows)):
        for obj in highs + lows:
            obj.hide_render = obj not in (high, low)
        bpy.ops.object.select_all(action="DESELECT")
        high.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        started = time.monotonic()
        if bake_type == "DIFFUSE":
            bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"})
        elif bake_type == "NORMAL":
            bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
        else:
            bpy.ops.object.bake(type=bake_type)
        bake_records.append({"map": label, "target": list(SITES)[i], "seconds": time.monotonic() - started})
        print("BAKE_PART=" + json.dumps(bake_records[-1]), flush=True)

base.filepath_raw = os.path.join(OUT, "insert-basecolor.png")
base.file_format = "PNG"
base.save()
normal.filepath_raw = os.path.join(OUT, "insert-normal.png")
normal.file_format = "PNG"
normal.save()
packed = image("insert-orm", (1, 0.8, 0, 1))
packed.colorspace_settings.name = "Non-Color"
import array
ao_pixels = array.array("f", [0]) * (args.size * args.size * 4)
rough_pixels = array.array("f", [0]) * len(ao_pixels)
ao.pixels.foreach_get(ao_pixels)
rough.pixels.foreach_get(rough_pixels)
for i in range(0, len(ao_pixels), 4):
    ao_pixels[i + 1] = rough_pixels[i]
    ao_pixels[i + 2] = 0
    ao_pixels[i + 3] = 1
packed.pixels.foreach_set(ao_pixels)
packed.filepath_raw = os.path.join(OUT, "insert-orm.png")
packed.file_format = "PNG"
packed.save()

nodes = low_material.node_tree.nodes
links = low_material.node_tree.links
principled = nodes.get("Principled BSDF")
target_node.image = base
links.new(target_node.outputs["Color"], principled.inputs["Base Color"])
normal_node = nodes.new("ShaderNodeTexImage")
normal_node.image = normal
normal_map = nodes.new("ShaderNodeNormalMap")
links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
orm_node = nodes.new("ShaderNodeTexImage")
orm_node.image = packed
separate = nodes.new("ShaderNodeSeparateRGB")
links.new(orm_node.outputs["Color"], separate.inputs["Image"])
links.new(separate.outputs["G"], principled.inputs["Roughness"])
principled.inputs["Metallic"].default_value = 0
for high in highs:
    high.hide_render = True
    high.hide_set(True)
for low, name in zip(lows, SITES):
    low.location.x = 0
    low.name = name
    low.hide_render = False
    low["bone_local_target"] = name
for image_data in [base, normal, packed, rough, ao]:
    image_data.pack()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "infestation-sculpt.blend"))
bpy.ops.object.select_all(action="DESELECT")
for low in lows:
    low.select_set(True)
bpy.context.view_layer.objects.active = lows[0]
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, "infestation-insert.glb"), export_format="GLB",
    use_selection=True, export_yup=False, export_apply=True, export_tangents=True,
    export_animations=False, export_cameras=False, export_lights=False)

files = []
for name in ["insert-basecolor.png", "insert-normal.png", "insert-orm.png", "infestation-insert.glb", "infestation-sculpt.blend", "sculpt-source.py"]:
    with open(os.path.join(OUT, name), "rb") as handle:
        content = handle.read()
    files.append({"file": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
receipt = {
    "status": "First sculpt/material checkpoint only; actual assembled-body neutral/torch review pending",
    "tool": {"name": "Blender", "version": bpy.app.version_string, "device": "CPU", "samples": 16},
    "space": "Existing Aegis bone-local coordinates authored directly; export_yup=False prevents Blender Z-up conversion. Node assembly must preserve these positions and validate bounds.",
    "construction": "Continuous voxel-fused volume, multiscale high-poly surface sculpt and targeted cloth thickness; insert-only decimation, shared packed UVs and selected-to-active Cycles bakes.",
    "limitations": "Scripted sculpt, not artist-hand-sculpted or AI-generated; decimated topology, not hand-retopology. Cross-Blender-version/bake-device bit identity not promised.",
    "census": census, "uv_atlas_triangle_area": uv_area, "bakes": bake_records, "files": files,
    "no_new_model_or_generation": True, "no_other_body_or_world_export": True,
}
with open(os.path.join(OUT, "sculpt-provenance.json"), "w", encoding="utf8") as handle:
    json.dump(receipt, handle, indent=2)
print("SCULPT_COMPLETE=" + json.dumps(receipt), flush=True)
