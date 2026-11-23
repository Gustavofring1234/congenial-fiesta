// Materiais dos modelos NW4R em three.js 0.180 (PBR do WEBC: sRGB + tone mapping).
//
// Vínculo textura -> material (Etapa 1.1): o .model.json do wispt lista TODAS as texturas do .brres; o vínculo
// certo vem do MDL0 (tools/export_models.py grava no sidecar, por material, as camadas na ordem do TEV com o PNG
// decodificado do TEX0, o wrap e o alfa). A camada base é a primeira que não é light map (lm_*) nem projeção.
//
// TEV aproximado (o mesmo usado nos layouts 2D e no projeto Unity):
//   cor = lerp(tev0, tev1, textura) × cor de vértice × cor do material
// tev0/tev1 só entram quando um CLR0 os anima (useTev = 1); sem isso o material é um MeshStandardMaterial comum.
import { runtime } from '../../lib/runtime.js';

const SKIP_BASE = /^(lm_\d|proje|shadow|spheremap|env_?)/i;

/** Camada usada como mapa de cor (índice em def.layers) ou -1. */
export function baseLayerIndex(def) {
  const layers = def?.layers || [];
  let i = layers.findIndex((l) => l.png && !SKIP_BASE.test(l.texture || ''));
  if (i < 0) i = layers.findIndex((l) => l.png);
  return i;
}

/** Acrescenta ao material os uniforms TEV (tev0, tev1, useTev). Idempotente. */
export function enableTev(mat) {
  const T = runtime.THREE;
  if (mat.userData.nw4rTev) return mat.userData.nw4rTev;
  const u = {
    nw4rTev0: { value: new T.Vector4(0, 0, 0, 0) },
    nw4rTev1: { value: new T.Vector4(1, 1, 1, 1) },
    nw4rUseTev: { value: 0 },
  };
  mat.userData.nw4rTev = u;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec4 nw4rTev0;\nuniform vec4 nw4rTev1;\nuniform float nw4rUseTev;\nvoid main() {')
      .replace('#include <map_fragment>', [
        '#ifdef USE_MAP',
        '  vec4 nw4rTex = texture2D( map, vMapUv );',
        '  if ( nw4rUseTev > 0.5 ) {',
        '    diffuseColor *= vec4( mix( nw4rTev0.rgb, nw4rTev1.rgb, nw4rTex.rgb ), mix( nw4rTev0.a, nw4rTev1.a, nw4rTex.a ) );',
        '  } else {',
        '    diffuseColor *= nw4rTex;',
        '  }',
        '#else',
        '  if ( nw4rUseTev > 0.5 ) diffuseColor *= nw4rTev1;',
        '#endif',
      ].join('\n'));
  };
  mat.customProgramCacheKey = () => 'nw4r-tev';
  mat.needsUpdate = true;
  return u;
}

/**
 * Cria o material de um material do sidecar. As texturas chegam depois (Promise em material.userData.ready).
 * @param {object} def    sidecar.materials[i]
 * @param {AssetStore} store
 * @param {object} [o]
 * @param {boolean} [o.vertexColors]
 * @param {boolean} [o.textures=true]  false: não baixa os PNG (testes sem DOM)
 */
export function createNw4rMaterial(def, store, { vertexColors = false, textures = true } = {}) {
  const T = runtime.THREE;
  const li = baseLayerIndex(def);
  const layer = li >= 0 ? def.layers[li] : null;
  // dummy_tex_*: reserva que o jogo troca em tempo de execução (cor/roupa do Mii, Etapa 3); fica branco neutro
  const placeholder = /^dummy_tex/i.test(layer?.texture || '');
  const translucent = !!def.translucent;
  const mat = new T.MeshStandardMaterial({
    name: def.name,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: def.doubleSided ? T.DoubleSide : T.FrontSide,
    transparent: translucent,
    depthWrite: !translucent,
    alphaTest: !translucent && layer?.alpha && !placeholder ? 0.5 : 0,
    // nos corpos Mii a cor de vértice tem RGB = 0 e só o alfa serve de máscara no TEV: não entra como cor
    vertexColors: vertexColors && !placeholder,
  });
  mat.userData.nw4r = { name: def.name, baseLayer: li, layers: def.layers || [], texture: layer?.texture || null, png: layer?.png || null, placeholder };
  mat.userData.ready = layer && textures && !placeholder
    ? store.texture(layer.png, { wrapS: layer.wrapS, wrapT: layer.wrapT })
        .then((tex) => { mat.map = tex; mat.needsUpdate = true; return mat; })
        .catch((e) => { console.warn(`sports: textura ${layer.png} (${def.name}) não carregou:`, e.message); return mat; })
    : Promise.resolve(mat);
  return mat;
}

/**
 * Troca os materiais do glTF pelos do sidecar (mesmo nome: os 914 materiais dos 259 .glb casam 1:1).
 * Devolve o relatório {bound, unmatched: [nomes]} e espera as texturas antes de resolver.
 */
export async function bindModelMaterials(root, sidecar, store, { textures = true } = {}) {
  const defs = new Map((sidecar.materials || []).map((m) => [m.name, m]));
  const made = new Map();
  const unmatched = new Set();
  let bound = 0;
  const waits = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const out = list.map((m) => {
      const def = defs.get(m?.name);
      if (!def) { if (m?.name) unmatched.add(m.name); return m; }
      const vc = !!o.geometry.attributes.color;
      const key = def.name + (vc ? '|vc' : '');
      let nm = made.get(key);
      if (!nm) {
        nm = createNw4rMaterial(def, store, { vertexColors: vc, textures });
        made.set(key, nm);
        waits.push(nm.userData.ready);
      }
      bound++;
      if (m && m !== nm) m.dispose();
      return nm;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
    if (defs.get(list[0]?.name)?.translucent) o.renderOrder = 1;
  });
  await Promise.all(waits);
  return { bound, materials: [...made.values()], unmatched: [...unmatched] };
}
