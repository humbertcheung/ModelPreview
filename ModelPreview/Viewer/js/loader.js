import * as THREE from 'three';
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
import { USDZLoader } from 'three/addons/loaders/USDZLoader.js';

export const SUPPORTED = new Set(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply', 'dae', '3mf', 'usdz']);
export const BIG_FILE_WARN = 200 * 1024 * 1024; // 200MB

function managerWithTGA(onMissingAsset) {
  const mgr = new THREE.LoadingManager();
  mgr.addHandler(/\.tga$/i, new TGALoader(mgr));
  if (onMissingAsset) {
    mgr.onError = (url) => onMissingAsset(url);
  }
  return mgr;
}

/** 加载任意支持的格式，返回 { root, animations, warnings } */
export async function loadModelFile(url, ext, opts = {}) {
  const r = await loadModelFileInner(url, ext, opts);
  if (r?.root) ensureNormals(r.root); // 缺法线的模型（法线模式黑面/PBR 光照异常）统一补平滑法线
  return r;
}

async function loadModelFileInner(url, ext, opts = {}) {
  const warnings = [];
  const onMissing = (u) => warnings.push(`缺少资源：${String(u).split('/').pop()}`);
  const mgr = managerWithTGA(onMissing);
  ext = (ext || url.split('.').pop() || '').toLowerCase();

  const withProgress = (loader) => (onProgress) => {
    return new Promise((resolve, reject) => {
      loader.load(url, (r) => resolve(r), (e) => { if (onProgress && e.total) onProgress(e.loaded / e.total); }, reject);
    });
  };

  switch (ext) {
    case 'glb':
    case 'gltf': {
      const loader = new GLTFLoader(mgr);
      const draco = new DRACOLoader();
      draco.setDecoderPath('./lib/addons/libs/draco/gltf/');
      loader.setDRACOLoader(draco);
      const gltf = await new Promise((resolve, reject) => {
        loader.load(url, resolve, (e) => { if (e.total) opts.onProgress?.(e.loaded / e.total); }, reject);
      });
      draco.dispose();
      return { root: gltf.scene, animations: gltf.animations || [], warnings };
    }
    case 'obj': {
      const loader = new OBJLoader(mgr);
      try {
        const mtlText = await (await fetch(url.replace(/\.obj(\?|$)/i, '.mtl$1'), { cache: 'no-store' })).text();
        if (!/^\s*</.test(mtlText)) {
          const dir = url.slice(0, url.lastIndexOf('/') + 1);
          const mtl = new MTLLoader(mgr).parse(mtlText, dir);
          mtl.preload();
          loader.setMaterials(mtl);
        }
      } catch { warnings.push('未找到配套 .mtl 材质，仅显示几何'); }
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      return { root: loader.parse(text), animations: [], warnings };
    }
    case 'fbx': {
      const loader = new FBXLoader(mgr);
      const obj = await new Promise((resolve, reject) => {
        loader.load(url, resolve, (e) => { if (e.total) opts.onProgress?.(e.loaded / e.total); }, reject);
      });
      return { root: obj, animations: obj.animations || [], warnings };
    }
    case 'stl': {
      const buf = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
      const geo = new STLLoader().parse(buf);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, defaultMat(false));
      return { root: mesh, animations: [], warnings };
    }
    case 'ply': {
      const buf = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
      const geo = new PLYLoader().parse(buf);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, defaultMat(!!geo.attributes.color || geo.hasColors));
      return { root: mesh, animations: [], warnings };
    }
    case 'dae': {
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      const dir = url.slice(0, url.lastIndexOf('/') + 1);
      const res = new ColladaLoader(mgr).parse(text, dir);
      return { root: res.scene, animations: res.scene?.animations || res.animations || [], warnings };
    }
    case '3mf': {
      const buf = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
      return { root: new ThreeMFLoader().parse(buf), animations: [], warnings };
    }
    case 'usdz': {
      const loader = new USDZLoader(mgr);
      const obj = await new Promise((resolve, reject) => {
        loader.load(url, resolve, (e) => { if (e.total) opts.onProgress?.(e.loaded / e.total); }, reject);
      });
      return { root: obj, animations: [], warnings };
    }
    default:
      throw new Error(`不支持的格式：.${ext}`);
  }
}

export function defaultMat(vertexColors) {
  return new THREE.MeshStandardMaterial({
    color: vertexColors ? 0xffffff : 0xcfd4dc,
    metalness: 0.08, roughness: 0.62,
    vertexColors: !!vertexColors,
    side: THREE.DoubleSide,
  });
}

/** 某些导出链（如部分 CAD→GLB）不带法线，法线模式/PBR 光照都会渲染成黑面，统一补平滑法线 */
function ensureNormals(root) {
  root.traverse(o => {
    if (o.isMesh && o.geometry && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();
  });
}

/** 内存加载（QL base64 分块 / 快速路径），返回 { root, animations, warnings } */
export function loadFromBuffer(buf, ext) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const decodeText = (u8) => new TextDecoder('utf-8').decode(u8);
  const warnings = [];
  const run = () => {
    switch (ext) {
      case 'glb': {
        return new Promise((resolve, reject) => {
          const loader = new GLTFLoader();
          const draco = new DRACOLoader();
          draco.setDecoderPath('./lib/addons/libs/draco/gltf/');
          loader.setDRACOLoader(draco);
          loader.parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), '',
            (gltf) => { draco.dispose(); resolve({ root: gltf.scene, animations: gltf.animations || [], warnings }); },
            (err) => { draco.dispose(); reject(new Error(`GLB 解析失败：${err?.message || err}`)); });
        });
      }
      case 'gltf':
        return new Promise((resolve, reject) => {
          new GLTFLoader().parse(decodeText(u8), '',
            (gltf) => resolve({ root: gltf.scene, animations: gltf.animations || [], warnings }),
            () => reject(new Error('GLTF 引用了外部资源（.bin/贴图），快速预览无法加载，请在主应用中打开')));
        });
      case 'obj': {
        const obj = new OBJLoader().parse(decodeText(u8));
        obj.traverse(o => { if (o.isMesh) { o.material = defaultMat(!!o.geometry?.attributes?.color); o.material.side = THREE.DoubleSide; } });
        return { root: obj, animations: [], warnings };
      }
      case 'stl': {
        const geo = new STLLoader().parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
        if (!geo.attributes.normal) geo.computeVertexNormals();
        return { root: new THREE.Mesh(geo, defaultMat(!!geo.attributes.color)), animations: [], warnings };
      }
      case 'ply': {
        const geo = new PLYLoader().parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
        if (!geo.attributes.normal) geo.computeVertexNormals();
        return { root: new THREE.Mesh(geo, defaultMat(!!geo.attributes.color || geo.hasColors)), animations: [], warnings };
      }
      case 'fbx': {
        const fbx = new FBXLoader().parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), '');
        return { root: fbx, animations: fbx.animations || [], warnings };
      }
      case 'dae': {
        const res = new ColladaLoader().parse(decodeText(u8), '');
        res.scene.traverse(o => { if (o.isMesh && o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.side = THREE.DoubleSide); });
        return { root: res.scene, animations: res.scene?.animations || res.animations || [], warnings };
      }
      case '3mf':
        return { root: new ThreeMFLoader().parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)), animations: [], warnings };
      default:
        throw new Error(`不支持的格式：.${ext}`);
    }
  };
  return Promise.resolve(run()).then((r) => {
    if (r?.root) ensureNormals(r.root);
    return r;
  });
}

/** 场景统计 */
export function computeStats(root, extraModels = []) {
  let vertices = 0, triangles = 0, meshes = 0;
  const mats = new Set();
  const roots = [root, ...extraModels.map(m => m.root)];
  for (const r of roots) {
    r.traverse((o) => {
      if (o.isMesh && o.geometry) {
        meshes++;
        const p = o.geometry.attributes.position;
        if (p) { vertices += p.count; triangles += o.geometry.index ? o.geometry.index.count / 3 : p.count / 3; }
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
      }
    });
  }
  return { vertices: Math.round(vertices), triangles: Math.round(triangles), meshes, materials: mats.size };
}
