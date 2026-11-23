// Acesso às bibliotecas que o WEBC já carrega (apps/companhia/vendor/three-vrm-pacote.min.js):
//   window.THREE        three.js 0.180 (WebGL 2, sRGB)
//   window.CompanhiaVRM { GLTFLoader, VRMLoaderPlugin, VRMUtils, VRMAnimationLoaderPlugin, MeshBVH, ... }
// Sem bundler e sem import map: os módulos de minigames/sports leem esses globais, assim usam a MESMA instância
// do three.js que o palco do WEBC (misturar duas cópias quebra instanceof e os materiais).
// Fora do WEBC (testes, página de demonstração), carregue o mesmo pacote antes dos módulos, ou chame
// useRuntime({ THREE, GLTFLoader, MeshBVH, VRMLoaderPlugin, VRMAnimationLoaderPlugin }).

let custom = null;

/** Troca as bibliotecas (testes em Node, outra página). Campos ausentes continuam vindo dos globais. */
export function useRuntime(libs) { custom = libs ? { ...libs } : null; }

function pick(name) {
  if (custom && custom[name]) return custom[name];
  const g = globalThis;
  if (name === 'THREE') return g.THREE;
  return g.CompanhiaVRM ? g.CompanhiaVRM[name] : undefined;
}

function need(name) {
  const v = pick(name);
  if (!v) throw new Error(`minigames/sports: falta ${name}. Carregue vendor/three-vrm-pacote.min.js do WEBC antes dos módulos (ou useRuntime).`);
  return v;
}

export const runtime = {
  get THREE() { return need('THREE'); },
  get GLTFLoader() { return need('GLTFLoader'); },
  get MeshBVH() { return need('MeshBVH'); },
  get VRMLoaderPlugin() { return need('VRMLoaderPlugin'); },
  get VRMAnimationLoaderPlugin() { return need('VRMAnimationLoaderPlugin'); },
  get VRMUtils() { return need('VRMUtils'); },
  has(name) { return !!pick(name); },
};

/** Quadros por segundo das animações e efeitos NW4R. */
export const NW4R_FPS = 60;
/** Escala das cenas (conferida em pinos de boliche, linha de falta e rede de tênis): 10 unidades = 1 metro. */
export const UNITS_PER_METER = 10;
