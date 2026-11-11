import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

/* ============ 渲染模式 ============ */

export class ShadingManager {
  constructor() {
    this.mode = 'shaded';
    this.wireframe = false;
    this.edges = false;
    this.edgeOverlays = [];
    this.normalMat = new THREE.MeshNormalMaterial();
    this.xrayMat = new THREE.MeshBasicMaterial({ color: 0x8fa8d8, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
    this.xrayTheme = 'dark';
  }

  apply(models, theme) {
    if (theme !== this.xrayTheme) {
      this.xrayTheme = theme;
      this.xrayMat.color.set(theme === 'light' ? 0x3a4a6a : 0x8fa8d8);
    }
    for (const m of models) {
      m.root.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.userData.origMaterial) o.userData.origMaterial = o.material;
        const orig = o.userData.origMaterial;
        switch (this.mode) {
          case 'normal':
            if (o.geometry && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();
            o.material = this.normalMat;
            break;
          case 'xray': o.material = this.xrayMat; break;
          default: o.material = orig;
        }
        const wf = this.mode === 'wire' ? true : this.wireframe;
        if (Array.isArray(o.material)) o.material.forEach(mt => mt.wireframe = wf);
        else o.material.wireframe = wf;
        o.castShadow = o.userData.shadowWanted ?? o.castShadow;
      });
    }
    this.updateEdges(models, theme);
  }

  updateEdges(models, theme) {
    for (const e of this.edgeOverlays) { e.parent?.remove(e); e.geometry.dispose(); e.material.dispose(); }
    this.edgeOverlays = [];
    if (!this.edges) return;
    const mat = new THREE.LineBasicMaterial({ color: theme === 'light' ? 0x333a45 : 0xaebdd8, transparent: true, opacity: 0.85 });
    for (const m of models) {
      m.root.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        try {
          const eg = new THREE.EdgesGeometry(o.geometry, 30);
          const line = new THREE.LineSegments(eg, mat);
          o.add(line);
          this.edgeOverlays.push(line);
        } catch { /* 复杂几何跳过 */ }
      });
    }
  }

  setMode(mode, models, theme) { this.mode = mode; this.apply(models, theme); }
  setWireframe(v, models, theme) { this.wireframe = v; this.apply(models, theme); }
  setEdges(v, models, theme) { this.edges = v; this.updateEdges(models, theme); }
}

/* ============ 结构树 / 拾取 / 显隐 ============ */

export class Outliner {
  constructor(treeEl, onSelect) {
    this.treeEl = treeEl;
    this.onSelect = onSelect;
    this.selected = new Set();
    this.rowByUuid = {}; // 必须在构造函数初始化：未加载模型时拾取也会访问它
    this.nodeByUuid = {}; // uuid → 节点（用于批量选择）
    this.axesProvider = null; // 由 app 注入 core.modelAxes，用于自动标注部件位置
    this.modelBox = null;    // 模型整体包围盒，用于判定部件位置
  }

  /** 部件分组键：把属于同一逻辑部件的多个节点归为一组。
   *  规则：取名称的主词（第一段，或包含的已知主词），
   *  第二段若是颜色/材质描述则保留（区分「其它覆盖件_灰」与「其它覆盖件_粉」）。
   *  例：座椅_坐垫 / 座椅_靠背 / 座椅支架 → 座椅
   *      其它覆盖件_灰_前右 → 其它覆盖件 灰
   *      轮胎_前右 / 轮毂_前右 → 轮胎 / 轮毂（不同部件，不合并） */
  groupKeyOf(name) {
    if (!name) return '';
    const clean = String(name).replace(/[（(].*?[）)]/g, '').trim();
    const parts = clean.split(/[_\-\s]+/).filter(Boolean);
    if (!parts.length) return '';
    let key = parts[0];
    // 无分隔符的名称（如「座椅支架」）：若包含已知主词则归入该主词
    if (parts.length === 1 && this._groupStems?.length) {
      // 排除自身（否则「座椅支架」会匹配到自己而不是「座椅」）
      const hit = this._groupStems.find(st => st.length >= 2 && st !== key && key.includes(st));
      if (hit) key = hit;
    }
    if (parts[1] && /^(灰|粉|蓝|黑|白|红|绿|黄|橙|紫|金属|碳纤维|哑光|亮面|深灰|浅灰|left|right|front|rear)/i.test(parts[1])) {
      key += ' ' + parts[1];
    }
    return key.trim().toLowerCase();
  }

  /** 依据部件包围盒中心在模型坐标系中的位置，给出「车头/车尾/左侧/右侧/中部」标签。
   *  模型命名不可靠时（部分导出器名称无语义），位置标签可帮助用户识别部件。 */
  positionLabel(node) {
    const axes = this.axesProvider?.();
    if (!axes || !node?.geometry) return '';
    const box = new THREE.Box3().setFromObject(node);
    if (box.isEmpty()) return '';
    const c = box.getCenter(new THREE.Vector3());
    const whole = this.modelBox;
    if (!whole || whole.isEmpty()) return '';
    const wsize = whole.getSize(new THREE.Vector3());
    const wctr = whole.getCenter(new THREE.Vector3());
    const d = c.clone().sub(wctr);
    const fwd = axes.forward, rgt = axes.right;
    const along = d.dot(fwd);   // + 为车头方向
    const side = d.dot(rgt);    // + 为车体右侧
    const halfL = Math.max(1e-6, wsize.dot(fwd) * 0.22);
    const halfW = Math.max(1e-6, wsize.dot(rgt) * 0.22);
    const parts = [];
    if (along > halfL) parts.push('车头');
    else if (along < -halfL) parts.push('车尾');
    if (side > halfW) parts.push('右侧');
    else if (side < -halfW) parts.push('左侧');
    return parts.join('·');
  }

  build(models) {
    // 阻止结构树内出现文本选择光标/选中高亮
    if (!this._selGuardBound) {
      this._selGuardBound = true;
      this.treeEl.addEventListener('selectstart', (e) => e.preventDefault());
      this.treeEl.addEventListener('mousedown', (e) => {
        // 在非按钮元素上阻止默认行为，彻底避免拖动选中文本
        if (e.target?.closest('button')) return;
        e.preventDefault();
      });
    }
    this.treeEl.innerHTML = '';
    this.selected.clear();
    this.rowByUuid = {};
    // 收集主词表（名称中 '_' 之前的主词），供 groupKeyOf 归组使用
    this._groupStems = [];
    for (const m of models) {
      m.root.traverse(o => {
        const nm = o.name || '';
        const stem = nm.split(/[_\-\s]+/)[0];
        if (stem && stem.length >= 2 && !this._groupStems.includes(stem)) this._groupStems.push(stem);
      });
    }
    this._groupStems.sort((a, b) => b.length - a.length); // 长主词优先匹配
    let total = 0;
    for (const m of models) {
      const rootRow = this.makeRow(m.root, m.name, true);
      this.treeEl.appendChild(rootRow.el);
      total += this.buildChildren(m.root, rootRow.childrenEl, 0);
    }
    if (!models.length || total === 0) {
      this.treeEl.innerHTML = '<div class="tree-empty">加载模型后显示场景层级</div>';
    }
  }

  buildChildren(node, container, depth) {
    let count = 0;
    for (const child of node.children) {
      if (child.type === 'LineSegments' || child.type === 'AxesHelper' || child.type === 'GridHelper' || child.type === 'Line') continue;
      const isGroup = child.children.length > 0 && !child.isMesh;
      const row = this.makeRow(child, child.name || (child.isMesh ? 'Mesh' : 'Group'), isGroup);
      container.appendChild(row.el);
      count++;
      if (child.isMesh) count++;
      if (isGroup) {
        count += this.buildChildren(child, row.childrenEl, depth + 1);
      }
    }
    return count;
  }

  makeRow(node, label, hasChildren) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.uuid = node.uuid;

    const twist = document.createElement('span');
    twist.className = 'twist' + (hasChildren ? '' : ' leaf');
    twist.textContent = hasChildren ? '+' : ''; // 加粗 + 折叠 / − 展开

    const icon = document.createElement('span');
    icon.className = 'ticon';
    icon.innerHTML = node.isMesh
      ? '<svg viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 12l9-5M12 12L3 7m9 5v10"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';

    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = label || '(未命名)';

    // 位置标签：命名本身已含方向词时不再重复标注
    let posTag = '';
    try {
      if (!/(前|后|左|右|front|rear|back|left|right)/i.test(label || '')) {
        posTag = this.positionLabel(node);
      }
    } catch { /* 忽略 */ }
    const pos = document.createElement('span');
    pos.className = 't-pos';
    pos.textContent = posTag;
    pos.hidden = !posTag;

    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.title = '显示 / 隐藏';
    eye.innerHTML = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/></svg>';

    row.appendChild(twist); row.appendChild(icon); row.appendChild(name); row.appendChild(pos); row.appendChild(eye);

    const childrenEl = document.createElement('div');
    childrenEl.className = 'tree-children collapsed'; // 默认所有层级折叠
    // 子级容器必须与行「平级」（外包 tree-item）：挂在 row 内会被 flex 布局横向排列成列
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.appendChild(row);
    item.appendChild(childrenEl);

    const toggleTwist = () => {
      if (!hasChildren) return;
      const nowCollapsed = childrenEl.classList.toggle('collapsed');
      twist.textContent = nowCollapsed ? '+' : '−';
    };
    twist.addEventListener('click', (e) => { e.stopPropagation(); toggleTwist(); });
    row.addEventListener('dblclick', (e) => { e.preventDefault(); toggleTwist(); }); // 双击行也可展开/折叠
    // 选择语义（必须合并为一个 click 处理器，注册多个会导致互相覆盖）：
    //   单击            = 单选
    //   Cmd/Ctrl + 单击 = 追加 / 取消（离散多选）
    //   Shift + 单击    = 从上次选中项到本项的连续区间多选（类似 Excel）
    row.addEventListener('click', (e) => {
      if (e.shiftKey && this._anchorRow && this._anchorRow !== row) {
        this.selectRange(this._anchorRow, row);
      } else if (e.metaKey || e.ctrlKey) {
        this.select(node, row, true);
      } else {
        this.select(node, row, false);
      }
      this._anchorRow = row;
    });
    // 右键：按「同名部件组」批量选中。
    // 一个视觉部件常被拆成多个节点（如座椅 = 坐垫 + 靠背 + 支架；车轮 = 轮胎 + 轮毂），
    // 逐个点选容易只显示一半；右键一次选中同组即可完整查看。
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const group = this.groupKeyOf(label || '');
      if (!group) { this.toast('该部件没有同名分组'); return; }
      const hits = [];
      for (const r of Object.values(this.rowByUuid || {})) {
        const t = r.querySelector('.tname')?.textContent || '';
        if (this.groupKeyOf(t) === group) hits.push(r);
      }
      if (hits.length < 2) { this.toast(`「${label}」只有 1 个节点，无需分组`); return; }
      this.selected.clear();
      for (const r of hits) {
        r.classList.add('selected');
        const n = this.nodeByUuid?.[r.dataset.uuid];
        if (n) this.selected.add(n);
      }
      this.onSelect([...this.selected]);
      this.toast(`已选中「${group}」的 ${hits.length} 个部件，可点「单独查看」`, 3200);
    });
    let visible = true;
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      visible = !visible;
      node.visible = visible;
      eye.classList.toggle('off', !visible);
      eye.innerHTML = visible
        ? '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6c2 0 3.8.6 5.3 1.4M21.5 13.4c.3-.5.5-.9.5-.9s-3.5-6-10-6M3 3l18 18"/></svg>';
    });

    this.rowByUuid[node.uuid] = row;
    this.nodeByUuid = this.nodeByUuid || {};
    this.nodeByUuid[node.uuid] = node;

    return { el: item, childrenEl }; // el 是外层容器（行 + 子级），childrenEl 供父级挂子节点
  }

  /** 连续区间选择（Shift + 单击）：选中 anchorRow 到 targetRow 之间的所有可见行 */
  selectRange(anchorRow, targetRow) {
    const rows = [...this.treeEl.querySelectorAll('.tree-row')];
    const a = rows.indexOf(anchorRow), b = rows.indexOf(targetRow);
    if (a < 0 || b < 0) { this.select(this.nodeByUuid?.[targetRow.dataset.uuid], targetRow, false); return; }
    const [s, e] = a < b ? [a, b] : [b, a];
    this.selected.clear();
    for (const r of Object.values(this.rowByUuid || {})) r.classList.remove('selected');
    for (let i = s; i <= e; i++) {
      const r = rows[i];
      if (!r) continue;
      r.classList.add('selected');
      const n = this.nodeByUuid?.[r.dataset.uuid];
      if (n) this.selected.add(n);
    }
    this.onSelect([...this.selected]);
  }

  select(node, row, additive) {
    if (!additive) {
      for (const r of Object.values(this.rowByUuid)) r.classList.remove('selected');
      this.selected.clear();
    }
    if (this.selected.has(node)) {
      this.selected.delete(node);
      row?.classList.remove('selected');
    } else {
      this.selected.add(node);
      row?.classList.add('selected');
    }
    this.onSelect([...this.selected]);
  }

  highlightFromPick(nodes) {
    for (const r of Object.values(this.rowByUuid)) r.classList.remove('selected');
    this.selected.clear();
    for (const n of nodes) {
      const r = this.rowByUuid[n.uuid];
      if (r) { r.classList.add('selected'); this.selected.add(n); }
    }
    this.onSelect([...this.selected]);
  }

  raycast(camera, targets, event, dom) {
    const rect = dom.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects(targets, false);
    return hits.length ? hits[0].object : null;
  }
}

/** 选中高亮（emissive 提亮） */
export function setHighlight(nodes, on) {
  for (const n of nodes) {
    n.traverse?.((o) => {
      if (!o.isMesh) return;
      if (on) {
        if (!o.userData.origEmissive) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          o.userData.origEmissive = mats.map(m => m.emissive?.clone() ?? null);
          o.userData.origEmissiveIntensity = mats.map(m => m.emissiveIntensity ?? 1);
          mats.forEach(m => { if (m.emissive) { m.emissive.set(0x2a5fd8); m.emissiveIntensity = 0.55; } });
        }
      } else if (o.userData.origEmissive) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m, i) => { if (m.emissive && o.userData.origEmissive[i]) { m.emissive.copy(o.userData.origEmissive[i]); m.emissiveIntensity = o.userData.origEmissiveIntensity[i]; } });
        delete o.userData.origEmissive;
      }
    });
  }
}

/** 隔离显示：只显示给定节点集合 */
export function isolate(models, keepNodes) {
  const keep = new Set();
  for (const n of keepNodes) {
    n.traverse?.(o => keep.add(o));
    let p = n.parent;
    while (p) { keep.add(p); p = p.parent; }
  }
  for (const m of models) {
    m.root.traverse(o => { if (o.isMesh || o.isGroup || o.isObject3D) { if (o.userData.__iso === undefined) o.userData.__iso = o.visible; o.visible = keep.has(o) ? o.userData.__iso : false; } });
  }
}

export function clearIsolate(models) {
  for (const m of models) m.root.traverse(o => { if (o.userData.__iso !== undefined) { o.visible = o.userData.__iso; delete o.userData.__iso; } });
}

/* ============ 动画播放器 ============ */

export class AnimationPlayer {
  constructor() {
    this.mixer = null;
    this.clips = [];
    this.action = null;
    this.playing = false;
    this.speed = 1;
    this.loop = true;
  }

  setup(mixer, clips, ui) {
    this.mixer = mixer;
    this.clips = clips;
    this.ui = ui;
    this.playing = false;
    this.action = null;
    if (!clips.length) return;
    this.selectClip(0);
  }

  selectClip(index) {
    if (!this.mixer || !this.clips[index]) return;
    const wasPlaying = this.playing;
    if (this.action) this.action.stop();
    const clip = this.clips[index];
    this.action = this.mixer.clipAction(clip);
    this.action.setLoop(this.loop ? THREE.LoopRepeat : THREE.LoopOnce, this.loop ? Infinity : 1);
    this.action.timeScale = this.speed;
    this.action.clampWhenFinished = true;
    this.action.reset().play();
    this.action.paused = !this.playing && wasPlaying !== true;
    if (this.playing) this.action.play();
    this.ui?.onClipChanged?.(index, clip);
  }

  play() { this.playing = true; this.action?.setEffectiveTimeScale(this.speed); if (this.action) this.action.paused = false; }
  pause() { this.playing = false; if (this.action) this.action.paused = true; }
  setSpeed(s) { this.speed = s; if (this.action) this.action.setEffectiveTimeScale(s); }
  setLoop(v) { this.loop = v; if (this.action) this.action.setLoop(v ? THREE.LoopRepeat : THREE.LoopOnce, v ? Infinity : 1); }
  seek(ratio) {
    if (!this.action) return;
    const dur = this.action.getClip().duration;
    this.action.time = ratio * dur;
    this.mixer?.update(0);
  }
  update(delta) {
    if (!this.mixer) return null;
    this.mixer.update(delta * (this.playing ? 1 : 0));
    if (this.action) {
      const dur = this.action.getClip().duration;
      return { time: this.action.time % dur, duration: dur };
    }
    return null;
  }
  dispose() { this.mixer?.stopAllAction(); this.mixer = null; this.clips = []; this.action = null; this.playing = false; }
}

/* ============ 导出 ============ */

export function exportGLB(models, merge) {
  return new Promise((resolve, reject) => {
    let target;
    if (models.length === 1) {
      target = models[0].root;
    } else {
      target = new THREE.Group();
      for (const m of models) {
        const holder = new THREE.Group();
        holder.name = m.name;
        holder.add(m.root.clone(true));
        target.add(holder);
      }
    }
    if (merge) {
      // 基础轻量化：同材质 mesh 几何合并
      const byMat = new Map();
      target.updateMatrixWorld(true);
      target.traverse((o) => {
        if (!o.isMesh) return;
        const key = (Array.isArray(o.material) ? o.material.map(m => m.uuid).join('|') : o.material?.uuid) ?? 'none';
        const g = o.geometry.clone();
        g.applyMatrix4(o.matrixWorld);
        if (!byMat.has(key)) byMat.set(key, { geo: [], mat: Array.isArray(o.material) ? o.material[0] : o.material });
        byMat.get(key).geo.push(g);
      });
      if (byMat.size > 0 && [...byMat.values()].some(v => v.geo.length > 1)) {
        const merged = new THREE.Group();
        merged.name = 'Merged';
        for (const { geo, mat } of byMat.values()) {
          try {
            const g = geo.length === 1 ? geo[0] : BufferGeometryUtils.mergeGeometries(geo, false);
            merged.add(new THREE.Mesh(g, mat));
          } catch { geo.forEach(g => merged.add(new THREE.Mesh(g, mat))); }
        }
        target = merged;
      }
    }
    const exporter = new GLTFExporter();
    exporter.parse(target, (result) => {
      resolve(new Blob([result], { type: 'model/gltf-binary' }));
    }, (err) => reject(err), { binary: true, onlyVisible: true });
  });
}
