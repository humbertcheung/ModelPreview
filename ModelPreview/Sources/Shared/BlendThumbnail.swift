import AppKit

/// 从 .blend 文件中提取 Blender 保存时内嵌的预览缩略图。
/// 支持两种格式：
///  - 旧格式（Blender ≤ 4.x）：12 字节头 + 24/32 字节块头（含 old-ptr）
///  - 新格式（Blender 5.x "BLENDER17"）：17 字节头 + 32 字节块头（8 字节块 ID）
/// 支持 zstd 压缩保存（含 Blender 5.x 的多 frame 连续压缩）。
/// PreviewImage 为嵌入结构（无独立块级类型标记），新格式用像素块反查定位。
enum BlendThumbnail {

    static func extract(from url: URL) -> NSImage? {
        guard var data = try? Data(contentsOf: url) else { return nil }
        // Blender 压缩保存：连续 zstd frame，先解压再解析
        if data.count > 4, data[0] == 0x28, data[1] == 0xB5, data[2] == 0x2F, data[3] == 0xFD {
            guard let raw = zstdDecompress(data) else { return nil }
            data = raw
        }
        let n = data.count
        guard n > 17 else { return nil }
        guard String(data: data.prefix(7), encoding: .ascii) == "BLENDER" else { return nil }
        // 新格式 "BLENDER17…"：byte7 是 '1'
        if data[7] == UInt8(ascii: "1") {
            return parseNewFormat(data)
        }
        return parseLegacyFormat(data)
    }

    // MARK: - zstd（多 frame）

    private static func zstdDecompress(_ data: Data) -> Data? {
        var outSize: Int = 0
        guard let buf = ZstdDecompressAll((data as NSData).bytes, data.count, &outSize),
              outSize > 0 else { return nil }
        defer { free(buf) }
        return Data(bytes: buf, count: outSize)
    }

    // MARK: - 新格式（Blender 5.x）

    private static func parseNewFormat(_ data: Data) -> NSImage? {
        let n = data.count
        let headerLen = 17
        var blockMap: [UInt64: (offset: Int, size: Int)] = [:]
        var pixelCandidates: [(id: UInt64, v: Int)] = []

        var off = headerLen
        while off + 32 <= n {
            let code = data.subdata(in: off..<(off+4))
            if code == Data("ENDB".utf8) { break }
            guard isBlockCode(code) else { return nil }
            let size = Int(i64(data, off + 16))
            guard size >= 0, off + 32 + size <= n else { return nil }
            let id = u64(data, off + 8)
            let dataOffset = off + 32
            if id != 0 { blockMap[id] = (dataOffset, size) }
            // 像素块：size = v²×4（正方形 RGBA）
            if size >= 1024, size % 4 == 0 {
                let v = Int((Double(size) / 4).squareRoot())
                if v * v * 4 == size, (16...2048).contains(v) {
                    pixelCandidates.append((id, v))
                }
            }
            off = dataOffset + size
        }

        // 反查嵌入的 PreviewImage：rect 指针(8B) 指向像素块，
        // 其前方 24/16 字节处是 w/h（与像素块边长相等）
        for (id, v) in pixelCandidates {
            var needle = Data(count: 8)
            needle.withUnsafeMutableBytes { $0.storeBytes(of: id.littleEndian, as: UInt64.self) }
            var pos = 0
            while true {
                let x: Int = data.withUnsafeBytes { src in
                    Int(FindBytes(src.baseAddress, src.count,
                                  (needle as NSData).bytes, 8, pos))
                }
                guard x >= 0 else { break }
                pos = x + 1
                guard x >= 24 else { continue }
                let w = i32(data, x - 24)
                let h = i32(data, x - 16)
                if w == v, h == v, let pix = blockMap[id] {
                    return image(fromRGBA: data.subdata(in: pix.offset..<(pix.offset + pix.size)),
                                 width: v, height: v)
                }
            }
        }
        return nil
    }

    private static func isBlockCode(_ code: Data) -> Bool {
        let s = code.filter { $0 != 0 }
        return !s.isEmpty && s.allSatisfy { (32..<127).contains($0) }
    }
    private static func i32(_ d: Data, _ off: Int) -> Int32 {
        Int32(d[off]) | Int32(d[off+1]) << 8 | Int32(d[off+2]) << 16 | Int32(d[off+3]) << 24
    }
    private static func i64(_ d: Data, _ off: Int) -> Int64 {
        var v: Int64 = 0
        for i in 0..<8 { v |= Int64(d[off+i]) << (8 * i) }
        return v
    }
    private static func u64(_ d: Data, _ off: Int) -> UInt64 {
        var v: UInt64 = 0
        for i in 0..<8 { v |= UInt64(d[off+i]) << (8 * i) }
        return v
    }

    // MARK: - 旧格式（Blender ≤ 4.x）

    private static func parseLegacyFormat(_ data: Data) -> NSImage? {
        let n = data.count
        let ptrSize = data[7] == UInt8(ascii: "-") ? 8 : 4   // '_' = 32 位, '-' = 64 位
        guard data[8] == UInt8(ascii: "v") else { return nil } // 仅小端

        @inline(__always) func i32(_ off: Int) -> Int32 {
            Int32(data[off]) | Int32(data[off+1]) << 8 | Int32(data[off+2]) << 16 | Int32(data[off+3]) << 24
        }
        @inline(__always) func u64(_ off: Int) -> UInt64 {
            var v: UInt64 = 0
            for i in 0..<ptrSize { v |= UInt64(data[off+i]) << (8 * i) }
            return v
        }

        struct FileBlock { let code: String; let sdnaIndex: Int; let count: Int; let dataOffset: Int; let size: Int }
        var blocks: [FileBlock] = []
        var blockMap: [UInt64: (offset: Int, size: Int)] = [:]
        var dnaRange: Range<Int>?

        var offset = 12
        while offset + 16 + ptrSize <= n {
            let code = String(data: data.subdata(in: offset..<(offset+4)), encoding: .ascii) ?? ""
            let size = Int(i32(offset + 4))
            let oldPtr = u64(offset + 8)
            let sdna = Int(i32(offset + 8 + ptrSize))
            let count = Int(i32(offset + 12 + ptrSize))
            let dataOffset = offset + 16 + ptrSize
            if code == "ENDB" { break }
            guard size >= 0, dataOffset + size <= n else { return nil }
            if code == "DNA1" { dnaRange = dataOffset..<(dataOffset + size) }
            if oldPtr != 0 { blockMap[oldPtr] = (dataOffset, size) }
            blocks.append(FileBlock(code: code, sdnaIndex: sdna, count: count, dataOffset: dataOffset, size: size))
            offset = dataOffset + size
        }
        guard let dna = dnaRange else { return nil }

        // SDNA（标记搜索，规避段对齐差异）
        func findTag(_ tag: String, from: Int, limit: Int) -> Int? {
            data.range(of: Data(tag.utf8), in: from..<min(limit, n))?.lowerBound
        }
        guard let sdnaStart = findTag("SDNA", from: dna.lowerBound, limit: dna.upperBound),
              let nameTag = findTag("NAME", from: sdnaStart + 4, limit: dna.upperBound),
              let typeTag = findTag("TYPE", from: nameTag + 4, limit: dna.upperBound),
              let tlenTag = findTag("TLEN", from: typeTag + 4, limit: dna.upperBound),
              let strcTag = findTag("STRC", from: tlenTag + 4, limit: dna.upperBound) else { return nil }

        var p = nameTag + 4
        let nameCount = Int(i32(p)); p += 4
        var names: [String] = []; names.reserveCapacity(nameCount)
        for _ in 0..<nameCount {
            guard let end = data[p...].firstIndex(of: 0), end < dna.upperBound else { return nil }
            names.append(String(data: data.subdata(in: p..<end), encoding: .utf8) ?? "")
            p = end + 1
        }
        p = typeTag + 4
        let typeCount = Int(i32(p)); p += 4
        var types: [String] = []; types.reserveCapacity(typeCount)
        for _ in 0..<typeCount {
            guard let end = data[p...].firstIndex(of: 0), end < dna.upperBound else { return nil }
            types.append(String(data: data.subdata(in: p..<end), encoding: .utf8) ?? "")
            p = end + 1
        }
        p = tlenTag + 4
        guard typeCount * 2 <= n - p else { return nil }
        var typeLen: [Int] = []
        typeLen.reserveCapacity(typeCount)
        for i in 0..<typeCount { typeLen.append(Int(data[p + i*2]) | Int(data[p + i*2 + 1]) << 8) }
        p = strcTag + 4
        let strcCount = Int(i32(p)); p += 4

        // 计算 PreviewImage 的 w / h / rect 字段偏移
        var previewIndex: Int?
        var wOff = -1, hOff = -1, rectOff = -1
        var instanceSize = 0
        for _ in 0..<strcCount {
            let typeIdx = Int(data[p]) | Int(data[p+1]) << 8
            let fieldCount = Int(data[p+2]) | Int(data[p+3]) << 8
            let isTarget = typeIdx < types.count && types[typeIdx] == "PreviewImage"
            var off = 0
            var lw = -1, lh = -1, lr = -1
            var fp = p + 4
            for _ in 0..<fieldCount {
                let fType = Int(data[fp]) | Int(data[fp+1]) << 8
                let fName = Int(data[fp+2]) | Int(data[fp+3]) << 8
                fp += 4
                guard fType < types.count, fName < names.count else { continue }
                let name = names[fName]
                let isPtr = name.hasPrefix("*")
                let elementSize = isPtr ? ptrSize : (fType < typeLen.count ? typeLen[fType] : 0)
                var arr = 1
                var tmp = name
                while let open = tmp.firstIndex(of: "["), let close = tmp.firstIndex(of: "]"), open < close {
                    let dim = Int(tmp[tmp.index(after: open)..<close]) ?? 1
                    arr *= max(dim, 1)
                    tmp = String(tmp[tmp.index(after: close)...])
                }
                let aligned = (off + elementSize - 1) & ~(elementSize - 1)
                if isTarget {
                    let pure = name.split(separator: "[").first.map(String.init)?
                        .replacingOccurrences(of: "*", with: "") ?? ""
                    if pure == "w", lw < 0 { lw = aligned }
                    if pure == "h", lh < 0 { lh = aligned }
                    if pure == "rect", lr < 0 { lr = aligned }
                }
                off = aligned + elementSize * arr
            }
            if isTarget {
                previewIndex = typeIdx
                wOff = lw; hOff = lh; rectOff = lr
                instanceSize = typeIdx < typeLen.count ? typeLen[typeIdx] : off
                break
            }
            p = fp
        }
        guard previewIndex != nil, wOff >= 0, hOff >= 0, rectOff >= 0 else { return nil }

        for block in blocks where block.sdnaIndex == previewIndex {
            for inst in 0..<max(block.count, 1) {
                let base = block.dataOffset + inst * instanceSize
                guard base + instanceSize <= n else { continue }
                let w0 = Int(i32(base + wOff))
                let h0 = Int(i32(base + hOff))
                let rectPtr = u64(base + rectOff)
                guard w0 > 0, h0 > 0, w0 <= 8192, h0 <= 8192, rectPtr != 0,
                      let pix = blockMap[rectPtr], pix.size >= w0 * h0 * 4 else { continue }
                return image(fromRGBA: data.subdata(in: pix.offset..<(pix.offset + w0 * h0 * 4)),
                             width: w0, height: h0)
            }
        }
        return nil
    }

    // MARK: - 像素 → NSImage

    private static func image(fromRGBA pixels: Data, width: Int, height: Int) -> NSImage? {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
                                         pixelsWide: width, pixelsHigh: height,
                                         bitsPerSample: 8, samplesPerPixel: 4,
                                         hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB,
                                         bytesPerRow: width * 4, bitsPerPixel: 32),
              let buf = rep.bitmapData else { return nil }
        pixels.copyBytes(to: buf, count: min(pixels.count, width * height * 4))
        let img = NSImage(size: NSSize(width: width, height: height))
        img.addRepresentation(rep)
        return img
    }
}
