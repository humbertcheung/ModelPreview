import * as THREE from 'three';
import { SceneCore, THEME_BG } from './core.js';
import { loadModelFile, loadFromBuffer, computeStats, SUPPORTED, BIG_FILE_WARN } from './loader.js';
import { ShadingManager, Outliner, setHighlight, isolate, clearIsolate, AnimationPlayer, exportGLB } from './features.js';

const $ = (id) => document.getElementById(id);
const bridge = window.webkit?.messageHandlers?.host ?? null;
const postToNative = (msg) => { try { bridge?.postMessage(msg); } catch { /* QL 宿主可能已释放 */ } };
const b64ToJSON = (b64) => JSON.parse(new TextDecoder('utf-8').decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
const fmtNum1 = (v) => { const t = (v + 0).toFixed(1); return t === '-0.0' ? '0.0' : t; }; // 负零归一

/* ================= 应用 ================= */

class App {
  constructor() {
    this.core = new SceneCore($('viewport'));
    this.shading = new ShadingManager();
    this.outliner = new Outliner($('tree'), (nodes) => {
      setHighlight(this._highlighted || [], false);
      this._highlighted = nodes;
      setHighlight(nodes, true);
      // 选中包围框：视口中直观标出选中部件
      if (this._selBox) { this.core.scene.remove(this._selBox); this._selBox = null; }
      if (nodes.length) {
        const box = new THREE.Box3();
        for (const n of nodes) {
          if (n.isMesh) { n.geometry.computeBoundingBox(); const b = n.geometry.boundingBox.clone().applyMatrix4(n.matrixWorld); box.union(b); }
          else box.expandByObject(n);
        }
        if (!box.isEmpty()) {
          this._selBox = new THREE.Box3Helper(box, new THREE.Color(this.core.theme === 'light' ? 0x2f5fe0 : 0xffc53d));
          this.core.scene.add(this._selBox);
        }
      }
      // 选中信息
      const names = nodes.map(n => n.name || n.type).join(', ');
      if (names) this.toast(`已选中：${names}`, 1800);
    });
    this.anim = new AnimationPlayer();
    this.selected = [];
    this.currentName = '';
    this.transparentShot = false;
    this.missingAssets = [];

    this.bindTopbar();
    this.bindLeftPanel();
    this.bindRightPanel();
    this.bindAnimbar();
    this.bindViewport();

    this.core.startLoop((delta) => this.onFrame(delta));

    new ResizeObserver(() => this.core.resize()).observe($('viewport'));
    this.core.resize();

    postToNative({ type: 'ready' });
  }

  /* ---------- 顶栏 ---------- */

  bindTopbar() {
    $('tb-open').addEventListener('click', () => postToNative({ type: 'open-panel' }));
    $('tb-append').addEventListener('click', () => postToNative({ type: 'open-panel', append: true }));
    $('tb-reset-scene').addEventListener('click', async () => {
      if (!this.core.models.length) { this.toast('场景为空'); return; }
      const ok = await this.confirmModal('场景重置', '将清空当前场景中的所有模型，确定继续？', null, '清空');
      if (ok === true) this.resetScene();
    });
    $('tb-reset-view').addEventListener('click', () => this.core.resetView());
    $('tb-cam-kind').addEventListener('click', () => {
      const kind = this.core.setCameraKind(this.core.camKind === 'persp' ? 'ortho' : 'persp');
      $('tb-cam-kind').textContent = kind === 'ortho' ? '透视' : '正交';
      $('tb-cam-kind').classList.toggle('active', kind === 'ortho');
    });
    $('tb-turntable').addEventListener('click', () => {
      this.core.turntableWanted = !this.core.turntableWanted;
      this.core.controls.autoRotate = this.core.turntableWanted;
      $('tb-turntable').classList.toggle('active', this.core.turntableWanted);
      this.core.continuous = this.core.turntableWanted;
      this.core.requestRender();
    });
    for (const btn of document.querySelectorAll('#tb-shading .mode-card')) {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#tb-shading .mode-card').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.shading.setMode(btn.dataset.mode, this.core.models, this.core.theme);
        this.core.requestShadowUpdate();
        this.toast(`渲染模式：${btn.querySelector('.m-title')?.textContent || btn.dataset.mode}`, 1500);
      });
    }
    $('tb-snapshot').addEventListener('click', () => this.saveSnapshot());
    $('tb-export-glb').addEventListener('click', () => this.doExportGLB());
    $('tb-embed').addEventListener('click', () => this.copyEmbedCode());
    // 注意：此处只能绑定一次。历史 bug：bindLeftPanel 里重复注册了同一按钮，
    // 一次点击触发两次 toggle 互相抵消，导致「显示/关闭面板」看起来完全失效。
    $('tb-left-panel').addEventListener('click', () => this.togglePanel('left-panel', 'tb-left-panel'));
    $('tb-right-panel').addEventListener('click', () => this.togglePanel('right-panel', 'tb-right-panel'));
    $('tb-shot').addEventListener('click', () => this.screenshot());
    $('tb-export-views').addEventListener('click', () => this.exportAllViews());
    $('tb-theme').addEventListener('click', () => this.setTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark'));
    postToNative({ type: 'topbar-ready' });
  }

  /** 显示/关闭左右面板（宽度保持不变，仅隐藏内容） */
  togglePanel(panelId, btnId) {
    const p = $(panelId);
    const show = p.style.display === 'none';
    p.style.display = show ? '' : 'none';
    $(btnId).classList.toggle('active', show);
    this.core.requestRender();
    this.core.resize();
  }

  /* ---------- 左面板 ---------- */

  bindLeftPanel() {
    $('opt-ground').addEventListener('change', e => {
      this.core.setGroundVisible(e.target.checked);
      if (e.target.checked && this.core.groundMode === 'generated') this.showGroundNote('使用系统地面');
      else this.hideGroundNote();
    });
    this.bindQlSettings();
    // 空格预览设置：展开/折叠（默认折叠）
    $('ql-settings-toggle').addEventListener('click', () => {
      const card = $('ql-settings-card');
      card.classList.toggle('collapsed');
      $('ql-settings-twist').classList.toggle('open', !card.classList.contains('collapsed'));
    });
    $('opt-grid').addEventListener('change', e => this.core.setGridVisible(e.target.checked));
    document.querySelectorAll('#ground-colors .gswatch').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#ground-colors .gswatch').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        this.core.setGroundColor(parseInt(b.dataset.c.replace('#', ''), 16), true);
        this.syncGroundRow(); // 切到系统地面后高度滑块行立即可用
        this.toast('地面已切换');
      });
    });
    $('opt-axes').addEventListener('change', e => this.core.setAxesVisible(e.target.checked));
    $('opt-shadow').addEventListener('change', e => {
      this.core.setShadowVisible(e.target.checked);
      // 阴影链路诊断：随开关切换上报实际状态
      try {
        const L = this.core.keyLight, c = L.shadow.camera;
        let castN = 0, recvN = 0;
        for (const m of this.core.models) m.root.traverse(o => { if (o.isMesh) { if (o.castShadow) castN++; if (o.receiveShadow) recvN++; } });
        postToNative({ type: 'debug-info', shadow: {
          checked: e.target.checked, lc: L.castShadow, smEnabled: this.core.renderer.shadowMap.enabled,
          models: this.core.models.length, castN, recvN,
          L: +c.left.toFixed(1), R: +c.right.toFixed(1), T: +c.top.toFixed(1), near: +c.near.toFixed(1), far: +c.far.toFixed(1),
          pos: L.position.toArray().map(v => +v.toFixed(1)),
          target: L.target.position.toArray().map(v => +v.toFixed(1)),
          mapSize: L.shadow.mapSize.width, mapNull: !L.shadow.map,
        } });
      } catch { /* 诊断不影响主流程 */ }
    });
    $('opt-edges').addEventListener('change', e => {
      this.shading.setEdges(e.target.checked, this.core.models, this.core.theme);
      this.core.requestRender();
    });
    $('sl-ground-h').addEventListener('input', e => {
      const v = +e.target.value;
      $('v-ground-h').textContent = fmtNum1(v / 10); // 负零归一
      this.core.setGroundHeightOffset(v / 10);
    });
    $('opt-ground').addEventListener('change', () => this.syncGroundRow());
    document.querySelectorAll('#ground-colors .gswatch').forEach(b => {
      const origHandler = b.addEventListener;
    });
    for (const btn of document.querySelectorAll('#view-presets button')) {
      btn.addEventListener('click', () => {
        this.core.setPresetView(btn.dataset.v);
        document.querySelectorAll('#view-presets button').forEach(b => b.classList.toggle('active', b === btn));
      });
    }
    // 用户手动旋转后清除预设高亮
    this.core.controls.addEventListener('start', () => {
      document.querySelectorAll('#view-presets button').forEach(b => b.classList.remove('active'));
    });
    for (const btn of document.querySelectorAll('#bg-mode button')) {
      btn.addEventListener('click', () => {
        this.core.applyBackground(btn.dataset.bg, this.core.bgColorKey);
        this.syncBgUI();
        this.toast(btn.dataset.bg === 'transparent' ? '透明背景（截图导出亦透明）' : btn.dataset.bg === 'gradient' ? '渐变背景' : '跟随界面主题');
      });
    }
    for (const sw of document.querySelectorAll('.swatch')) {
      sw.addEventListener('click', () => {
        this.core.applyBackground('color', sw.dataset.bg);
        this.syncBgUI();
        this.toast('背景已切换');
      });
    }
    $('opt-transparent-shot').addEventListener('change', e => { this.transparentShot = e.target.checked; });
    $('bg-reset').addEventListener('click', () => {
      this.core.applyBackground('theme', 'dark');
      document.querySelectorAll('#bg-mode button').forEach(b => b.classList.toggle('active', b.dataset.bg === 'theme'));
      document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s.dataset.bg === 'dark'));
      this.toast('背景已重置');
    });
    $('sl-exposure').addEventListener('input', e => {
      this.core.setExposure(e.target.value / 100);
      $('v-exposure').textContent = fmtNum1(e.target.value / 100);
    });
    $('sl-env').addEventListener('input', e => {
      this.core.setEnvIntensity(e.target.value / 100);
      $('v-env').textContent = fmtNum1(e.target.value / 100);
    });
    // 渲染调节重置：曝光恢复 1.0 / 环境恢复 0.2
    $('render-reset').addEventListener('click', () => {
      $('sl-exposure').value = 100; $('sl-env').value = 20;
      this.core.setExposure(1.0); this.core.setEnvIntensity(0.2);
      $('v-exposure').textContent = '1.0'; $('v-env').textContent = '0.2';
      this.toast('渲染调节已重置');
    });
  }

  /** 视口里是否为「系统地面板」→ 高度滑块显隐。
   *  条件用 generatedGround.visible 而非 groundMode==='generated'：
   *  地面开关自动补的地面处于 auto 模式，同样可以调高度；模型自带地面不可调，保持隐藏。 */
  syncGroundRow() {
    const hasGenerated = !!(this.core.generatedGround && this.core.generatedGround.visible);
    $('ground-height-row').style.display = hasGenerated ? 'flex' : 'none';
  }

  /* ---------- 空格预览设置（写入共享文件，QL 扩展读取） ---------- */

  qlSettings() {
    return {
      qlGroundEnabled: $('set-ql-ground').checked,
      qlGroundColor: document.querySelector('#ql-ground-colors .gswatch.active')?.dataset.c || '#ffffff',
      qlHideBackdrop: $('set-ql-hidebackdrop').checked,
    };
  }

  bindQlSettings() {
    const apply = (s) => {
      if (!s) return;
      $('set-ql-ground').checked = s.qlGroundEnabled !== false;
      $('set-ql-hidebackdrop').checked = s.qlHideBackdrop !== false;
      document.querySelectorAll('#ql-ground-colors .gswatch').forEach(b =>
        b.classList.toggle('active', b.dataset.c === (s.qlGroundColor || '#ffffff')));
    };
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('mp3d-qlsettings') || 'null'); } catch { }
    apply(saved);
    const handler = () => {
      const s = this.qlSettings();
      try { localStorage.setItem('mp3d-qlsettings', JSON.stringify(s)); } catch { }
      postToNative({ type: 'save-settings', settings: s });
      this.toast('空格预览设置已保存');
    };
    $('set-ql-ground').addEventListener('change', handler);
    $('set-ql-hidebackdrop').addEventListener('change', handler);
    document.querySelectorAll('#ql-ground-colors .gswatch').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('#ql-ground-colors .gswatch').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      handler();
    }));
  }

  /** 背景状态统一同步：模式按钮与色板的 active 一致反映当前状态 */
  syncBgUI() {
    const mode = this.core.bgMode;
    // 模式按钮：theme/gradient/transparent 高亮；color 模式时三个都不高亮（由色板表达）
    document.querySelectorAll('#bg-mode button').forEach(b =>
      b.classList.toggle('active', b.dataset.bg === mode));
    // 色板：color 模式高亮当前色；gradient/theme 模式高亮对应色（若有）
    document.querySelectorAll('.swatch').forEach(s =>
      s.classList.toggle('active', s.dataset.bg === this.core.bgColorKey &&
        (mode === 'color' || mode === 'gradient' || (mode === 'theme' && s.dataset.bg === this.core.theme))));
  }

  /* ---------- 右面板 ---------- */

  bindRightPanel() {
    $('snap-save').addEventListener('click', () => this.saveSnapshot());
  }

  /* ---------- 动画条 ---------- */

  bindAnimbar() {
    $('anim-play').addEventListener('click', () => {
      if (!this.anim.mixer) return;
      if (this.anim.playing) this.anim.pause(); else this.anim.play();
      this.core.continuous = this.anim.playing;
      this.core.requestRender();
      this.syncAnimUI();
    });
    $('anim-clip').addEventListener('change', e => this.anim.selectClip(+e.target.value));
    $('anim-time').addEventListener('input', e => { this.anim.seek(+e.target.value / 1000); this.core.requestRender(); });
    $('anim-speed-sel').addEventListener('change', e => this.anim.setSpeed(+e.target.value));
    $('anim-loop-chk').addEventListener('change', e => this.anim.setLoop(e.target.checked));
  }

  syncAnimUI() {
    $('ic-play').style.display = this.anim.playing ? 'none' : '';
    $('ic-pause').style.display = this.anim.playing ? '' : 'none';
  }

  /* ---------- 视口（拾取 / 拖放） ---------- */

  bindViewport() {
    const dom = this.core.renderer.domElement;
    dom.addEventListener('click', (e) => {
      if (e.detail === 0) return;
      const hit = this.outliner.raycast(this.core.active, this.core.pickables || this.core.scene, e, dom);
      const nodes = hit ? [hit] : [];
      this.outliner.highlightFromPick(nodes);
    });
    window.addEventListener('dragover', (e) => { e.preventDefault(); $('drop-hint').classList.add('visible'); });
    window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) $('drop-hint').classList.remove('visible'); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      $('drop-hint').classList.remove('visible');
      const f = e.dataTransfer?.files?.[0];
      if (f && f.path) {
        const url = 'file://' + f.path.split('/').map(encodeURIComponent).join('/');
        this.openFile(url, { name: f.name, ext: f.name.split('.').pop(), append: e.dataTransfer.files.length > 1 || e.shiftKey });
      }
    });
  }

  /* ---------- 主题 ---------- */

  setTheme(theme) {
    document.body.dataset.theme = theme;
    this.core.setTheme(theme);
    this.shading.apply(this.core.models, theme);
    this.shading.updateEdges(this.core.models, theme);
    postToNative({ type: 'theme', theme });
    try { localStorage.setItem('mp3d-theme', theme); } catch { /* QL 无存储 */ }
  }

  /* ---------- 模型加载 ---------- */

  async openFile(url, opts = {}) {
    const ext = (opts.ext || url.split('.').pop() || '').toLowerCase();
    if (!SUPPORTED.has(ext)) {
      this.showError(`暂不支持 .${ext} 格式。\n支持：GLB / GLTF / OBJ / FBX / STL / PLY / DAE / 3MF / USDZ / BLEND(经主应用)`);
      return;
    }
    // 超大文件警告
    if (opts.size && opts.size > BIG_FILE_WARN) {
      const ok = await this.confirmModal('超大文件警告',
        `该文件约 ${(opts.size / 1024 / 1024).toFixed(0)} MB，加载和渲染可能明显缓慢甚至失败。是否继续？`, null, '继续加载');
      if (!ok) { this.hideLoading(); return; }
    }
    this.showLoading('正在加载模型…');
    try {
      const result = await loadModelFile(url, ext, { onProgress: (r) => this.showProgress(r) });
      this.addModelResult(result, opts);
      this.setFileInfo({ name: opts.name, size: opts.size, ext: opts.displayExt || ext, note: opts.note });
      // 无自带地面 → 询问是否添加系统默认地面（当前未显示系统地面时）
      if (!opts.append && !this.core.detectModelGround() && !this.core.groundVisible) {
        const ok = await this.confirmModal('添加系统默认地面',
          '模型没有自带地面。是否添加系统默认地面？\n（可随时在左侧「地面」开关中显示/隐藏）', null, '添加地面');
        if (ok) {
          $('opt-ground').checked = true;
          this.core.setGroundVisible(true);
          this.syncGroundRow();
          this.showGroundNote('使用系统地面');
        }
      }
    } catch (err) {
      console.error(err);
      this.showError(String(err?.message || err));
      this.hideLoading();
    }
  }

  addModelResult(result, opts = {}) {
    const { root, animations, warnings } = result;
    // 居中：底面贴网格
    const box = new THREE.Box3().setFromObject(root);
    const center = box.getCenter(new THREE.Vector3());
    root.position.x -= center.x; root.position.z -= center.z; root.position.y -= box.min.y;

    root.traverse(o => { if (o.isMesh) { o.userData.shadowWanted = true; } });

    this.clearImageView();
    if (!opts.append) this.clearModels(false);
    const id = THREE.MathUtils.generateUUID();
    this.core.models.push({ id, root, name: opts.name || 'model' });
    this.core.scene.add(root);
    this.core.refreshPickables();
    this.core.ensureGrid();

    if (animations?.length) {
      const mixer = new THREE.AnimationMixer(root);
      this.anim.setup(mixer, animations, {
        onClipChanged: (i, clip) => {
          $('anim-clip').value = String(i);
          $('anim-name').textContent = clip.name || `动画 ${i + 1}`;
        },
      });
      $('animbar').classList.add('visible');
      $('anim-clip').innerHTML = animations.map((c, i) => `<option value="${i}">${c.name || '动画 ' + (i + 1)}</option>`).join('');
      this.syncAnimUI();
    } else {
      this.anim.dispose();
      $('animbar').classList.remove('visible');
    }

    this.refreshStats(opts.size);
    this.outliner.build(this.core.models);
    if (this.shading.mode !== 'shaded' || this.shading.wireframe) this.shading.apply(this.core.models, this.core.theme);
    if (this.shading.edges) this.shading.setEdges(true, this.core.models, this.core.theme);
    if (this.core.shadowVisible) this.core.setShadowVisible(true);

    if (warnings.length) this.toast(warnings.slice(0, 2).join('；'), 3500);
    this.core.resetView();
    this.core.requestShadowUpdate();
    this.syncGroundRow();
    this.hideLoading();
    this.hideError();
  }

  clearModels(rebuildTree = true) {
    for (const m of this.core.models) {
      this.core.scene.remove(m.root);
      m.root.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(mt => {
          for (const k in mt) { const v = mt[k]; if (v && v.isTexture) v.dispose(); }
          mt.dispose();
        });
      });
    }
    this.core.models = [];
    this.core.refreshPickables();
    this.anim.dispose();
    $('animbar').classList.remove('visible');
    setHighlight(this._highlighted || [], false);
    this._highlighted = [];
    if (rebuildTree) this.outliner.build([]);
    this.refreshStats();
  }

  resetScene() {
    this.clearModels();
    this.setFileInfo({});
    this.core.resetView();
    this.toast('场景已重置');
  }

  dumpBBox() {
    const meshes = [];
    for (const m of this.core.models) m.root.traverse(o => {
      if (o.isMesh && o.geometry?.attributes?.position) {
        o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        const s = b.getSize(new THREE.Vector3());
        const c = b.getCenter(new THREE.Vector3());
        meshes.push({ name: (o.name || o.parent?.name || '?').slice(0, 24), verts: o.geometry.attributes.position.count,
                      maxDim: +Math.max(s.x, s.y, s.z).toFixed(3), cx: +c.x.toFixed(2), cy: +c.y.toFixed(2), cz: +c.z.toFixed(2) });
      }
    });
    const box = this.core.smartBoundingBox();
    const bs = box ? box.getSize(new THREE.Vector3()) : null;
    postToNative({ type: 'debug-info', meshes,
                   smartSize: bs ? `${bs.x.toFixed(2)}x${bs.y.toFixed(2)}x${bs.z.toFixed(2)}` : 'null',
                   camDist: +this.core.active.position.distanceTo(this.core.controls.target).toFixed(2) });

  }

  getSmartSize() {
    const b = this.core.smartBoundingBox();
    if (!b) return null;
    const s = b.getSize(new THREE.Vector3());
    return { x: +s.x.toFixed(2), y: +s.y.toFixed(2), z: +s.z.toFixed(2) };
  }

  updateButtonStates() {
    const has = this.core.models.length > 0;
    // 无模型时禁用：重置视角/快照/导出/截图（保留打开/合并/主题可用）
    const ids = ['tb-reset-view', 'tb-snapshot', 'tb-export-glb', 'tb-shot', 'tb-reset-scene'];
    for (const id of ids) $(id).disabled = !has;
    document.querySelectorAll('#view-presets button').forEach(b => b.disabled = !has);
    document.querySelectorAll('#tb-shading .mode-card').forEach(b => b.disabled = !has);
    const optIds = ['opt-grid', 'opt-axes', 'opt-shadow', 'opt-edges', 'opt-transparent-shot'];
    for (const id of optIds) $(id).disabled = !has;
    document.getElementById('tb-cam-kind').disabled = !has;
  }

  refreshStats(sizeBytes) {
    const st = this.core.models.length ? computeStats(this.core.models[0].root, this.core.models.slice(1)) : null;
    const fmt = (v) => v == null ? '—' : v >= 1e6 ? (v / 1e6).toFixed(2) + ' M' : v >= 1e3 ? (v / 1e3).toFixed(1) + ' k' : String(v);
    let sizeText = '—';
    if (st && this.core.models.length) {
      const box = new THREE.Box3();
      for (const m of this.core.models) box.expandByObject(m.root);
      if (!box.isEmpty()) {
        const s = box.getSize(new THREE.Vector3());
        const f = (x) => {
          if (!isFinite(x)) return '—';
          return (Math.round(x * 100) / 100).toString(); // 去尾 0：1.10→1.1、2.00→2
        };
        sizeText = `${f(s.x)} × ${f(s.y)} × ${f(s.z)}`;
      }
    }
    $('st-vertices').textContent = st ? fmt(st.vertices) : '—';
    $('st-triangles').textContent = st ? fmt(st.triangles) : '—';
    $('st-meshes').textContent = st ? String(st.meshes) : '—';
    $('st-materials').textContent = st ? String(st.materials) : '—';
    $('st-size').textContent = sizeText;
    $('st-animations').textContent = String(this.anim.clips.length);
    // 底部状态栏（等宽统计，3DMate 风格）
    $('sb-stats').textContent = st
      ? `${fmt(st.triangles)} tris · ${st.meshes} meshes · ${this.fmtBytes(sizeBytes)}`
      : '— tris · — meshes';
    this.updateButtonStates();
  }

  setFileInfo(opts = {}) {
    if (!opts.name) { $('file-section').classList.add('hidden'); return; }
    $('file-section').classList.remove('hidden');
    $('file-name').textContent = opts.name;
    $('file-size').textContent = opts.size ? this.fmtBytes(opts.size) : '—';
    const ext = (opts.displayExt || opts.ext || '').toUpperCase();
    const badge = $('file-format');
    badge.textContent = ext || '—';
    badge.style.background = {
      GLB: '#3a6df0', GLTF: '#2f8ddd', OBJ: '#9a68d9', FBX: '#c95d2e', STL: '#2e9e63',
      PLY: '#2e9e8f', DAE: '#b5588c', '3MF': '#d9a02e', BLEND: '#e87d3e', USDZ: '#4a8fd0',
    }[ext] || '#5c6270';
    const note = $('file-note');
    if (opts.note) { note.textContent = opts.note; note.classList.remove('hidden'); }
    else note.classList.add('hidden');
    this.currentName = opts.name;
  }

  fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  /* ---------- 视角快照 ---------- */

  loadSnapshots() {
    try { return JSON.parse(localStorage.getItem('mp3d-snaps') || '[]'); } catch { return []; }
  }
  persistSnaps(list) {
    try { localStorage.setItem('mp3d-snaps', JSON.stringify(list)); } catch { /* QL 无存储 */ }
  }
  saveSnapshot() {
    if (!this.core.models.length) { this.toast('请先加载模型'); return; }
    const list = this.loadSnapshots();
    const snap = this.core.snapshot();
    snap.name = `视角 ${list.length + 1}（${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）`;
    list.push(snap);
    this.persistSnaps(list);
    this.renderSnaps();
    this.toast('视角快照已保存');
  }
  renderSnaps() {
    const list = this.loadSnapshots();
    const el = $('snap-list');
    if (!list.length) { el.innerHTML = '<div class="tree-empty">暂无快照</div>'; return; }
    el.innerHTML = '';
    list.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'snap-item';
      const go = document.createElement('button');
      go.className = 'snap-go';
      go.textContent = s.name;
      go.addEventListener('click', () => { this.core.restoreSnapshot(s); this.toast('已恢复：' + s.name); });
      const del = document.createElement('button');
      del.className = 'snap-del';
      del.textContent = '✕';
      del.title = '删除快照';
      del.addEventListener('click', () => { list.splice(i, 1); this.persistSnaps(list); this.renderSnaps(); });
      item.appendChild(go); item.appendChild(del);
      el.appendChild(item);
    });
  }

  /* ---------- 截图 / 导出 ---------- */

  screenshot() {
    const savedGrid = this.core.gridVisible;
    if (this.core.grid) this.core.grid.visible = false;
    if (this.core.axes) this.core.axes.visible = false;
    const savedBg = this.core.scene.background;
    if (this.transparentShot) this.core.scene.background = null;

    const w = this.core.container.clientWidth || 800, h = this.core.container.clientHeight || 600;
    const prevPR = this.core.renderer.getPixelRatio();
    this.core.renderer.setPixelRatio(3);
    this.core.renderer.setSize(w, h, false);
    this.core.renderer.render(this.core.scene, this.core.active);
    const data = this.core.renderer.domElement.toDataURL('image/png');

    this.core.renderer.setPixelRatio(prevPR);
    this.core.renderer.setSize(w, h, false);
    this.core.scene.background = savedBg;
    if (this.core.grid) this.core.grid.visible = savedGrid;
    if (this.core.axes) this.core.axes.visible = this.core.axesVisible;
    this.core.renderer.render(this.core.scene, this.core.active);
    this.core.requestRender();

    const name = (this.currentName || 'model').replace(/\.[^.]+$/, '') + '.png';
    if (bridge) postToNative({ type: 'screenshot', name, data });
    else {
      const a = document.createElement('a');
      a.href = data; a.download = name; a.click();
      this.toast(`已导出 ${Math.round(w * 3)}×${Math.round(h * 3)} 截图`);
    }
  }

  /** 一键导出所有预设视角（前/后/左/右/顶/底/45°）的高分辨率 PNG */
  async exportAllViews() {
    if (!this.core.models.length) { this.toast('请先加载模型'); return; }
    const views = [
      { key: 'front', label: '前' }, { key: 'back', label: '后' },
      { key: 'left', label: '左' }, { key: 'right', label: '右' },
      { key: 'top', label: '顶' }, { key: 'bottom', label: '底' },
      { key: 'iso45', label: '45度' },
    ];
    const base = (this.currentName || 'model').replace(/\.[^.]+$/, '');
    // 保存当前视角与显示状态，导出后完整恢复
    const saved = this.core.snapshot();
    const savedGrid = this.core.gridVisible, savedAxes = this.core.axesVisible;
    const savedBg = this.core.scene.background;
    if (this.core.grid) this.core.grid.visible = false;
    if (this.core.axes) this.core.axes.visible = false;

    const w = this.core.container.clientWidth || 800, h = this.core.container.clientHeight || 600;
    const prevPR = this.core.renderer.getPixelRatio();
    this.core.renderer.setPixelRatio(3);
    this.core.renderer.setSize(w, h, false);

    const images = [];
    this.showLoading('正在导出 7 个视角…');
    for (const v of views) {
      this.core.setPresetView(v.key);
      this.core.renderer.render(this.core.scene, this.core.active);
      const data = this.core.renderer.domElement.toDataURL('image/png');
      images.push({ view: v.key, label: v.label, name: `${base}-${v.label}.png`, data });
      await new Promise(r => setTimeout(r, 0)); // 让出主线程，保持界面响应
    }

    // 恢复现场
    this.core.renderer.setPixelRatio(prevPR);
    this.core.renderer.setSize(w, h, false);
    this.core.scene.background = savedBg;
    if (this.core.grid) this.core.grid.visible = savedGrid;
    if (this.core.axes) this.core.axes.visible = savedAxes;
    this.core.restoreSnapshot(saved);
    this.core.requestShadowUpdate();
    this.hideLoading();

    if (bridge) {
      postToNative({ type: 'export-views', name: base, images });
      this.toast(`已生成 ${images.length} 张视角图，请选择保存位置…`, 2500);
    } else {
      for (const im of images) { const a = document.createElement('a'); a.href = im.data; a.download = im.name; a.click(); }
      this.toast(`已导出 ${images.length} 张视角图`);
    }
  }

  async doExportGLB() {
    if (!this.core.models.length) { this.toast('请先加载模型'); return; }
    this.showLoading('正在导出 GLB…');
    try {
      const merge = this.core.models.length > 1;
      const blob = await exportGLB(this.core.models, false);
      const name = (this.currentName || 'model').replace(/\.[^.]+$/, '') + '-export.glb';
      if (bridge) {
        const buf = await blob.arrayBuffer();
        let binary = '';
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        postToNative({ type: 'export-glb', name, data: btoa(binary) });
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; a.click();
      }
      this.toast('GLB 导出完成');
    } catch (err) {
      this.showError('GLB 导出失败：' + (err?.message || err));
    }
    this.hideLoading();
  }

  async copyEmbedCode() {
    const name = this.currentName || 'model.glb';
    const code = `<!-- 3D 模型网页嵌入（model-viewer） -->
<script type="module"
  src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"><\/script>
<model-viewer
  src="./${name}"
  alt="${name} 3D 模型"
  camera-controls
  auto-rotate
  shadow-intensity="1"
  style="width:100%;height:480px;background:#17191d">
</model-viewer>`;
    try {
      await navigator.clipboard.writeText(code);
      this.toast('嵌入代码已复制到剪贴板');
    } catch {
      this.confirmModal('网页嵌入代码', code.replace(/</g, '&lt;').replace(/\n/g, '<br>'), null, '关闭');
    }
  }

  /* ---------- QL 分块加载 ---------- */

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
    this.setLoadingText(`正在接收模型数据… ${this.fmtBytes(s.received)}`);
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
      await new Promise(r => setTimeout(r, 30));
      const result = loadFromBuffer(merged.buffer, s.ext);
      this.addModelResult(result, { name: s.name, size: s.size, ext: s.displayExt || s.ext, note: s.note });
      this.setFileInfo({ name: s.name, size: s.size, ext: s.displayExt || s.ext, note: s.note });
    } catch (err) {
      this.showError(String(err?.message || err));
      this.hideLoading();
    }
  }

  showGroundNote(text) {
    const el = document.getElementById('sb-ground');
    if (!el) return;
    el.textContent = 'ⓖ ' + text;
    el.style.display = '';
  }
  hideGroundNote() {
    const el = document.getElementById('sb-ground');
    if (el) el.style.display = 'none';
  }

  /* ---------- 缩略图显示（QL 降级路径） ---------- */

  showImage(dataUrl) {
    this.hideError(); this.hideLoading();
    let el = document.getElementById('image-view');
    if (!el) {
      el = document.createElement('div');
      el.id = 'image-view';
      Object.assign(el.style, {
        position: 'absolute', inset: '0', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: '20',
        pointerEvents: 'none', background: 'var(--bg-viewport)',
      });
      const img = document.createElement('img');
      Object.assign(img.style, { maxWidth: '86%', maxHeight: '80%', borderRadius: '10px', boxShadow: '0 8px 40px rgba(0,0,0,.4)' });
      const cap = document.createElement('div');
      cap.id = 'image-view-cap';
      Object.assign(cap.style, { position: 'absolute', bottom: '18px', width: '100%', textAlign: 'center', color: 'var(--text-faint)', fontSize: '12px' });
      el.appendChild(img); el.appendChild(cap);
      this.core.container.appendChild(el);
    }
    el.style.display = 'flex';
    el.querySelector('img').src = dataUrl;
  }

  clearImageView() {
    const el = document.getElementById('image-view');
    if (el) el.style.display = 'none';
  }

  /* ---------- UI 工具 ---------- */

  showLoading(text) { $('loading').classList.remove('hidden'); this.setLoadingText(text); $('progress-wrap').classList.add('hidden'); }
  setLoadingText(t) { $('loading-text').textContent = t; }
  showProgress(ratio) {
    $('progress-wrap').classList.remove('hidden');
    $('progress-bar').style.width = Math.round(ratio * 100) + '%';
  }
  hideLoading() { $('loading').classList.add('hidden'); }
  showError(detail, title = '无法加载模型') {
    $('error-panel').classList.remove('hidden');
    $('error-title').textContent = title;
    $('error-detail').textContent = detail;
    this.hideLoading();
  }
  hideError() { $('error-panel').classList.add('hidden'); }
  toast(text, ms = 2200) {
    const el = $('toast');
    el.textContent = text;
    el.classList.toggle('multiline', text.includes('\n'));
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  confirmModal(title, body, onOk, okText = '确定') {
    return new Promise((resolve) => {
      $('modal-title').textContent = title;
      $('modal-body').innerHTML = body;
      $('modal-ok').textContent = okText;
      $('modal-back').classList.add('visible');
      const done = (v) => {
        $('modal-back').classList.remove('visible');
        $('modal-ok').onclick = null; $('modal-cancel').onclick = null;
        $('modal-back').onclick = null;
        resolve(v);
        if (v) onOk?.(v);
      };
      $('modal-ok').onclick = () => done(true);
      $('modal-cancel').onclick = () => done(false);
      $('modal-back').onclick = (e) => { if (e.target === $('modal-back')) done(false); };
    });
  }

  onFrame(delta) {
    const animState = this.anim.update(delta);
    // 动画播放 / 自动旋转期间需要逐帧渲染
    const animating = !!(animState && this.anim.playing);
    this.core.continuous = animating || this.core.turntableWanted;
    if (animating) this.core.requestRender();
    if (animState && this.anim.playing) {
      const now = performance.now();
      if (!this._lastAnimUi || now - this._lastAnimUi > 100) {
        this._lastAnimUi = now;
        $('anim-time').value = Math.round((animState.time / animState.duration) * 1000);
        $('anim-clock').textContent = `${animState.time.toFixed(2)} / ${animState.duration.toFixed(2)}s`;
      }
    }
  }
}

/* ================= 初始化与命令分发 ================= */

window.addEventListener('error', (e) => {
  window.__lastErr = `${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`;
  postToNative({ type: 'js-error', msg: window.__lastErr });
});
window.addEventListener('unhandledrejection', (e) => {
  window.__lastErr = 'unhandled: ' + (e.reason?.message || e.reason);
  postToNative({ type: 'js-error', msg: window.__lastErr });
});

const app = new App();

window.viewer = {
  app,
  openFile: (url, opts) => app.openFile(url, opts || {}),
  loadFromBuffer: (buf, ext) => app.addModelResult(loadFromBuffer(buf, ext), {}),
  chunksStart: (m) => app.chunksStart(m),
  chunksPush: (d) => app.chunksPush(d),
  chunksFinish: () => app.chunksFinish(),
  cmdB64: (b64) => {
    try {
      const cmd = b64ToJSON(b64);
      switch (cmd.op) {
        case 'open-url': return app.openFile(cmd.url, cmd);
        case 'chunks-start': return app.chunksStart(cmd);
        case 'push': return app.chunksPush(cmd.data);
        case 'finish': return app.chunksFinish();
        case 'loading': return app.showLoading(cmd.text || '处理中…');
        case 'status': return app.setLoadingText(cmd.text || '处理中…');
        case 'error': return app.showError(cmd.detail || '', cmd.title || '提示');
        case 'show-image': {
          app.clearModels(false);
          app.showImage(cmd.dataUrl);
          if (cmd.name) app.setFileInfo({ name: cmd.name, size: cmd.size, displayExt: cmd.displayExt || 'BLEND', note: '内嵌缩略图 · 在主应用中打开可 3D 交互' });
          return;
        }
        case 'set-fileinfo': return app.setFileInfo(cmd);
        case 'reset-view': return app.core.resetView();
        case 'screenshot': return app.screenshot();
        case 'set-theme': return app.setTheme(cmd.theme);
        case 'debug-bbox': {
          const meshes = [];
          for (const m of app.core.models) m.root.traverse(o => {
            if (o.isMesh && o.geometry?.attributes?.position) {
              o.geometry.computeBoundingBox();
              const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
              const s = b.getSize(new THREE.Vector3());
              const c = b.getCenter(new THREE.Vector3());
              meshes.push({ name: o.name || o.parent?.name || '?', verts: o.geometry.attributes.position.count,
                            maxDim: +Math.max(s.x, s.y, s.z).toFixed(3), cx: +c.x.toFixed(2), cy: +c.y.toFixed(2), cz: +c.z.toFixed(2) });
            }
          });
          const box = app.core.smartBoundingBox();
          const bs = box ? box.getSize(new THREE.Vector3()) : null;
          postToNative({ type: 'debug-info', meshes, smartSize: bs ? `${bs.x.toFixed(2)}x${bs.y.toFixed(2)}x${bs.z.toFixed(2)}` : 'null' });
          return;
        }
        case 'toggle': {
          if (cmd.key === 'grid') { const c = $('opt-grid'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); }
          // 工具栏线框按钮：切到线框；已在线框则切回着色（toggle 语义）
          if (cmd.key === 'wire' || cmd.key === 'wireframe') {
            const target = app.shading.mode === 'wire' ? 'shaded' : 'wire';
            document.querySelector(`#tb-shading .mode-card[data-mode="${target}"]`)?.click();
          }
          if (cmd.key === 'autorotate') $('tb-turntable').click();
          return;
        }
      }
    } catch (e) { console.error('cmd error', e); }
  },
};

// 恢复主题偏好
try {
  const saved = localStorage.getItem('mp3d-theme');
  if (saved) app.setTheme(saved);
} catch { /* QL 无存储 */ }

// QL 设置回读（native 注入）
// 原生端保存完成后回传：显示含完整路径的成功提示
window.viewer.onExportViewsDone = (path, count) => {
  if (!path || !count) { app.toast('未导出任何图片', 3000); return; }
  app.toast(`已导出 ${count} 张视角图\n保存位置：${path}`, 9000);
};

window.viewer.applyQlSettingsB64 = (b64) => {
  try {
    const json = JSON.parse(new TextDecoder('utf-8').decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    $('set-ql-ground').checked = json.qlGroundEnabled !== false;
    $('set-ql-hidebackdrop').checked = json.qlHideBackdrop !== false;
    document.querySelectorAll('#ql-ground-colors .gswatch').forEach(b =>
      b.classList.toggle('active', b.dataset.c === (json.qlGroundColor || '#ffffff')));
  } catch (e) { /* 忽略 */ }
};

// 拖放提示（路径注入由原生处理，浏览器测试用 files）
if (!bridge) {
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f && f.path) {
      const url = 'file://' + f.path.split('/').map(encodeURIComponent).join('/');
      app.openFile(url, { name: f.name, ext: f.name.split('.').pop() });
    }
  });
}
