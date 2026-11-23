// Ambiente de teste em Node para minigames/sports: carrega o MESMO pacote vendor do WEBC (three.js 0.180 +
// three-vrm + MeshBVH) e um AssetStore que lê do disco. Sem WebGL: só lógica, geometria, clipes e simulação.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');
export const SPORTS = path.join(ROOT, 'minigames/sports');
export const ASSETS = path.join(SPORTS, 'assets');
const VENDOR = process.env.WEBC_VENDOR || path.resolve(ROOT, '../../LNUX-APPs/apps/companhia/vendor/three-vrm-pacote.min.js');

let ready = null;
export function setup() {
  if (!ready) ready = (async () => {
    if (!existsSync(VENDOR)) throw new Error(`pacote vendor do WEBC não encontrado: ${VENDOR} (defina WEBC_VENDOR)`);
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    const warn = console.warn, err = console.error;
    // o GLTFLoader reclama das imagens embutidas (sem DOM em Node); os testes usam textures:false
    console.warn = (...a) => { if (!String(a[0]).includes('GLTFLoader')) warn(...a); };
    console.error = (...a) => { if (!String(a[0]).includes('GLTFLoader')) err(...a); };
    await import(pathToFileURL(VENDOR).href);
    const { AssetStore, setDefaultStore } = await import(pathToFileURL(path.join(SPORTS, 'engine/assets/AssetStore.js')).href);
    const store = new AssetStore({
      base: pathToFileURL(ASSETS + '/').href,
      fetch: async (u) => {
        try { return new Response(await readFile(fileURLToPath(u))); } catch (e) { return new Response(null, { status: 404 }); }
      },
    });
    setDefaultStore(store);
    return { THREE: globalThis.THREE, VRM: globalThis.CompanhiaVRM, store };
  })();
  return ready;
}

export const mod = (p) => import(pathToFileURL(path.join(SPORTS, p)).href);
export const json = async (p) => JSON.parse(await readFile(path.join(ASSETS, p), 'utf8'));

/** VRM 1.0 mínimo em pose T (olhando para +Z, esquerda em +X), sem malha, como .glb. */
export function syntheticVrm1() {
  const L = (s) => [
    [`${s}Shoulder`, 'upperChest', [0.04, 0.12, 0]], [`${s}UpperArm`, `${s}Shoulder`, [0.1, 0, 0]],
    [`${s}LowerArm`, `${s}UpperArm`, [0.26, 0, 0]], [`${s}Hand`, `${s}LowerArm`, [0.24, 0, 0]],
    [`${s}IndexProximal`, `${s}Hand`, [0.08, 0, 0.02]], [`${s}IndexIntermediate`, `${s}IndexProximal`, [0.03, 0, 0]],
    [`${s}ThumbMetacarpal`, `${s}Hand`, [0.02, 0, 0.03]], [`${s}ThumbProximal`, `${s}ThumbMetacarpal`, [0.03, 0, 0.02]],
    [`${s}UpperLeg`, 'hips', [0.09, -0.06, 0]], [`${s}LowerLeg`, `${s}UpperLeg`, [0, -0.42, 0]], [`${s}Foot`, `${s}LowerLeg`, [0, -0.42, 0]],
  ];
  const mirror = (rows) => rows.map(([n, p, t]) => [n.replace('left', 'right'), p.replace('left', 'right'), [-t[0], t[1], t[2]]]);
  const bones = [
    ['hips', null, [0, 0.95, 0]], ['spine', 'hips', [0, 0.1, 0]], ['chest', 'spine', [0, 0.12, 0]],
    ['upperChest', 'chest', [0, 0.12, 0]], ['neck', 'upperChest', [0, 0.14, 0]], ['head', 'neck', [0, 0.08, 0]],
    ...L('left'), ...mirror(L('left')),
  ];
  const idx = Object.fromEntries(bones.map((b, i) => [b[0], i]));
  const nodes = bones.map(([n, , t]) => ({ name: n, translation: t }));
  bones.forEach(([n, p]) => { if (p) (nodes[idx[p]].children = nodes[idx[p]].children || []).push(idx[n]); });
  const gl = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [idx.hips] }], nodes,
    extensionsUsed: ['VRMC_vrm'],
    extensions: { VRMC_vrm: {
      specVersion: '1.0',
      meta: { name: 'teste', authors: ['teste'], licenseUrl: 'https://vrm.dev/licenses/1.0/' },
      humanoid: { humanBones: Object.fromEntries(bones.map(([n]) => [n, { node: idx[n] }])) },
    } },
  };
  let js = Buffer.from(JSON.stringify(gl));
  if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + js.length, 8);
  head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const b = Buffer.concat([head, js]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
