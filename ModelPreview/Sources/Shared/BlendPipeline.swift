import Foundation
import CryptoKit
import Darwin

/// 线程安全容器：后台线程写、主线程读（Swift 6 并发检查友好）
final class Atomic<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ v: T) { value = v }
    var get: T { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
}

/// 兜底持有仍存活的 Process：Process 在运行中被释放时，
/// macOS 27 新 Foundation 会在内部任务 dealloc 时抛 ObjC 异常（Swift 无法捕获 → abort）。
enum ProcessKeepAlive {
    private static let lock = NSLock()
    private static var list: [Process] = []
    static func keep(_ p: Process) {
        lock.lock(); list.append(p); lock.unlock()
    }
}

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
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }

        do {
            try process.run()
        } catch {
            throw BlendError.failed("无法启动 Blender：\(error.localizedDescription)")
        }

        // 关键：stdout / stderr 必须同时被读取。管道缓冲区仅 64KB，
        // 若不读取，Blender 输出超过缓冲后会被永久阻塞（转换假死直到看门狗杀进程）。
        let outBox = Atomic(Data())
        let errBox = Atomic(Data())
        let ioGroup = DispatchGroup()
        ioGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            outBox.set(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
            ioGroup.leave()
        }
        ioGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            errBox.set(stderrPipe.fileHandleForReading.readDataToEndOfFile())
            ioGroup.leave()
        }

        // 超时看门狗
        let timedOut = Atomic(false)
        let watchdog = DispatchWorkItem {
            if process.isRunning {
                timedOut.set(true)
                process.terminate()
            }
        }
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: watchdog)

        let finished = done.wait(timeout: .now() + timeout + 5) == .success
        if !finished {
            watchdog.cancel()
            if process.isRunning {
                timedOut.set(true)
                process.terminate() // SIGTERM
                if done.wait(timeout: .now() + 5) != .success, process.isRunning {
                    kill(process.processIdentifier, SIGKILL) // 不响应 SIGTERM 时强杀
                    _ = done.wait(timeout: .now() + 5)
                }
            }
        }
        watchdog.cancel()

        // 回收子进程：必须 waitUntilExit，否则 Process 释放时内部任务尚未回收，
        // macOS 27 的新 Foundation 会在任务 dealloc 时抛 ObjC 异常（Swift 无法捕获 → abort）。
        if process.isRunning {
            ProcessKeepAlive.keep(process) // 仍在运行：交由此处持有，杜绝「运行中被释放」这一崩溃类别
        } else {
            process.waitUntilExit()
        }
        _ = ioGroup.wait(timeout: .now() + 5) // 管道读完（带上限，避免子进程遗留导致永久等待）

        // 注意：此处刻意不读取 process.terminationStatus / terminationReason。
        // macOS 27 上该 getter 在任务状态异常时会抛 ObjC 异常（Swift do/catch 无法捕获 → 进程崩溃），
        // 崩溃报告：-[NSConcreteTask terminationStatus] → objc_exception_throw → abort。
        // 转换成功与否以「输出文件」为准（功能上的真实判据），错误信息取自 Blender 输出。
        let outAttrs = try? fm.attributesOfItem(atPath: tmp.path)
        let outSize = (outAttrs?[.size] as? NSNumber)?.int64Value ?? 0
        let produced = fm.fileExists(atPath: tmp.path) && outSize > 0
        if !produced {
            try? fm.removeItem(at: tmp) // 清理半途残留
            let text = (String(data: errBox.get, encoding: .utf8) ?? "") + "\n" + (String(data: outBox.get, encoding: .utf8) ?? "")
            let detail = text
                .split(separator: "\n")
                .filter { $0.lowercased().contains("error") || $0.contains("Traceback") || $0.contains("Error:") }
                .suffix(3).joined(separator: "\n")
            if timedOut.get {
                throw BlendError.timeout
            }
            throw BlendError.failed(detail.isEmpty
                ? "Blender 未生成输出文件（模型可能损坏，或 Blender 异常退出）"
                : detail)
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
        p.standardError = FileHandle.nullDevice // 不读 stderr 会让管道写满后阻塞
        do { try p.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit() // 回收子进程：否则 Process 释放时内部任务未回收会抛 ObjC 异常
        return String(data: data, encoding: .utf8)
    }
}

/// 判断 app 是否运行在 Quick Look 扩展环境中
func runningInQuickLookExtension() -> Bool {
    Bundle.main.bundleURL.pathExtension == "appex"
}
