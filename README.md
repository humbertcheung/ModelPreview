# 3D模型预览（macOS）

本地、免费、无订阅的 3D 模型预览应用，作为 Eyemesh 的替代品。包含两部分：

1. **主应用** —— 完整 3D 交互预览（three.js + WKWebView 渲染）
2. **Quick Look 扩展** —— Finder 中**选中预览**（预览面板）与**空格键预览**

## 功能总览

### 文件加载（100% 本地解析，不上传）
- 拖拽导入 / 文件选择 / Finder 打开方式；**合并加载**（多模型同场景）与**场景重置**
- GLB / glTF 2.0（含 Draco）、OBJ+MTL、STL、PLY（顶点色）、FBX（含动画）、DAE、3MF、USDZ、BLEND（经 Blender 转换）
- 加载进度条、超大文件警告（>200MB）、贴图/资源缺失提示、异常错误面板
- 自动居中、包围盒适配、相机自动归位

### 相机与视图
- 轨道控制（左键旋转/右键平移/滚轮缩放）、**透视/正交一键切换**
- **六视图预设**（前/后/左/右/顶/底，自动切正交）、**ViewHelper 方位 Gizmo**（点击切换视图）
- **视角快照**（命名保存、localStorage 持久化、一键恢复/删除）
- 自动转盘（鼠标交互时自动暂停，空闲 2 秒恢复）、一键重置视角

### 渲染模式与显示
- 着色（PBR）/ **法线模式** / 线框 / **X 光半透明** / **边界边**叠加
- 地面网格、**坐标轴**、**地面阴影**开关
- 背景：主题跟随 / **渐变** / 纯色 6 色 / **透明**
- 后处理滑块：**曝光**、**环境强度**

### 动画播放（GLB/FBX）
- 播放/暂停、**进度条拖动**、速度 0.25~2x、循环开关、多 Clip 下拉切换、时间显示

### 结构树与对象操作
- **场景层级树**（展开折叠、Mesh/Group 图标）
- **点击拾取**（视口点选部件，树中同步高亮）、**高亮显示**（emissive）
- 单显/隐（眼睛按钮）、多选（⌘点击）、配合隔离查看

### 导出
- **高清截图**：相机视角 3 倍分辨率 PNG，自动隐藏网格，**可选透明背景**
- **导出 GLB**：当前场景导出为 glTF-Binary（多模型自动分组合并）

### 界面
- **浅色 / 深色模式**一键切换（全组件 CSS 变量主题适配）
- 原生工具栏 tooltip 提示、本地隐私声明
- Quick Look 窄面板自动精简（隐藏面板只留视口）

## 支持的格式

| 格式 | 主应用 | 空格预览 | 说明 |
|------|--------|----------|------|
| GLB / GLTF | ✅ 完整（含 Draco、贴图、动画） | ✅ SceneKit 渲染 | glTF 2.0 |
| OBJ (+MTL) | ✅ 完整（含材质/贴图） | ✅ ModelIO | |
| STL | ✅ | ✅ ModelIO | ASCII / 二进制 |
| PLY | ✅（含顶点色） | ✅ ModelIO | |
| DAE (Collada) | ✅ | ✅ SceneKit | |
| FBX | ✅（含动画） | ℹ️ 提示信息 | |
| 3MF | ✅ | ℹ️ 提示信息 | |
| **BLEND** | ✅ **Blender 无头转换** | ✅ 内嵌缩略图 | 见下文 |

### .blend 文件的预览机制

- **主应用**：自动调用本机安装的 Blender（`/Applications/Blender.app`）无头转换为 GLB 后渲染，
  支持修改器（`export_apply`）、内嵌贴图；结果缓存到
  `~/Library/Containers/com.modelpreview.macos.QuickLook/Data/Library/Caches/blend2glb/`
  （按 路径+大小+修改时间 做键）—— 该目录与 Quick Look 扩展共享，**同一文件二次打开秒开**。
- **空格预览（三级策略）**：
  1. 共享缓存命中（该文件曾在主应用中打开过）→ **直接 3D 渲染**，可拖动旋转；
  2. 未命中但文件有内嵌缩略图 → 显示缩略图（支持旧格式 ≤4.x 与 5.x "BLENDER17" 新格式，含 zstd 多 frame 解压）；
  3. 都没有 → 提示"在主应用中打开一次即可获得 3D 空格预览"。
  ⚠️ 实测 Blender 5.2 保存的部分文件未内嵌缩略图数据（如 `kart-commercial.blend`），
  此类文件请先在主应用中打开一次。

## 构建

```bash
./build.sh
```

产物：`build/3D模型预览.app`（含 `Contents/PlugIns/QuickLookPreview.appex`）。
脚本会自动 ad-hoc 签名并注册到 Launch Services / pluginkit。

依赖：Xcode 命令行工具（swiftc）。three.js 已本地化在 `ModelPreview/Viewer/lib/`，无需网络。
（本项目曾用 `proxy`/`unproxy` 代理命令下载 zstd 与 three.js 源码，日常构建无需网络。）

## 使用

- **打开**：Finder 双击 / 右键“打开方式 → 3D模型预览”；或应用内工具栏“打开”；或拖文件进窗口
- **空格预览**：Finder 选中文件按空格
- **交互**：拖动旋转 / 滚轮缩放 / 右键平移；工具栏：重置视角、线框、地面网格、自动旋转、截图（PNG）
- 右侧信息面板：顶点/三角面/网格/材质数、包围盒尺寸、动画列表（可点击切换）

## Quick Look 相关

- 扩展 ID：`com.modelpreview.macos.QuickLook`
- 若与 Eyemesh 冲突（其未订阅时抢注 GLB 预览并显示错误页），已通过以下方式处理：
  ```bash
  pluginkit -e ignore -i com.prestapps.Eyemesh.EyemeshQuick2   # 恢复用: -e use
  pluginkit -e use   -i com.modelpreview.macos.QuickLook
  ```
- 重新构建后如预览不生效：`pluginkit -a build/3D模型预览.app/Contents/PlugIns/QuickLookPreview.appex`
  并 `pkill -f quicklookd`

## 项目结构

```
ModelPreview/
  Sources/
    App/          主应用（AppDelegate.swift, main.swift）
    QuickLook/    QL 扩展（SceneKit 渲染）
    Shared/
      BlendPipeline.swift     Blender 无头转换 + 缓存
      BlendThumbnail.swift    .blend SDNA 解析提取内嵌缩略图（含 zstd）
      GLTFSceneLoader.swift   自研 glTF→SceneKit 加载器
      ViewerSchemeHandler.swift  viewer:// 自定义协议（绕开 file:// 限制）
      MDLBridge.h             SceneKit↔ModelIO ObjC 桥接 + zstd 原型
      zstd/                   zstd 解压源码（Facebook/zstd 1.5.6 子集）
  Viewer/         three.js 前端（index.html, viewer.js, lib/）
  Resources/      Info.plist ×2、appex entitlements
samples/          各格式测试样本（含脚本生成的 GLB/STL/PLY/OBJ/DAE 与 Blender 生成的 .blend）
tools/            gen_samples.py（测试模型生成）、gen_icon.py（应用图标）
build.sh          一键构建脚本
```

## 技术说明

- 主应用 WKWebView 通过自定义 `viewer://` 协议加载页面与模型，绕开 WebKit 对 file:// 的
  ES 模块与 fetch 限制（页面内含 fetch→XHR polyfill）
- QL 扩展采用 SceneKit 原生渲染（与 Eyemesh 相同技术路线），沙盒化运行；
  WKWebView 在 QL 沙盒扩展中无法启动 WebContent 进程，故不可用于 QL
- .blend 缩略图解析为自研 SDNA 解析器，兼容 Blender 2.8x–5.x 的字段布局变化
