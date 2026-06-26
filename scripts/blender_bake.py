# In-Blender translator + baker for the dual-system material testing pipeline.
#
# Runs inside Blender (see scripts/blender-bake.mjs, which spawns it). Reads a MaterialGraphDocument
# (our app's node-graph JSON — the single source of truth shared by both systems), rebuilds the graph
# as a Blender shader node tree, and bakes each connected PBR channel to bake/<name>/<channel>.blender.png.
# The app produces the matching <channel>.ours.png, so the two sit side by side for comparison.
#
# Invocation (done by the .mjs wrapper):
#   blender --background --factory-startup --python blender_bake.py -- <config.json> <outdir> <size> [channels]
#
# Design notes:
#   - We DELIBERATELY do not aim for pixel-perfect parity: our TSL noise (MaterialX) and Blender's
#     Perlin/Worley differ by construction. This tool is for structural/visual comparison while we port
#     Blender's math faithfully (see blender-node-alignment-plan.md, decision 2).
#   - Unmapped node types raise (no silent bail). Add an entry to NODE_BUILDERS to support a new node.
#   - Coordinate domain matches our baked backend: a Texture Coordinate's UV output feeds any
#     unconnected vector input (our baked coord is vec3(uv, 0)).
#   - Color management: view transform is forced to 'Standard' to avoid Filmic/AgX. The PNG is still
#     sRGB-encoded on save, whereas the app writes raw render-target bytes — so expect a brightness
#     offset on color channels. Structure (the thing under test) is preserved.

import json
import sys
import os

import bpy

# Default channels to bake = the Principled BSDF input keys we compare (mirrors the node's inputs in
# src/scene/material/graph/nodes/principled-bsdf.ts). Only those actually wired in a config are baked.
DEFAULT_CHANNELS = ["baseColor", "metallic", "roughness", "normal", "emission"]
# Scalar (single-float) Principled inputs — baked grayscale; a colour feeding one is converted via RGB
# to BW to mirror our luminance coercion.
FIELD_CHANNELS = {
    "metallic", "roughness", "ior", "alpha", "coat", "coatRoughness",
    "sheen", "sheenRoughness", "transmission",
}

MATERIAL_OUTPUT_TYPE = "material-output"
# Shader nodes are structural here: we don't translate them to Blender nodes, we read the channel
# sources from the (single) shader node's input edges. Mirrors plan L1 (no real closure).
SHADER_TYPES = {"principled-bsdf", "emission"}


def srgb_hex_to_linear_rgba(hex_str):
    """'#rrggbb' -> linear (r, g, b, 1.0), matching Blender's expected linear color values."""
    h = hex_str.lstrip("#")
    srgb = [int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]

    def to_linear(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return tuple(to_linear(c) for c in srgb) + (1.0,)


def find_socket(sockets, name, sock_type=None):
    """Resolve a socket by display name (and optional bl type), tolerant of Blender's duplicate
    same-named sockets on multi-type nodes (e.g. Mix)."""
    for s in sockets:
        if s.name == name and (sock_type is None or s.type == sock_type):
            return s
    # fall back to name-only match
    for s in sockets:
        if s.name == name:
            return s
    raise KeyError(f"socket '{name}' not found (have: {[s.name for s in sockets]})")


class Built:
    """A created Blender node plus the maps from our port keys to its sockets."""

    def __init__(self, node, inputs, outputs):
        self.node = node
        self.inputs = inputs  # our input key  -> bpy input socket
        self.outputs = outputs  # our output key -> bpy output socket


# --- per-node builders: type -> fn(node_tree, doc_node) -> Built ------------------------------------
# Each translates one of our nodes into the closest grounded Blender equivalent. Param names mirror the
# node defs under src/scene/material/graph/nodes/.


def build_fbm(nt, n):
    p = n.get("params", {})
    node = nt.nodes.new("ShaderNodeTexNoise")
    node.noise_dimensions = "3D"
    node.inputs["Scale"].default_value = float(p.get("scale", 1.2))
    node.inputs["Detail"].default_value = float(p.get("octaves", 4))
    node.inputs["Roughness"].default_value = float(p.get("gain", 0.5))
    if "Lacunarity" in node.inputs:
        node.inputs["Lacunarity"].default_value = float(p.get("lacunarity", 2.0))
    return Built(node, {"coord": node.inputs["Vector"]}, {"field": node.outputs["Fac"]})


_VORONOI_METRIC = {"euclidean": "EUCLIDEAN", "manhattan": "MANHATTAN", "chebychev": "CHEBYCHEV"}


def build_voronoi(nt, n):
    p = n.get("params", {})
    node = nt.nodes.new("ShaderNodeTexVoronoi")
    node.voronoi_dimensions = "3D"
    node.feature = "F1"
    node.distance = _VORONOI_METRIC.get(str(p.get("metric", "euclidean")), "EUCLIDEAN")
    if hasattr(node, "normalize"):
        node.normalize = False
    node.inputs["Scale"].default_value = float(p.get("scale", 1.0))
    if "Randomness" in node.inputs:
        node.inputs["Randomness"].default_value = float(p.get("randomness", 1.0))
    return Built(node, {"coord": node.inputs["Vector"]}, {"distance": node.outputs["Distance"]})


_MATH_OPS = {
    "add": "ADD",
    "subtract": "SUBTRACT",
    "multiply": "MULTIPLY",
    "max": "MAXIMUM",
    "min": "MINIMUM",
}


def build_math(nt, n):
    p = n.get("params", {})
    op = str(p.get("op", "mix"))
    factor = float(p.get("factor", 0.5))
    if op == "mix":
        node = nt.nodes.new("ShaderNodeMix")
        node.data_type = "FLOAT"
        find_socket(node.inputs, "Factor", "VALUE").default_value = factor
        b = find_socket(node.inputs, "B", "VALUE")
        b.default_value = factor
        return Built(
            node,
            {"a": find_socket(node.inputs, "A", "VALUE"), "b": b},
            {"field": find_socket(node.outputs, "Result", "VALUE")},
        )
    node = nt.nodes.new("ShaderNodeMath")
    node.operation = _MATH_OPS.get(op, "ADD")
    node.inputs[1].default_value = factor
    return Built(node, {"a": node.inputs[0], "b": node.inputs[1]}, {"field": node.outputs[0]})


def build_levels(nt, n):
    p = n.get("params", {})
    node = nt.nodes.new("ShaderNodeMapRange")
    node.clamp = True
    lo, hi = float(p.get("min", 0.0)), float(p.get("max", 1.0))
    if p.get("invert"):
        lo, hi = hi, lo
    node.inputs["From Min"].default_value = 0.0
    node.inputs["From Max"].default_value = 1.0
    node.inputs["To Min"].default_value = lo
    node.inputs["To Max"].default_value = hi
    return Built(node, {"field": node.inputs["Value"]}, {"field": node.outputs["Result"]})


def build_color_ramp(nt, n):
    p = n.get("params", {})
    node = nt.nodes.new("ShaderNodeValToRGB")
    ramp = node.color_ramp
    ramp.interpolation = "LINEAR"
    ramp.elements[0].position = float(p.get("low", 0.3))
    ramp.elements[0].color = srgb_hex_to_linear_rgba(p.get("colorA", "#3f2d1e"))
    ramp.elements[1].position = float(p.get("high", 0.75))
    ramp.elements[1].color = srgb_hex_to_linear_rgba(p.get("colorB", "#8a6a4a"))
    return Built(node, {"field": node.inputs["Fac"]}, {"color": node.outputs["Color"]})


def build_constant_field(nt, n):
    p = n.get("params", {})
    node = nt.nodes.new("ShaderNodeValue")
    node.outputs["Value"].default_value = float(p.get("value", 0.5))
    return Built(node, {}, {"field": node.outputs["Value"]})


def build_constant_color(nt, n):
    p = n.get("params", {})
    node = nt.nodes.new("ShaderNodeRGB")
    node.outputs["Color"].default_value = srgb_hex_to_linear_rgba(p.get("color", "#808080"))
    return Built(node, {}, {"color": node.outputs["Color"]})


NODE_BUILDERS = {
    "fbm": build_fbm,
    "voronoi": build_voronoi,
    "math": build_math,
    "levels": build_levels,
    "color-ramp": build_color_ramp,
    "constant-field": build_constant_field,
    "constant-color": build_constant_color,
}


def build_graph(doc):
    """Create a material whose node tree mirrors the doc's value-producing nodes. The shader node
    (Principled/Emission) and Material Output are structural — not translated — so channel_sources maps
    a Principled input key -> the bpy output socket feeding it (the value we bake per channel)."""
    mat = bpy.data.materials.new("dual_bake")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    tex_coord = nt.nodes.new("ShaderNodeTexCoord")
    default_uv = tex_coord.outputs["UV"]  # vec3(u, v, 0) — matches our baked coord domain

    built = {}
    output_id = None
    shader_ids = set()
    for n in doc.get("nodes", []):
        t = n["type"]
        if t == MATERIAL_OUTPUT_TYPE:
            output_id = n["id"]
            continue
        if t in SHADER_TYPES:
            shader_ids.add(n["id"])  # structural — channels are read from its input edges
            continue
        builder = NODE_BUILDERS.get(t)
        if builder is None:
            raise RuntimeError(
                f"no Blender mapping for node type '{t}'. Add a builder to NODE_BUILDERS in "
                f"scripts/blender_bake.py (intentionally not bailing silently)."
            )
        built[n["id"]] = builder(nt, n)

    if output_id is None:
        raise RuntimeError(f"config has no '{MATERIAL_OUTPUT_TYPE}' node")

    surface_edge = next(
        (e for e in doc.get("edges", []) if e["toNode"] == output_id and e["toInput"] == "surface"),
        None,
    )
    if surface_edge is None or surface_edge["fromNode"] not in shader_ids:
        raise RuntimeError("material-output.surface must be fed by a shader node (Principled/Emission)")
    shader_id = surface_edge["fromNode"]

    # Wire the value graph (edges between translated nodes); skip edges into the shader/output nodes.
    for e in doc.get("edges", []):
        if e["toNode"] == output_id or e["toNode"] in shader_ids:
            continue
        src = built.get(e["fromNode"])
        dst = built.get(e["toNode"])
        if src is None or dst is None:
            continue
        out_sock = src.outputs.get(e["fromOutput"])
        in_sock = dst.inputs.get(e["toInput"])
        if out_sock is None:
            raise RuntimeError(f"node {e['fromNode']} has no mapped output '{e['fromOutput']}'")
        if in_sock is None:
            raise RuntimeError(f"node {e['toNode']} has no mapped input '{e['toInput']}'")
        nt.links.new(out_sock, in_sock)

    # Any unconnected vector input ('coord') gets the shared UV domain.
    for b in built.values():
        coord_in = b.inputs.get("coord")
        if coord_in is not None and not coord_in.is_linked:
            nt.links.new(default_uv, coord_in)

    # Channel sources = the shader node's input edges, keyed by its input (= our PBR channel) name.
    channel_sources = {}
    for e in doc.get("edges", []):
        if e["toNode"] != shader_id:
            continue
        src = built.get(e["fromNode"])
        if src is None:
            continue
        out_sock = src.outputs.get(e["fromOutput"])
        if out_sock is None:
            raise RuntimeError(f"node {e['fromNode']} has no mapped output '{e['fromOutput']}'")
        channel_sources[e["toInput"]] = out_sock

    return mat, nt, channel_sources


def setup_bake_target(mat, nt, size):
    """A UV-mapped plane + an active Image node Blender bakes into."""
    bpy.ops.mesh.primitive_plane_add(size=2.0)
    plane = bpy.context.active_object
    plane.data.materials.append(mat)

    img = bpy.data.images.new("bake_target", width=size, height=size, alpha=False, float_buffer=False)
    img_node = nt.nodes.new("ShaderNodeTexImage")
    img_node.image = img
    nt.nodes.active = img_node
    for node in nt.nodes:
        node.select = False
    img_node.select = True
    return plane, img, img_node


def bake_channel(nt, channel, source_sock, img, filepath):
    """Route the channel's source through an Emission shader and EMIT-bake it into img."""
    # Rebuild a clean Emission -> Output surface each time.
    for n in list(nt.nodes):
        if n.bl_idname in ("ShaderNodeEmission", "ShaderNodeOutputMaterial", "ShaderNodeRGBToBW"):
            nt.nodes.remove(n)
    emit = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")

    # Mirror our build-time coercion for scalar channels fed by a colour: our compiler converts
    # colour -> float via luminance, so emit the grey luminance (RGB to BW) rather than the colour.
    # (Other implicit conversions on intermediate edges — float->vector broadcast, colour<->vector —
    #  are applied by Blender natively when the sockets are linked in build_graph.)
    src = source_sock
    if channel in FIELD_CHANNELS and source_sock.type == "RGBA":
        bw = nt.nodes.new("ShaderNodeRGBToBW")
        nt.links.new(source_sock, bw.inputs["Color"])
        src = bw.outputs["Val"]
    nt.links.new(src, emit.inputs["Color"])  # float auto-broadcasts to grey, like vec3(node)
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])

    bpy.ops.object.bake(type="EMIT", margin=0)

    # Note: the saved PNG has a fixed orientation offset vs our channel-baker (our baker samples
    # uv=(x/W, 1-y/H); Blender's plane-UV bake lands transposed). This is cosmetic — the authoritative
    # per-node check is the pure-JS reference cross-check (orientation-aware), not raw image overlay.
    # Aligning the on-disk orientation here proved fiddly (bottom-up pixels + save vflip) and low-value,
    # so it's left as-is; see blender-node-alignment-plan.md Phase 4 notes.
    scene = bpy.context.scene
    # Colour-management convention (plan L5 / Phase 6) — match our baker: colour channels are sRGB-encoded
    # (Standard view transform), data channels (roughness/metallic/normal/…) stay linear (Raw).
    is_color = channel in ("baseColor", "emission")
    scene.view_settings.view_transform = "Standard" if is_color else "Raw"
    img.filepath_raw = filepath
    img.file_format = "PNG"
    img.save_render(filepath, scene=scene)
    print(f"[blender] wrote {filepath}")


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(argv) < 2:
        raise SystemExit("usage: blender_bake.py -- <config.json> <outdir> [size] [channels-csv]")
    config_path, outdir = argv[0], argv[1]
    size = int(argv[2]) if len(argv) > 2 and argv[2] else 1024
    requested = [c for c in argv[3].split(",") if c] if len(argv) > 3 and argv[3] else DEFAULT_CHANNELS

    with open(config_path, "r") as f:
        doc = json.load(f)

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.render.bake.margin = 0
    scene.render.bake.use_clear = True
    scene.view_settings.view_transform = "Standard"

    mat, nt, channel_sources = build_graph(doc)
    plane, img, _ = setup_bake_target(mat, nt, size)
    bpy.context.view_layer.objects.active = plane
    plane.select_set(True)

    os.makedirs(outdir, exist_ok=True)
    written = []
    for channel in requested:
        src = channel_sources.get(channel)
        if src is None:
            continue  # channel unconnected in this config — skip, same as the app side
        bake_channel(nt, channel, src, img, os.path.join(outdir, f"{channel}.blender.png"))
        written.append(channel)
    print(f"[blender] done: {', '.join(written) or '(no connected channels)'}")


if __name__ == "__main__":
    main()
