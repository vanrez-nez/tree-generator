#!/usr/bin/env node

import net from "node:net";
import fs from "node:fs";

const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const HOST = process.env.BLENDER_HOST || "localhost";
const PORT = Number.parseInt(process.env.BLENDER_PORT || "9876", 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.BLENDER_TIMEOUT_MS || "30000", 10);

let stdinBuffer = "";

const tools = [
  {
    name: "ping_blender",
    description: "Check whether the official Blender MCP bridge is reachable.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_scene_info",
    description: "Get a concise JSON summary of the current Blender scene.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_object_info",
    description: "Get JSON details for a named object in the current Blender scene.",
    inputSchema: {
      type: "object",
      properties: {
        object_name: {
          type: "string",
          description: "The exact Blender object name.",
        },
      },
      required: ["object_name"],
    },
  },
  {
    name: "execute_blender_code",
    description: "Execute Python code in Blender through the official bridge. Set a JSON-serializable dict in result.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Python code to execute. The code should assign a dict to result.",
        },
        strict_json: {
          type: "boolean",
          description: "Require result to be JSON serializable.",
          default: false,
        },
      },
      required: ["code"],
    },
  },
  {
    name: "list_objects",
    description: "List scene objects (name, type, visibility) — lighter than get_scene_info.",
    inputSchema: {
      type: "object",
      properties: {
        type_filter: {
          type: "string",
          description: "Optional Blender object type to filter by, e.g. MESH, EMPTY, ARMATURE.",
        },
      },
    },
  },
  {
    name: "render_view",
    description:
      "Render the current 3D viewport (OpenGL, fast) and return the image so it can be viewed. Falls back to a full F12 render if no viewport is available.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number", description: "Render width in pixels (default keeps scene setting)." },
        height: { type: "number", description: "Render height in pixels (default keeps scene setting)." },
        filepath: { type: "string", description: "Optional output PNG path. Defaults to a temp file." },
      },
    },
  },
  {
    name: "import_model",
    description: "Import a model file into the current scene. Supports .glb/.gltf, .fbx, .obj.",
    inputSchema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "Absolute path to the model file." },
      },
      required: ["filepath"],
    },
  },
  {
    name: "export_glb",
    description: "Export the scene (or just selected objects) to a .glb file.",
    inputSchema: {
      type: "object",
      properties: {
        filepath: { type: "string", description: "Absolute output path ending in .glb." },
        selected_only: {
          type: "boolean",
          description: "Export only the currently selected objects.",
          default: false,
        },
      },
      required: ["filepath"],
    },
  },
  {
    name: "set_transform",
    description: "Set location, rotation (euler radians), and/or scale of a named object.",
    inputSchema: {
      type: "object",
      properties: {
        object_name: { type: "string", description: "The exact Blender object name." },
        location: { type: "array", items: { type: "number" }, description: "[x, y, z]." },
        rotation_euler: { type: "array", items: { type: "number" }, description: "[x, y, z] in radians." },
        scale: { type: "array", items: { type: "number" }, description: "[x, y, z]." },
      },
      required: ["object_name"],
    },
  },
  {
    name: "delete_object",
    description: "Delete a named object from the scene.",
    inputSchema: {
      type: "object",
      properties: {
        object_name: { type: "string", description: "The exact Blender object name." },
      },
      required: ["object_name"],
    },
  },
  {
    name: "list_materials",
    description: "List all materials with user count and a quick base-color/texture summary.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_material_info",
    description:
      "Get detailed info for a material: Principled BSDF inputs (base color, metallic, roughness, etc.) and any image-texture file paths.",
    inputSchema: {
      type: "object",
      properties: {
        material_name: { type: "string", description: "The exact material name." },
      },
      required: ["material_name"],
    },
  },
  {
    name: "list_animations",
    description:
      "List animation data. With no args, lists every action in the file (frame range, fcurve count, users). With object_name, returns that object's active action plus NLA strips.",
    inputSchema: {
      type: "object",
      properties: {
        object_name: {
          type: "string",
          description: "Optional object to inspect (e.g. an armature). Omit to list all actions.",
        },
      },
    },
  },
];

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function textResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

function errorResponse(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function requestBlender(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    const chunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for Blender at ${HOST}:${PORT}`));
    }, REQUEST_TIMEOUT_MS);

    function finish(error, response) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(response);
      }
    }

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\0`);
    });

    socket.on("data", (chunk) => {
      const nulIndex = chunk.indexOf(0);
      if (nulIndex >= 0) {
        chunks.push(chunk.subarray(0, nulIndex));
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          finish(null, JSON.parse(raw));
        } catch (error) {
          finish(new Error(`Invalid JSON from Blender: ${error.message}`));
        }
      } else {
        chunks.push(chunk);
      }
    });

    socket.on("error", (error) => {
      finish(new Error(`Could not connect to Blender at ${HOST}:${PORT}: ${error.message}`));
    });

    socket.on("end", () => {
      if (!settled) {
        finish(new Error("Blender closed the connection before sending a complete response"));
      }
    });
  });
}

async function executeInBlender(code, strictJson = false) {
  const response = await requestBlender({
    type: "execute",
    code,
    strict_json: strictJson,
  });

  if (response.status === "ok") {
    return response.result ?? {};
  }

  const message = response.message || "Unknown Blender bridge error";
  const details = [message, response.stdout, response.stderr].filter(Boolean).join("\n\n");
  throw new Error(details);
}

function sceneInfoCode() {
  return `
import bpy

objects = []
for obj in bpy.context.scene.objects:
    objects.append({
        "name": obj.name,
        "type": obj.type,
        "location": [round(v, 4) for v in obj.location],
        "rotation_euler": [round(v, 4) for v in obj.rotation_euler],
        "scale": [round(v, 4) for v in obj.scale],
        "visible": bool(obj.visible_get()),
    })

result = {
    "file": bpy.data.filepath,
    "scene": bpy.context.scene.name,
    "frame": bpy.context.scene.frame_current,
    "unit_system": bpy.context.scene.unit_settings.system,
    "object_count": len(bpy.context.scene.objects),
    "objects": objects[:200],
    "active_object": bpy.context.object.name if bpy.context.object else None,
    "collections": [collection.name for collection in bpy.data.collections],
    "materials": [material.name for material in bpy.data.materials],
    "cameras": [camera.name for camera in bpy.data.cameras],
    "lights": [light.name for light in bpy.data.lights],
}
`;
}

function objectInfoCode(objectName) {
  return `
import bpy

name = ${JSON.stringify(objectName)}
obj = bpy.data.objects.get(name)
if obj is None:
    result = {"found": False, "name": name}
else:
    result = {
        "found": True,
        "name": obj.name,
        "type": obj.type,
        "location": [round(v, 5) for v in obj.location],
        "rotation_euler": [round(v, 5) for v in obj.rotation_euler],
        "scale": [round(v, 5) for v in obj.scale],
        "dimensions": [round(v, 5) for v in obj.dimensions],
        "visible": bool(obj.visible_get()),
        "selected": bool(obj.select_get()),
        "parent": obj.parent.name if obj.parent else None,
        "children": [child.name for child in obj.children],
        "materials": [slot.material.name for slot in obj.material_slots if slot.material],
        "data_name": obj.data.name if getattr(obj, "data", None) else None,
    }
`;
}

function listObjectsCode(typeFilter) {
  return `
import bpy

type_filter = ${typeFilter ? JSON.stringify(typeFilter) : "None"}
objects = []
for obj in bpy.context.scene.objects:
    if type_filter and obj.type != type_filter:
        continue
    objects.append({
        "name": obj.name,
        "type": obj.type,
        "visible": bool(obj.visible_get()),
    })

result = {"count": len(objects), "objects": objects[:500]}
`;
}

function renderViewCode(filepath, width, height) {
  return `
import bpy, os, tempfile

filepath = ${filepath ? JSON.stringify(filepath) : "os.path.join(tempfile.gettempdir(), 'blender_mcp_render.png')"}
scene = bpy.context.scene
r = scene.render
r.filepath = filepath
r.image_settings.file_format = 'PNG'
${Number.isFinite(width) ? `r.resolution_x = ${Math.round(width)}` : ""}
${Number.isFinite(height) ? `r.resolution_y = ${Math.round(height)}` : ""}
r.resolution_percentage = 100

done = False
for window in bpy.context.window_manager.windows:
    for area in window.screen.areas:
        if area.type == 'VIEW_3D':
            with bpy.context.temp_override(window=window, area=area):
                bpy.ops.render.opengl(write_still=True)
            done = True
            break
    if done:
        break

if not done:
    bpy.ops.render.render(write_still=True)

result = {"path": bpy.path.abspath(filepath), "mode": "opengl" if done else "render"}
`;
}

function importModelCode(filepath) {
  return `
import bpy, os

fp = ${JSON.stringify(filepath)}
ext = os.path.splitext(fp)[1].lower()
before = {o.name for o in bpy.data.objects}
if ext in (".glb", ".gltf"):
    bpy.ops.import_scene.gltf(filepath=fp)
elif ext == ".fbx":
    bpy.ops.import_scene.fbx(filepath=fp)
elif ext == ".obj":
    bpy.ops.wm.obj_import(filepath=fp)
else:
    raise ValueError("Unsupported model extension: " + ext)
after = {o.name for o in bpy.data.objects}
result = {"imported": sorted(after - before), "filepath": fp}
`;
}

function exportGlbCode(filepath, selectedOnly) {
  return `
import bpy

bpy.ops.export_scene.gltf(
    filepath=${JSON.stringify(filepath)},
    export_format='GLB',
    use_selection=${selectedOnly ? "True" : "False"},
)
result = {"filepath": ${JSON.stringify(filepath)}, "selected_only": ${selectedOnly ? "True" : "False"}}
`;
}

function setTransformCode(name, location, rotation, scale) {
  const asVec = (v) => (Array.isArray(v) ? JSON.stringify(v) : "None");
  return `
import bpy

obj = bpy.data.objects.get(${JSON.stringify(name)})
if obj is None:
    result = {"found": False, "name": ${JSON.stringify(name)}}
else:
    loc = ${asVec(location)}
    rot = ${asVec(rotation)}
    scl = ${asVec(scale)}
    if loc is not None:
        obj.location = loc
    if rot is not None:
        obj.rotation_euler = rot
    if scl is not None:
        obj.scale = scl
    result = {
        "found": True,
        "name": obj.name,
        "location": [round(v, 5) for v in obj.location],
        "rotation_euler": [round(v, 5) for v in obj.rotation_euler],
        "scale": [round(v, 5) for v in obj.scale],
    }
`;
}

function deleteObjectCode(name) {
  return `
import bpy

obj = bpy.data.objects.get(${JSON.stringify(name)})
if obj is None:
    result = {"found": False, "deleted": False, "name": ${JSON.stringify(name)}}
else:
    bpy.data.objects.remove(obj, do_unlink=True)
    result = {"found": True, "deleted": True, "name": ${JSON.stringify(name)}}
`;
}

function listMaterialsCode() {
  return `
import bpy

def summarize(mat):
    info = {"name": mat.name, "users": mat.users, "use_nodes": mat.use_nodes}
    base = None
    textures = []
    if mat.use_nodes and mat.node_tree:
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                bc = node.inputs.get('Base Color')
                if bc is not None and not bc.is_linked:
                    base = [round(v, 4) for v in bc.default_value]
            elif node.type == 'TEX_IMAGE' and node.image:
                textures.append(node.image.name)
    else:
        base = [round(v, 4) for v in mat.diffuse_color]
    info["base_color"] = base
    info["textures"] = textures
    return info

mats = [summarize(m) for m in bpy.data.materials]
result = {"count": len(mats), "materials": mats}
`;
}

function materialInfoCode(name) {
  return `
import bpy

mat = bpy.data.materials.get(${JSON.stringify(name)})
if mat is None:
    result = {"found": False, "name": ${JSON.stringify(name)}}
else:
    info = {
        "found": True,
        "name": mat.name,
        "users": mat.users,
        "use_nodes": mat.use_nodes,
        "blend_method": getattr(mat, "blend_method", None),
        "principled": {},
        "image_textures": [],
    }
    if mat.use_nodes and mat.node_tree:
        for node in mat.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                for inp in node.inputs:
                    if inp.is_linked:
                        info["principled"][inp.name] = "<linked>"
                    else:
                        val = inp.default_value
                        try:
                            info["principled"][inp.name] = [round(v, 4) for v in val]
                        except TypeError:
                            info["principled"][inp.name] = round(float(val), 4)
            elif node.type == 'TEX_IMAGE' and node.image:
                img = node.image
                info["image_textures"].append({
                    "node": node.name,
                    "image": img.name,
                    "filepath": bpy.path.abspath(img.filepath) if img.filepath else None,
                    "size": list(img.size),
                    "colorspace": img.colorspace_settings.name,
                })
    result = info
`;
}

function animationsCode(objectName) {
  // Blender 4.4+/5.x slotted actions: fcurves live under layers -> strips -> channelbags.
  const fcurvesHelper = `
def _count_fcurves(action):
    total = 0
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for cb in getattr(strip, "channelbags", []):
                total += len(cb.fcurves)
    return total

def _slots(action):
    return [s.name_display for s in getattr(action, "slots", [])]
`;
  if (objectName) {
    return `
import bpy
${fcurvesHelper}
obj = bpy.data.objects.get(${JSON.stringify(objectName)})
if obj is None:
    result = {"found": False, "name": ${JSON.stringify(objectName)}}
else:
    ad = obj.animation_data
    info = {"found": True, "name": obj.name, "action": None, "nla_tracks": []}
    if ad:
        if ad.action:
            fr = ad.action.frame_range
            info["action"] = {
                "name": ad.action.name,
                "frame_range": [round(fr[0], 2), round(fr[1], 2)],
                "fcurves": _count_fcurves(ad.action),
                "slots": _slots(ad.action),
            }
        for track in ad.nla_tracks:
            info["nla_tracks"].append({
                "name": track.name,
                "muted": track.mute,
                "strips": [
                    {
                        "name": s.name,
                        "action": s.action.name if s.action else None,
                        "frame_start": round(s.frame_start, 2),
                        "frame_end": round(s.frame_end, 2),
                    }
                    for s in track.strips
                ],
            })
    result = info
`;
  }
  return `
import bpy
${fcurvesHelper}
actions = []
for a in bpy.data.actions:
    fr = a.frame_range
    actions.append({
        "name": a.name,
        "frame_range": [round(fr[0], 2), round(fr[1], 2)],
        "fcurves": _count_fcurves(a),
        "slots": _slots(a),
        "users": a.users,
    })
result = {"count": len(actions), "actions": actions}
`;
}

function imageResult(filePath, meta) {
  const data = fs.readFileSync(filePath).toString("base64");
  return {
    content: [
      { type: "image", data, mimeType: "image/png" },
      { type: "text", text: JSON.stringify(meta, null, 2) },
    ],
    isError: false,
  };
}

async function callTool(name, args = {}) {
  if (name === "ping_blender") {
    const result = await executeInBlender(
      "import bpy\nresult = {\"ok\": True, \"blender_version\": bpy.app.version_string}",
      true,
    );
    return textResult(result);
  }

  if (name === "get_scene_info") {
    const result = await executeInBlender(sceneInfoCode(), true);
    return textResult(result);
  }

  if (name === "get_object_info") {
    if (!args.object_name || typeof args.object_name !== "string") {
      throw new Error("get_object_info requires object_name");
    }
    const result = await executeInBlender(objectInfoCode(args.object_name), true);
    return textResult(result);
  }

  if (name === "execute_blender_code") {
    if (!args.code || typeof args.code !== "string") {
      throw new Error("execute_blender_code requires code");
    }
    const result = await executeInBlender(args.code, Boolean(args.strict_json));
    return textResult(result);
  }

  if (name === "list_objects") {
    const result = await executeInBlender(listObjectsCode(args.type_filter), true);
    return textResult(result);
  }

  if (name === "render_view") {
    const result = await executeInBlender(
      renderViewCode(args.filepath, Number(args.width), Number(args.height)),
      true,
    );
    return imageResult(result.path, result);
  }

  if (name === "import_model") {
    if (!args.filepath || typeof args.filepath !== "string") {
      throw new Error("import_model requires filepath");
    }
    const result = await executeInBlender(importModelCode(args.filepath), true);
    return textResult(result);
  }

  if (name === "export_glb") {
    if (!args.filepath || typeof args.filepath !== "string") {
      throw new Error("export_glb requires filepath");
    }
    const result = await executeInBlender(exportGlbCode(args.filepath, Boolean(args.selected_only)), true);
    return textResult(result);
  }

  if (name === "set_transform") {
    if (!args.object_name || typeof args.object_name !== "string") {
      throw new Error("set_transform requires object_name");
    }
    const result = await executeInBlender(
      setTransformCode(args.object_name, args.location, args.rotation_euler, args.scale),
      true,
    );
    return textResult(result);
  }

  if (name === "delete_object") {
    if (!args.object_name || typeof args.object_name !== "string") {
      throw new Error("delete_object requires object_name");
    }
    const result = await executeInBlender(deleteObjectCode(args.object_name), true);
    return textResult(result);
  }

  if (name === "list_materials") {
    const result = await executeInBlender(listMaterialsCode(), true);
    return textResult(result);
  }

  if (name === "get_material_info") {
    if (!args.material_name || typeof args.material_name !== "string") {
      throw new Error("get_material_info requires material_name");
    }
    const result = await executeInBlender(materialInfoCode(args.material_name), true);
    return textResult(result);
  }

  if (name === "list_animations") {
    const result = await executeInBlender(animationsCode(args.object_name), true);
    return textResult(result);
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleMessage(message) {
  if (message.method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: "blender-official-bridge",
          version: "0.1.0",
        },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    writeMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: { tools },
    });
    return;
  }

  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    } catch (error) {
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: textResult(error.message, true),
      });
    }
    return;
  }

  if (message.id !== undefined) {
    errorResponse(message.id, -32601, `Method not found: ${message.method}`);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newlineIndex = stdinBuffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = stdinBuffer.slice(0, newlineIndex).trim();
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (line) {
      try {
        void handleMessage(JSON.parse(line));
      } catch (error) {
        errorResponse(null, -32700, `Parse error: ${error.message}`);
      }
    }
    newlineIndex = stdinBuffer.indexOf("\n");
  }
});
