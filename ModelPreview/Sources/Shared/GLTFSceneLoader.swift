import SceneKit
import AppKit

/// 轻量 glTF 2.0 → SceneKit 加载器（GLB / 外部资源 glTF）。
/// 面向 Quick Look 预览：静态几何 + 基础 PBR 材质 + 内嵌纹理。
/// 不支持：Draco 压缩（报错提示）、morph targets、骨骼动画（显示 bind pose）。
enum GLTFSceneLoader {

    enum LoadError: LocalizedError {
        case badFormat(String)
        case dracoCompressed
        var errorDescription: String? {
            switch self {
            case .badFormat(let m): return "glTF 解析失败：\(m)"
            case .dracoCompressed: return "该模型使用 Draco 压缩，快速预览暂不支持，请在主应用中打开"
            }
        }
    }

    static func load(from url: URL) throws -> SCNScene {
        let data = try Data(contentsOf: url)
        if url.pathExtension.lowercased() == "glb" {
            let (jsonData, bin) = try splitGLB(data)
            guard let json = (try? JSONSerialization.jsonObject(with: jsonData)) as? [String: Any] else {
                throw LoadError.badFormat("JSON chunk 解析失败")
            }
            return try build(json: json, bin: bin, baseURL: url.deletingLastPathComponent())
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw LoadError.badFormat("JSON 解析失败")
        }
        return try build(json: json, bin: nil, baseURL: url.deletingLastPathComponent())
    }

    // MARK: - GLB 拆包

    static func splitGLB(_ data: Data) throws -> (json: Data, bin: Data?) {
        guard data.count >= 20, data.prefix(4) == Data([0x67, 0x6C, 0x54, 0x46]) else {
            throw LoadError.badFormat("缺少 GLB 魔数")
        }
        func u32(_ off: Int) -> Int {
            Int(data[off]) | Int(data[off+1]) << 8 | Int(data[off+2]) << 16 | Int(data[off+3]) << 24
        }
        var off = 12
        var json: Data?
        var bin: Data?
        while off + 8 <= data.count {
            let len = u32(off), type = u32(off + 4)
            let start = off + 8
            guard start + len <= data.count else { break }
            if type == 0x4E4F534A { json = data.subdata(in: start..<(start + len)) }
            if type == 0x004E4942 { bin = data.subdata(in: start..<(start + len)) }
            off = start + len
        }
        guard let j = json else { throw LoadError.badFormat("缺少 JSON chunk") }
        return (j, bin)
    }

    // MARK: - 场景构建

    private static func build(json: [String: Any], bin: Data?, baseURL: URL) throws -> SCNScene {
        let ctx = Ctx(json: json, bin: bin, baseURL: baseURL)
        let scene = SCNScene()

        var dracoCount = 0, totalPrims = 0
        for mesh in ctx.array("meshes") {
            for prim in ctx.array(mesh["primitives"]) {
                totalPrims += 1
                if (prim["extensions"] as? [String: Any])?["KHR_draco_mesh_compression"] != nil { dracoCount += 1 }
            }
        }
        if totalPrims > 0, dracoCount == totalPrims { throw LoadError.dracoCompressed }

        let defaultScene = ctx.array("scenes").first ?? [:]
        for i in ctx.ints(defaultScene["nodes"]) {
            if let node = try ctx.buildNode(i) { scene.rootNode.addChildNode(node) }
        }
        return scene
    }

    // MARK: - 解析上下文

    private final class Ctx {
        let json: [String: Any]
        let bin: Data?
        let baseURL: URL
        init(json: [String: Any], bin: Data?, baseURL: URL) {
            self.json = json; self.bin = bin; self.baseURL = baseURL
        }

        func array(_ key: String) -> [[String: Any]] { json[key] as? [[String: Any]] ?? [] }
        func array(_ v: Any?) -> [[String: Any]] { v as? [[String: Any]] ?? [] }
        func floats(_ v: Any?) -> [Float] { (v as? [NSNumber])?.map(\.floatValue) ?? [] }
        func ints(_ v: Any?) -> [Int] { (v as? [NSNumber])?.map(\.intValue) ?? [] }

        private func dataView(_ idx: Int) -> (offset: Int, length: Int, stride: Int?)? {
            let views = array("bufferViews")
            guard idx < views.count else { return nil }
            let v = views[idx]
            let length = (v["byteLength"] as? NSNumber)?.intValue ?? 0
            let offset = (v["byteOffset"] as? NSNumber)?.intValue ?? 0
            return (offset, length, (v["byteStride"] as? NSNumber)?.intValue)
        }

        /// accessor 数据读取为 Float 数组（处理 stride 与各种 componentType）
        private func readFloats(accessorIdx: Int) -> [Float]? {
            let accessors = array("accessors")
            guard accessorIdx < accessors.count else { return nil }
            let a = accessors[accessorIdx]
            guard let bv = (a["bufferView"] as? NSNumber)?.intValue,
                  let view = dataView(bv), let bin else { return nil }
            let compSize: [Int: Int] = [5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4]
            let types: [String: Int] = ["SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16]
            let ct = (a["componentType"] as? NSNumber)?.intValue ?? 5126
            let nComp = types[a["type"] as? String ?? "SCALAR"] ?? 1
            let count = (a["count"] as? NSNumber)?.intValue ?? 0
            let aOff = (a["byteOffset"] as? NSNumber)?.intValue ?? 0
            let stride = view.stride ?? (compSize[ct] ?? 4) * nComp

            var out = [Float](repeating: 0, count: count * nComp)
            for i in 0..<count {
                let base = view.offset + aOff + i * stride
                for c in 0..<nComp {
                    let o = base + c * (compSize[ct] ?? 4)
                    guard o + (compSize[ct] ?? 4) <= bin.count else { continue }
                    switch ct {
                    case 5126:
                        let bits = UInt32(bin[o]) | UInt32(bin[o+1]) << 8 | UInt32(bin[o+2]) << 16 | UInt32(bin[o+3]) << 24
                        out[i * nComp + c] = Float(bitPattern: bits)
                    case 5123: out[i * nComp + c] = Float(UInt16(bin[o]) | UInt16(bin[o+1]) << 8) / 65535
                    case 5122: out[i * nComp + c] = Float(Int16(bitPattern: UInt16(bin[o]) | UInt16(bin[o+1]) << 8)) / 32767
                    case 5121: out[i * nComp + c] = Float(bin[o]) / 255
                    case 5120: out[i * nComp + c] = Float(Int8(bitPattern: bin[o])) / 127
                    default: break
                    }
                }
            }
            return out
        }

        private struct Attrib { var count: Int; var comps: Int; var floats: [Float] }

        private func attrib(_ attrs: [String: Any], _ key: String, flipV: Bool = false) -> Attrib? {
            let accessors = array("accessors")
            guard let idx = (attrs[key] as? NSNumber)?.intValue, idx < accessors.count,
                  var f = readFloats(accessorIdx: idx) else { return nil }
            let a = accessors[idx]
            let types: [String: Int] = ["SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16]
            let comps = types[a["type"] as? String ?? "SCALAR"] ?? 1
            let count = (a["count"] as? NSNumber)?.intValue ?? 0
            if flipV {
                if comps >= 2 {
                    // V 分量位于每个向量的最后一个槽位（UV → 奇数位）
                    for i in stride(from: comps - 1, to: f.count, by: comps) {
                        f[i] = 1 - f[i]
                    }
                }
            }
            return Attrib(count: count, comps: comps, floats: f)
        }

        private func indices(_ accessorIdx: Int) -> (data: Data, bytesPer: Int, count: Int)? {
            let accessors = array("accessors")
            guard accessorIdx < accessors.count else { return nil }
            let a = accessors[accessorIdx]
            guard let bv = (a["bufferView"] as? NSNumber)?.intValue,
                  let view = dataView(bv), let bin else { return nil }
            let count = (a["count"] as? NSNumber)?.intValue ?? 0
            let aOff = (a["byteOffset"] as? NSNumber)?.intValue ?? 0
            let start = view.offset + aOff
            switch (a["componentType"] as? NSNumber)?.intValue {
            case 5125:
                guard start + count * 4 <= bin.count else { return nil }
                return (bin.subdata(in: start..<(start + count * 4)), 4, count)
            case 5123:
                guard start + count * 2 <= bin.count else { return nil }
                return (bin.subdata(in: start..<(start + count * 2)), 2, count)
            case 5121:
                guard start + count <= bin.count else { return nil }
                return (bin.subdata(in: start..<(start + count)), 1, count)
            default: return nil
            }
        }

        private func makeSource(_ attr: Attrib, semantic: SCNGeometrySource.Semantic) -> SCNGeometrySource {
            let data = attr.floats.withUnsafeBufferPointer { Data(buffer: $0) }
            return SCNGeometrySource(data: data, semantic: semantic, vectorCount: attr.count,
                                     usesFloatComponents: true, componentsPerVector: attr.comps,
                                     bytesPerComponent: 4, dataOffset: 0, dataStride: attr.comps * 4)
        }

        // MARK: 节点层级

        func buildNode(_ idx: Int) throws -> SCNNode? {
            let nodes = array("nodes")
            guard idx < nodes.count else { return nil }
            let n = nodes[idx]
            let node = SCNNode()
            node.name = n["name"] as? String

            let m = floats(n["matrix"])
            if m.count == 16 {
                // glTF matrix 为列主序
                let c0 = SIMD4(m[0], m[1], m[2], m[3])
                let c1 = SIMD4(m[4], m[5], m[6], m[7])
                let c2 = SIMD4(m[8], m[9], m[10], m[11])
                let c3 = SIMD4(m[12], m[13], m[14], m[15])
                node.simdTransform = simd_float4x4(c0, c1, c2, c3)
            } else {
                let t = floats(n["translation"]), s = floats(n["scale"]), r = floats(n["rotation"])
                if r.count == 4 { node.simdRotation = SIMD4(r[0], r[1], r[2], r[3]) } // 四元数
                if t.count == 3 { node.simdPosition = SIMD3(t[0], t[1], t[2]) }
                if s.count == 3 { node.simdScale = SIMD3(s[0], s[1], s[2]) }
            }

            if let meshIdx = (n["mesh"] as? NSNumber)?.intValue, meshIdx < array("meshes").count {
                let mesh = array("meshes")[meshIdx]
                for prim in array(mesh["primitives"]) {
                    if (prim["extensions"] as? [String: Any])?["KHR_draco_mesh_compression"] != nil { continue }
                    if let geo = geometry(for: prim) {
                        node.addChildNode(SCNNode(geometry: geo))
                    }
                }
            }
            for child in ints(n["children"]) {
                if let c = try buildNode(child) { node.addChildNode(c) }
            }
            return node
        }

        // MARK: 几何构建

        private func geometry(for prim: [String: Any]) -> SCNGeometry? {
            let attrs = prim["attributes"] as? [String: Any] ?? [:]
            guard let pos = attrib(attrs, "POSITION"), pos.count > 0 else { return nil }

            var sources: [SCNGeometrySource] = [makeSource(pos, semantic: .vertex)]
            if let nrm = attrib(attrs, "NORMAL") { sources.append(makeSource(nrm, semantic: .normal)) }
            if let uv = attrib(attrs, "TEXCOORD_0", flipV: true) { sources.append(makeSource(uv, semantic: .texcoord)) }
            if let col = attrib(attrs, "COLOR_0"), col.comps >= 3 { sources.append(makeSource(col, semantic: .color)) }

            let mode = (prim["mode"] as? NSNumber)?.intValue ?? 4  // glTF 默认 mode=4 TRIANGLES
            var element: SCNGeometryElement?

            func triElement(_ data: Data, bytesPer: Int, triCount: Int) -> SCNGeometryElement {
                SCNGeometryElement(data: data, primitiveType: .triangles, primitiveCount: triCount, bytesPerIndex: bytesPer)
            }

            switch mode {
            case 4: // TRIANGLES（索引或非索引）
                if let idxRef = (prim["indices"] as? NSNumber)?.intValue, let ind = indices(idxRef) {
                    element = triElement(ind.data, bytesPer: ind.bytesPer, triCount: ind.count / 3)
                } else {
                    element = SCNGeometryElement(data: nil, primitiveType: .triangles,
                                                 primitiveCount: pos.count / 3, bytesPerIndex: 4)
                }
            case 1, 2: // STRIP / FAN → 展开为三角形
                var tris: [UInt32] = []
                if let idxRef = (prim["indices"] as? NSNumber)?.intValue, let ind = indices(idxRef) {
                    tris = expandStripFan(indicesData: ind.data, bytesPer: ind.bytesPer, count: ind.count, fan: mode == 2)
                } else {
                    tris = expandStripFan(indicesData: nil, bytesPer: 4, count: pos.count, fan: mode == 2)
                }
                if !tris.isEmpty {
                    element = SCNGeometryElement(data: tris.withUnsafeBufferPointer { Data(buffer: $0) },
                                                 primitiveType: .triangles, primitiveCount: tris.count / 3, bytesPerIndex: 4)
                }
            default:
                return nil // 线/点等模式不参与实体渲染
            }
            guard let el = element else { return nil }

            let geo = SCNGeometry(sources: sources, elements: [el])
            if let mat = makeMaterial((prim["material"] as? NSNumber)?.intValue) {
                geo.materials = [mat]
            }
            return geo
        }

        private func expandStripFan(indicesData: Data?, bytesPer: Int, count: Int, fan: Bool) -> [UInt32] {
            var raw: [UInt32] = []
            if let d = indicesData {
                raw.reserveCapacity(count)
                switch bytesPer {
                case 4: d.withUnsafeBytes { p in for i in 0..<count { raw.append(p.loadUnaligned(fromByteOffset: i*4, as: UInt32.self)) } }
                case 2: d.withUnsafeBytes { p in for i in 0..<count { raw.append(UInt32(p.loadUnaligned(fromByteOffset: i*2, as: UInt16.self))) } }
                default: d.withUnsafeBytes { p in for i in 0..<count { raw.append(UInt32(p[i])) } }
                }
            } else {
                raw = Array(0..<UInt32(count))
            }
            var tris: [UInt32] = []
            tris.reserveCapacity(max(0, raw.count - 2) * 3)
            for i in 2..<raw.count {
                if fan { tris.append(contentsOf: [raw[0], raw[i-1], raw[i]]) }
                else if i % 2 == 0 { tris.append(contentsOf: [raw[i-2], raw[i-1], raw[i]]) }
                else { tris.append(contentsOf: [raw[i-1], raw[i-2], raw[i]]) }
            }
            return tris
        }

        // MARK: 材质与纹理

        func makeMaterial(_ matIdx: Int?) -> SCNMaterial? {
            guard let matIdx, matIdx < array("materials").count else { return nil }
            let m = array("materials")[matIdx]
            let mat = SCNMaterial()
            let pbr = m["pbrMetallicRoughness"] as? [String: Any] ?? [:]
            let color = floats(pbr["baseColorFactor"])
            if color.count >= 3 {
                mat.diffuse.contents = NSColor(srgbRed: CGFloat(color[0]), green: CGFloat(color[1]),
                                               blue: CGFloat(color[2]), alpha: color.count > 3 ? CGFloat(color[3]) : 1)
            } else {
                mat.diffuse.contents = NSColor.white
            }
            if let tex = pbr["baseColorTexture"] as? [String: Any],
               let imgIdx = imageIndex(forTextureIndex: (tex["index"] as? NSNumber)?.intValue ?? -1),
               let image = loadImage(imgIdx) {
                mat.diffuse.contents = image
            }
            let metal = (pbr["metallicFactor"] as? NSNumber)?.floatValue ?? 1
            let rough = (pbr["roughnessFactor"] as? NSNumber)?.floatValue ?? 1
            // 预览取舍：QL 环境无 HDRI，高金属度材质会近乎纯黑，钳制到可见范围
            mat.lightingModel = .physicallyBased
            mat.metalness.contents = NSNumber(value: min(max(metal, 0), 0.35))
            mat.roughness.contents = NSNumber(value: min(max(rough, 0.3), 0.9))
            let e = floats(m["emissiveFactor"])
            if e.count >= 3, (e.max() ?? 0) > 0 {
                mat.emission.contents = NSColor(srgbRed: CGFloat(e[0]), green: CGFloat(e[1]), blue: CGFloat(e[2]), alpha: 1)
            }
            mat.isDoubleSided = (m["doubleSided"] as? NSNumber)?.boolValue ?? false
            return mat
        }

        private func imageIndex(forTextureIndex texIdx: Int) -> Int? {
            let textures = array("textures")
            guard texIdx >= 0, texIdx < textures.count else { return nil }
            return (textures[texIdx]["source"] as? NSNumber)?.intValue
        }

        private func loadImage(_ imgIdx: Int?) -> NSImage? {
            guard let imgIdx, imgIdx < array("images").count else { return nil }
            let img = array("images")[imgIdx]
            if let bv = (img["bufferView"] as? NSNumber)?.intValue,
               let view = dataViewPrivate(bv), let bin {
                let s = view.offset, e = min(view.offset + view.length, bin.count)
                return NSImage(data: bin.subdata(in: s..<e))
            }
            if let uri = img["uri"] as? String {
                if uri.hasPrefix("data:") {
                    if let b64 = uri.split(separator: ",").last,
                       let d = Data(base64Encoded: String(b64)) { return NSImage(data: d) }
                } else {
                    let url = baseURL.appendingPathComponent(uri)
                    if let d = try? Data(contentsOf: url) { return NSImage(data: d) }
                }
            }
            return nil
        }

        private func dataViewPrivate(_ idx: Int) -> (offset: Int, length: Int, stride: Int?)? {
            dataView(idx)
        }
    }
}
