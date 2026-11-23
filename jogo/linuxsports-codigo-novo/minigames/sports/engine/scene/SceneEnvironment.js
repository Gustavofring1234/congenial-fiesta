// Ambiente das cenas (porte de Nw4rEnvironment.cs). Lê o preset (Environment/<preset>.env.json, gerado por
// tools/export_environment.py) e monta as luzes no three.js 0.180 com as mesmas regras do C#:
//   - luzes GX ligadas com cor habilitada (enabled && gx && colorEnable); cor final = min(255, cor × intensidade);
//   - ambiente = ambientColors[ambientIndex] (AmbientLight);
//   - uma luz direcional de mundo faz sombra (PCFSoft, câmera de sombra ajustada ao raio em volta do foco); as outras
//     direcionais não fazem sombra. Se o preset não tem direcional de mundo ligada (rpcommon), o sol fica com
//     intensidade 0: existe só para manter o sistema de sombra montado;
//   - luzes locais (ponto/spot) só as N mais perto da câmera (N pela qualidade). Alcance como no C#:
//     refDist = refDistance × |alvo − posição|, alcance = refDist / (1 − refBrightness); sem atenuação = 0 (sem corte);
//   - bloom: o .pblm vai para o BloomPass (render() desenha com bloom quando há).
//
// Coordenadas: o referencial das cenas e dos presets é o do Wii = three.js. Nada é espelhado aqui (o espelho em X
// do Unity não entra no JS). As luzes de espaço de câmera (view, cameraFront, cameraBack) são presas à câmera.
import { runtime } from '../../lib/runtime.js';
import { defaultStore } from '../assets/AssetStore.js';
import { BloomPass, DEFAULT_INTENSITY_SCALE } from './BloomPass.js';

/** Qualidade: tamanho do shadow map, nº de luzes locais acesas e níveis do bloom. */
export const QUALITY = {
  low: { shadowMap: 1024, localLights: 2, bloomLevels: 2 },
  medium: { shadowMap: 2048, localLights: 4, bloomLevels: 3 },
  high: { shadowMap: 4096, localLights: 8, bloomLevels: 4 },
};

/** Intensidade das luzes locais (candela no three): ajuste no WEBC, junto com a iluminação das cenas. */
export const LOCAL_INTENSITY = 1;

const ENV_INDEX = 'Environment/environment_index.json';
const SCENES_INDEX = 'Scenes/scenes_index.json';
const ESPACO_CAMERA = new Set(['view', 'cameraFront', 'cameraBack']);
const ESPACO_MUNDO = new Set(['world', 'worldSpecular']);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const cor01 = (c) => c.slice(0, 3).map((v) => v / 255);

/** Luz GX que entra na cena (o mesmo filtro de Nw4rEnvironment.BuildLights). */
export function isLiveLight(l) { return !!(l.enabled && l.gx && l.colorEnable); }

/** Uma luz do .plight (campos já como o env.json traz) -> luz com cor final 0..1 (min(255, cor × intensidade)). */
export function parseLight(l) {
  const k = l.intensity ?? 1;
  return {
    index: l.index,
    enabled: !!l.enabled, gx: !!l.gx, colorEnable: !!l.colorEnable, lightTexture: !!l.lightTexture,
    type: l.type, space: l.space,
    position: l.position.slice(0, 3), target: l.target.slice(0, 3),
    color: l.color.slice(0, 3).map((v) => Math.min(255, v * k) / 255),
    spotCutoff: l.spotCutoff, refDistance: l.refDistance, refBrightness: l.refBrightness,
    manualAttnA: !!l.manualAttnA, manualAttnK: !!l.manualAttnK, distAttnFn: l.distAttnFn,
  };
}

/** Preset cru (env.json) -> dados do ambiente: luzes normalizadas, cores 0..1, bloom e texturas de lightmap. */
export function parseEnvironment(json) {
  const light = json.light || {};
  return {
    name: json.name ?? null,
    sport: json.sport ?? null,
    ambientColors: (light.ambientColors || []).map(cor01),
    globalColor: cor01(light.globalColor || [0, 0, 0, 255]),
    lights: (light.lights || []).map(parseLight),
    lightTextures: (json.lightmap && json.lightmap.textures) || [],
    bloom: json.bloom || null,
  };
}

/**
 * Nome do preset a partir de: nome do preset, assetId de cena (scene.assetId), caminho .scene.json ou o objeto
 * da cena carregada (SceneLoader: usa assetId ou file). Consulta o environment_index (scenes -> preset).
 */
export function resolvePreset(index, scenesIndex, chave) {
  const k = chave && typeof chave === 'object' ? (chave.assetId ?? chave.name ?? chave.file) : chave;
  if (typeof k !== 'string' || !k) throw new Error('loadEnvironment: informe um preset, o assetId da cena ou o caminho do .scene.json');
  if (index.presets.some((p) => p.name === k)) return k;
  let arquivo = chave && typeof chave === 'object' && chave.file ? chave.file : null;
  if (!arquivo && /\.scene\.json$/.test(k)) arquivo = k;
  if (!arquivo && scenesIndex) {
    const cena = scenesIndex.scenes.find((s) => s.assetId === k || s.name === k);
    if (cena) arquivo = cena.file;
  }
  if (arquivo && index.scenes[arquivo]) return index.scenes[arquivo];
  throw new Error(`loadEnvironment: nenhum preset para "${k}"`);
}

/**
 * Carrega o ambiente de um preset ou de uma cena.
 * @param {AssetStore} store  (padrão: defaultStore())
 * @param {string|object} sceneAssetIdOrPresetName  nome do preset, scn_..., caminho .scene.json ou scene carregada
 * @returns {Promise<object>} parseEnvironment(...) + preset (nome usado)
 */
export async function loadEnvironment(store = defaultStore(), sceneAssetIdOrPresetName) {
  const index = await store.json(ENV_INDEX);
  const chave = sceneAssetIdOrPresetName;
  const nome = typeof chave === 'string' && index.presets.some((p) => p.name === chave)
    ? chave
    : resolvePreset(index, await store.json(SCENES_INDEX), chave);
  const entrada = index.presets.find((p) => p.name === nome);
  const json = await store.json(entrada.file);
  return { ...parseEnvironment(json), preset: nome };
}

/** Rótulos dos pontos que definem uma direcional: (posição, alvo) no espaço da luz. */
function pontosDaLuz(l) {
  if (l.space === 'cameraFront') return { p: [0, 0, 0], t: [0, 0, -1] };
  if (l.space === 'cameraBack') return { p: [0, 0, 0], t: [0, 0, 1] };
  return { p: l.position, t: l.target };
}

/** Alcance no three (distância de corte; 0 = sem corte), como Nw4rEnvironment.Range. */
export function alcanceDaLuz(l, comprimento) {
  if (l.manualAttnK || l.distAttnFn === 0) return 0;
  const refDist = Math.max(1e-3, l.refDistance * Math.max(comprimento, 1e-3));
  const rb = clamp(l.refBrightness, 0.01, 0.99);
  return refDist / (1 - rb);
}

export class SceneEnvironment {
  /**
   * @param {THREE.WebGLRenderer} renderer  (pode ser falso em testes: só precisa de shadowMap, e de capabilities
   *                                         e extensions para o bloom no render)
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {{quality?: 'low'|'medium'|'high', shadows?: boolean, bloom?: boolean}} [o]
   */
  constructor(renderer, scene, camera, { quality = 'medium', shadows = true, bloom = true } = {}) {
    const T = runtime.THREE;
    if (!QUALITY[quality]) throw new Error(`qualidade desconhecida: ${quality} (use low, medium ou high)`);
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.quality = quality;
    this.q = QUALITY[quality];
    this.shadows = !!shadows;
    this.env = null;
    this.focus = new T.Vector3();
    this.radius = 40;
    this.ambient = null;
    this.sun = null;
    this.sunDir = new T.Vector3(0, -1, 0);
    this.dirs = [];       // demais direcionais: {light, def, cameraSpace}
    this.cands = [];      // luzes locais candidatas: {def, kind, cameraSpace}
    this.locals = [];     // luzes locais em cena (no máximo q.localLights): {cand, kind, light}
    this.spare = { point: [], spot: [] };
    this.bloomPass = bloom ? new BloomPass({ levels: this.q.bloomLevels }) : null;
    renderer.shadowMap.enabled = this.shadows;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
  }

  /**
   * Monta o preset na cena (troca o anterior). focus/radius definem a área coberta pela sombra.
   * @param {object} env  resultado de loadEnvironment (ou parseEnvironment)
   * @param {{focus?: number[]|THREE.Vector3, radius?: number, ambientIndex?: number, intensityScale?: number}} [o]
   */
  apply(env, { focus = [0, 0, 0], radius = 40, ambientIndex = 0, intensityScale = DEFAULT_INTENSITY_SCALE } = {}) {
    const T = runtime.THREE;
    this.clear();
    this.env = env;
    this.focus.copy(vetor(focus));
    this.radius = Math.max(1, radius);

    const cores = env.ambientColors;
    const amb = cores.length ? cores[clamp(ambientIndex, 0, cores.length - 1)] : [0, 0, 0];
    this.ambient = new T.AmbientLight(new T.Color(amb[0], amb[1], amb[2]), 1);
    this.scene.add(this.ambient);

    const vivas = env.lights.filter(isLiveLight);
    const direcionais = vivas.filter((l) => l.type === 'directional');
    const solDef = direcionais.find((l) => ESPACO_MUNDO.has(l.space)) || null;
    this.sun = new T.DirectionalLight(solDef ? new T.Color(...solDef.color) : new T.Color(1, 1, 1), solDef ? 1 : 0);
    this.sun.castShadow = this.shadows;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.mapSize.set(this._tamanhoSombra(), this._tamanhoSombra());
    this.sunDef = solDef;
    this.scene.add(this.sun, this.sun.target);

    for (const def of direcionais) {
      if (def === solDef) continue;
      const light = new T.DirectionalLight(new T.Color(...def.color), 1);
      light.castShadow = false;
      this.scene.add(light, light.target);
      this.dirs.push({ light, def, cameraSpace: ESPACO_CAMERA.has(def.space) });
    }

    this.cands = vivas
      .filter((l) => l.type !== 'directional')
      .map((def) => ({ def, kind: def.type === 'spot' && !def.manualAttnA ? 'spot' : 'point', cameraSpace: ESPACO_CAMERA.has(def.space) }));

    if (this.bloomPass) this.bloomPass.setPblm(env.bloom, intensityScale);
    this.setFocus(this.focus, this.radius);
    this.update(null);
    return this;
  }

  /** Recentra a sombra do sol e as direcionais de mundo (focus = área coberta, radius = meia largura). */
  setFocus(focus, radius = this.radius) {
    this.focus.copy(vetor(focus));
    this.radius = Math.max(1, radius);
    if (this.sun) {
      this.sunDir.copy(this.sunDef ? normalizado(this.sunDef.target, this.sunDef.position) : vetor([0, -1, 0]));
      this._colocarSol();
    }
    for (const d of this.dirs) this._colocarDirecional(d);
    return this;
  }

  /** Atualiza as luzes que dependem da câmera: direcionais de espaço de câmera e as N locais mais perto. */
  update(cameraPosition = null) {
    if (!this.env) return this;
    const T = runtime.THREE;
    this.camera.updateMatrixWorld();
    const posCam = cameraPosition ? vetor(cameraPosition) : this.camera.getWorldPosition(new T.Vector3());
    for (const d of this.dirs) if (d.cameraSpace) this._colocarDirecional(d);
    this._escolherLocais(posCam);
    return this;
  }

  /** Desenha a cena (com bloom quando o preset tem). Use no lugar de renderer.render. */
  render() {
    if (this.bloomPass) this.bloomPass.render(this.renderer, this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  }

  /** Tamanho do buffer de desenho para o bloom (pixels). */
  setSize(w, h) {
    if (this.bloomPass) this.bloomPass.setSize(w, h);
    return this;
  }

  /** Tira do cenário todas as luzes montadas por apply() e libera as sombras. */
  clear() {
    const cena = this.scene;
    const tirar = (o) => { if (o) cena.remove(o); };
    tirar(this.ambient);
    if (this.sun) { tirar(this.sun); tirar(this.sun.target); this.sun.shadow.dispose(); }
    for (const d of this.dirs) { tirar(d.light); tirar(d.light.target); d.light.shadow.dispose(); }
    for (const s of [...this.locals, ...this.spare.point, ...this.spare.spot]) { tirar(s.light); tirar(s.light.target); }
    this.ambient = null;
    this.sun = null;
    this.sunDef = null;
    this.dirs = [];
    this.cands = [];
    this.locals = [];
    this.spare = { point: [], spot: [] };
    this.env = null;
    return this;
  }

  dispose() {
    this.clear();
    if (this.bloomPass) this.bloomPass.dispose();
  }

  // ── internos ────────────────────────────────────────────────────

  _tamanhoSombra() {
    const max = this.renderer.capabilities && this.renderer.capabilities.maxTextureSize;
    return max ? Math.min(this.q.shadowMap, max) : this.q.shadowMap;
  }

  /** Sol: fica no lado oposto do foco, na direção da luz, e a câmera de sombra cobre ±radius em volta do foco. */
  _colocarSol() {
    const s = this.sun;
    const R = this.radius;
    s.position.copy(this.focus).addScaledVector(this.sunDir, -2 * R);
    s.target.position.copy(this.focus);
    const c = s.shadow.camera;
    c.left = -R; c.right = R; c.top = R; c.bottom = -R;
    c.near = 0.5; c.far = 4 * R;
    c.updateProjectionMatrix();
    s.updateMatrixWorld();
    s.target.updateMatrixWorld();
  }

  _colocarDirecional(d) {
    const { p, t } = pontosDaLuz(d.def);
    if (d.cameraSpace) {
      d.light.position.copy(ponto(p, this.camera));
      d.light.target.position.copy(ponto(t, this.camera));
    } else {
      d.light.position.copy(this.focus).addScaledVector(normalizado(t, p), -2 * this.radius);
      d.light.target.position.copy(this.focus);
    }
    d.light.updateMatrixWorld();
    d.light.target.updateMatrixWorld();
  }

  /** As `q.localLights` candidatas mais perto da câmera; as demais saem da cena (nunca passam do limite). */
  _escolherLocais(posCam) {
    const ordem = this.cands
      .map((c) => ({ c, dist: this._posicaoLocal(c).distanceTo(posCam) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, this.q.localLights)
      .map((r) => r.c);

    const manter = [];
    const livres = [];
    for (const s of this.locals) (ordem.includes(s.cand) ? manter : livres).push(s);
    for (const c of ordem) {
      if (manter.some((s) => s.cand === c)) continue;
      const i = livres.findIndex((s) => s.kind === c.kind);
      let slot = i >= 0 ? livres.splice(i, 1)[0] : null;
      if (!slot) slot = this._novaLocal(c.kind);
      slot.cand = c;
      manter.push(slot);
    }
    for (const s of livres) this._recolher(s);
    this.locals = manter;
    for (const s of this.locals) this._configurarLocal(s);
  }

  _novaLocal(kind) {
    const T = runtime.THREE;
    const pilha = this.spare[kind];
    if (pilha.length) {
      const s = pilha.pop();
      this.scene.add(s.light, s.light.target);
      return s;
    }
    const light = kind === 'spot' ? new T.SpotLight(0xffffff, 1) : new T.PointLight(0xffffff, 1);
    this.scene.add(light, light.target);
    return { kind, light, cand: null };
  }

  _recolher(s) {
    this.scene.remove(s.light, s.light.target);
    this.spare[s.kind].push(s);
  }

  _posicaoLocal(c) {
    const { p } = pontosDaLuz(c.def);
    return c.cameraSpace ? ponto(p, this.camera) : vetor(p);
  }

  _configurarLocal(s) {
    const def = s.cand.def;
    const { p, t } = pontosDaLuz(def);
    const pos = s.cand.cameraSpace ? ponto(p, this.camera) : vetor(p);
    const alvo = s.cand.cameraSpace ? ponto(t, this.camera) : vetor(t);
    const comprimento = Math.hypot(t[0] - p[0], t[1] - p[1], t[2] - p[2]);
    const L = s.light;
    L.position.copy(pos);
    L.color.setRGB(def.color[0], def.color[1], def.color[2]);
    L.intensity = LOCAL_INTENSITY;
    L.distance = alcanceDaLuz(def, comprimento);
    L.decay = 2;
    if (s.kind === 'spot') {
      L.angle = (clamp(def.spotCutoff, 1, 89) * Math.PI) / 180; // corte GX é semi-ângulo; o SpotLight também
      L.penumbra = 0.1;
      L.target.position.copy(alvo);
      L.target.updateMatrixWorld();
    }
    L.updateMatrixWorld();
  }
}

/** Vetor do three a partir de array [x,y,z], Vector3 ou null (origem). */
function vetor(v) {
  const T = runtime.THREE;
  if (!v) return new T.Vector3();
  if (Array.isArray(v)) return new T.Vector3(v[0] || 0, v[1] || 0, v[2] || 0);
  return new T.Vector3().copy(v);
}

/** Ponto no espaço de câmera -> mundo. */
function ponto(p, camera) {
  return vetor(p).applyMatrix4(camera.matrixWorld);
}

/** Direção unitária de `de` para `para` (Wii); (0,-1,0) se os pontos coincidem. */
function normalizado(para, de) {
  const T = runtime.THREE;
  const d = new T.Vector3(para[0] - de[0], para[1] - de[1], para[2] - de[2]);
  if (d.lengthSq() < 1e-12) return new T.Vector3(0, -1, 0);
  return d.normalize();
}
