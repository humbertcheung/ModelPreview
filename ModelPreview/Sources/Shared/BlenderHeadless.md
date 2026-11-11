# Blender 无头渲染（.blend 预览）

## 何时会被触发

只有打开 **`.blend` 文件**且**共享缓存未命中**时才会调用 Blender：

| 场景 | 是否调用 Blender |
|---|---|
| 打开 .blend（首次） | ✅ 调用（无头转换为 GLB） |
| 打开 .blend（已转换过，同一文件路径+大小+修改时间未变） | ❌ 直接读缓存，秒开 |
| 在 Quick Look 中空格预览 .blend（缓存命中） | ❌ 读缓存，3D 渲染 |
| 在 Quick Look 中空格预览 .blend（缓存未命中） | ❌ 不转换，显示内嵌缩略图或提示 |
| 打开 GLB/OBJ/FBX 等其他格式 | ❌ 完全不涉及 |

转换流程：`.blend` → Blender 无头模式 → `.glb` → 写入共享缓存 → 预览。

## 依赖条件

1. **必须安装 Blender**
   - 官方下载：https://www.blender.org/download/
   - 默认安装位置：`/Applications/Blender.app`
   - 应用会依次查找：`/Applications/Blender.app` → `~/Applications/Blender.app` → Spotlight 检索
     （`kMDItemCFBundleIdentifier == 'org.blenderfoundation.blender'`）
2. **未安装 Blender 时的行为**
   - 打开 .blend 时立即弹出提示：「未检测到 Blender」+ 安装指引（不会先等一次失败的转换）
   - 其他格式不受影响，可正常使用
3. **权限与沙盒**
   - 主应用为非沙盒应用，可直接启动 `/Applications/Blender.app/Contents/MacOS/Blender`
   - Quick Look 扩展运行在沙盒中，**不执行** Blender 转换，只读取主应用写好的缓存

## 缓存位置

```
~/Library/Containers/com.modelpreview.macos.QuickLook/Data/Library/Caches/blend2glb/<sha256>.glb
```

- 键 = SHA256(文件路径 | 文件大小 | 修改时间)
- 主应用与 Quick Look 扩展共用同一目录，因此「在主应用打开一次」后，空格预览即可直接 3D 渲染

## 转换参数

- `blender -b --factory-startup <文件路径> --python-expr <脚本>`
- 脚本先做**贴图重定位**：贴图相对路径断裂时，在 blend 同目录/上级目录/`textures/` 子目录中按文件名查找；
  仍找不到则用 `mdfind -name <文件名>` 全盘检索（覆盖 Spotlight 已索引的位置）
- 导出：`bpy.ops.export_scene.gltf(filepath=..., export_format='GLB', export_apply=True)`
  （`export_apply=True` 会应用修改器）

## 超时与失败处理

- 超时上限 **120 秒**，超时后 SIGTERM → 5 秒无响应则 SIGKILL
- 失败时弹出错误提示，并附带 Blender 输出的关键错误行（如 `File format is not supported`）
- 转换在后台线程进行，界面保持响应

## 已知限制

- Blender 5.x 某些版本保存的文件不含内嵌缩略图 → 首次空格预览会显示提示而非图像；
  在主应用打开一次即可获得 3D 预览
- 无 Blender 时无法预览 .blend 的 3D 内容（内嵌缩略图仍可显示）
