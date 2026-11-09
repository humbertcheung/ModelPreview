import Cocoa
import WebKit
import UniformTypeIdentifiers

/// WKWebView 子类：接管文件拖放，阻止 WebKit 直接导航到模型文件
final class WebViewDragHandler: WKWebView {
    var onDropFile: ((URL) -> Void)?

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) { fatalError("unsupported") }

    private func setHover(_ hovering: Bool) {
        evaluateJavaScript(
            "document.getElementById('drop-hint').classList.\(hovering ? "add" : "remove")('visible')",
            completionHandler: nil)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let hasFile = sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self],
                                                              options: [.urlReadingFileURLsOnly: true])
        if hasFile { setHover(true) }
        return hasFile ? .copy : []
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        return draggingEntered(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        setHover(false)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        setHover(false)
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                                               options: [.urlReadingFileURLsOnly: true]) as? [URL],
              let url = urls.first else { return false }
        onDropFile?(url)
        return true
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, NSToolbarDelegate, WKNavigationDelegate {

    static let supportedExts: Set<String> = ["glb", "gltf", "obj", "fbx", "stl", "ply", "dae", "3mf", "usdz", "blend"]

    private var window: NSWindow!
    private var webView: WebViewDragHandler!
    private var pendingURL: URL?
    private var pendingAppend = false
    private var themeButtonState = false { didSet { syncThemeButton() } }
    private var pageReady = false
    private var toolbarItems: [String: NSToolbarItem] = [:]

    // MARK: - 启动

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupAppMenu()
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        win.title = "3D 模型预览"
        win.minSize = NSSize(width: 880, height: 560)

        let toolbar = NSToolbar(identifier: "main-toolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        toolbar.allowsUserCustomization = false
        win.toolbar = toolbar
        win.toolbarStyle = .unified
        win.center()

        let config = WKWebViewConfiguration()
        // 非持久化存储：viewer JS/CSS 永远加载最新版本（模型缓存在文件系统自行管理）
        config.websiteDataStore = WKWebsiteDataStore.nonPersistent()
        config.userContentController.add(self, name: "host")
        let viewerDir = Bundle.main.resourceURL!.appendingPathComponent("Viewer", isDirectory: true)
        ViewerSchemeHandler.register(into: config, viewerResourceDir: viewerDir)
        webView = WebViewDragHandler(frame: NSRect(x: 0, y: 0, width: 1280, height: 780), configuration: config)
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.onDropFile = { [weak self] url in self?.openModel(url) }
        win.contentView = webView

        webView.load(URLRequest(url: ViewerSchemeHandler.pageURL))

        window = win
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        NSLog("[MP] open event: \(urls.map(\.path))")
        for url in urls { openModel(url) }
    }

    /// 标准应用菜单：⌘Q 退出 + 编辑菜单（WKWebView 的复制/粘贴依赖它）
    private func setupAppMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(NSMenuItem(title: "关于 3D模型预览", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        appMenu.addItem(.separator())
        appMenu.addItem(NSMenuItem(title: "退出 3D模型预览", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "文件")
        fileMenu.addItem(NSMenuItem(title: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        fileItem.submenu = fileMenu
        main.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(NSMenuItem(title: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        editMenu.addItem(NSMenuItem(title: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        editMenu.addItem(NSMenuItem(title: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        editMenu.addItem(NSMenuItem(title: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        editItem.submenu = editMenu
        main.addItem(editItem)

        NSApplication.shared.mainMenu = main
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: - 模型装载

    private func openModel(_ url: URL, append: Bool = false) {
        pendingAppend = append
        guard pageReady else { pendingURL = url; return } // 页面未就绪，暂存
        let ext = url.pathExtension.lowercased()
        guard Self.supportedExts.contains(ext) else {
            sendCmd(["op": "error", "title": "不支持的格式",
                     "detail": "暂不支持 .\(ext) 文件。\n支持：GLB / GLTF / OBJ / FBX / STL / PLY / DAE / 3MF / BLEND"])
            return
        }
        if ext == "blend" {
            openBlend(url)
        } else {
            sendCmd(["op": "open-url",
                     "url": ViewerSchemeHandler.filesURL(for: url).absoluteString,
                     "name": url.lastPathComponent, "ext": ext,
                     "size": fileSize(url), "append": pendingAppend])
        }
    }

    private func openBlend(_ url: URL) {
        if let cached = BlendPipeline.cachedGLB(for: url) {
            openGLBAsBlend(cached, original: url)
            return
        }
        sendCmd(["op": "loading", "text": "正在通过 Blender 转换模型…"])
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let glb = try BlendPipeline.convert(blendURL: url)
                DispatchQueue.main.async { self.openGLBAsBlend(glb, original: url) }
            } catch {
                DispatchQueue.main.async {
                    self.sendCmd(["op": "error", "title": "无法预览 .blend 文件",
                                  "detail": BlendPipeline.describe(error: error)])
                }
            }
        }
    }

    private func openGLBAsBlend(_ glb: URL, original: URL) {
        sendCmd(["op": "open-url",
                 "url": ViewerSchemeHandler.filesURL(for: glb).absoluteString,
                 "name": original.lastPathComponent, "ext": "glb", "displayExt": "BLEND",
                 "size": fileSize(original),
                 "note": "由 Blender 无头转换生成"])
    }

    private func fileSize(_ url: URL) -> Int64 {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.size] as? NSNumber)?.int64Value ?? 0
    }

    // MARK: - JS 桥

    private func sendCmd(_ dict: [String: Any?]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict.mapValues { $0 ?? NSNull() })
        else { return }
        let b64 = data.base64EncodedString()
        let script = "window.viewer && window.viewer.cmdB64('\(b64)')"
        let run: (String) -> Void = { js in
            self.webView.evaluateJavaScript(js) { _, error in
                if let error { NSLog("[MP] JS eval error: \(error.localizedDescription)") }
            }
        }
        if Thread.isMainThread {
            run(script)
        } else {
            DispatchQueue.main.async { run(script) }
        }
    }

    private func appendMsgLog(_ s: String) {
        let path = "/tmp/mp-messages.log"
        let line = "\(Date().timeIntervalSince1970) \(s)\n"
        if let fh = FileHandle(forWritingAtPath: path) { fh.seekToEndOfFile(); fh.write(line.data(using: .utf8)!); fh.closeFile() }
        else { try? line.write(toFile: path, atomically: true, encoding: .utf8) }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        appendMsgLog("MSG: \(String(describing: message.body).prefix(400))")
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            pageReady = true
            // 恢复空格预览设置到设置面板
            let settingsPath = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Containers/com.modelpreview.macos.QuickLook/Data/Library/Caches/ql-settings.json")
            if let data = FileManager.default.contents(atPath: settingsPath.path),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                    guard let data2 = try? JSONSerialization.data(withJSONObject: json) else { return }
                    let b64 = data2.base64EncodedString()
                    self?.webView.evaluateJavaScript("window.viewer && window.viewer.applyQlSettingsB64 && window.viewer.applyQlSettingsB64('\(b64)')", completionHandler: nil)
                }
            }
            if let pending = pendingURL { pendingURL = nil; openModel(pending) }
        case "screenshot":
            saveScreenshot(name: body["name"] as? String ?? "model.png",
                           dataURL: body["data"] as? String ?? "")
        case "export-glb":
            saveExportGLB(name: body["name"] as? String ?? "model-export.glb",
                          dataURL: body["data"] as? String ?? "")
        case "export-views":
            saveAllViews(name: body["name"] as? String ?? "model",
                         images: body["images"] as? [[String: Any]] ?? [])
        case "open-panel":
            pickFile(append: body["append"] as? Bool ?? false)
        case "theme":
            themeButtonState = (body["theme"] as? String) == "light"
        case "save-settings":
            if let settings = body["settings"] as? [String: Any],
               let data = try? JSONSerialization.data(withJSONObject: settings) {
                let dir = FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent("Library/Containers/com.modelpreview.macos.QuickLook/Data/Library/Caches", isDirectory: true)
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                try? data.write(to: dir.appendingPathComponent("ql-settings.json"))
            }
        case "debug-info":
            let meshes = body["meshes"] as? [[String: Any]] ?? []
            appendMsgLog("DBG smartSize=\(body["smartSize"] as? String ?? "?")")
            for m in meshes {
                appendMsgLog("DBG \(m["name"] as? String ?? "?") verts=\(m["verts"] ?? 0) maxDim=\(m["maxDim"] ?? "?") c=(\(m["cx"] ?? "?"),\(m["cy"] ?? "?"),\(m["cz"] ?? "?"))")
            }
            if let sh = body["shadow"] as? [String: Any] {
                appendMsgLog("SHADOW \(sh)")
            }
        default:
            break
        }
    }

    private func saveExportGLB(name: String, dataURL: String) {
        guard let b64 = dataURL.components(separatedBy: ",").last,
              let data = Data(base64Encoded: b64) else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "glb") ?? .data]
        panel.nameFieldStringValue = name
        panel.beginSheetModal(for: window) { resp in
            if resp == .OK, let url = panel.url {
                do { try data.write(to: url); NSWorkspace.shared.activateFileViewerSelecting([url]) }
                catch { NSAlert(error: error).runModal() }
            }
        }
    }

    /// 一键导出全部视角 PNG：让用户选择文件夹，写入 7 张图后直接在访达中显示
    private func saveAllViews(name: String, images: [[String: Any]]) {
        guard !images.isEmpty else { return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "导出到此处"
        panel.message = "选择用于保存 \(images.count) 张视角图的文件夹"
        panel.beginSheetModal(for: window) { [weak self] resp in
            guard let self, resp == .OK, let dir = panel.url else { return }
            var written: [URL] = []
            for img in images {
                let fileName = (img["name"] as? String) ?? "\(name).png"
                let dataURL = (img["data"] as? String) ?? ""
                guard let b64 = dataURL.components(separatedBy: ",").last,
                      let data = Data(base64Encoded: b64) else { continue }
                let dest = dir.appendingPathComponent(fileName)
                do {
                    try data.write(to: dest)
                    written.append(dest)
                } catch {
                    NSAlert(error: error).runModal()
                }
            }
            if !written.isEmpty {
                NSWorkspace.shared.activateFileViewerSelecting(written)
                self.appendMsgLog("EXPORT-VIEWS wrote \(written.count) files to \(dir.path)")
            }
        }
    }

    private func saveScreenshot(name: String, dataURL: String) {        guard let b64 = dataURL.components(separatedBy: ",").last,
              let data = Data(base64Encoded: b64) else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        panel.nameFieldStringValue = name
        panel.beginSheetModal(for: window) { resp in
            if resp == .OK, let url = panel.url {
                do { try data.write(to: url); NSWorkspace.shared.activateFileViewerSelecting([url]) }
                catch { NSAlert(error: error).runModal() }
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("typeof window.viewer") { result, _ in
            NSLog("[MP] page loaded, window.viewer = \(result ?? "nil")")
        }
    }

    // MARK: - 工具栏

    private enum ItemID {
        static let open = "open"
        static let theme = "theme"
        static let reset = "reset"
        static let wireframe = "wireframe"
        static let grid = "grid"
        static let autorotate = "autorotate"
        static let screenshot = "screenshot"
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace,
         .init(ItemID.open), .init(ItemID.theme), .space,
         .init(ItemID.reset), .init(ItemID.wireframe), .init(ItemID.grid), .init(ItemID.autorotate),
         .space,
         .init(ItemID.screenshot),
         .flexibleSpace]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    private func symbolOrFallback(_ name: String, fallback: String) -> NSImage {
        NSImage(systemSymbolName: name, accessibilityDescription: nil)
            ?? NSImage(systemSymbolName: fallback, accessibilityDescription: nil)
            ?? NSImage()
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = NSToolbarItem(itemIdentifier: itemIdentifier)
        let id = itemIdentifier.rawValue
        switch id {
        case ItemID.open:
            item.label = "打开模型"
            item.toolTip = "打开模型文件（本地解析，不上传）"
            item.image = symbolOrFallback("folder", fallback: "doc")
            item.action = #selector(pickFile(_:))
        case ItemID.theme:
            item.label = "外观"
            item.toolTip = "切换浅色 / 深色模式"
            item.image = symbolOrFallback("circle.lefthalf.filled", fallback: "circle.righthalf.filled")
            item.action = #selector(toggleTheme(_:))
        case ItemID.reset:
            item.label = "重置视角"
            item.toolTip = "重置视角（相机自动归位）"
            item.image = symbolOrFallback("arrow.counterclockwise", fallback: "arrow.left")
            item.action = #selector(resetView(_:))
        case ItemID.wireframe:
            item.label = "线框"
            item.toolTip = "线框模式：以线框显示模型"
            item.image = symbolOrFallback("square.on.square.dashed", fallback: "square.dashed")
            item.action = #selector(toggleWireframe(_:))
        case ItemID.grid:
            item.label = "地面网格"
            item.toolTip = "显示 / 隐藏地面网格"
            item.image = symbolOrFallback("grid", fallback: "circle.grid.3x3")
            item.action = #selector(toggleGrid(_:))
        case ItemID.autorotate:
            item.label = "自动旋转"
            item.toolTip = "自动转盘旋转（鼠标交互时暂停）"
            item.image = symbolOrFallback("rotate.3d", fallback: "arrow.triangle.2.circlepath")
            item.action = #selector(toggleAutoRotate(_:))
        case ItemID.screenshot:
            item.label = "截图"
            item.toolTip = "导出相机视角高分辨率 PNG（自动隐藏网格）"
            item.image = symbolOrFallback("camera", fallback: "photo")
            item.action = #selector(takeScreenshot(_:))
        default:
            return nil
        }
        toolbarItems[id] = item
        return item
    }

    // MARK: - 工具栏动作

    func pickFile(append: Bool = false) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.message = append ? "选择要合并加载的模型文件" : "选择 3D 模型文件"
        panel.allowedContentTypes = Self.supportedExts.compactMap { try? UTType(filenameExtension: $0) }
        panel.message = "选择 3D 模型文件"
        panel.beginSheetModal(for: window) { [weak self] resp in
            guard resp == .OK, let url = panel.url else { return }
            self?.openModel(url, append: append)
        }
    }
    @objc private func pickFile(_ sender: Any?) { pickFile(append: false) }

    @objc private func resetView(_ sender: Any?) { sendCmd(["op": "reset-view"]) }
    @objc private func toggleTheme(_ sender: Any?) {
        themeButtonState.toggle()
        sendCmd(["op": "set-theme", "theme": themeButtonState ? "light" : "dark"])
    }
    private func syncThemeButton() {
        toolbarItems[ItemID.theme]?.image = symbolOrFallback(
            themeButtonState ? "sun.max" : "moon", fallback: "circle.lefthalf.filled")
    }

    @objc private func toggleWireframe(_ sender: Any?) { sendCmd(["op": "toggle", "key": "wireframe"]) }
    @objc private func toggleGrid(_ sender: Any?) { sendCmd(["op": "toggle", "key": "grid"]) }
    @objc private func toggleAutoRotate(_ sender: Any?) { sendCmd(["op": "toggle", "key": "autorotate"]) }
    @objc private func takeScreenshot(_ sender: Any?) { sendCmd(["op": "screenshot"]) }
}
