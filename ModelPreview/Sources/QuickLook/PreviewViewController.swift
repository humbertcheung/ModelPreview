import Cocoa
import SceneKit
import ModelIO
import Quartz
import AppKit

/// Quick Look 预览扩展（SceneKit 原生渲染，无 WebKit 依赖）。
/// - GLB/GLTF → 自研 GLTFSceneLoader
/// - OBJ/STL/PLY → ModelIO
/// - DAE → SceneKit 原生
/// - BLEND → 内嵌缩略图提取
/// - FBX/3MF 等 → 信息提示（完整预览请用主应用）
final class PreviewViewController: NSViewController, QLPreviewingController {

    private func dbg(_ s: String) {
        let path = NSTemporaryDirectory() + "ql-debug.log"
        let line = "\(Date()) \(s)\n"
        if let fh = FileHandle(forWritingAtPath: path) {
            fh.seekToEndOfFile(); fh.write(line.data(using: .utf8)!); fh.closeFile()
        } else {
            try? line.write(toFile: path, atomically: true, encoding: .utf8)
        }
    }

    override func loadView() {
        let holder = NSView(frame: NSRect(x: 0, y: 0, width: 960, height: 640))
        holder.wantsLayer = true
        holder.layer?.backgroundColor = NSColor(red: 0.09, green: 0.10, blue: 0.11, alpha: 1).cgColor
        view = holder
    }

    func preparePreviewOfFile(at url: URL, completionHandler: @escaping (Error?) -> Void) {
        dbg("prepare: \(url.lastPathComponent)")
        completionHandler(nil)

        let ext = url.pathExtension.lowercased()

        // 先在主线程同步挂载持续渲染的 SCNView 占位，避免与 QL 面板显示产生时序竞争；
        // 模型在后台解析完成后直接替换 view.scene（SCNView 会立即重绘）。
        // blend 也预挂 SCNView：缓存命中走 3D 渲染；未命中时移除占位改显缩略图/提示。
        if ["glb", "gltf", "obj", "stl", "ply", "dae", "blend"].contains(ext) {
            DispatchQueue.main.async { [weak self] in
                guard let self, self.scnView == nil else { return }
                let v = SCNView(frame: self.view.bounds)
                v.autoresizingMask = [.width, .height]
                v.backgroundColor = NSColor(red: 0.09, green: 0.10, blue: 0.11, alpha: 1)
                v.autoenablesDefaultLighting = true
                v.allowsCameraControl = true
                v.antialiasingMode = .multisampling4X
                // 持续渲染：QL 面板需要随相机交互实时更新；
                // 此前改为按需渲染会导致面板偶发黑屏（体验优先，QL 进程生命周期短，开销可接受）
                v.rendersContinuously = true
                self.scnView = v
                self.view.addSubview(v)
                // 大模型解析期间显示加载动画，避免长时间黑屏无反馈
                self.showLoadingIndicator(text: "正在载入模型…")
                self.dbg("placeholder SCNView mounted for .\(ext)")
            }
        }

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0

            switch ext {
            case "glb", "gltf":
                let flipV = Self.loadQlSettings().flipTextureV
                self.mountScene { try GLTFSceneLoader.load(from: url, flipTextureV: flipV) }
            case "obj", "stl", "ply":
                self.mountScene { try Self.loadWithModelIO(url) }
            case "dae":
                self.mountScene {
                    guard let s = try? SCNScene(url: url, options: [.checkConsistency: false]) else {
                        throw NSError(domain: "QL", code: 1, userInfo: [NSLocalizedDescriptionKey: "DAE 解析失败"])
                    }
                    return s
                }
            case "blend":
                // 1) 共享缓存命中（主应用已转换过）→ 直接 3D 渲染
                dbg("blend: checking shared cache")
                let cached = BlendPipeline.cachedGLB(for: url)
                dbg("blend: cache \(cached != nil ? "HIT \(cached!.lastPathComponent)" : "miss")")
                if let cached {
                    let flipV2 = Self.loadQlSettings().flipTextureV
                    mountScene { try GLTFSceneLoader.load(from: cached, flipTextureV: flipV2) }
                    return
                }
                // 2) .blend 内嵌缩略图（移除占位 SCNView 后显示）
                dbg("blend: extracting thumbnail")
                let image = BlendThumbnail.extract(from: url)
                dbg("blend: thumbnail \(image != nil ? "OK" : "none")")
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.hideLoadingIndicator()
                    self.scnView?.removeFromSuperview()
                    self.scnView = nil
                    let content: NSView
                    if let image {
                        content = self.imageView(image, caption: "内嵌缩略图 · 在主应用中打开可 3D 交互")
                    } else {
                        content = self.infoView(title: "首次预览需要一次转换",
                                                detail: "在「3D模型预览」应用中打开此文件一次（数秒），\n之后空格预览即可显示完整 3D 模型。")
                    }
                    self.replaceContent(with: content)
                    self.dbg("thumbnail/info added for .blend (\(size) bytes)")
                }
            default:
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.scnView == nil else { return }
                    self.replaceContent(with: self.infoView(
                        title: "\(ext.uppercased()) 快速预览",
                        detail: "此格式的完整 3D 交互预览请用「3D模型预览」应用打开\n（支持旋转 / 缩放 / 线框 / 材质信息）"))
                    self.dbg("info added for .\(ext)")
                }
            }
        }
    }

    private var scnView: SCNView?

    // MARK: - 加载指示器（大模型解析期间的反馈，避免长时间黑屏）

    private var loadingView: NSView?

    /// 显示旋转加载指示器 + 文字提示
    private func showLoadingIndicator(text: String) {
        guard loadingView == nil else { return }
        let box = NSView(frame: self.view.bounds)
        box.autoresizingMask = [.width, .height]
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor(red: 0.09, green: 0.10, blue: 0.11, alpha: 1).cgColor

        let spinner = LoadingSpinner(frame: NSRect(x: 0, y: 0, width: 46, height: 46))
        spinner.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(spinner)

        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        label.textColor = NSColor.white.withAlphaComponent(0.72)
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false

        box.addSubview(label)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: box.centerYAnchor, constant: -14),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 14),
            label.centerXAnchor.constraint(equalTo: box.centerXAnchor),
        ])

        self.view.addSubview(box)
        loadingView = box
    }

    private func hideLoadingIndicator() {
        loadingView?.removeFromSuperview()
        loadingView = nil
    }

    private func replaceContent(with content: NSView) {
        content.frame = view.bounds
        content.autoresizingMask = [.width, .height]
        view.addSubview(content)
    }

    struct QlSettings {
        var groundEnabled = true
        var groundColorHex = "#ffffff"
        var hideBackdrop = true
        var flipTextureV = false   // 贴图垂直翻转：与导出管线有关，色彩错乱时可切换
    }

    static func loadQlSettings() -> QlSettings {
        let p = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ql-settings.json")
        guard let data = try? Data(contentsOf: p),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return QlSettings() }
        return QlSettings(groundEnabled: j["qlGroundEnabled"] as? Bool ?? true,
                          groundColorHex: j["qlGroundColor"] as? String ?? "#ffffff",
                          hideBackdrop: j["qlHideBackdrop"] as? Bool ?? true,
                          flipTextureV: j["flipTextureV"] as? Bool ?? false)
    }

    static func colorFromHex(_ hex: String) -> NSColor {
        var h = hex.trimmingCharacters(in: .whitespaces)
        if h.hasPrefix("#") { h.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: h).scanHexInt64(&v)
        return NSColor(red: CGFloat((v >> 16) & 0xFF) / 255,
                       green: CGFloat((v >> 8) & 0xFF) / 255,
                       blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }

    private func mountScene(_ loader: () throws -> SCNScene) {
        do {
            let scene = try loader()
            let settings = Self.loadQlSettings()
            // 整体尺寸（用于识别背景面）
            let (bbMin0, bbMax0) = scene.rootNode.boundingBox
            let sceneDims = SIMD3(Float(bbMax0.x - bbMin0.x), Float(bbMax0.y - bbMin0.y), Float(bbMax0.z - bbMin0.z))
            let maxDimOfScene = max(sceneDims.x, sceneDims.y, sceneDims.z)
            // 内容居中：几何中心移到原点（与主应用一致），保证取景始终居中
            let (minV, maxV) = scene.rootNode.boundingBox
            let c = SCNVector3((minV.x + maxV.x) / 2, (minV.y + maxV.y) / 2, (minV.z + maxV.z) / 2)
            scene.rootNode.position = SCNVector3(-c.x, -c.y, -c.z)
            // 隐藏巨大扁平背景面（按设置，默认开）
            if settings.hideBackdrop {
                scene.rootNode.enumerateHierarchy { node, _ in
                    guard node.geometry != nil else { return }
                    let bb = node.boundingBox
                    let wMin = node.convertPosition(bb.min, to: nil)
                    let wMax = node.convertPosition(bb.max, to: nil)
                    let d = SIMD3(Float(wMax.x - wMin.x), Float(wMax.y - wMin.y), Float(wMax.z - wMin.z))
                    let dims = [d.x, d.y, d.z].sorted()
                    if dims[0] <= Float(maxDimOfScene) * 0.03 && dims[2] >= Float(maxDimOfScene) * 1.5 {
                        node.isHidden = true
                    }
                }
            }
            // 环境贴图/相机均为 AppKit/SceneKit UI 操作，必须在主线程
            DispatchQueue.main.async { [weak self] in
                guard let self, let v = self.scnView else { return }
                Self.applyStudioLighting(scene)
                Self.fitCamera(to: scene, view: v)
                // 无地面模型自动补地面（按设置与颜色）：SCNBox 薄板（水平天然正确）+ 无光照纯色
                if settings.groundEnabled {
                    let (gMin, gMax) = scene.rootNode.boundingBox
                    let gd = SIMD3(Float(gMax.x - gMin.x), Float(gMax.y - gMin.y), Float(gMax.z - gMin.z))
                    let gSize = max(gd.x, gd.z)
                    if gSize > 0 {
                        let ground = SCNBox(width: CGFloat(gSize * 4), height: 0.002, length: CGFloat(gSize * 4), chamferRadius: 0)
                        let mat = SCNMaterial()
                        mat.lightingModel = .constant
                        mat.diffuse.contents = Self.colorFromHex(settings.groundColorHex)
                        ground.materials = [mat]
                        let node = SCNNode(geometry: ground)
                        node.position = SCNVector3(0, Float(gMin.y) - 0.002, 0)
                        scene.rootNode.addChildNode(node)
                    }
                }
                v.scene = scene
                // 只绘制一帧（按需渲染模式）。注意：不要调用 v.prepare(scene)——
                // 它会同步编译全部着色器，大模型（数十万面）会阻塞主线程数秒，
                // 直接导致空格预览/选中预览打开变慢。
                v.display()
                self.hideLoadingIndicator()
                self.dbg("scene mounted: nodes=\(scene.rootNode.childNodes.count)")
            }
        } catch {
            dbg("scene load fail: \(error.localizedDescription)")
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.hideLoadingIndicator()
                guard self.scnView == nil else { return }
                self.replaceContent(with: self.infoView(title: "无法解析模型", detail: error.localizedDescription))
            }
        }
    }

    /// 程序化 equirectangular 环境贴图：让金属/PBR 材质有内容可反射（否则金属呈纯黑）
    static func applyStudioLighting(_ scene: SCNScene) {
        let w = 512, h = 256
        let img = NSImage(size: NSSize(width: w, height: h))
        img.lockFocusFlipped(false)
        let ctx = NSGraphicsContext.current!.cgContext
        // 上亮下暗的摄影棚渐变
        let colors = [CGColor(gray: 0.95, alpha: 1),
                      CGColor(gray: 0.55, alpha: 1),
                      CGColor(gray: 0.10, alpha: 1)] as CFArray
        let grad = CGGradient(colorsSpace: CGColorSpaceCreateDeviceGray(), colors: colors,
                              locations: [0, 0.5, 1])!
        ctx.drawLinearGradient(grad, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: CGFloat(h)), options: [])
        // 两块柔光板（模拟柔光箱高光）
        ctx.setFillColor(CGColor(gray: 1.0, alpha: 1))
        ctx.fillEllipse(in: CGRect(x: CGFloat(w) * 0.12, y: CGFloat(h) * 0.55, width: 90, height: 70))
        ctx.setFillColor(CGColor(gray: 0.85, alpha: 1))
        ctx.fillEllipse(in: CGRect(x: CGFloat(w) * 0.60, y: CGFloat(h) * 0.50, width: 110, height: 80))
        img.unlockFocus()

        scene.lightingEnvironment.contents = img
        scene.lightingEnvironment.intensity = 1.4
        // 补一盏主光增强形状感
        let key = SCNLight()
        key.type = .directional
        key.intensity = 650
        let keyNode = SCNNode()
        keyNode.light = key
        keyNode.eulerAngles = SCNVector3(-0.7, 0.5, 0)
        scene.rootNode.addChildNode(keyNode)
    }

    static func loadWithModelIO(_ url: URL) throws -> SCNScene {
        let asset = MDLAsset(url: url)
        asset.loadTextures()
        guard asset.count > 0 else {
            throw NSError(domain: "QL", code: 2, userInfo: [NSLocalizedDescriptionKey: "文件不包含几何数据"])
        }
        let scene = SCNScene()
        for obj in asset.childObjects(of: MDLObject.self) {
            scene.rootNode.addChildNode(MakeSCNNodeFromMDLObject(obj))
        }
        return scene
    }

    static func fitCamera(to scene: SCNScene, view: SCNView) {
        // 智能取景：以顶点数最多的 mesh（主体）为锚点，排除巨大地面/背景平面与远处离群件
        var infos: [(min: SIMD3<Float>, max: SIMD3<Float>, verts: Int)] = []
        scene.rootNode.enumerateHierarchy { node, _ in
            guard let g = node.geometry, let src = g.sources.first else { return }
            let b = node.boundingBox
            let wMin = node.convertPosition(b.min, to: nil)
            let wMax = node.convertPosition(b.max, to: nil)
            infos.append((min: SIMD3(Float(wMin.x), Float(wMin.y), Float(wMin.z)),
                          max: SIMD3(Float(wMax.x), Float(wMax.y), Float(wMax.z)),
                          verts: src.vectorCount))
        }
        guard !infos.isEmpty else { return }
        let anchor = infos.reduce(infos[0]) { $1.verts > $0.verts ? $1 : $0 }
        let ad = anchor.max - anchor.min
        let aMax = max(ad.x, ad.y, ad.z)
        let aCenter = (anchor.max + anchor.min) / 2
        let keep = infos.filter { b in
            let d = b.max - b.min
            let s = max(d.x, d.y, d.z)
            let c = (b.max + b.min) / 2
            return s <= aMax * 5 && simd_distance(c, aCenter) <= aMax * 5
        }
        let use = keep.isEmpty ? [anchor] : keep
        var lo = SIMD3(Float.greatestFiniteMagnitude, Float.greatestFiniteMagnitude, Float.greatestFiniteMagnitude)
        var hi = SIMD3(-Float.greatestFiniteMagnitude, -Float.greatestFiniteMagnitude, -Float.greatestFiniteMagnitude)
        for b in use {
            lo = simd_min(lo, b.min); hi = simd_max(hi, b.max)
        }
        let center = SCNVector3((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2)
        let d = hi - lo
        let radius = Float(max(max(d.x, d.y), d.z) / 2)
        guard radius > 0, radius.isFinite else { return }

        let cam = SCNCamera()
        cam.zNear = CGFloat(radius / 100)
        cam.zFar = CGFloat(radius * 40)
        cam.fieldOfView = 50
        let camNode = SCNNode()
        camNode.camera = cam
        let dist = radius * 3.1
        let dir = simd_normalize(SIMD3<Float>(1, 0.55, 1))
        camNode.simdPosition = SIMD3<Float>(Float(center.x), Float(center.y), Float(center.z)) + dir * dist
        camNode.look(at: center)
        scene.rootNode.addChildNode(camNode)
        view.pointOfView = camNode
    }

    // MARK: - 图片 / 信息视图

    private func imageView(_ image: NSImage, caption: String) -> NSView {
        let holder = NSView(frame: NSRect(x: 0, y: 0, width: 960, height: 640))
        let img = NSImageView(frame: NSRect(x: 0, y: 60, width: 960, height: 560))
        img.image = image
        img.imageScaling = .scaleProportionallyUpOrDown
        holder.addSubview(img)
        let label = NSTextField(labelWithString: caption)
        label.frame = NSRect(x: 0, y: 18, width: 960, height: 24)
        label.alignment = .center
        label.textColor = NSColor(white: 0.62, alpha: 1)
        label.font = NSFont.systemFont(ofSize: 13)
        holder.addSubview(label)
        return holder
    }

    private func infoView(title: String, detail: String) -> NSView {
        let holder = NSView(frame: NSRect(x: 0, y: 0, width: 960, height: 640))
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false

        let icon = NSTextField(labelWithString: "🧊")
        icon.font = NSFont.systemFont(ofSize: 52)
        let t = NSTextField(labelWithString: title)
        t.font = NSFont.boldSystemFont(ofSize: 17)
        t.textColor = NSColor(white: 0.9, alpha: 1)
        let d = NSTextField(wrappingLabelWithString: detail)
        d.alignment = .center
        d.textColor = NSColor(white: 0.62, alpha: 1)
        d.font = NSFont.systemFont(ofSize: 13)
        d.maximumNumberOfLines = 4

        stack.addArrangedSubview(icon)
        stack.addArrangedSubview(t)
        stack.addArrangedSubview(d)
        holder.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: holder.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: holder.centerYAnchor),
        ])
        return holder
    }
}


/// 简单的旋转加载指示器（纯 CoreAnimation，无额外依赖）
/// 注意：不要用 CATransform3DMakeRotation 旋转整个 layer —— 在有 perspective 的层里
/// 会表现为绕轴公转而非面内自转。这里改为旋转「描边起始角」，
/// 保证始终是面内旋转的圆弧进度。
final class LoadingSpinner: NSView {
    private let trackLayer = CAShapeLayer()
    private let headLayer = CAShapeLayer()
    private let headGradient = CAGradientLayer()
    private var timer: Timer?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        let r = min(frameRect.width, frameRect.height) / 2 - 3
        let path = NSBezierPath(ovalIn: NSRect(x: frameRect.midX - r, y: frameRect.midY - r, width: r * 2, height: r * 2))
        let cgPath = path.cgPath

        trackLayer.path = cgPath
        trackLayer.fillColor = NSColor.clear.cgColor
        trackLayer.strokeColor = NSColor.white.withAlphaComponent(0.14).cgColor
        trackLayer.lineWidth = 3
        trackLayer.lineCap = .round
        layer?.addSublayer(trackLayer)

        headLayer.path = cgPath
        headLayer.fillColor = NSColor.clear.cgColor
        headLayer.strokeColor = NSColor(red: 0.31, green: 0.49, blue: 1.0, alpha: 1).cgColor
        headLayer.lineWidth = 3
        headLayer.lineCap = .round
        headLayer.strokeStart = 0
        headLayer.strokeEnd = 0.25
        layer?.addSublayer(headLayer)

        startAnimating()
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        let r = min(bounds.width, bounds.height) / 2 - 3
        let path = NSBezierPath(ovalIn: NSRect(x: bounds.midX - r, y: bounds.midY - r, width: r * 2, height: r * 2))
        trackLayer.path = path.cgPath
        headLayer.path = path.cgPath
        trackLayer.frame = bounds
        headLayer.frame = bounds
    }

    private func startAnimating() {
        stopAnimating()
        // CADisplayLink 的 target/selector 初始化在 macOS 不可用，改用 Timer 驱动
        let t = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            self?.step()
        }
        t.tolerance = 0.005
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func stopAnimating() {
        timer?.invalidate()
        timer = nil
    }

    /// 圆弧「头部」沿圆周前进：起点增加、终点跟随 —— 视觉上是面内旋转的进度环
    private func step() {
        let span: CGFloat = 0.25
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        headLayer.strokeStart = headLayer.strokeStart + span
        if headLayer.strokeStart > 1 - span { headLayer.strokeStart = 0 }
        headLayer.strokeEnd = headLayer.strokeStart + span
        if headLayer.strokeEnd > 1 { headLayer.strokeEnd = 1 }
        CATransaction.commit()
    }

    deinit { stopAnimating() }
}
