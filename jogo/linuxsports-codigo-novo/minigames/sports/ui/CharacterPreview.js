// Pré-visualização 3D giratória do editor de personagens (estilo Wii): um canvas próprio com o Mii montado pelo
// MiiOpponentBuilder com as mesmas peças do RFL dos 60 oponentes. Gira sozinho; arrastar gira à mão. A cada edição o
// Mii é remontado (com um pequeno atraso para não remontar a cada clique de uma sequência rápida).
import { runtime } from '../lib/runtime.js';

export class CharacterPreview {
  /**
   * @param {HTMLElement} container
   * @param {MiiOpponentBuilder} builder
   */
  constructor(container, builder) {
    const T = runtime.THREE;
    this.T = T;
    this.builder = builder;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sp-preview';
    this.canvas.setAttribute('aria-label', 'Pré-visualização do personagem');
    container.append(this.canvas);
    this.renderer = new T.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.scene.add(new T.HemisphereLight(0xffffff, 0x556677, 1.6));
    const sun = new T.DirectionalLight(0xffffff, 1.6);
    sun.position.set(20, 40, 30);
    this.scene.add(sun);
    this.camera = new T.PerspectiveCamera(30, 1, 0.5, 500);
    this.camera.position.set(0, 9, 34);
    this.camera.lookAt(0, 8, 0);
    this.turntable = new T.Group();
    this.scene.add(this.turntable);
    this.model = null;
    this.version = -1;
    this.building = null;
    this.timer = 0;
    this.angle = 0;
    this.dragging = null;
    this.raf = 0;
    this.disposed = false;
    this.canvas.addEventListener('pointerdown', (e) => { this.dragging = e.clientX; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => { if (this.dragging !== null) { this.angle += (e.clientX - this.dragging) * 0.012; this.dragging = e.clientX; } });
    this.canvas.addEventListener('pointerup', () => { this.dragging = null; });
    let last = performance.now();
    const loop = (now) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (this.dragging === null) this.angle += dt * 0.8;
      this.turntable.rotation.y = this.angle;
      this._resize();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  _resize() {
    const w = this.canvas.clientWidth || 240, h = this.canvas.clientHeight || 240;
    if (this.canvas.width !== Math.round(w * devicePixelRatio) || this.canvas.height !== Math.round(h * devicePixelRatio)) {
      this.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Mostra o Mii do editor; remonta quando a versão muda. */
  show(editor) {
    if (editor.version === this.version) return;
    this.version = editor.version;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._rebuild(editor.toInfo(), editor.version), 120);
  }

  async _rebuild(info, version) {
    const g = await this.builder.build({ id: 'editor', info }, { body: true });
    if (this.disposed || version !== this.version) return;
    if (this.model) this.turntable.remove(this.model);
    // corpo Mii tem ~16 u de altura: centraliza na câmera pela caixa
    const box = new this.T.Box3().setFromObject(g), c = box.getCenter(new this.T.Vector3());
    g.position.set(-c.x, -box.min.y, -c.z);
    this.model = g;
    this.turntable.add(g);
    const h = box.max.y - box.min.y || 16;
    this.camera.position.set(0, h * 0.55, h * 2.1);
    this.camera.lookAt(0, h * 0.5, 0);
    this.ready = true;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    this.renderer.dispose();
    this.canvas.remove();
  }
}
