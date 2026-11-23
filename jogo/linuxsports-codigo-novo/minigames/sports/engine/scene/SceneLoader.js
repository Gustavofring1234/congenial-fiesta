// Carrega uma cena convertida (Scenes/<caminho>.scene.json, de tools/stage_web_assets.py):
//   models[]    -> loadModel (glb + sidecar com materiais/ossos/skin)
//   collision[] -> CollisionWorld (MeshBVH)
//   objects[]   -> objetos do .pmp (campos de golfe) como Object3D com position/quaternion/scale prontos
//                  (registro Z,Y,X = colunas da rotação; calibrado em index/pmp-three-calibration.json:
//                  1.359/1.361 sobre a colisão, mediana ≤ 0,89 u; +Z do tee aponta para os pinos em 12/12)
import { runtime } from '../../lib/runtime.js';
import { defaultStore } from '../assets/AssetStore.js';
import { loadModel } from '../assets/ModelLoader.js';
import { CollisionWorld } from './CollisionWorld.js';

/** Tipos de objeto .pmp conhecidos (os demais ficam como 'pmp_<id>'). */
export const PMP_TYPES = { 0: 'tee', 1: 'pin' };

export function pmpObject(o) {
  const T = runtime.THREE;
  const obj = new T.Object3D();
  obj.name = `${PMP_TYPES[o.typeId] || 'pmp_' + o.typeId}_${o.variant}`;
  obj.position.fromArray(o.position);
  obj.quaternion.fromArray(o.quaternion);
  obj.scale.fromArray(o.scale);
  obj.userData.pmp = { typeId: o.typeId, variant: o.variant, kind: PMP_TYPES[o.typeId] || null };
  return obj;
}

export class SceneLoader {
  constructor(store = defaultStore()) { this.store = store; }

  /** Índice das 32 cenas: [{assetId, sport, file, name, objects}]. */
  async list() { return (await this.store.json('Scenes/scenes_index.json')).scenes; }

  /** Procura por nome (ex.: 'glf_course_fc1') ou assetId. */
  async find(nameOrId) {
    const all = await this.list();
    return all.find((s) => s.name === nameOrId || s.assetId === nameOrId) || null;
  }

  /**
   * @param {string|object} entry  nome, assetId, entrada do índice ou caminho do .scene.json
   * @param {object} [o] { textures: true, collision: true, onProgress(feito, total) }
   * @returns {Promise<{root, scene, models, collision, objects, byName(name)}>}
   */
  async load(entry, { textures = true, collision = true, onProgress = null } = {}) {
    const T = runtime.THREE;
    const file = typeof entry === 'object' ? entry.file
      : /\.scene\.json$/.test(entry) ? entry : (await this.find(entry))?.file;
    if (!file) throw new Error(`cena não encontrada: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`);
    const scene = await this.store.json(file);
    const root = new T.Group();
    root.name = file.split('/').pop().replace('.scene.json', '');
    root.userData.scene = scene;

    const total = scene.models.length + (collision ? 1 : 0);
    let done = 0;
    const tick = () => { done++; if (onProgress) onProgress(done, total); };
    const models = await Promise.all(scene.models.map(async (m) => {
      if (!m.sidecar) { tick(); return null; }
      try {
        const model = await loadModel(this.store, m.sidecar, { textures });
        model.userData.sceneName = m.name || model.userData.nw4r.model;
        root.add(model);
        return model;
      } catch (e) {
        console.warn(`sports: modelo ${m.name} (${m.sidecar}) não carregou:`, e.message);
        return null;
      } finally { tick(); }
    }));

    let world = null;
    if (collision) {
      world = await CollisionWorld.load(this.store, scene.collision.map((c) => c.glb));
      tick();
    }

    const objects = new T.Group();
    objects.name = 'pmp_objects';
    for (const o of scene.objects || []) objects.add(pmpObject(o));
    if (objects.children.length) root.add(objects);

    const byName = (name) => models.find((m) => m && (m.userData.sceneName === name || m.userData.nw4r?.model === name)) || null;
    return { root, scene, models: models.filter(Boolean), collision: world, objects: objects.children, byName };
  }
}
