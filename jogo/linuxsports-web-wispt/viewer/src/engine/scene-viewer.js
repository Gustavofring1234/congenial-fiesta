// Visualizador 3D (three.js): modelos .glb, colisão .glb (cor por flag) e objetos do .pmp.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { url } from './assets.js';
import { pmpMatrix } from './pmp.js';

const loader = new GLTFLoader();
const loadGlb = (p) => new Promise((resolve, reject) => loader.load(url(p), resolve, undefined, reject));

export class Viewer3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fb4d9);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 2, 1.5);
    this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1e6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.groups = { models: new THREE.Group(), collision: new THREE.Group(), objects: new THREE.Group() };
    Object.values(this.groups).forEach((g) => this.scene.add(g));
    this.groups.collision.visible = false;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const tick = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(tick); };
    tick();
  }

  resize() {
    const w = this.container.clientWidth || 600, h = this.container.clientHeight || 420;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    for (const g of Object.values(this.groups)) {
      g.traverse((o) => { o.geometry?.dispose?.(); if (o.material) [].concat(o.material).forEach((m) => { m.map?.dispose?.(); m.dispose?.(); }); });
      g.clear();
    }
  }

  setVisible(name, v) { this.groups[name].visible = v; }

  /** models: [{ glb }], collision: [glb paths], objects: SceneJson.objects */
  async show({ models = [], collision = [], objects = [] }) {
    this.clear();
    const errors = [];
    await Promise.all(models.map(async (p) => {
      try { this.groups.models.add((await loadGlb(p)).scene); } catch (e) { errors.push(`${p}: ${e.message ?? e}`); }
    }));
    await Promise.all(collision.map(async (p) => {
      try {
        const g = await loadGlb(p);
        g.scene.traverse((o) => {
          if (!o.isMesh) return;
          const flag = o.parent?.userData?.collisionFlag ?? o.userData?.collisionFlag ?? hashName(o.name);
          o.material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(((flag * 0.618) % 1 + 1) % 1, 0.65, 0.5), transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
          const wire = new THREE.LineSegments(new THREE.WireframeGeometry(o.geometry), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
          o.add(wire);
        });
        this.groups.collision.add(g.scene);
      } catch (e) { errors.push(`${p}: ${e.message ?? e}`); }
    }));
    this.fit();
    if (objects.length) this.addObjects(objects);
    return errors;
  }

  addObjects(objects) {
    const box = new THREE.Box3().setFromObject(this.groups.models.children.length ? this.groups.models : this.groups.collision);
    const size = box.isEmpty() ? 10 : box.getSize(new THREE.Vector3()).length() * 0.004;
    const types = [...new Set(objects.map((o) => o.typeId))].sort((a, b) => a - b);
    for (const type of types) {
      const list = objects.filter((o) => o.typeId === type);
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(size, size * 2, size), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL((type * 0.137) % 1, 0.8, 0.5) }), list.length);
      const m = new THREE.Matrix4();
      list.forEach((o, i) => mesh.setMatrixAt(i, pmpMatrix(o, m)));
      mesh.name = `pmp_type_${type}`;
      this.groups.objects.add(mesh);
    }
  }

  fit() {
    const target = this.groups.models.children.length ? this.groups.models : this.groups.collision;
    const box = new THREE.Box3().setFromObject(target);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), d = box.getSize(new THREE.Vector3()).length() || 1;
    this.camera.near = d / 2000;
    this.camera.far = d * 20;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(c).add(new THREE.Vector3(d * 0.45, d * 0.35, d * 0.55));
    this.controls.target.copy(c);
    this.controls.update();
  }
}

function hashName(s = '') {
  const m = /0x([0-9a-f]+)/i.exec(s);
  if (m) return parseInt(m[1], 16);
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}
