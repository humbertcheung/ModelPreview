import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/ThreeMFLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';

/* ================= 工具 ================= */

const $ = (id) => document.getElementById(id);
const bridge = window.webkit?.messageHandlers?.host ?? null;
const postToNative = (msg) => { try { bridge?.postMessage(msg); } catch (e) { /* QL 宿主可能已释放 */ } };

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}
function fmtCount(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' k';
  return String(n);
}
function fmtLen(n) {
  if (!isFinite(n)) return '—';
  if (n >= 1e6 || (n > 0 && n < 1e-3)) return n.toExponential(2);
  return n.toFixed(n >= 100 ? 1 : n >= 1 ? 2 : 3);
}

/* ================= 背景 ================= */

const BACKGROUNDS = {
  dark:   { color: 0x17191d, env: 1.0,  grid: [0x3a3f4a, 0x23262c], dir: 1.1 },
  light:  { color: 0xe9ecf1, env: 1.15, grid: [0xc4c9d4, 0xdadfe7], dir: 0.9 },
  studio: { color: 0x222529, env: 1.4,  grid: [0x454a56, 0x2b2e35], dir: 1.5 },
};

/* ================= 查看器 ================= */

class Viewer {
  constructor(container) {
    this.container = container;
    this.model = null;          // 当前模型根节点
    this.animations = [];
    this.mixer = null;
    this.activeAction = null;
    this.materials = new Set();
    this.wireframe = false;
    this.gridVisible = true;
    this.bgMode = 'dark';
    this.chunkState = null;
    this.currentName = '';

    this.initThree();
    this.bindUI();
    this.animate();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  initThree() {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.toneMapping = THREE.NeutralToneMapping; // 颜色忠实度优先
    this.renderer.toneMappingExposure = 1.0;
    this.container.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.01, 2000);
    this.camera.position.set(3, 2, 4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 2.2;

    // 环境光照（PBR 质感）
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    this.dirLight.position.set(4, 8, 5);
    this.scene.add(this.dirLight);

    this.grid = null;
    this.setBackground('dark');
  }

  bindUI() {
    $('opt-grid').addEventListener('change', (e) => this.setGrid(e.target.checked));
    $('opt-wireframe').addEventListener('change', (e) => this.setWireframe(e.target.checked));
    $('opt-autorotate').addEventListener('change', (e) => this.setAutoRotate(e.target.checked));
    document.querySelectorAll('.swatch').forEach((btn) => {
      btn.addEventListener('click', () => this.setBackground(btn.dataset.bg));
    });
  }

  syncUI() {
    $('opt-grid').checked = this.gridVisible;
    $('opt-wireframe').checked = this.wireframe;
    $('opt-autorotate').checked = this.controls.autoRotate;
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s.dataset.bg === this.bgMode));
    postToNative({ type: 'state', wireframe: this.wireframe, grid: this.gridVisible, autorotate: this.controls.autoRotate, bg: this.bgMode });
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    if (this.mixer) this.mixer.update(this.clock?.getDelta() ?? 0);
    this.renderer.render(this.scene, this.camera);
  };

  /* ---------- 场景内容管理 ---------- */

  clearModel() {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
          m.dispose();
        });
      });
      this.model = null;
    }
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer = null; }
    this.activeAction = null;
    this.animations = [];
    this.materials.clear();
    if (this.grid) { this.scene.remove(this.grid); this.grid = null; }
    this.showAnimPanel(false);
  }

  makeGrid(size) {
    this.gridSize = size;
    const c = BACKGROUNDS[this.bgMode].grid;
    const g = new THREE.GridHelper(size, 40, c[0], c[1]);
    g.material.transparent = true;
    g.material.opacity = 0.55;
    g.visible = this.gridVisible;
    return g;
  }

  /* ---------- 模型装载核心 ---------- */

  async addModel(root, animations = [], opts = {}) {
    this.clearModel();
    this.clearImage();
    this.model = root;
    this.scene.add(root);
    this.animations = animations || [];

    // 材质缺省优化：无光照信息的 STL/PLY 需要法线
    root.traverse((o) => {
      if (o.isMesh && o.geometry && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      if (o.isMesh) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          this.materials.add(m);
          if (this.wireframe) m.wireframe = true;
          if (m.isMeshStandardMaterial && m.side === THREE.FrontSide && opts.forceDoubleSide) m.side = THREE.DoubleSide;
        });
      }
    });

    // 居中：底面贴网格
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) throw new Error('模型不包含任何可见几何体');
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    root.position.x -= center.x;
    root.position.z -= center.z;
    root.position.y -= box.min.y;

    this.grid = this.makeGrid(maxDim * 4);
    this.scene.add(this.grid);

    // 相机参数随模型尺度调整
    this.camera.near = maxDim / 1000;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, size.y / 2, 0);
    this.resetView();

    // 动画
    if (this.animations.length) {
      this.mixer = new THREE.AnimationMixer(root);
      this.clock = new THREE.Clock();
      this.showAnimPanel(true);
      const list = $('anim-list');
      list.innerHTML = '';
      this.animations.forEach((clip, i) => {
        const el = document.createElement('div');
        el.className = 'anim-item' + (i === 0 ? ' active' : '');
        el.textContent = clip.name || `动画 ${i + 1}`;
        el.addEventListener('click', () => this.playAnimation(i));
        list.appendChild(el);
      });
      this.playAnimation(0);
    } else {
      this.showAnimPanel(false);
    }

    this.updateStats({ size, maxDim });
    this.hideLoading();
    this.hideError();
  }

  resetView() {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = (maxDim / 2) / Math.tan((this.camera.fov * Math.PI / 180) / 2) * 1.35;
    const dir = new THREE.Vector3(1, 0.55, 1).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.lookAt(center);
    this.controls.target.copy(center);
    this.controls.update();
  }

  updateStats({ size }) {
    let vertices = 0, triangles = 0, meshes = 0;
    this.model.traverse((o) => {
      if (o.isMesh && o.geometry) {
        meshes++;
        const p = o.geometry.attributes.position;
        if (p) {
          vertices += p.count;
          triangles += o.geometry.index ? o.geometry.index.count / 3 : p.count / 3;
        }
      }
    });
    const st = {
      'st-vertices': fmtCount(Math.round(vertices)),
      'st-triangles': fmtCount(Math.round(triangles)),
      'st-meshes': String(meshes),
      'st-materials': String(this.materials.size),
      'st-size': `${fmtLen(size.x)} × ${fmtLen(size.y)} × ${fmtLen(size.z)}`,
      'st-animations': this.animations.length ? String(this.animations.length) : '0',
    };
    for (const [id, v] of Object.entries(st)) $(id).textContent = v;
  }

  /* ---------- 各格式 URL 加载（主应用模式） ---------- */

  loadingManager(baseDir) {
    const mgr = new THREE.LoadingManager();
    mgr.addHandler(/\.tga$/i, new TGALoader(mgr));
    return mgr;
  }

  async openFile(fileURL, opts = {}) {
    const ext = opts.ext || (fileURL.split('.').pop() || '').toLowerCase();
    this.showLoading('正在加载模型…');
    this.hideError();
    try {
      if (ext === 'glb' || ext === 'gltf') {
        await this.loadGLTFURL(fileURL);
      } else if (ext === 'obj') {
        await this.loadOBJURL(fileURL);
      } else if (ext === 'fbx') {
        await this.loadWithProgress(new FBXLoader(this.loadingManager()), fileURL, ext);
      } else if (ext === 'dae') {
        await this.loadColladaURL(fileURL);
      } else if (ext === '3mf') {
        await this.loadWithProgress(new ThreeMFLoader(), fileURL, ext);
      } else if (ext === 'stl' || ext === 'ply') {
        await this.loadBufferURL(fileURL, ext);
      } else {
        throw new Error(`不支持的格式：.${ext}`);
      }
      this.setFileInfo(opts);
    } catch (err) {
      console.error(err);
      this.showError(this.humanError(err, ext));
      this.hideLoading();
    }
  }

  fetchArrayBuffer(url) {
    return fetch(url, { cache: 'no-store' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    });
  }

  loadGLTFURL(url) {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath('./lib/addons/libs/draco/gltf/');
      loader.setDRACOLoader(draco);
      loader.load(url, (gltf) => {
        draco.dispose();
        this.addModel(gltf.scene, gltf.animations).then(resolve).catch(reject);
      }, undefined, (err) => { draco.dispose(); reject(this.explainGLTFError(err, url)); });
    });
  }

  async loadOBJURL(url) {
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    const loader = new OBJLoader(this.loadingManager());
    try {
      const mtlText = await (await fetch(url.replace(/\.obj(\?|$)/i, '.mtl$1'), { cache: 'no-store' })).text();
      if (/^\s*</.test(mtlText)) throw new Error('no mtl');
      const mtl = new MTLLoader(this.loadingManager()).parse(mtlText, dir);
      mtl.preload();
      loader.setMaterials(mtl);
    } catch (e) { /* 无 MTL 也能预览几何 */ }
    const text = await (await fetch(url, { cache: 'no-store' })).text();
    const obj = loader.parse(text);
    await this.addModel(obj, []);
  }

  loadWithProgress(loader, url, ext) {
    return new Promise((resolve, reject) => {
      loader.load(url, (obj) => {
        const anims = obj.animations || [];
        this.addModel(obj, anims).then(resolve).catch(reject);
      }, undefined, (err) => reject(new Error(`.${ext} 解析失败：${err?.message || err}`)));
    });
  }

  async loadColladaURL(url) {
    const text = await (await fetch(url, { cache: 'no-store' })).text();
    const dir = url.slice(0, url.lastIndexOf('/') + 1);
    const res = new ColladaLoader(this.loadingManager()).parse(text, dir);
    await this.addModel(res.scene, res.scene?.animations || res.animations || []);
  }

  async loadBufferURL(url, ext) {
    const buf = await this.fetchArrayBuffer(url);
    await this.loadFromBuffer(buf, ext);
  }

  explainGLTFError(err, url) {
    const msg = String(err?.message || err);
    if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
      return '无法读取文件（可能引用了外部资源或路径不可访问）';
    }
    return msg;
  }

  humanError(err, ext) {
    const msg = String(err?.message || err);
    if (/no mtl/i.test(msg)) return 'MTL 材质文件解析失败，已跳过材质';
    return msg;
  }

  /* ---------- 各格式内存加载（Quick Look 模式 / 分块传输） ---------- */

  loadFromBuffer(buf, ext) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    switch (ext) {
      case 'glb': return this.parseGLBBuffer(u8.buffer);
      case 'gltf': return this.parseGLTFText(new TextDecoder('utf-8').decode(u8));
      case 'obj': {
        const obj = new OBJLoader().parse(new TextDecoder('utf-8').decode(u8));
        return this.addModel(obj, [], { forceDoubleSide: true });
      }
      case 'stl': {
        const geo = new STLLoader().parse(u8.buffer);
        return this.addBufferGeometry(geo);
      }
      case 'ply': {
        const geo = new PLYLoader().parse(u8.buffer);
        return this.addBufferGeometry(geo);
      }
      case 'fbx': {
        const fbx = new FBXLoader().parse(u8.buffer, '');
        return this.addModel(fbx, fbx.animations || []);
      }
      case 'dae': {
        const res = new ColladaLoader().parse(new TextDecoder('utf-8').decode(u8), '');
        return this.addModel(res.scene, res.scene?.animations || res.animations || [], { forceDoubleSide: true });
      }
      case '3mf': return this.addModel(new ThreeMFLoader().parse(u8.buffer), []);
      default: throw new Error(`不支持的格式：.${ext}`);
    }
  }

  parseGLBBuffer(buffer) {
    return new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      const draco = new DRACOLoader();
      draco.setDecoderPath('./lib/addons/libs/draco/gltf/');
      loader.setDRACOLoader(draco);
      loader.parse(buffer, '', (gltf) => {
        draco.dispose();
        this.addModel(gltf.scene, gltf.animations).then(resolve).catch(reject);
      }, (err) => { draco.dispose(); reject(new Error(`GLB 解析失败：${err?.message || err}`)); });
    });
  }

  parseGLTFText(text) {
    return new Promise((resolve, reject) => {
      new GLTFLoader().parse(text, '', (gltf) => {
        this.addModel(gltf.scene, gltf.animations).then(resolve).catch(reject);
      }, (err) => {
        reject(new Error('GLTF 引用了外部资源（.bin/贴图），快速预览无法加载，请在主应用中打开'));
      });
    });
  }

  addBufferGeometry(geo) {
    const hasColor = !!geo.attributes.color || geo.hasColors;
    const mat = new THREE.MeshStandardMaterial({
      color: hasColor ? 0xffffff : 0xcfd4dc,
      metalness: 0.08,
      roughness: 0.62,
      vertexColors: hasColor,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    return this.addModel(mesh, []);
  }

  /* ---------- 分块接收（QL 大文件） ---------- */

  chunksStart(meta) {
    this.chunkState = { ...meta, parts: [], received: 0 };
    this.showLoading('正在接收模型数据…');
  }

  chunksPush(b64) {
    const s = this.chunkState;
    if (!s) return;
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    s.parts.push(u8);
    s.received += u8.length;
    this.setLoadingText(`正在接收模型数据… ${fmtBytes(s.received)}`);
  }

  async chunksFinish() {
    const s = this.chunkState;
    this.chunkState = null;
    if (!s) return;
    const total = s.parts.reduce((a, p) => a + p.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of s.parts) { merged.set(p, off); off += p.length; }
    s.parts.length = 0;
    this.setLoadingText('正在解析模型…');
    try {
      await new Promise((r) => setTimeout(r, 30)); // 让 UI 先刷新
      await this.loadFromBuffer(merged.buffer, s.ext);
      this.setFileInfo({ name: s.name, size: s.size, ext: s.displayExt || s.ext, note: s.note });
    } catch (err) {
      console.error(err);
      this.showError(String(err?.message || err));
      this.hideLoading();
    }
  }

  /* ---------- 缩略图/图片显示 ---------- */

  showImage(dataUrl) {
    this.hideError();
    this.hideLoading();
    let el = document.getElementById('image-view');
    if (!el) {
      el = document.createElement('div');
      el.id = 'image-view';
      Object.assign(el.style, {
        position: 'absolute', inset: '0', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: '20', pointerEvents: 'none',
      });
      const img = document.createElement('img');
      Object.assign(img.style, {
        maxWidth: '86%', maxHeight: '86%', borderRadius: '10px',
        boxShadow: '0 8px 40px rgba(0,0,0,.55)',
      });
      el.appendChild(img);
      this.container.appendChild(el);
    }
    el.style.display = 'flex';
    el.querySelector('img').src = dataUrl;
  }

  clearImage() {
    const el = document.getElementById('image-view');
    if (el) el.style.display = 'none';
  }

  /* ---------- 信息面板 ---------- */

  setFileInfo(opts = {}) {
    $('file-section').classList.remove('hidden');
    $('file-name').textContent = opts.name || '未命名';
    $('file-size').textContent = fmtBytes(opts.size);
    const ext = (opts.displayExt || opts.ext || '').toUpperCase();
    const badge = $('file-format');
    badge.textContent = ext || '—';
    badge.style.background = {
      GLB: '#3a6df0', GLTF: '#2f8ddd', OBJ: '#9a68d9', FBX: '#c95d2e',
      STL: '#2e9e63', PLY: '#2e9e8f', DAE: '#b5588c', '3MF': '#d9a02e', BLEND: '#e87d3e',
    }[ext] || '#5c6270';
    const note = $('file-note');
    if (opts.note) { note.textContent = opts.note; note.classList.remove('hidden'); }
    else note.classList.add('hidden');
    this.currentName = opts.name || '';
  }

  showAnimPanel(show) { $('anim-panel').classList.toggle('hidden', !show); }

  playAnimation(index) {
    if (!this.mixer || !this.animations[index]) return;
    if (this.activeAction) this.activeAction.stop();
    this.activeAction = this.mixer.clipAction(this.animations[index]);
    this.activeAction.reset().play();
    document.querySelectorAll('.anim-item').forEach((el, i) => el.classList.toggle('active', i === index));
  }

  /* ---------- 显示选项 ---------- */

  setWireframe(on) {
    this.wireframe = on;
    this.materials.forEach((m) => { m.wireframe = on; });
    this.syncUI();
  }
  setGrid(on) {
    this.gridVisible = on;
    if (this.grid) this.grid.visible = on;
    this.syncUI();
  }
  setAutoRotate(on) {
    this.controls.autoRotate = on;
    this.syncUI();
  }
  setBackground(mode) {
    this.bgMode = mode in BACKGROUNDS ? mode : 'dark';
    const cfg = BACKGROUNDS[this.bgMode];
    this.scene.background = new THREE.Color(cfg.color);
    this.scene.environmentIntensity = cfg.env; // r163+，旧版本静默忽略
    this.dirLight.intensity = cfg.dir;
    if (this.grid) {
      const vis = this.grid.visible, gs = this.gridSize ?? 10;
      this.scene.remove(this.grid);
      this.grid = this.makeGrid(gs); // 按原尺寸以新配色重建
      this.grid.visible = vis;
      this.scene.add(this.grid);
    }
    document.getElementById('viewport').style.background = '#' + cfg.color.toString(16).padStart(6, '0');
    this.syncUI();
  }

  /* ---------- 截图：导出相机视角的纯场景画面（无网格等辅助物，高分辨率） ---------- */

  screenshot() {
    // 1) 隐藏辅助物（地面网格等）
    const savedGridVisible = this.grid ? this.grid.visible : false;
    if (this.grid) this.grid.visible = false;

    // 2) 临时提升渲染分辨率（3x），离屏渲染当前相机视角
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;
    const prevPixelRatio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(3);
    this.renderer.setSize(w, h, false);

    this.renderer.render(this.scene, this.camera);
    const data = this.renderer.domElement.toDataURL('image/png');

    // 3) 恢复视口显示（分辨率与网格可见性）
    this.renderer.setPixelRatio(prevPixelRatio);
    this.renderer.setSize(w, h, false);
    if (this.grid) this.grid.visible = savedGridVisible;
    this.renderer.render(this.scene, this.camera);

    const name = (this.currentName || 'model').replace(/\.[^.]+$/, '') + '.png';
    if (bridge) postToNative({ type: 'screenshot', name, data });
    else {
      const a = document.createElement('a');
      a.href = data; a.download = name; a.click();
      this.toast(`已导出截图 ${Math.round(w * 3)}×${Math.round(h * 3)}`);
    }
  }

  /* ---------- UI 状态 ---------- */

  showLoading(text) { $('loading').classList.remove('hidden'); this.setLoadingText(text); }
  setLoadingText(t) { $('loading-text').textContent = t; }
  hideLoading() { $('loading').classList.add('hidden'); }
  showError(detail, title = '无法加载模型') {
    $('error-panel').classList.remove('hidden');
    $('error-title').textContent = title;
    $('error-detail').textContent = detail;
    this.hideLoading();
    postToNative({ type: 'error', title, detail });
  }
  hideError() { $('error-panel').classList.add('hidden'); }
  toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  humanError_wrap() {}
}

/* ================= 原生命令入口 ================= */

function b64ToJSON(b64) {
  return JSON.parse(new TextDecoder('utf-8').decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
}

function dispatchCmd(cmd) {
  const v = window.viewer;
  switch (cmd.op) {
    case 'open-url': return v.openFile(cmd.url, cmd);
    case 'chunks-start': return v.chunksStart(cmd);
    case 'push': return v.chunksPush(cmd.data);
    case 'finish': return v.chunksFinish();
    case 'status': return v.setLoadingText(cmd.text || '处理中…');
    case 'loading': return v.showLoading(cmd.text || '处理中…');
    case 'show-image': return v.showImage(cmd.dataUrl);
    case 'set-fileinfo': return v.setFileInfo(cmd);
    case 'error': return v.showError(cmd.detail || '', cmd.title || '提示');
    case 'toggle': {
      if (cmd.key === 'wireframe') v.setWireframe(!v.wireframe);
      if (cmd.key === 'grid') v.setGrid(!v.gridVisible);
      if (cmd.key === 'autorotate') v.setAutoRotate(!v.controls.autoRotate);
      return;
    }
    case 'set-bg': return v.setBackground(cmd.mode);
    case 'reset-view': return v.resetView();
    case 'screenshot': return v.screenshot();
    case 'play-anim': return v.playAnimation(cmd.index);
  }
}

/* ================= 初始化 ================= */

const viewer = new Viewer($('viewport'));
window.viewer = viewer;
window.viewer.cmdB64 = (b64) => { try { dispatchCmd(b64ToJSON(b64)); } catch (e) { console.error('cmd error', e); } };

// 拖放（仅主应用窗口有效；QL 中被宿主拦截无碍）
const vp = $('viewport');
window.addEventListener('dragover', (e) => { e.preventDefault(); $('drop-hint').classList.add('visible'); });
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null || e.target === document.documentElement) $('drop-hint').classList.remove('visible');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop-hint').classList.remove('visible');
  const f = e.dataTransfer?.files?.[0];
  if (f && f.path) {
    const url = 'file://' + f.path.split('/').map(encodeURIComponent).join('/');
    viewer.openFile(url, { name: f.name, ext: f.name.split('.').pop() });
  }
});

postToNative({ type: 'ready' });
