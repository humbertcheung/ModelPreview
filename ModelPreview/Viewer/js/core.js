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
    // 像素比上限 1.75：Retina 下 2.0 是 4 倍像素，改为 1.75 后约省 23% 填充率
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
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
    this.needsRender = true;   // 脏标记：仅在场景/相机变化时渲染
    this.continuous = false;   // 动画/自动旋转期间需要连续渲染
  }

  /** 标记场景已变化，下一帧渲染 */
  requestRender() { this.needsRender = true; }

  /** 标记阴影需要重新计算（模型/地面/光源变化时） */
  requestShadowUpdate() {
    this.needsRender = true;
    this.renderer.shadowMap.needsUpdate = true;
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
  
    this.requestRender();}

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
  
    this.requestRender();}

  /** 模型自身朝向（世界坐标）：
   *  forward = 车头方向，right = 车体右侧，up = 世界竖直方向。
   *  通过部件命名中的方向词（前/后/左/右、front/rear/left/right、_L/_R）推断，
   *  因为 Blender 导出的模型朝向千差万别（kart 车头朝 +X，多数模型朝 +Z/-Z）。 */
  modelAxes() {
    const key = this.models.map(m => m.root.uuid).join(',');
    if (this._axesKey === key && this._axes) return this._axes;

    // 方向词：中文（前/后/左/右）与英文常见命名（front/rear/left/right、_FL/_FR/_RL/_RR）
    const RE_FRONT = /(前|frt|front|fwd|nose|hood|bonnet|bumper|前部)/i;
    const RE_BACK = /(后|bck|back|rear|tail|trunk|尾)/i;
    const RE_LEFT = /(左|lft|left|port|_(fl|rl|l)\b)/i;
    const RE_RIGHT = /(右|rgt|right|stbd|starboard|_(fr|rr|r)\b)/i;

    const sets = { front: [], back: [], left: [], right: [] };
    const centers = [];
    for (const m of this.models) {
      m.root.traverse(o => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        o.geometry.computeBoundingBox();
        const c = o.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld);
        centers.push(c);
        const n = o.name || '';
        if (RE_FRONT.test(n)) sets.front.push(c);
        if (RE_BACK.test(n)) sets.back.push(c);
        if (RE_LEFT.test(n)) sets.left.push(c);
        if (RE_RIGHT.test(n)) sets.right.push(c);
      });
    }
    if (!centers.length) return null;

    const mean = (arr) => {
      const v = new THREE.Vector3();
      for (const c of arr) v.add(c);
      return v.divideScalar(arr.length || 1);
    };
    const modelCenter = mean(centers);
    const worldUp = new THREE.Vector3(0, 1, 0);

    // 前进方向：优先用「前部件」减「后部件」，否则用「前部件」减模型中心
    let forward = null;
    if (sets.front.length && sets.back.length) forward = mean(sets.front).sub(mean(sets.back));
    else if (sets.front.length) forward = mean(sets.front).sub(modelCenter);
    else if (sets.back.length) forward = modelCenter.sub(mean(sets.back));
    if (forward && forward.lengthSq() > 1e-8) {
      forward.normalize();
      // 与竖直方向正交化（模型可能带轻微倾斜）
      const horiz = forward.clone().projectOnPlane(worldUp);
      if (horiz.lengthSq() > 1e-6) forward = horiz.normalize();
    } else {
      forward = new THREE.Vector3(0, 0, 1); // 兜底：glTF/Blender 常见朝向
    }

    // 右侧方向：优先用命名推断（对镜像缩放的模型也正确），否则用 forward × up
    let right = null;
    if (sets.right.length && sets.left.length) right = mean(sets.right).sub(mean(sets.left));
    else if (sets.right.length) right = mean(sets.right).sub(modelCenter);
    else if (sets.left.length) right = modelCenter.sub(mean(sets.left));
    if (right && right.lengthSq() > 1e-8) {
      right = right.projectOnPlane(worldUp).normalize();
      // 命名推断的 right 与 forward 右手系相反时（镜像模型），仍以命名为准但记录下来
    } else {
      right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
    }

    this._axes = { forward, right, up: worldUp.clone() };
    this._axesKey = key;
    return this._axes;
  }

  /** 视图预设（基于模型自身朝向）：
   *  前 = 车头正对镜头；后 = 车尾正对镜头；
   *  右 = 从车体右侧看；左 = 从车体左侧看；
   *  顶/底 = 车头朝下；45° = 车头朝左下角、车尾朝右上角（前左上方俯视 45°） */
  setPresetView(name) {
    if (!this.models.length) return;
    const box = this.smartBoundingBox();
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) || 1;
    const dist = (radius / 2) / Math.tan((50 * Math.PI / 180) / 2) * 1.4;

    const axes = this.modelAxes();
    const fwd = axes ? axes.forward.clone() : new THREE.Vector3(0, 0, 1);
    const rgt = axes ? axes.right.clone() : new THREE.Vector3(1, 0, 0);
    const up = axes ? axes.up.clone() : new THREE.Vector3(0, 1, 0);

    let d, camUp = up.clone();
    switch (name) {
      case 'front': d = fwd.clone(); break;                       // 车头正对
      case 'back': d = fwd.clone().negate(); break;               // 车尾正对
      case 'right': d = rgt.clone(); break;                       // 车体右侧
      case 'left': d = rgt.clone().negate(); break;               // 车体左侧
      case 'top':                                    // 俯视：车头朝下
        d = up.clone();
        camUp = fwd.clone().negate();
        break;
      case 'bottom':                                 // 仰视：车头朝下
        d = up.clone().negate();
        camUp = fwd.clone().negate();
        break;
      case 'iso45':                                  // 前左上方 45°：车头朝左下角
        d = fwd.clone().sub(rgt).add(up).normalize();
        break;
      default: d = fwd.clone();
    }

    const wasKind = this.camKind;
    // 45° 用透视（3/4 产品视角更自然）；六个轴向视图用正交
    if (name === 'iso45') { if (wasKind !== 'persp') this.setCameraKind('persp'); }
    else if (wasKind !== 'ortho') this.setCameraKind('ortho');

    this.active.position.copy(center).addScaledVector(d, dist);
    this.controls.target.copy(center);
    this.active.up.copy(camUp);
    this.active.lookAt(center);
    this.controls.update();
    this._lastPreset = name;
    this.requestRender();
  }

  resetView() {
    const box = this.smartBoundingBox();
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = (maxDim / 2) / Math.tan((50 * Math.PI / 180) / 2) * 1.35;
    // 默认视角与「45°」预设保持一致（模型前左上方），朝向随模型自身推断
    const axes = this.modelAxes();
    const fwd = axes ? axes.forward : new THREE.Vector3(0, 0, 1);
    const rgt = axes ? axes.right : new THREE.Vector3(1, 0, 0);
    const up = axes ? axes.up : new THREE.Vector3(0, 1, 0);
    const dir = fwd.clone().sub(rgt).add(up).normalize();
    this.active.up.set(0, 1, 0);
    this.active.position.copy(center).addScaledVector(dir, dist);
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
    this.requestShadowUpdate();
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
  
    this.requestRender();}

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
  
    this.requestRender();}

  setTheme(theme) {
    this.theme = theme;
    if (this.bgMode === 'theme') this.applyBackground('theme', theme);
    if (this.grid) this.recolorGrid();
  
    this.requestRender();}

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
  
    this.requestRender();}
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
  
    this.requestRender();
    this.requestShadowUpdate();}

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
  
    this.requestRender();}

  setGroundColor(hex, forceGenerated = false) {
    this.groundColor = hex;
    if (forceGenerated) this.groundMode = 'generated';
    this.ensureGroundGenerated();
    const modelGround = this.groundMode === 'auto' ? this.detectModelGround() : null;
    if (modelGround) modelGround.visible = false;
    this.generatedGround.material.color.set(hex); // 只换色，不动网格/位置 → 防闪
    this.generatedGround.visible = this.groundVisible;
  
    this.requestRender();
    this.requestShadowUpdate();}

  setAxesVisible(v) {
    this.axesVisible = v;
    if (v && !this.axes) {
      this.axes = this.createFancyAxes(this.currentMaxDim() * 0.55);
      this.scene.add(this.axes);
    }
    if (this.axes) this.axes.visible = v;
  
    this.requestRender();}

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
    this.requestShadowUpdate();
  }

  setExposure(v) { this.renderer.toneMappingExposure = v; this.requestRender(); }
  setEnvIntensity(v) { this.scene.environmentIntensity = v; this.requestRender(); }

  /* ---------- 渲染循环 ---------- */

  startLoop(onFrame) {
    this.clock = new THREE.Clock();
    const loop = () => {
      requestAnimationFrame(loop);
      const delta = this.clock.getDelta();
      // 相机阻尼更新：仅在相机真的变化时标脏
      const camChanged = this.controls.update();
      if (camChanged) this.needsRender = true;
      if (onFrame) onFrame(delta);
      // 按需渲染：场景无变化时完全跳过绘制，GPU 占用从持续满载降到接近 0
      if (this.needsRender || this.continuous) {
        if (document.hidden) { this.needsRender = true; return; } // 后台不绘制
        // 动画/转盘时模型在动，阴影需逐帧重算；静止时阴影贴图保持不变
        if (this.continuous) this.renderer.shadowMap.needsUpdate = true;
        this.renderer.render(this.scene, this.active);
        this.needsRender = false;
      }
    };
    loop();
  }

}
