// Animações que não cabem num AnimationClip do three.js (o PropertyBinding não chega em material.map.matrix nem
// troca texturas): SRT0 (matriz de textura), CLR0 (cores TEV/material), PAT0 (troca de textura) e SCN0
// (câmera, luzes e ambiente da cena). Avaliadas por quadro em update(dt) / setFrame(f).
//
// SRT0/PAT0: só a camada que o material desenha (a base; outras camadas ficam em `unsupported`).
// SRT0: a textura base do material é clonada (a imagem continua compartilhada) para a matriz não vazar para os
//       outros materiais que usam o mesmo PNG; matriz = setUvTransform(tS, tT, sS, sT, rot).
// CLR0: tev0/tev1 -> uniforms do material NW4R (lerp pela textura); mat0 -> material.color; kon0..3 com só o
//       alfa animado (máscara 0xffffff00, fade dos letreiros win/lose/tie/nice) -> opacidade = maior alfa konst.
//       RGB de konst e tev2 não existem no TEV aproximado e ficam listados em `unsupported`.
// PAT0: as texturas de troca vêm de sidecar.patternTextures (decodificadas do TEX0 por export_models.py).
// SCN0: a primeira câmera não-placeholder move a câmera dada (aim: olha para o alvo + twist; rotate: Euler ZYX
//       e a câmera NW4R olha para -Z, como a do three); luzes por nome; ambiente -> AmbientLight.
import { runtime, NW4R_FPS } from '../../lib/runtime.js';
import { sampleCurve, sampleClr } from './Nw4rCurves.js';
import { enableTev } from '../assets/Nw4rMaterial.js';

const DEG = Math.PI / 180;

/** Camada que o material desenha (Nw4rMaterial.baseLayerIndex); 0 se não souber. */
const baseSlot = (mat) => Math.max(0, mat.userData.nw4r?.baseLayer ?? 0);

function materialsByName(model) {
  const map = new Map();
  for (const m of model?.userData.nw4r?.materials || []) {
    if (!map.has(m.name)) map.set(m.name, []);
    map.get(m.name).push(m);
  }
  return map;
}

export class Nw4rMaterialAnimator {
  /**
   * @param {object} anim   JSON de SRT0/CLR0/PAT0/SCN0
   * @param {object} [o]    { model, store, camera, lights: {nome: THREE.Light}, ambient: THREE.AmbientLight, loop }
   */
  constructor(anim, { model = null, store = null, camera = null, lights = {}, ambient = null, loop } = {}) {
    this.anim = anim;
    this.type = anim.type;
    this.frames = Math.max(1, Math.round(anim.frames || 1));
    this.loop = loop ?? !!anim.loop;
    this.frame = 0;
    this.playing = true;
    this.model = model;
    this.store = store;
    this.camera = camera;
    this.lights = lights;
    this.ambient = ambient;
    this.unsupported = new Set();
    this.patTextures = new Map();
    this.ready = Promise.resolve(this);
    const mats = materialsByName(model);
    this.bindings = [];
    if (this.type === 'SRT0') {
      for (const m of anim.materials || []) {
        for (const tx of m.textures || []) {
          for (const mat of mats.get(m.material) || []) {
            // o material desenha só a camada base (a 1ª que não é light map/projeção): é ela que a SRT move
            if (tx.slot === baseSlot(mat)) this.bindings.push({ mat, tx });
            else this.unsupported.add(`${m.material}#${tx.slot}`);
          }
        }
      }
    } else if (this.type === 'CLR0') {
      for (const m of anim.materials || []) {
        for (const tg of m.targets || []) {
          const konst = /^kon\d$/.test(tg.target);
          if (konst && (tg.mask & 0xff) === 0) {
            // konst com só o alfa animado (máscara 0xffffff00): fade dos letreiros win/lose/tie/nice -> opacidade
            for (const mat of mats.get(m.material) || []) { mat.transparent = true; mat.depthWrite = false; this.bindings.push({ mat, tg, konst: true }); }
            continue;
          }
          if (!['tev0', 'tev1', 'mat0'].includes(tg.target)) { this.unsupported.add(tg.target); continue; }
          for (const mat of mats.get(m.material) || []) {
            const u = tg.target === 'mat0' ? null : enableTev(mat);
            this.bindings.push({ mat, tg, u });
          }
        }
      }
    } else if (this.type === 'PAT0') {
      const pngs = new Map((model?.userData.nw4r?.sidecar.patternTextures || []).map((p) => [p.name, p.png]));
      const loads = [];
      for (const m of anim.materials || []) {
        for (const slot of m.slots || []) {
          if (!slot.hasTexture) continue;
          const targets = (mats.get(m.material) || []).filter((mat) => slot.slot === baseSlot(mat));
          if (!targets.length) { this.unsupported.add(`${m.material}#${slot.slot}`); continue; }
          for (const mat of targets) this.bindings.push({ mat, slot });
          for (const k of slot.keys || []) {
            const png = pngs.get(k.texture);
            if (png && store && !this.patTextures.has(k.texture)) {
              const first = targets[0].userData.nw4r;
              const layer = first?.layers?.[first.baseLayer] || {};
              const p = store.texture(png, { wrapS: layer.wrapS, wrapT: layer.wrapT }).then((t) => this.patTextures.set(k.texture, t)).catch(() => {});
              this.patTextures.set(k.texture, null);
              loads.push(p);
            }
          }
        }
      }
      this.ready = Promise.all(loads).then(() => this);
    }
    this.setFrame(0);
  }

  get duration() { return this.frames / NW4R_FPS; }

  update(dt) {
    if (!this.playing) return;
    let f = this.frame + dt * NW4R_FPS;
    if (f >= this.frames) {
      if (this.loop) f %= this.frames;
      else { f = this.frames; this.playing = false; }
    }
    this.setFrame(f);
  }

  setFrame(f) {
    this.frame = f;
    if (this.type === 'SRT0') this.applySrt(f);
    else if (this.type === 'CLR0') this.applyClr(f);
    else if (this.type === 'PAT0') this.applyPat(f);
    else if (this.type === 'SCN0') this.applyScn(f);
  }

  applySrt(f) {
    for (const { mat, tx } of this.bindings) {
      if (!mat.map) continue; // textura ainda não chegou: a matriz entra no próximo quadro
      if (mat.userData.nw4rSrtMap !== mat.map) {
        mat.map = mat.map.clone();
        mat.map.matrixAutoUpdate = false;
        mat.userData.nw4rSrtMap = mat.map;
      }
      const ss = tx.scaleS ? sampleCurve(tx.scaleS, f) : 1;
      const st = tx.scaleT ? sampleCurve(tx.scaleT, f) : 1;
      const ts = tx.translateS ? sampleCurve(tx.translateS, f) : 0;
      const tt = tx.translateT ? sampleCurve(tx.translateT, f) : 0;
      const rot = tx.rotate ? sampleCurve(tx.rotate, f) * DEG : 0;
      mat.map.matrix.setUvTransform(ts, tt, ss, st, rot, 0, 0);
    }
  }

  applyClr(f) {
    const konstAlpha = new Map();
    for (const { mat, tg, u, konst } of this.bindings) {
      const c = sampleClr(tg, f);
      if (konst) { konstAlpha.set(mat, Math.max(konstAlpha.get(mat) ?? 0, c[3] / 255)); continue; }
      if (tg.target === 'mat0') { mat.color.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, runtime.THREE.SRGBColorSpace); continue; }
      const v = tg.target === 'tev0' ? u.nw4rTev0.value : u.nw4rTev1.value;
      // GX trabalha em sRGB; o shader mistura no espaço linear do three: converte a cor antes
      const col = new runtime.THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, runtime.THREE.SRGBColorSpace);
      const keepAlpha = (tg.mask & 0xff) !== 0 ? v.w : c[3] / 255;
      v.set(col.r, col.g, col.b, keepAlpha);
      u.nw4rUseTev.value = 1;
    }
    for (const [mat, a] of konstAlpha) mat.opacity = a;
  }

  applyPat(f) {
    for (const { mat, slot } of this.bindings) {
      const keys = slot.keys || [];
      let k = keys[0];
      for (const x of keys) { if (x.frame <= f) k = x; else break; }
      const tex = k && this.patTextures.get(k.texture);
      if (tex && mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; }
    }
  }

  applyScn(f) {
    const T = runtime.THREE;
    const a = this.anim;
    const cam = this.camera;
    const c = (a.cameras || []).find((x) => !x.placeholder);
    if (cam && c) {
      const s = (k) => sampleCurve(c[k], f);
      cam.position.set(s('posX'), s('posY'), s('posZ'));
      if (c.type === 'aim') {
        cam.up.set(0, 1, 0);
        cam.lookAt(s('aimX'), s('aimY'), s('aimZ'));
        const tw = c.twist ? s('twist') : 0;
        if (tw) cam.rotateZ(-tw * DEG);
      } else {
        cam.quaternion.setFromEuler(new T.Euler(s('rotX') * DEG, s('rotY') * DEG, s('rotZ') * DEG, 'ZYX'));
      }
      if (cam.isPerspectiveCamera && c.fovY) cam.fov = s('fovY');
      if (c.near) cam.near = s('near');
      if (c.far) cam.far = Math.min(s('far'), 1e6);
      cam.updateProjectionMatrix?.();
    }
    for (const lt of a.lights || []) {
      const L = this.lights[lt.name];
      if (!L) continue;
      const st = [sampleCurve(lt.startX, f), sampleCurve(lt.startY, f), sampleCurve(lt.startZ, f)];
      const en = [sampleCurve(lt.endX, f), sampleCurve(lt.endY, f), sampleCurve(lt.endZ, f)];
      L.position.fromArray(st);
      if (L.target) { L.target.position.fromArray(en); L.target.updateMatrixWorld(); }
      if (lt.color) L.color.setRGB(lt.color[0] / 255, lt.color[1] / 255, lt.color[2] / 255, T.SRGBColorSpace);
      if (L.isSpotLight && lt.cutoffDeg) L.angle = Math.min(Math.PI / 2, lt.cutoffDeg * DEG);
    }
    const amb = (a.ambients || [])[0];
    if (this.ambient && amb) this.ambient.color.setRGB(amb.color[0] / 255, amb.color[1] / 255, amb.color[2] / 255, T.SRGBColorSpace);
  }
}
