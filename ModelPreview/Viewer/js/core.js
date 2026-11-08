import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/** 主题对应的默认场景背景色 */
export const THEME_BG = { dark: 0x17191d, light: 0xe9ecf1 };
const GRADIENT_STOPS = { dark: [0x232833, 0x101217], light: [0xffffff, 0xdfe4ec], sky: [0x9ec8f5, 0xe8f2fb] };

export class SceneCore {
  constructor(container) {
    this.container = container;
    this.theme = 'dark';
    this.bgMode = 'theme';       // theme | color | gradient | transparent
    this.bgColorKey = 'dark';
    this.shading = 'shaded';     // shaded | normal | wire | xray
    this.models = [];            // { id, root, name }

    this.initRenderer();
    this.initScene();
    this.initCameras();
    this.applyBackground('theme', 'dark');
  }

  initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(this.container.clientWidth || 800, this.container.clientHeight || 600);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    // WebKit 实测：autoClear=false（手动 clear）会破坏 shadow map pass，保持默认 true
    this.renderer.shadowMap.enabled = true;      // 常开：材质首次编译即含阴影支持
    // WebKit(WKWebView) 实测：PCFSoftShadowMap 不渲染阴影，PCFShadowMap 正常（Chrome 两者均正常）
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.container.prepend(this.renderer.domElement);
  }

  initScene() {
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    // 环境给模型提供反射；地面的阴影对比由地面材质单独压低 envMapIntensity 保证
    // （二分实验：scene.environment 全量作用地面时，白地面被环境照亮到接近满白，阴影对比 <8% 不可见）
    this.scene.environmentIntensity = 0.45;
    pmrem.dispose();

    // 强度 3.0：环境光贡献压到 0.2 后主光取 3 保证模型亮度与阴影对比
    // （二分实验证实：toneMapping+env 下 1.1 的直射光阴影对比 <10%，视觉不可见）
    this.keyLight = new THREE.DirectionalLight(0xffffff, 3.0);
    this.keyLight.position.set(4, 8, 5);
    this.keyLight.castShadow = true; // 常开：开关只切换接收面显示，避免材质重编译闪烁
    this.keyLight.shadow.bias = -0.0005;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target); // 关键：target 必须在场景中，阴影相机方向才正确

    this.grid = null;
    this.axes = null;
    this.gridVisible = true;
    this.axesVisible = false;
    this.shadowVisible = false;
    this.groundMode = 'auto';
    this.groundColor = 0xf2f3f5;
  }

  initCameras() {
    const w = this.container.clientWidth || 800, h = this.container.clientHeight || 600;
    this.persp = new THREE.PerspectiveCamera(50, w / h, 0.01, 2000);
    this.persp.position.set(3, 2, 4);
    const frustum = this.orthoFrustumHeight(this.persp);
    this.ortho = new THREE.OrthographicCamera(-frustum * w / h / 2, frustum * w / h / 2, frustum / 2, -frustum / 2, -2000, 2000);
    this.ortho.position.copy(this.persp.position);
    this.active = this.persp;
    this.camKind = 'persp';

    this.controls = new OrbitControls(this.active, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 2.2;
    // 自动转盘：用户交互时暂停，空闲 2 秒后恢复
    this.controls.addEventListener('start', () => { this.userInteracting = true; });
    this.controls.addEventListener('end', () => {
      this.userInteracting = false;
      if (this.turntableWanted) {
        clearTimeout(this._resumeTimer);
        this._resumeTimer = setTimeout(() => { this.controls.autoRotate = this.turntableWanted && !this.userInteracting; }, 2000);
      }
    });
  }

  orthoFrustumHeight(cam) {
    const dist = cam ? cam.position.distanceTo(this.controls?.target ?? new THREE.Vector3()) : 5;
    return 2 * Math.tan((cam.fov * Math.PI / 180) / 2) * Math.max(dist, 0.001);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    const fh = this.orthoFrustumHeight(this.persp);
    this.ortho.left = -fh * w / h / 2; this.ortho.right = fh * w / h / 2;
    this.ortho.top = fh / 2; this.ortho.bottom = -fh / 2;
    this.ortho.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /* ---------- 相机 ---------- */

  setCameraKind(kind) {
    if (kind === this.camKind) return this.camKind;
    const src = this.active;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (kind === 'ortho') {
      const fh = this.orthoFrustumHeight(this.persp);
      this.ortho.left = -fh * w / h / 2; this.ortho.right = fh * w / h / 2;
      this.ortho.top = fh / 2; this.ortho.bottom = -fh / 2;
      this.ortho.position.copy(src.position);
      this.ortho.zoom = 1;
      this.ortho.updateProjectionMatrix();
      this.active = this.ortho;
    } else {
      this.persp.position.copy(src.position);
      this.active = this.persp;
    }
    this.camKind = kind;
    this.controls.object = this.active;
    this.controls.update();
    return kind;
  }

  /** 六视图预设（正交投影下最直观） */
  setPresetView(name) {
    if (!this.models.length) return;
    const box = this.smartBoundingBox();
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) || 1;
    const dist = (radius / 2) / Math.tan((50 * Math.PI / 180) / 2) * 1.4;

    const dirs = {
      front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0],
      right: [1, 0, 0], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001],
    };
    const d = new THREE.Vector3(...(dirs[name] || [0, 0, 1])).normalize();
    // 记录当前 up 以保持顶/底视图稳定
    const wasKind = this.camKind;
    if (wasKind !== 'ortho') this.setCameraKind('ortho');
    this.active.position.copy(center).addScaledVector(d, dist);
    this.controls.target.copy(center);
    this.active.up.set(0, 1, 0);
    if (name === 'top') this.active.up.set(0, 0, -1);
    if (name === 'bottom') this.active.up.set(0, 0, 1);
    this.active.lookAt(center);
    this.controls.update();
    this._lastPreset = name;
  }

  resetView() {
    const box = this.smartBoundingBox();
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = (maxDim / 2) / Math.tan((50 * Math.PI / 180) / 2) * 1.35;
    this.active.up.set(0, 1, 0);
    this.active.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.55, 1).normalize(), dist);
    this.controls.target.copy(center);
    if (this.camKind === 'ortho') this.setCameraKind('persp');
    this.controls.update();
    this.fitShadowCamera(box); // 阴影视锥必须随模型适配，否则大模型永远在 ±5 默认视锥外 → 无投影
  }

  /** 让平行光与阴影相机包裹整个模型：光源在模型斜上方，正交阴影范围 = 模型半径 */
  fitShadowCamera(box) {
    const light = this.keyLight;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.62, 1); // 包围球半径（略余量）
    const dir = new THREE.Vector3(0.5, 1.15, 0.65).normalize(); // 固定采光方向：右上前
    light.position.copy(center).addScaledVector(dir, radius * 2.2);
    light.target.position.copy(center);
    light.target.updateMatrixWorld();
    const cam = light.shadow.camera;
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = 0.1; cam.far = radius * 5;
    cam.updateProjectionMatrix();
    if (light.shadow.mapSize.width < 2048) light.shadow.mapSize.set(2048, 2048);
    if (light.shadow.map) { light.shadow.map.dispose(); light.shadow.map = null; } // 强制下一帧重建阴影贴图
    light.shadow.bias = -0.0005;
  }

  /** 视角快照 */
  snapshot() {
    return {
      kind: this.camKind,
      pos: this.active.position.toArray(),
      target: this.controls.target.toArray(),
      up: this.active.up.toArray(),
      zoom: this.camKind === 'ortho' ? this.ortho.zoom : 1,
      time: Date.now(),
    };
  }
  restoreSnapshot(s) {
    this.setCameraKind(s.kind || 'persp');
    this.active.position.fromArray(s.pos);
    this.controls.target.fromArray(s.target);
    this.active.up.fromArray(s.up || [0, 1, 0]);
    if (s.kind === 'ortho') { this.ortho.zoom = s.zoom || 1; this.ortho.updateProjectionMatrix(); }
    this.controls.update();
  }

  /* ---------- 背景 / 环境 ---------- */

  makeGradientTexture(topHex, bottomHex) {
    const c = document.createElement('canvas');
    c.width = 2; c.height = 512;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, topHex); grad.addColorStop(1, bottomHex);
    g.fillStyle = grad; g.fillRect(0, 0, 2, 512);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
  }

  /** bgMode: theme | color | gradient | transparent；colorKey: dark/light/studio/sky/white/black */
  applyBackground(bgMode, colorKey) {
    this.bgMode = bgMode;
    this.bgColorKey = colorKey ?? this.bgColorKey;
    const hex = { dark: 0x17191d, light: 0xe9ecf1, studio: 0x222529, sky: 0xbcd8f5, white: 0xffffff, black: 0x000000 };
    if (bgMode === 'transparent') {
      this.scene.background = null;
    } else if (bgMode === 'gradient') {
      const stops = GRADIENT_STOPS[this.bgColorKey] ?? GRADIENT_STOPS.dark;
      const top = '#' + stops[0].toString(16).padStart(6, '0');
      const bot = '#' + stops[1].toString(16).padStart(6, '0');
      this.scene.background = this.makeGradientTexture(top, bot);
    } else if (bgMode === 'theme') {
      this.scene.background = new THREE.Color(THEME_BG[this.theme]);
    } else {
      this.scene.background = new THREE.Color(hex[this.bgColorKey] ?? 0x17191d);
    }
    this.container.style.background = bgMode === 'transparent' ? 'transparent' : '#' + (typeof this.scene.background === 'number' || this.scene.background?.isColor ? this.scene.background.getHexString?.() ?? '17191d' : '17191d');
    if (bgMode === 'gradient') this.container.style.background = '';
  }

  setTheme(theme) {
    this.theme = theme;
    if (this.bgMode === 'theme') this.applyBackground('theme', theme);
    if (this.grid) this.recolorGrid();
  }

  /* ---------- 网格 / 坐标轴 / 阴影 ---------- */

  /** 可拾取 mesh 列表缓存（模型增删/显隐后由 refreshPickables 重建） */
  refreshPickables() {
    this.pickables = [];
    for (const m of this.models) {
      m.root.traverse(o => { if (o.isMesh && o.visible) this.pickables.push(o); });
    }
  }

  /** 智能包围盒：以顶点数最多的 mesh（主体）为锚点，排除巨大地面/背景平面与远处离群件 */
  smartBoundingBox() {
    const meshes = [];
    for (const m of this.models) {
      m.root.traverse(o => {
        if (o.isMesh && o.geometry?.attributes?.position) {
          o.geometry.computeBoundingBox();
          const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
          meshes.push({ box: b, verts: o.geometry.attributes.position.count });
        }
      });
    }
    if (!meshes.length) return null;
    const anchor = meshes.reduce((a, b) => b.verts > a.verts ? b : a);
    const asize = anchor.box.getSize(new THREE.Vector3());
    const aMax = Math.max(asize.x, asize.y, asize.z) || 1;
    const aCenter = anchor.box.getCenter(new THREE.Vector3());
    const keep = meshes.filter(m => {
      const s = Math.max(...m.box.getSize(new THREE.Vector3()).toArray());
      const c = m.box.getCenter(new THREE.Vector3());
      return s <= aMax * 5 && c.distanceTo(aCenter) <= aMax * 5;
    });
    const out = new THREE.Box3();
    for (const m of keep) out.union(m.box);
    return out;
  }

  currentMaxDim() {
    const box = this.smartBoundingBox();
    if (!box || box.isEmpty()) return 1;
    return Math.max(box.getSize(new THREE.Vector3()).x, box.getSize(new THREE.Vector3()).y, box.getSize(new THREE.Vector3()).z) || 1;
  }

  ensureGrid() {
    if (this.grid) return;
    const size = this.currentMaxDim() * 4;
    this.grid = new THREE.GridHelper(size, 40, 0x3a3f4a, 0x23262c);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.grid.visible = this.gridVisible;
    this.scene.add(this.grid);
    this.recolorGrid();
    this.syncGridHeight();
  }

  /** 网格线高度跟随地面板：地面板显示时网格浮于其上，避免 z-fighting 闪烁 */
  syncGridHeight() {
    if (!this.grid) return;
    const groundShowing = this.generatedGround && this.generatedGround.visible;
    const box = this.smartBoundingBox();
    if (groundShowing && box && !box.isEmpty()) {
      this.grid.position.y = box.min.y - this.currentMaxDim() * 0.001 + this.currentMaxDim() * 0.004;
    } else {
      this.grid.position.y = 0;
    }
  }
  recolorGrid() {
    if (!this.grid) return;
    const light = this.theme === 'light';
    this.grid.material.color.set(light ? 0xb9c0cc : 0x3a3f4a);
  }
  setGridVisible(v) {
    this.gridVisible = v;
    if (this.models.length) this.ensureGrid();
    if (this.grid) this.grid.visible = v;
  }
  /** 检测模型自带的地面：水平扁平且较大的平面 */
  detectModelGround() {
    const mainBox = this.smartBoundingBox();
    if (!mainBox || mainBox.isEmpty()) return null;
    const mainSize = mainBox.getSize(new THREE.Vector3());
    const mainMax = Math.max(mainSize.x, mainSize.y, mainSize.z) || 1;
    let found = null;
    for (const m of this.models) {
      m.root.traverse(o => {
        if (!o.isMesh || !o.geometry?.attributes?.position || found) return;
        o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        const s = b.getSize(new THREE.Vector3());
        if (s.y <= mainMax * 0.04 && Math.min(s.x, s.z) >= mainMax * 0.4) found = o;
      });
    }
    return found;
  }

  /** 地面系统：groundMode 'auto'（模型自带优先）/ 'generated'（用户选色后使用系统地面板）。
   *  面积与网格一致（智能尺寸 × 4），位置在模型底部，轻微下沉避免 z-fighting。 */
  setGroundVisible(v) {
    this.groundVisible = v;
    const modelGround = this.groundMode === 'generated' ? null : this.detectModelGround();
    if (modelGround) {
      modelGround.visible = v;
      if (this.generatedGround) this.generatedGround.visible = false;
      return;
    }
    if (v) {
      this.ensureGroundGenerated();
      this.generatedGround.visible = true;
      this.placeGround();
      this.syncGridHeight(); // 网格线浮于地面板上方，共存不闪
    } else {
      if (this.generatedGround) this.generatedGround.visible = false;
      this.syncGridHeight();
    }
  }

  ensureGroundGenerated() {
    if (this.generatedGround) return;
    this.generatedGround = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      // envMapIntensity 0.12：地面几乎只吃主光，阴影处不被环境填亮，投影对比清晰且不死黑
      new THREE.MeshStandardMaterial({ color: this.groundColor, roughness: 0.95, metalness: 0, envMapIntensity: 0.12 })
    );
    this.generatedGround.rotation.x = -Math.PI / 2;
    this.generatedGround.receiveShadow = true;
    this.scene.add(this.generatedGround);
    this.placeGround(); // 首次创建即定位（面积与网格一致）
  }

  placeGround() {
    if (!this.generatedGround) return;
    const box = this.smartBoundingBox();
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const gridSize = maxDim * 4; // 与网格面积一致
    this.generatedGround.scale.set(gridSize, gridSize, 1);
    this.generatedGround.position.set(center.x, box.min.y - maxDim * 0.01 + (this.groundHeightOffset || 0), center.z);
  }

  /** 地面高度偏移（模型单位） */
  setGroundHeightOffset(v) {
    this.groundHeightOffset = v;
    this.placeGround();
    this.syncGridHeight();
  }

  setGroundColor(hex, forceGenerated = false) {
    this.groundColor = hex;
    if (forceGenerated) this.groundMode = 'generated';
    this.ensureGroundGenerated();
    const modelGround = this.groundMode === 'auto' ? this.detectModelGround() : null;
    if (modelGround) modelGround.visible = false;
    this.generatedGround.material.color.set(hex); // 只换色，不动网格/位置 → 防闪
    this.generatedGround.visible = this.groundVisible;
  }

  setAxesVisible(v) {
    this.axesVisible = v;
    if (v && !this.axes) {
      this.axes = this.createFancyAxes(this.currentMaxDim() * 0.55);
      this.scene.add(this.axes);
    }
    if (this.axes) this.axes.visible = v;
  }

  /** 增强坐标轴：粗圆柱 + 圆锥箭头 + XYZ 文字标识 */
  createFancyAxes(size) {
    const group = new THREE.Group();
    const axes = [
      { dir: new THREE.Vector3(1, 0, 0), color: 0xe5484d, label: 'X', rotZ: -Math.PI / 2 },
      { dir: new THREE.Vector3(0, 1, 0), color: 0x46a758, label: 'Y', rotZ: 0 },
      { dir: new THREE.Vector3(0, 0, 1), color: 0x3a6df0, label: 'Z', rotX: Math.PI / 2 },
    ];
    const shaftR = size * 0.006, headR = size * 0.015, headL = size * 0.05;
    for (const a of axes) {
      const mat = new THREE.MeshBasicMaterial({ color: a.color });
      const shaftLen = size - headL;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, shaftLen, 12), mat);
      shaft.position.copy(a.dir).multiplyScalar(shaftLen / 2);
      const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headL, 16), mat);
      head.position.copy(a.dir).multiplyScalar(size - headL / 2);
      if (a.rotZ) { shaft.rotation.z = a.rotZ; head.rotation.z = a.rotZ; }
      if (a.rotX) { shaft.rotation.x = a.rotX; head.rotation.x = a.rotX; }
      group.add(shaft, head);
      // 文字 Sprite
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = '#' + a.color.toString(16).padStart(6, '0');
      g.font = 'bold 96px -apple-system, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(a.label, 64, 70);
      const tex = new THREE.CanvasTexture(c);
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      spr.position.copy(a.dir).multiplyScalar(size + headL * 0.8);
      spr.scale.set(size * 0.12, size * 0.12, 1);
      group.add(spr);
    }
    return group;
  }
  setShadowVisible(v) {
    this.shadowVisible = v;
    // 光与 shadowMap 常开：避免灯光列表变化引发全场景材质重编译（闪烁根源）
    this.keyLight.castShadow = true;
    for (const m of this.models) {
      m.root.traverse(o => {
        if (!o.isMesh) return;
        if (!o.userData.shadowInit) {
          // castShadow 首次置位：仅此一次重编译材质，后续开关零重编译（防闪烁）
          o.userData.shadowInit = true;
          o.castShadow = true;
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(mt => { if (mt) mt.needsUpdate = true; });
        }
        o.receiveShadow = v; // 开关语义 = 是否接收阴影（地面板同理由下方切换）
      });
    }
    if (this.generatedGround) {
      this.generatedGround.receiveShadow = v;
      this.placeGround(); // 高度偏移可能变化，重新定位
    }
    // 视锥适配：开关/合并/切换模型后阴影相机始终包裹当前模型
    const box = this.smartBoundingBox();
    if (box && !box.isEmpty()) this.fitShadowCamera(box);
    this.syncGridHeight();
  }

  setExposure(v) { this.renderer.toneMappingExposure = v; }
  setEnvIntensity(v) { this.scene.environmentIntensity = v; }

  /* ---------- 渲染循环 ---------- */

  startLoop(onFrame) {
    this.clock = new THREE.Clock();
    const loop = () => {
      requestAnimationFrame(loop);
      const delta = this.clock.getDelta();
      this.controls.update();
      if (onFrame) onFrame(delta);
      this.renderer.render(this.scene, this.active);
    };
    loop();
  }

}
