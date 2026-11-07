import Foundation
import CryptoKit

/// .blend 文件预览支持：借助本机安装的 Blender 无头转换为 GLB，并按 (路径|大小|mtime) 缓存。
enum BlendPipeline {

    enum BlendError: LocalizedError {
        case noBlender
        case failed(String)
        case timeout

        var errorDescription: String? {
            switch self {
            case .noBlender:
                return "未检测到 Blender。请安装 Blender 后重试（/Applications/Blender.app）"
            case .timeout:
                return "Blender 转换超时，模型可能过于复杂"
            case .failed(let detail):
                return "Blender 转换失败：\(detail)"
            }
        }
    }

    /// 共享缓存根目录：QL 扩展容器的 Caches/blend2glb/
    /// - QL 扩展（沙盒）：cachesDirectory 自动映射到自身容器 Caches
    /// - 主应用（非沙盒）：直接构造扩展容器的绝对路径（同一物理位置，容器目录无 MACL 可写）
    /// 注意：沙盒进程的 homeDirectoryForCurrentUser 被重定向，不可用于构造绝对路径。
    static var cacheRoot: URL {
        let caches: URL
        if runningInQuickLookExtension() {
            caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        } else {
            caches = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Containers/com.modelpreview.macos.QuickLook/Data/Library/Caches",
                                        isDirectory: true)
        }
        let dir = caches.appendingPathComponent("blend2glb", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func cacheKey(for url: URL) -> String {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = (attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let plain = Data("\(url.standardizedFileURL.path)|\(size)|\(mtime)".utf8)
        let digest = SHA256.hash(data: plain)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// 命中缓存则返回已转换的 GLB
    static func cachedGLB(for blendURL: URL) -> URL? {
        let candidate = cacheRoot.appendingPathComponent(cacheKey(for: blendURL) + ".glb")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }

    /// 定位 Blender 可执行文件
    static func findBlender() -> URL? {
        var candidates = ["/Applications/Blender.app/Contents/MacOS/Blender"]
        candidates.append(NSHomeDirectory() + "/Applications/Blender.app/Contents/MacOS/Blender")
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return URL(fileURLWithPath: c)
        }
        // Spotlight 兜底
        if let out = runProcess(URL(fileURLWithPath: "/usr/bin/mdfind"),
                                ["kMDItemCFBundleIdentifier == 'org.blenderfoundation.blender'"]) {
            for line in out.split(separator: "\n") {
                let exe = line.trimmingCharacters(in: .whitespacesAndNewlines) + "/Contents/MacOS/Blender"
                if FileManager.default.isExecutableFile(atPath: exe) {
                    return URL(fileURLWithPath: exe)
                }
            }
        }
        return nil
    }

    /// 无头转换 .blend → GLB（应用修改器、内嵌贴图），结果写入缓存并返回
    static func convert(blendURL: URL, timeout: TimeInterval = 120) throws -> URL {
        if let cached = cachedGLB(for: blendURL) { return cached }

        guard let blender = findBlender() else { throw BlendError.noBlender }

        let fm = FileManager.default
        let tmp = fm.temporaryDirectory.appendingPathComponent("blend2glb-\(UUID().uuidString).glb")
        let escaped = tmp.path.replacingOccurrences(of: "'", with: "\\'")
        // 贴图重定位：Blender 保存后贴图文件被移动时相对路径断裂，
        // 转换前在 blend 同目录/上级目录/textures 子目录中按文件名查找并修正
        let relocate = """
        import bpy, os
        blend_dir = os.path.dirname(bpy.data.filepath)
        cands = [blend_dir, os.path.dirname(blend_dir), os.path.join(blend_dir, 'textures'), os.path.join(os.path.dirname(blend_dir), 'textures')]
        import subprocess
        for img in bpy.data.images:
            if img.source == 'FILE' and img.filepath and not img.packed_file:
                fp = bpy.path.abspath(img.filepath)
                if not os.path.isfile(fp):
                    base = os.path.basename(img.filepath)
                    cand = None
                    for d in cands:
                        c = os.path.join(d, base)
                        if os.path.isfile(c):
                            cand = c
                            break
                    if not cand and base.lower().endswith(('.png', '.jpg', '.jpeg', '.exr', '.hdr')):
                        try:
                            r = subprocess.run(['mdfind', '-name', base], capture_output=True, text=True, timeout=8)
                            for line in r.stdout.split('\\n'):
                                line = line.strip()
                                if line and os.path.isfile(line) and os.path.basename(line).lower() == base.lower():
                                    cand = line
                                    break
                        except Exception:
                            pass
                    if cand:
                        img.filepath = cand
        """
        let expr = relocate + "\nimport bpy\nbpy.ops.export_scene.gltf(filepath='\(escaped)', export_format='GLB', export_apply=True)"

        let process = Process()
        process.executableURL = blender
        process.arguments = ["-b", "--factory-startup", blendURL.standardizedFileURL.path,
                             "--python-expr", expr]
        var stderrData = Data()
        let stderrPipe = Pipe()
        process.standardError = stderrPipe
        process.standardOutput = Pipe()

        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }

        do {
            try process.run()
        } catch {
            throw BlendError.failed("无法启动 Blender：\(error.localizedDescription)")
        }

        // 后台收集 stderr
        let stderrQueue = DispatchQueue.global(qos: .utility)
        stderrQueue.async { stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile() }

        // 超时看门狗
        let watchdog = DispatchWorkItem {
            if process.isRunning {
                process.terminate()
            }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: watchdog)

        _ = done.wait(timeout: .now() + timeout + 5)
        watchdog.cancel()

        let status = process.terminationStatus
        if status != 0 || !fm.fileExists(atPath: tmp.path) {
            try? fm.removeItem(at: tmp) // 清理半途残留
            let detail = String(data: stderrData, encoding: .utf8)?
                .split(separator: "\n")
                .filter { $0.lowercased().contains("error") || $0.contains("Traceback") }
                .suffix(3).joined(separator: "\n") ?? ""
            throw process.terminationReason == .uncaughtSignal && status != 0
                ? BlendError.timeout
                : BlendError.failed(detail.isEmpty ? "退出码 \(status)" : detail)
        }

        let dest = cacheRoot.appendingPathComponent(cacheKey(for: blendURL) + ".glb")
        try? fm.removeItem(at: dest)
        try fm.moveItem(at: tmp, to: dest)
        return dest
    }

    static func describe(error: Error) -> String {
        (error as? BlendError)?.errorDescription ?? error.localizedDescription
    }

    private static func runProcess(_ exe: URL, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        do { try p.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)
    }
}

/// 判断 app 是否运行在 Quick Look 扩展环境中
func runningInQuickLookExtension() -> Bool {
    Bundle.main.bundleURL.pathExtension == "appex"
}
