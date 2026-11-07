#!/usr/bin/env python3
"""生成 3D 预览测试样本：GLB / STL / PLY / OBJ+MTL / DAE"""
import json, math, struct, os, sys

OUT = os.path.join(os.path.dirname(__file__), "..", "samples")
os.makedirs(OUT, exist_ok=True)

# ---------------- GLB 写出器 ----------------
class GLBWriter:
    def __init__(self):
        self.buffers = []          # binary blobs
        self.buffer_views = []
        self.accessors = []
        self.materials = []
        self.meshes = []
        self.nodes = []

    def add_buffer_view(self, data, target):
        offset = sum(len(b) for b in self.buffers)
        self.buffers.append(data)
        self.buffer_views.append({
            "buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": target,
        })
        return len(self.buffer_views) - 1

    def add_accessor(self, values, minv, maxv, component_type, vtype):
        fmt = {5126: "f", 5123: "H", 5125: "I"}[component_type]
        ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[vtype]
        blob = struct.pack("<" + fmt * (len(values)), *values)
        bv = self.add_buffer_view(blob, 34962 if vtype != "SCALAR" or component_type != 5125 else 34962)
        self.buffer_views[-1]["target"] = 34962 if vtype != "SCALAR" else 34963
        self.accessors.append({
            "bufferView": bv, "componentType": component_type, "count": len(values) // ncomp,
            "type": vtype, "min": minv, "max": maxv,
        })
        return len(self.accessors) - 1

    def add_mesh(self, name, positions, normals, indices, material, translation=(0, 0, 0)):
        lo = [min(positions[i::3]) for i in range(3)]
        hi = [max(positions[i::3]) for i in range(3)]
        pos_acc = self.add_accessor(positions, lo, hi, 5126, "VEC3")
        nrm_acc = self.add_accessor(normals, [-1, -1, -1], [1, 1, 1], 5126, "VEC3")
        idx_acc = self.add_accessor(indices, None, None, 5125, "SCALAR")
        self.meshes.append({
            "name": name,
            "primitives": [{
                "attributes": {"POSITION": pos_acc, "NORMAL": nrm_acc},
                "indices": idx_acc, "material": material,
            }],
        })
        self.nodes.append({"mesh": len(self.meshes) - 1, "name": name, "translation": list(translation)})

    def add_material(self, name, color, metallic=0.0, roughness=0.6):
        self.materials.append({
            "name": name,
            "pbrMetallicRoughness": {"baseColorFactor": list(color), "metallicFactor": metallic, "roughnessFactor": roughness},
        })
        return len(self.materials) - 1

    def write(self, path):
        gltf = {
            "asset": {"version": "2.0", "generator": "sample-generator"},
            "scene": 0,
            "scenes": [{"nodes": list(range(len(self.nodes)))}],
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "buffers": [{"byteLength": sum(len(b) for b in self.buffers)}],
            "bufferViews": self.buffer_views,
            "accessors": self.accessors,
        }
        js = json.dumps(gltf, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        bin_data = b"".join(self.buffers)
        bin_data += b"\0" * ((4 - len(bin_data) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(bin_data)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
            f.write(struct.pack("<II", len(bin_data), 0x004E4942)); f.write(bin_data)

# ---------------- 几何生成 ----------------
def cube(tr=(0, 0, 0)):
    """24 顶点带法线立方体"""
    faces = [
        (( 1,0,0), (( 1,-1,-1),( 1, 1,-1),( 1, 1, 1),( 1,-1, 1))),
        ((-1,0,0), ((-1,-1, 1),(-1, 1, 1),(-1, 1,-1),(-1,-1,-1))),
        ((0, 1,0), ((-1, 1,-1),(-1, 1, 1),( 1, 1, 1),( 1, 1,-1))),
        ((0,-1,0), ((-1,-1, 1),(-1,-1,-1),( 1,-1,-1),( 1,-1, 1))),
        ((0,0, 1), (( 1,-1, 1),( 1, 1, 1),(-1, 1, 1),(-1,-1, 1))),
        ((0,0,-1), ((-1,-1,-1),(-1, 1,-1),( 1, 1,-1),( 1,-1,-1))),
    ]
    positions, normals, indices = [], [], []
    for n, quad in faces:
        base = len(positions) // 3
        for v in quad:
            positions += [v[0] * 0.9, v[1] * 0.9, v[2] * 0.9]
            normals += list(n)
        indices += [base, base + 1, base + 2, base, base + 2, base + 3]
    return positions, normals, indices

def torus_knot(p=2, q=3, radius=1.0, tube=0.35, tubular=140, radial=20, tr=(0, 0, 0)):
    def P(u):
        quOverP = q / p * u
        cs = math.cos(quOverP)
        return (radius * (2 + cs) * 0.5 * math.cos(u),
                radius * (2 + cs) * 0.5 * math.sin(u),
                radius * math.sin(quOverP) * 0.5)
    positions, normals, indices = [], [], []
    du = 1e-3
    for i in range(tubular):
        u = i / tubular * p * 2 * math.pi
        c = P(u)
        t = tuple(P(u + du)[k] - P(u - du)[k] for k in range(3))
        tl = math.sqrt(sum(x * x for x in t)); t = [x / tl for x in t]
        up = (0, 0, 1) if abs(t[2]) < 0.9 else (1, 0, 0)
        n1 = (t[1] * up[2] - t[2] * up[1], t[2] * up[0] - t[0] * up[2], t[0] * up[1] - t[1] * up[0])
        nl = math.sqrt(sum(x * x for x in n1)); n1 = [x / nl for x in n1]
        b = (t[1] * n1[2] - t[2] * n1[1], t[2] * n1[0] - t[0] * n1[2], t[0] * n1[1] - t[1] * n1[0])
        for j in range(radial + 1):
            v = j / radial * 2 * math.pi
            cv, sv = math.cos(v), math.sin(v)
            nx = cv * n1[0] + sv * b[0]; ny = cv * n1[1] + sv * b[1]; nz = cv * n1[2] + sv * b[2]
            positions += [c[0] + tube * nx, c[1] + tube * ny, c[2] + tube * nz]
            normals += [nx, ny, nz]
    for i in range(tubular):
        for j in range(radial):
            a = i * (radial + 1) + j
            b_ = ((i + 1) % tubular) * (radial + 1) + j
            indices += [a, b_, a + 1, b_, b_ + 1, a + 1]
    return positions, normals, indices

def sphere_uv(r=1.0, wseg=32, hseg=20):
    positions, normals, uvs = [], [], []
    for y in range(hseg + 1):
        v = y / hseg
        phi = v * math.pi
        for x in range(wseg + 1):
            u = x / wseg
            theta = u * 2 * math.pi
            nx = math.sin(phi) * math.cos(theta); ny = math.cos(phi); nz = math.sin(phi) * math.sin(theta)
            positions += [r * nx, r * ny, r * nz]
            normals += [nx, ny, nz]
            uvs += [1 - u, v]
    indices = []
    for y in range(hseg):
        for x in range(wseg):
            a = y * (wseg + 1) + x; b = a + wseg + 1
            indices += [a, b, a + 1, b, b + 1, a + 1]
    return positions, normals, uvs, indices

# ---------------- 1) sample.glb ----------------
g = GLBWriter()
m_red = g.add_material("cube-red", [0.92, 0.30, 0.28, 1.0], 0.0, 0.45)
m_blue = g.add_material("knot-blue", [0.28, 0.55, 0.98, 1.0], 0.85, 0.22)
p, n, i = cube(); g.add_mesh("Cube", p, n, i, m_red, translation=(-1.6, 0.9, 0))
p, n, i = torus_knot(); g.add_mesh("TorusKnot", p, n, i, m_blue, translation=(1.4, 1.05, 0))
g.write(os.path.join(OUT, "sample.glb"))
print("sample.glb OK")

# ---------------- 2) torus.stl (ASCII) ----------------
p, n, i = torus_knot(tubular=60, radial=10)
tris = []
for k in range(0, len(i), 3):
    a, b, c = i[k] * 3, i[k+1] * 3, i[k+2] * 3
    A, B, C = p[a:a+3], p[b:b+3], p[c:c+3]
    u = [B[j] - A[j] for j in range(3)]; v = [C[j] - A[j] for j in range(3)]
    fn = (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])
    fl = math.sqrt(sum(x*x for x in fn)) or 1
    fn = [x/fl for x in fn]
    tris.append((fn, A, B, C))
with open(os.path.join(OUT, "torus.stl"), "w") as f:
    f.write("solid torus\n")
    for fn, A, B, C in tris:
        f.write(f"  facet normal {fn[0]:.5f} {fn[1]:.5f} {fn[2]:.5f}\n    outer loop\n")
        for V in (A, B, C):
            f.write(f"      vertex {V[0]:.5f} {V[1]:.5f} {V[2]:.5f}\n")
        f.write("    endloop\n  endfacet\n")
    f.write("endsolid torus\n")
print("torus.stl OK")

# ---------------- 3) sphere-color.ply (带顶点色) ----------------
pos, nrm, uvs, idx = sphere_uv()
lines = ["ply", "format ascii 1.0", "comment colored sphere",
         f"element vertex {len(pos)//3}",
         "property float x", "property float y", "property float z",
         "property uchar red", "property uchar green", "property uchar blue",
         f"element face {len(idx)//3}", "property list uchar int vertex_indices", "end_header"]
for k in range(0, len(pos), 3):
    y = nrm[k + 1]
    r = int(127 + 127 * max(0, y)); b = int(127 + 127 * max(0, -y)); gr = int(180 * (1 - abs(y)))
    lines.append(f"{pos[k]:.5f} {pos[k+1]:.5f} {pos[k+2]:.5f} {r} {gr} {b}")
for k in range(0, len(idx), 3):
    lines.append(f"3 {idx[k]} {idx[k+1]} {idx[k+2]}")
with open(os.path.join(OUT, "sphere-color.ply"), "w") as f:
    f.write("\n".join(lines) + "\n")
print("sphere-color.ply OK")

# ---------------- 4) parts.obj + parts.mtl ----------------
p, n, i = cube()
with open(os.path.join(OUT, "parts.obj"), "w") as f:
    f.write("# two-part cube sample\nmtllib parts.mtl\n")
    for k in range(0, len(p), 3):
        f.write(f"v {p[k]:.4f} {p[k+1]:.4f} {p[k+2]:.4f}\n")
    for k in range(0, len(n), 3):
        f.write(f"vn {n[k]:.4f} {n[k+1]:.4f} {n[k+2]:.4f}\n")
    half = len(i) // 2
    f.write("o left_half\nusemtl red_mat\n")
    for k in range(0, half, 3):
        f.write(f"f {i[k]+1}//{i[k]+1} {i[k+1]+1}//{i[k+1]+1} {i[k+2]+1}//{i[k+2]+1}\n")
    f.write("o right_half\nusemtl blue_mat\n")
    for k in range(half, len(i), 3):
        f.write(f"f {i[k]+1}//{i[k]+1} {i[k+1]+1}//{i[k+1]+1} {i[k+2]+1}//{i[k+2]+1}\n")
with open(os.path.join(OUT, "parts.mtl"), "w") as f:
    f.write("newmtl red_mat\nKd 0.92 0.30 0.28\nKa 0.1 0.1 0.1\nNs 60\n\n"
            "newmtl blue_mat\nKd 0.28 0.55 0.98\nKa 0.1 0.1 0.1\nNs 90\n")
print("parts.obj / parts.mtl OK")

# ---------------- 5) tetra.dae (手写最小 Collada) ----------------
verts = [(1,1,1), (-1,-1,1), (-1,1,-1), (1,-1,-1)]
faces = [(0,2,1), (0,1,3), (0,3,2), (1,2,3)]
fp = "\n".join(f"{verts[a][0]:.4f} {verts[a][1]:.4f} {verts[a][2]:.4f} "
               f"{verts[b][0]:.4f} {verts[b][1]:.4f} {verts[b][2]:.4f} "
               f"{verts[c][0]:.4f} {verts[c][1]:.4f} {verts[c][2]:.4f}" for a, b, c in faces)
pidx = " ".join(f"{a} {b} {c}" for a, b, c in faces)
dae = f"""<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><contributor><authoring_tool>sample-generator</authoring_tool></contributor><up_axis>Y_UP</up_axis></asset>
  <library_geometries>
    <geometry id="tetra" name="Tetra">
      <mesh>
        <source id="tetra-pos">
          <float_array id="tetra-pos-arr" count="{9*len(faces)}">{fp}</float_array>
          <technique_common>
            <accessor source="#tetra-pos-arr" count="{3*len(faces)}" stride="3">
              <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="tetra-vtx"><input semantic="POSITION" source="#tetra-pos"/></vertices>
        <triangles count="{len(faces)}" material="mat0">
          <input semantic="VERTEX" source="#tetra-vtx" offset="0"/>
          <p>{pidx}</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>
  <library_effects>
    <effect id="fx">
      <profile_COMMON>
        <technique sid="common">
          <lambert>
            <diffuse><color>0.95 0.62 0.15 1</color></diffuse>
          </lambert>
        </technique>
      </profile_COMMON>
    </effect>
  </library_effects>
  <library_materials><material id="m0" name="orange"><instance_effect url="#fx"/></material></library_materials>
  <library_visual_scenes>
    <visual_scene id="Scene">
      <node id="n0" name="Tetra">
        <instance_geometry url="#tetra">
          <instance_material symbol="mat0" target="#m0"/>
        </instance_geometry>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>
"""
with open(os.path.join(OUT, "tetra.dae"), "w") as f:
    f.write(dae)
print("tetra.dae OK")
print("ALL SAMPLES DONE")
