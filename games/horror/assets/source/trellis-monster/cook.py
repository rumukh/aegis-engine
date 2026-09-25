"""Cable Warden-specific offline cook. Requires the exact approved source and Blender 5.2.2."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import time

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Quaternion, Vector


RAW_SHA = "a746635b2d00181390215f8728e4bb77e3218df20a3621547e89f9703abf0546"
MOTION_SHA = "e26edcaa4cf3703a65190b0a93432c54cedea7525a18ce45cf77a81991c1e682"
CONCEPT_SHA = "9ec968df4af0b4b7d877c5aa020048cc09e51b742b015e6ab7168376653ebbaf"
CLIPS = {"Idle": 204, "Stalk": 132, "Search": 264, "Lunge": 48}
AXES = Matrix.Rotation(math.pi / 2, 4, "X")


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def vec(point):
    return Vector((point[0], -point[2], point[1]))


def engine(point):
    return (float(point.x), float(point.z), float(-point.y))


def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def select_only(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def glb(path):
    data = path.read_bytes()
    require(struct.unpack_from("<III", data) == (0x46546C67, 2, len(data)), "Invalid GLB header")
    at = 12
    doc = binary = None
    while at < len(data):
        length, kind = struct.unpack_from("<II", data, at)
        payload = data[at + 8:at + 8 + length]
        if kind == 0x4E4F534A:
            doc = json.loads(payload)
        elif kind == 0x004E4942:
            binary = payload
        at += length + 8
    return doc, binary


def read_tracks(path):
    doc, binary = glb(path)
    widths = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}

    def accessor(index):
        a = doc["accessors"][index]
        view = doc["bufferViews"][a["bufferView"]]
        require(a["componentType"] == 5126, "Motion source must use float accessors")
        width = widths[a["type"]]
        start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = view.get("byteStride", width * 4)
        return [struct.unpack_from("<" + "f" * width, binary, start + row * stride) for row in range(a["count"])]

    clips = {}
    for animation in doc["animations"]:
        tracks = {}
        for channel in animation["channels"]:
            sampler = animation["samplers"][channel["sampler"]]
            require(sampler.get("interpolation", "LINEAR") == "LINEAR", "Unsupported motion interpolation")
            name = doc["nodes"][channel["target"]["node"]]["name"]
            tracks[(name, channel["target"]["path"])] = {
                "times": [x[0] for x in accessor(sampler["input"])],
                "values": accessor(sampler["output"]),
            }
        clips[animation["name"]] = tracks
    require(set(clips) == set(CLIPS), "Historical clip inventory changed")
    return clips


def sample(tracks, name, path, seconds, default):
    track = tracks.get((name, path))
    if track is None:
        return default
    times = track["times"]
    end = next((i for i, t in enumerate(times) if t >= seconds), len(times) - 1)
    start = max(0, end - 1)
    span = times[end] - times[start]
    alpha = 0 if span <= 0 else (seconds - times[start]) / span
    first, last = track["values"][start], track["values"][end]
    if path == "rotation":
        q1 = Quaternion((first[3], *first[:3]))
        q2 = Quaternion((last[3], *last[:3]))
        return q1.slerp(q2, alpha)
    return Vector(first).lerp(Vector(last), alpha)


def rotate_about(point, rotation):
    return Matrix.Translation(point) @ rotation @ Matrix.Translation(-point)


def source_rotation(tracks, name, seconds, strength=1):
    q = sample(tracks, name, "rotation", seconds, Quaternion())
    if strength != 1:
        q = Quaternion().slerp(q, strength)
    return AXES @ q.to_matrix().to_4x4() @ AXES.inverted()


def clean_mesh(source, receipt):
    require(sha(source) == RAW_SHA, "Source is not the user-approved unrigged001")
    bpy.ops.import_scene.gltf(filepath=str(source), disable_bone_shape=True)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    require(len(meshes) == 1, "Expected the single approved raw mesh")
    body = meshes[0]
    for vertex in body.data.vertices:
        vertex.co = body.matrix_world @ vertex.co
    body.parent = None
    body.matrix_world = Matrix.Identity(4)
    for obj in list(bpy.context.scene.objects):
        if obj != body:
            bpy.data.objects.remove(obj, do_unlink=True)
    points = np.array([engine(v.co) for v in body.data.vertices])
    low, high = points.min(axis=0), points.max(axis=0)
    scale = 2.03 / (high[1] - low[1])
    center_x = (low[0] + high[0]) / 2
    for vertex in body.data.vertices:
        x, y, z = engine(vertex.co)
        x, y, z = (x - center_x) * scale, (y - low[1]) * scale, z * scale
        # The generated forefeet are overlong; retain heels and shorten only the toe region.
        if y < 0.10 and z > -0.02:
            z = -0.02 + (z + 0.02) * 0.80
        vertex.co = vec((x, y, z))
    body.name = "CableWardenBody"
    body.data.name = "ApprovedTrellisSurface"
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=0.000002)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(body.data)
    bm.free()
    raw_uv = body.data.uv_layers.active
    require(raw_uv is not None, "Approved source lost its UVs")
    raw_uv.name = "SourceUV"
    select_only(body)
    subdivision = body.modifiers.new("OneLevelSurfaceCleanup", "SUBSURF")
    subdivision.levels = 1
    subdivision.render_levels = 1
    subdivision.subdivision_type = "CATMULL_CLARK"
    subdivision.uv_smooth = "PRESERVE_BOUNDARIES"
    bpy.ops.object.modifier_apply(modifier=subdivision.name)
    receipt["normalization"] = {
        "uniformScale": float(scale), "sourceMinY": float(low[1]), "sourceCenterX": float(center_x),
        "axes": "glTF +Y up/+Z forward -> Blender import -> glTF export_yup; no extra axis rotation",
        "targetHeightMeters": 2.03,
    }
    receipt["geometryEdits"] = [
        "Weld positional duplicates at 2 micrometres while retaining per-corner source UVs.",
        "One Catmull-Clark level to round coarse head/shoulder/foot facets and provide joint vertices.",
        "Shorten only the generated forefoot ahead of z=-0.02m by 20%, preserving heels.",
    ]
    return body


def material_sources(body):
    material = body.data.materials[0]
    material.name = "SourceTrellisTissue"
    nodes, links = material.node_tree.nodes, material.node_tree.links
    bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
    source_texture = next(n for n in nodes if n.type == "TEX_IMAGE")
    source_texture.image.name = "ApprovedRawAlbedo"
    source_texture.image.use_fake_user = True
    source_uv = nodes.new("ShaderNodeUVMap")
    source_uv.uv_map = "SourceUV"
    links.new(source_uv.outputs["UV"], source_texture.inputs["Vector"])
    bsdf.inputs["Metallic"].default_value = 0
    bsdf.inputs["Roughness"].default_value = 0.68
    tint = nodes.new("ShaderNodeMixRGB")
    tint.blend_type = "MULTIPLY"
    tint.inputs[0].default_value = 1
    tint.inputs[2].default_value = (1.12, 1.12, 1.12, 1)
    links.new(source_texture.outputs["Color"], tint.inputs[1])
    links.new(tint.outputs["Color"], bsdf.inputs["Base Color"])
    gray = nodes.new("ShaderNodeRGBToBW")
    links.new(source_texture.outputs["Color"], gray.inputs[0])
    rough = nodes.new("ShaderNodeMapRange")
    rough.inputs["From Min"].default_value = 0
    rough.inputs["From Max"].default_value = 0.45
    rough.inputs["To Min"].default_value = 0.78
    rough.inputs["To Max"].default_value = 0.50
    links.new(gray.outputs[0], rough.inputs["Value"])
    links.new(rough.outputs["Result"], bsdf.inputs["Roughness"])
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.30
    bump.inputs["Distance"].default_value = 0.008
    links.new(gray.outputs[0], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    cut = bpy.data.materials.new("RepairedDigitTissue")
    cut_nodes = cut.node_tree.nodes
    cut_bsdf = cut_nodes.get("Principled BSDF")
    cut_bsdf.inputs["Base Color"].default_value = (0.055, 0.060, 0.064, 1)
    cut_bsdf.inputs["Metallic"].default_value = 0
    cut_bsdf.inputs["Roughness"].default_value = 0.72
    noise = cut_nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 90
    cut_bump = cut_nodes.new("ShaderNodeBump")
    cut_bump.inputs["Strength"].default_value = 0.15
    cut_bump.inputs["Distance"].default_value = 0.001
    cut.node_tree.links.new(noise.outputs["Fac"], cut_bump.inputs["Height"])
    cut.node_tree.links.new(cut_bump.outputs["Normal"], cut_bsdf.inputs["Normal"])
    body.data.materials.append(cut)
    return material, cut


def cut_slot(body, center, dimensions, name):
    bpy.ops.mesh.primitive_cube_add(size=1, location=vec(center))
    cutter = bpy.context.object
    cutter.name = name
    cutter.dimensions = (dimensions[0], dimensions[2], dimensions[1])
    select_only(cutter)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for material in body.data.materials:
        cutter.data.materials.append(material)
    for polygon in cutter.data.polygons:
        polygon.material_index = 1
    bevel = cutter.modifiers.new("RoundedWeb", "BEVEL")
    bevel.width = min(dimensions) * 0.35
    bevel.segments = 3
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    select_only(body)
    operation = body.modifiers.new(name, "BOOLEAN")
    operation.operation = "DIFFERENCE"
    operation.solver = "EXACT"
    operation.object = cutter
    bpy.ops.object.modifier_apply(modifier=operation.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def repair_digits(body, receipt):
    for sign, side in [(-1, "left"), (1, "right")]:
        for i, z in enumerate([-0.010, 0.025, 0.060]):
            cut_slot(body, (sign * 0.35, 0.791 + i * 0.003, z),
                     (0.14, 0.204, 0.0055), f"FingerSeparation-{side}-{i}")
        for i, offset in enumerate([-0.035, -0.010, 0.015, 0.040]):
            cut_slot(body, (sign * (0.17 + offset), 0.035, 0.137),
                     (0.0035, 0.12, 0.09), f"ToeSeparation-{side}-{i}")
    for vertex in body.data.vertices:
        x, y, z = engine(vertex.co)
        if y < 0.018:
            vertex.co.z = 0
    for polygon in body.data.polygons:
        polygon.use_smooth = True
    body.data.update()
    receipt["geometryEdits"].extend([
        "Three bounded rounded slots through each distal finger mass, keeping palm/isolated thumb and all approved body geometry.",
        "Four narrow forefoot slots per foot; flatten only the lowest 18mm of sole vertices for planted contact.",
        "Smooth exported vertex normals are authored in this cooker, not synthesized by the engine.",
    ])


def bake_materials(body, out, receipt):
    select_only(body)
    runtime_uv = body.data.uv_layers.new(name="RuntimeUV")
    body.data.uv_layers.active = runtime_uv
    runtime_uv.active_render = True
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.008)
    bpy.ops.object.mode_set(mode="OBJECT")
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 4
    scene.render.bake.margin = 8
    scene.render.bake.use_clear = True
    outputs = []
    baked = {}
    for channel, size in [("basecolor", 2048), ("roughness", 1024), ("normal", 1024)]:
        image = bpy.data.images.new(f"CableWarden-{channel}", size, size, alpha=False)
        image.colorspace_settings.name = "sRGB" if channel == "basecolor" else "Non-Color"
        changed = []
        for material in body.data.materials:
            nodes, links = material.node_tree.nodes, material.node_tree.links
            target = nodes.new("ShaderNodeTexImage")
            target.image = image
            nodes.active = target
            if channel != "normal":
                output = next(n for n in nodes if n.type == "OUTPUT_MATERIAL")
                bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
                emission = nodes.new("ShaderNodeEmission")
                socket = bsdf.inputs["Base Color" if channel == "basecolor" else "Roughness"]
                if socket.is_linked:
                    links.new(socket.links[0].from_socket, emission.inputs["Color"])
                else:
                    value = socket.default_value
                    emission.inputs["Color"].default_value = value if channel == "basecolor" else (value, value, value, 1)
                links.new(emission.outputs[0], output.inputs["Surface"])
                changed.append((material, output, bsdf, emission))
        result = bpy.ops.object.bake(type="NORMAL" if channel == "normal" else "EMIT")
        require("FINISHED" in result, f"{channel} bake failed")
        for material, output, bsdf, emission in changed:
            material.node_tree.links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
            material.node_tree.nodes.remove(emission)
        image.filepath_raw = str(out / f"{channel}.png")
        image.file_format = "PNG"
        image.save()
        image.pack()
        pixels = np.empty(size * size * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        require(np.isfinite(pixels).all(), f"{channel} bake contains nonfinite pixels")
        baked[channel] = image
        outputs.append({"channel": channel, "dimensions": [size, size], "sha256": sha(out / f"{channel}.png"),
                        "pixelStdDev": float(pixels.reshape(-1, 4)[:, :3].std())})
    material = bpy.data.materials.new("CableWardenAuthoredPBR")
    material.use_backface_culling = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Metallic"].default_value = 0
    bsdf.inputs["Roughness"].default_value = 0.68
    for channel in ["basecolor", "roughness", "normal"]:
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = baked[channel]
        if channel == "normal":
            normal = nodes.new("ShaderNodeNormalMap")
            normal.inputs["Strength"].default_value = 0.65
            links.new(texture.outputs["Color"], normal.inputs["Color"])
            links.new(normal.outputs["Normal"], bsdf.inputs["Normal"])
        else:
            links.new(texture.outputs["Color"], bsdf.inputs["Base Color" if channel == "basecolor" else "Roughness"])
    body.data.materials.clear()
    body.data.materials.append(material)
    for polygon in body.data.polygons:
        polygon.material_index = 0
    for layer in list(body.data.uv_layers):
        if layer.name != "RuntimeUV":
            body.data.uv_layers.remove(layer)
    receipt["materials"] = {
        "maps": outputs, "metallic": 0, "roughnessRange": [0.50, 0.78], "normalStrength": 0.65,
        "bakeEngine": "Cycles CPU, emission/base-colour and tangent normals, no studio light baked",
        "provenance": "Approved generated albedo reprojected; 12% linear colour lift, luminance-derived artistic relief/roughness, localized procedural repair tissue. Not physical scans or recovered PBR.",
    }


def build_rig(body):
    data = bpy.data.armatures.new("CableWardenSkeleton")
    rig = bpy.data.objects.new("responder", data)
    bpy.context.scene.collection.objects.link(rig)
    select_only(rig)
    bpy.ops.object.mode_set(mode="EDIT")
    definitions = {
        "root": ((0, 0, 0), (0, 0.12, 0), None),
        "pelvis": ((0, 1.0, -0.035), (0, 1.3, -0.035), "root"),
        "thorax": ((0, 1.3, -0.035), (0, 1.68, -0.015), "pelvis"),
        "helmet": ((0, 1.68, -0.015), (0, 2.0, 0.08), "thorax"),
    }
    for sign, side in [(-1, "left"), (1, "right")]:
        definitions.update({
            f"hip-{side}": ((sign * 0.135, 1.0, -0.035), (sign * 0.150, 0.54, -0.06), "pelvis"),
            f"knee-{side}": ((sign * 0.150, 0.54, -0.06), (sign * 0.170, 0.115, -0.11), f"hip-{side}"),
            f"ankle-{side}": ((sign * 0.170, 0.115, -0.11), (sign * 0.175, 0.055, 0.10), f"knee-{side}"),
            f"shoulder-{side}": ((sign * 0.225, 1.58, -0.055), (sign * 0.29, 1.22, -0.06), "thorax"),
            f"elbow-{side}": ((sign * 0.29, 1.22, -0.06), (sign * 0.335, 0.985, 0.025), f"shoulder-{side}"),
            f"hand-{side}": ((sign * 0.335, 0.985, 0.025), (sign * 0.34, 0.90, 0.04), f"elbow-{side}"),
        })
        for finger, z in enumerate([-0.030, 0.0075, 0.0425, 0.082]):
            definitions[f"finger-{side}-{finger}"] = (
                (sign * 0.342, 0.904, z), (sign * 0.322, 0.790, z + 0.005), f"hand-{side}"
            )
    for name, (head, tail, parent) in definitions.items():
        bone = data.edit_bones.new(name)
        bone.head, bone.tail = vec(head), vec(tail)
        if parent:
            bone.parent = data.edit_bones[parent]
        bone.use_deform = name != "root"
    bpy.ops.object.mode_set(mode="OBJECT")
    names = [name for name in definitions if name != "root"]
    points = np.array([engine(vertex.co) for vertex in body.data.vertices])
    edges = np.array([list(edge.vertices) for edge in body.data.edges], dtype=np.int32)
    adjacency = [[] for _ in points]
    for a, b in edges:
        adjacency[a].append(b)
        adjacency[b].append(a)

    def components_below(height):
        unseen = set(np.flatnonzero(points[:, 1] < height).tolist())
        result = []
        while unseen:
            pending = [unseen.pop()]
            members = []
            while pending:
                index = pending.pop()
                members.append(index)
                for other in adjacency[index]:
                    if other in unseen:
                        unseen.remove(other)
                        pending.append(other)
            result.append(np.array(members, dtype=np.int32))
        return result

    arm_regions = {}
    for members in components_below(1.4):
        if len(members) < 500:
            continue
        part = points[members]
        if part[:, 0].max() < -0.1:
            arm_regions["left"] = members
        elif part[:, 0].min() > 0.1:
            arm_regions["right"] = members
    require(set(arm_regions) == {"left", "right"}, "Approved surface no longer has the measured separate arm regions")
    leg_regions = {}
    for members in components_below(0.88):
        if len(members) < 500 or points[members, 1].min() > 0.02:
            continue
        leg_regions["left" if points[members, 0].mean() < 0 else "right"] = members
    require(set(leg_regions) == {"left", "right"}, "Approved surface no longer has separate lower-leg regions")
    allowed = np.ones((len(points), len(names)), dtype=bool)
    low_body = points[:, 1] < 1.4
    for members in arm_regions.values():
        low_body[members] = False
    arm_names = {name for name in names if name.startswith(("shoulder-", "elbow-", "hand-", "finger-"))}
    for column, name in enumerate(names):
        if name in arm_names:
            allowed[low_body, column] = False
    for side, members in arm_regions.items():
        for column, name in enumerate(names):
            allowed[members, column] = name == "thorax" or (
                name in arm_names and (name.endswith(f"-{side}") or f"-{side}-" in name))
    for side, members in leg_regions.items():
        for column, name in enumerate(names):
            allowed[members, column] = name in {"pelvis", f"hip-{side}", f"knee-{side}", f"ankle-{side}"}
    distances = np.empty_like(allowed, dtype=np.float64)
    for column, name in enumerate(names):
        head, tail, _ = definitions[name]
        head, tail = np.array(head), np.array(tail)
        direction = tail - head
        along = np.clip(((points - head) @ direction) / (direction @ direction), 0, 1)
        distances[:, column] = np.linalg.norm(points - (head + along[:, None] * direction), axis=1)
    nearest = np.argmin(np.where(allowed, distances, np.inf), axis=1)
    chain_neighbors = np.zeros((len(names), len(names)), dtype=bool)
    for i, name in enumerate(names):
        parent = definitions[name][2]
        for j, other in enumerate(names):
            chain_neighbors[i, j] = other == name or other == parent or definitions[other][2] == name
    allowed &= chain_neighbors[nearest]
    weights = np.where(allowed, 1 / (distances + 0.035) ** 4, 0)
    weights /= weights.sum(axis=1, keepdims=True)
    degree = np.array([len(neighbors) for neighbors in adjacency], dtype=float)[:, None]
    require((degree > 0).all(), "Cleaned surface contains isolated vertices")
    for _ in range(64):
        neighbors = np.zeros_like(weights)
        np.add.at(neighbors, edges[:, 0], weights[edges[:, 1]])
        np.add.at(neighbors, edges[:, 1], weights[edges[:, 0]])
        weights = 0.5 * weights + 0.5 * neighbors / degree
        weights /= weights.sum(axis=1, keepdims=True)
    for name in names:
        body.vertex_groups.new(name=name)
    for vertex in body.data.vertices:
        x, y, _ = points[vertex.index]
        side = "left" if x < 0 else "right"
        influence = {name: float(weights[vertex.index, i]) for i, name in enumerate(names)}
        foot = 1 - smooth(0.06, 0.19, y)
        if foot > 0:
            influence = {name: value * (1 - foot) for name, value in influence.items()}
            influence[f"ankle-{side}"] += foot
        selected = sorted(influence.items(), key=lambda item: item[1], reverse=True)[:4]
        total = sum(value for _, value in selected)
        require(total > 0, f"Unweighted vertex {vertex.index}")
        for name, weight in selected:
            body.vertex_groups[name].add([vertex.index], weight / total, "REPLACE")
    modifier = body.modifiers.new("CableWardenSkin", "ARMATURE")
    modifier.object = rig
    modifier.use_deform_preserve_volume = False
    body.parent = rig
    return rig, definitions, {"armRegionVertices": {side: len(part) for side, part in arm_regions.items()},
                              "legRegionVertices": {side: len(part) for side, part in leg_regions.items()},
                              "surfaceRelaxationIterations": 64}


def solve_knee(hip, ankle, thigh_length, shin_length):
    delta = ankle - hip
    distance = delta.length
    require(abs(thigh_length - shin_length) < distance < thigh_length + shin_length,
            f"Foot target outside leg reach: {distance} / {thigh_length + shin_length}")
    direction = delta.normalized()
    along = (thigh_length * thigh_length - shin_length * shin_length + distance * distance) / (2 * distance)
    pole = vec((0, 0, 1))
    bend = (pole - direction * pole.dot(direction)).normalized()
    return hip + direction * along + bend * math.sqrt(max(0, thigh_length * thigh_length - along * along))


def bone_motion(head, tail, target_head, target_tail):
    rotation = (tail - head).rotation_difference(target_tail - target_head)
    return Matrix.Translation(target_head) @ rotation.to_matrix().to_4x4() @ Matrix.Translation(-head)


def animate(rig, definitions, clips, receipt):
    rig.animation_data_create()
    rest = {name: bone.matrix_local.copy() for name, bone in rig.data.bones.items()}
    heads = {name: vec(head) for name, (head, _, _) in definitions.items()}
    tails = {name: vec(tail) for name, (_, tail, _) in definitions.items()}
    facts = []
    for name, frames in CLIPS.items():
        action = bpy.data.actions.new(name)
        rig.animation_data.action = action
        tracks = clips[name]
        for frame in range(frames + 1):
            seconds = frame / 60
            bpy.context.scene.frame_set(frame)
            phase = seconds / 1.1
            hip_height = 0.885 + 0.047 * math.sin(math.pi * (phase % 1)) ** 2 if name == "Stalk" else 1.0
            sway = -0.014 * math.sin(phase * math.pi) if name == "Stalk" else 0
            delta = vec((sway, hip_height - 1.0, 0))
            pelvis = Matrix.Translation(delta)
            motions = {"root": Matrix.Identity(4), "pelvis": pelvis}
            motions["thorax"] = pelvis @ rotate_about(heads["thorax"], source_rotation(tracks, "thorax", seconds))
            motions["helmet"] = motions["thorax"] @ rotate_about(heads["helmet"], source_rotation(tracks, "helmet", seconds))
            for leg, (sign, side) in enumerate([(-1, "left"), (1, "right")]):
                local = (phase + leg) % 2
                part = local % 1
                foot_z = (0.4 - 0.8 * part if local < 1 else -0.4 * math.cos(part * math.pi)) if name == "Stalk" else 0
                lift = 0.075 * math.sin(part * math.pi) ** 2 if name == "Stalk" and local >= 1 else 0
                hip_name, knee_name, ankle_name = (f"{part_name}-{side}" for part_name in ["hip", "knee", "ankle"])
                hip = heads[hip_name] + delta
                ankle = vec((sign * 0.170 + sway, 0.115 + lift, foot_z))
                knee = solve_knee(hip, ankle, (tails[hip_name] - heads[hip_name]).length, (tails[knee_name] - heads[knee_name]).length)
                motions[hip_name] = bone_motion(heads[hip_name], tails[hip_name], hip, knee)
                motions[knee_name] = bone_motion(heads[knee_name], tails[knee_name], knee, ankle)
                motions[ankle_name] = Matrix.Translation(ankle - heads[ankle_name])
                shoulder, elbow, hand = f"shoulder-{side}", f"elbow-{side}", f"hand-{side}"
                motions[shoulder] = motions["thorax"] @ rotate_about(
                    heads[shoulder], source_rotation(tracks, shoulder, seconds, 0.72 if name == "Lunge" else 1))
                motions[elbow] = motions[shoulder] @ rotate_about(heads[elbow], source_rotation(tracks, elbow, seconds))
                motions[hand] = motions[elbow]
                curl = 0.12 * smooth(0.25, 0.52, seconds) if name == "Lunge" else 0.025
                for finger in range(4):
                    key = f"finger-{side}-{finger}"
                    motions[key] = motions[hand] @ rotate_about(heads[key], Matrix.Rotation(curl, 4, "X"))
            desired = {bone_name: motions[bone_name] @ rest[bone_name] for bone_name in definitions}
            for bone_name, (_, _, parent_name) in definitions.items():
                pose = rig.pose.bones[bone_name]
                pose.rotation_mode = "QUATERNION"
                parent_inverse = rest[parent_name] @ desired[parent_name].inverted() if parent_name else Matrix.Identity(4)
                # Compute local channels directly instead of reading stale parent dependency-graph matrices.
                pose.matrix_basis = rest[bone_name].inverted() @ parent_inverse @ desired[bone_name]
                pose.keyframe_insert(data_path="location", frame=frame)
                pose.keyframe_insert(data_path="rotation_quaternion", frame=frame)
                pose.keyframe_insert(data_path="scale", frame=frame)
            bpy.context.view_layer.update()
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for curve in bag.fcurves:
                        for key in curve.keyframe_points:
                            key.interpolation = "LINEAR"
        slot = rig.animation_data.action_slot
        rig.animation_data.action = None
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 0, action)
        strip.action_slot = slot
        strip.extrapolation = "NOTHING"
        strip.blend_type = "REPLACE"
        track.mute = True
        facts.append({"name": name, "frames": frames, "durationSeconds": frames / 60,
                      "sourceMotion": "Historical pinned clip quaternion samples; asset-specific leg IK retains 1.6m/2.2s gait and 75mm swing lift",
                      "rootLocomotion": False})
    for track in rig.animation_data.nla_tracks:
        track.mute = False
    bpy.context.scene.frame_set(0)
    receipt["animation"] = {
        "clips": facts, "stalkCycleAdvanceMeters": 1.6, "stanceSeconds": 1.1,
        "swingLiftMeters": 0.075, "stalkPlaybackRates": [1.58125, 2.0625, 3.64375],
        "lungeShoulderRetargetScale": 0.72,
        "pelvisHeights": {"stationary": 1.0, "stalkBase": 0.885, "stalkBob": 0.047},
        "reason": "Fit approved longer hands and different leg lengths without increasing catch reach or changing authoritative motion.",
    }


def main(args, out, receipt):
    require(bpy.app.version == (5, 2, 2), "Use explicitly selected Blender 5.2.2 LTS")
    require(sha(args.motion) == MOTION_SHA, "Historical motion source changed")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps, scene.render.fps_base = 60, 1
    scene.frame_start, scene.frame_end = 0, 264
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    receipt["stage"] = "geometry-cleanup"
    body = clean_mesh(args.input, receipt)
    material_sources(body)
    repair_digits(body, receipt)
    body.data.calc_loop_triangles()
    require(len(body.data.loop_triangles) <= 65382, "Cook exceeds the old triangle ceiling")
    receipt["stage"] = "pbr-baking"
    bake_materials(body, out, receipt)
    receipt["stage"] = "asset-specific-skin"
    rig, definitions, weighting = build_rig(body)
    receipt["rig"] = {"bones": len(definitions), "maxInfluences": 4, "weighting": weighting,
                       "algorithm": "Cable Warden-specific surface-component masks, nearest adjacent joint chains, topology relaxation and locked soles; not a general autorigger"}
    receipt["stage"] = "motion-retarget"
    animate(rig, definitions, read_tracks(args.motion), receipt)
    receipt["stage"] = "export"
    bpy.ops.wm.save_as_mainfile(filepath=str(out / "cable-warden.blend"))
    select_only(rig)
    body.select_set(True)
    path = out / "responder.glb"
    result = bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_selection=True, export_yup=True,
        export_materials="EXPORT", export_image_format="AUTO", export_skins=True,
        export_animations=True, export_animation_mode="NLA_TRACKS",
        export_force_sampling=True, export_frame_range=False, export_frame_step=1,
    )
    require("FINISHED" in result, "GLB export failed")
    doc, _ = glb(path)
    require(len(doc.get("skins", [])) == 1, "Export did not retain one real skin")
    require(sorted(a["name"] for a in doc["animations"]) == sorted(CLIPS), "Exported clips do not match")
    receipt["output"] = {"file": path.name, "bytes": path.stat().st_size, "sha256": sha(path),
                         "skins": len(doc["skins"]), "images": len(doc.get("images", [])),
                         "triangles": len(body.data.loop_triangles), "bones": len(definitions)}
    require(path.stat().st_size < 16_362_838, "Cook exceeds the old responder's exclusive encoded bytes")
    receipt["status"] = "cooked-pending-deformation-and-visual-verification"
    receipt["stage"] = "complete"


parser = argparse.ArgumentParser()
parser.add_argument("--input", type=Path, required=True)
parser.add_argument("--motion", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
start = time.monotonic()
receipt = {
    "schema": "cable-warden-cook/1", "status": "running", "stage": "preflight",
    "source": {"rawSha256": RAW_SHA, "conceptSha256": CONCEPT_SHA, "motionSha256": MOTION_SHA},
    "blender": {"executable": bpy.app.binary_path, "version": bpy.app.version_string,
                "buildHash": bpy.app.build_hash.decode(), "buildDate": bpy.app.build_date.decode()},
    "scriptSha256": sha(Path(__file__)),
    "approval": "User approved exact raw001 for cleanup and rigging on 2026-09-25; final game approval pending",
    "scope": "Character-specific cleanup/material/rig/animation only; no gameplay, environment or historical asset edits",
    "licensing": "Research/evaluation pipeline; no whole-toolchain MIT or commercial-output clearance claim",
}
try:
    main(args, out, receipt)
except Exception as error:
    receipt["status"] = "failed"
    receipt["error"] = f"{type(error).__name__}: {error}"
    raise
finally:
    receipt["seconds"] = time.monotonic() - start
    (out / "cook.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print("AEGIS_CHARACTER_COOK=" + json.dumps(receipt))
