// Cabeça e corpo Mii dos adversários do WEBC (porte de Entities/Mii/*.cs e Activities/Common/AiProfile.cs).
//
// Dados (minigames/sports/assets/Mii/, gerados por tools/export_mii.py):
//   Shapes/<parte>.json        malhas da cabeça (posições, normais, UVs, triângulos; faceline traz âncoras)
//   Textures/<pasta>/NN.png    texturas do rosto e de forma; textures.json traz o wrap GX (0 clamp, 1 repeat, 2 mirror)
//   Profiles/cpu_mii_NNN.json  campos decodificados do RFLCharData (.rcd)
//   rfl_params.json            tabelas de cores e rotações tiradas do main.dol
//
// Referencial: o do Wii é o do three.js. Nada aqui é espelhado (o C# espelha X só para o Unity).
// Diferenças em relação ao C# (ver também o relatório da etapa):
//   - o rosto (olhos, sobrancelhas, boca, bigode, pinta) é desenhado num canvas 2D com a mesma geometria das
//     quads do RFL; olho e boca são compostos por canal (composeChannels: máscaras R/G/B do RGB5A3), sobrancelha,
//     bigode e pinta (I4/IA4) recebem tinta sólida c0;
//   - camisa e calça estão no mesmo material do corpo (mt_main, uma malha só): a cor favorita pinta o material;
//     a calça fica registrada em userData.nw4r.pants, sem região própria.
import { runtime } from '../lib/runtime.js';
import { defaultStore, wrapMode } from '../engine/assets/AssetStore.js';
import { loadModel, resetPose } from '../engine/assets/ModelLoader.js';

/** Pasta dos sidecars dos corpos ava_body* (Models, subpasta G3D: ava_bodyA1__ava_bodyA1.nw4r.json). */
const BODY_DIR = 'Models/src/core/shared/Kokeshi/common/G3D/';
const WHITE = [255, 255, 255, 255];

/**
 * Olhos e bocas do RFL (RGB5A3) guardam máscaras por canal, não cor: no olho R = contorno, G = íris, B = branco
 * do olho; na boca R = lábio, G = interior escuro, B = dentes. Cor = R·cR + G·cG + B·cB (0..255), alfa da textura.
 * Tingir tudo com uma cor só (source-in) apagava o branco dos olhos.
 */
export function composeChannels(data, cR, cG, cB) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, gg = data[i + 1] / 255, b = data[i + 2] / 255;
    for (let k = 0; k < 3; k++) data[i + k] = Math.min(255, Math.round(r * cR[k] + gg * cG[k] + b * cB[k]));
  }
  return data;
}

/** Escala da cabeça em relação ao osso (MiiCharacterBuilder.headScale; a escala real não foi achada no código). */
const HEAD_SCALE = 0.125;
/** Lado da textura do rosto (o RFL usa 64, 128 ou 256). */
const FACE_RES = 256;
/** Escala dos eixos do rosto (RFLiDrawQuad). */
const AXIS_X = 0.8896146;
const AXIS_Y = 0.9276675;
/** Calça: o C# não define a cor da calça; usa-se a entrada 11 da tabela de cores favoritas (preto). */
const PANTS_INDEX = 11;
/** Textura da pinta (a pinta ativa é o índice 1 da pasta mole). */
const MOLE_TEXTURE = 1;
/** Expressões aceitas por setExpression (MiiExpression do C#: Normal, Smile, Sorrow, Anger, Surprise). */
export const EXPRESSIONS = ['neutral', 'smile', 'sad', 'angry', 'surprise'];

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const pad2 = (n) => String(n).padStart(2, '0');
const cssColor = ([r, g, b, a]) => `rgba(${r},${g},${b},${a / 255})`;
/** Entrada de uma tabela de cores; índice fora da tabela cai na entrada 0 (o RFL só usa índices válidos). */
const at = (list, i) => list[i] ?? list[0];

/** Hash FNV-1a de 32 bits (estável entre navegadores; igual ao StableHash do AiProfile.cs). */
export function stableHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h & 0x7fffffff;
}

/** Nome do corpo: A = masculino, B = feminino; k = 0..3 pelo peso (MiiCharacterBuilder / SportActor.BodyFor). */
export function bodyNameFor(info) {
  if (!info) return 'ava_bodyA1';
  const k = clamp(Math.floor((info.build * 4) / 128), 0, 3);
  return (info.sex === 1 ? 'ava_bodyB' : 'ava_bodyA') + k;
}

/** Escala do corpo pelo peso (X e Z) e pela altura (Y). Valores entre 0,9 e 1,1. */
export function bodyScale(info) {
  const h = clamp(info.height / 127, 0, 1);
  const b = clamp(info.build / 127, 0, 1);
  return { x: 0.9 + 0.2 * b, y: 0.9 + 0.2 * h, z: 0.9 + 0.2 * b };
}

/**
 * Perfil de IA a partir do perfil Mii (AiProfile.Create + FromMii). Campos numéricos, todos em [0,1]:
 *   reach     altura (o C# usa 0,85..1,15 como multiplicador; aqui normalizado)
 *   power     força: skill e peso, com leve ajuste pelo sexo
 *   speed     deslocamento: skill e peso (pesos médios são mais rápidos)
 *   accuracy  precisão: skill e variação do hash
 *   style     agressividade (0 = cauteloso, 1 = agressivo), do hash e do skill
 *   handedness probabilidade de preferir o lado direito (0 = esquerdo, 1 = direito), do hash
 * Determinístico: o mesmo perfil e a mesma força dão sempre o mesmo resultado.
 * @param {object} profile  entrada de profiles.json ou o objeto info de Profiles/*.json
 * @param {number} [skill=0.5] força 0..1
 */
export function aiProfile(profile, skill = 0.5) {
  const info = profile.info || profile;
  const id = profile.id ?? info.id ?? '';
  const s = clamp(skill, 0, 1);
  const h01 = clamp(info.height / 127, 0, 1);
  const b01 = clamp(info.build / 127, 0, 1);
  const female = info.sex === 1;
  const hash = stableHash(`${info.name ?? ''}|${id}`);
  const u1 = (hash & 0xff) / 255;
  const u3 = ((hash >> 16) & 0xff) / 255;
  return {
    reach: h01,
    power: clamp(0.3 + 0.4 * s + 0.3 * b01 + (female ? -0.03 : 0.03), 0, 1),
    speed: clamp(0.35 + 0.45 * s + 0.25 * (1 - Math.abs(b01 - 0.4)) - 0.1 * clamp(b01 - 0.6, 0, 1), 0, 1),
    accuracy: clamp(0.25 + 0.7 * s + 0.05 * (u1 - 0.5), 0, 1),
    style: clamp(0.3 + 0.4 * u3 + 0.2 * s, 0, 1),
    handedness: u1,
  };
}

/**
 * Campos do rosto para uma expressão (MiiCharInfo.WithExpression + SwapEyeType).
 * Devolve uma cópia; o perfil original não muda.
 */
export function expressionInfo(info, expression, params) {
  const c = JSON.parse(JSON.stringify(info));
  const swapEye = (type) => {
    c.eye.rotate = clamp(params.eyeRotateOffset[c.eye.type] - params.eyeRotateOffset[type] + c.eye.rotate, 0, 7);
    c.eye.type = type;
  };
  switch (expression) {
    case 'smile':
      swapEye(48);
      break;
    case 'angry':
      c.eyebrow.rotate = Math.min(c.eyebrow.rotate + 2, 11);
      c.eye.rotate = Math.min(c.eye.rotate + 2, 7);
      c.mouth.type = 10;
      break;
    case 'sad':
      c.eyebrow.rotate = clamp(c.eyebrow.rotate - 2, 0, 11);
      c.eye.rotate = clamp(c.eye.rotate - 2, 0, 7);
      c.mouth.type = 12;
      break;
    case 'surprise':
      c.eyebrow.y = (c.eyebrow.y - 2) & 0x1f;
      swapEye(49);
      break;
    default:
      break;
  }
  return c;
}

/**
 * Quads do rosto (MiiFaceTexture.Quads), na ordem de desenho: bigode, boca, sobrancelhas, olhos, pinta.
 * Cada quad: textura (pasta, índice), posição e tamanho em pixels da textura do rosto, rotação em graus,
 * align (0 centro, 2 lado esquerdo, 1 lado direito com u espelhado), modo e cores (c0, c1) em RGBA 0..255.
 */
export function faceQuads(info, res, p) {
  const u = res / 64;
  const out = [];
  if (info.beard.mustache !== 0) {
    const k = 1 + 0.4 * info.beard.scale;
    const base = {
      folder: 'mustache', index: info.beard.mustache, x: 32 * u, y: (31.7635536 + 1.0760944 * info.beard.y) * u,
      w: 4.5 * k * u, h: 9 * k * u, rot: 0, mode: 'solid', c0: at(p.mustacheColor2D, info.beard.color),
    };
    out.push({ ...base, align: 2 }, { ...base, align: 1 });
  }
  {
    const k = 1 + 0.4 * info.mouth.scale;
    out.push({
      folder: 'mouth', index: info.mouth.type, x: 32 * u, y: (29.2588501 + 1.0760944 * info.mouth.y) * u,
      w: 6.1875 * k * u, h: 4.5 * k * u, rot: 0, align: 0, mode: 'mouth',
      c0: at(p.mouthColorDark, info.mouth.color), c1: at(p.mouthColorLip, info.mouth.color),
    });
  }
  {
    const k = 1 + 0.4 * info.eyebrow.scale;
    const rot = 11.25 * ((info.eyebrow.rotate + p.eyebrowRotateOffset[info.eyebrow.type]) & 31);
    const base = {
      folder: 'eyebrow', index: info.eyebrow.type, y: (16.5498066 + 1.0760944 * info.eyebrow.y) * u,
      w: 5.0625 * k * u, h: 4.5 * k * u, mode: 'solid', c0: at(p.eyebrowColor2D, info.eyebrow.color),
    };
    out.push({ ...base, x: (32 - AXIS_X * info.eyebrow.x) * u, rot, align: 2 });
    out.push({ ...base, x: (32 + AXIS_X * info.eyebrow.x) * u, rot: 360 - rot, align: 1 });
  }
  {
    const k = 1 + 0.4 * info.eye.scale;
    const rot = 11.25 * ((info.eye.rotate + p.eyeRotateOffset[info.eye.type]) & 31);
    const outline = info.eye.type === 9 || info.eye.type === 20 ? p.eyeOutline[String(info.eye.type)] : p.eyeOutline.default;
    const base = {
      folder: 'eye', index: info.eye.type, y: (18.4515247 + 1.0760944 * info.eye.y) * u,
      w: 5.34375 * k * u, h: 4.5 * k * u, mode: 'eye', c0: outline, c1: at(p.eyeColor, info.eye.color),
    };
    out.push({ ...base, x: (32 - AXIS_X * info.eye.x) * u, rot, align: 2 });
    out.push({ ...base, x: (32 + AXIS_X * info.eye.x) * u, rot: 360 - rot, align: 1 });
  }
  if (info.mole.type !== 0) {
    const k = 1 + 0.4 * info.mole.scale;
    out.push({
      folder: 'mole', index: MOLE_TEXTURE, x: (17.7661648 + 1.7792293 * info.mole.x) * u,
      y: (17.9598598 + 1.0760944 * info.mole.y) * u, w: k * u, h: k * u, rot: 0, align: 0,
      mode: 'solid', c0: p.moleColor,
    });
  }
  return out;
}

/**
 * Matriz do canvas (a, b, c, d, e, f) de uma quad do RFL: T(x,y) · S(eixos) · R(rot) · S(w,h), com a textura
 * (W x H pixels) mapeada na caixa local x ∈ [x0, x0+1], y ∈ [-0,5; 0,5]. Com flip, a imagem sai espelhada em X.
 * Equações de RFLiDrawQuad/Draw/Vertex, em pixels de imagem (ix, iy) -> pixels do canvas.
 */
export function quadMatrix(q, x0, flip, W, H) {
  const r = q.rot * DEG;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  const kx = (flip ? -1 : 1) / W;
  const ky = 1 / H;
  const ox = x0 + (flip ? 1 : 0);
  return [
    AXIS_X * cs * q.w * kx,
    AXIS_Y * sn * q.w * kx,
    -AXIS_X * sn * q.h * ky,
    AXIS_Y * cs * q.h * ky,
    q.x + AXIS_X * (cs * q.w * ox + sn * q.h * 0.5),
    q.y + AXIS_Y * (sn * q.w * ox - cs * q.h * 0.5),
  ];
}

/** Geometria de uma parte da cabeça (MiiResources.BuildMesh sem o espelho do Unity). */
function shapeGeometry(shape, { transform = false, scale = 1, trans = null, flip = false, flipV = false }) {
  const T = runtime.THREE;
  const pos = shape.positions;
  const nrm = shape.normals;
  const n = pos.length / 3;
  const fx = flip ? -1 : 1;
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    let x = fx * pos[3 * i];
    let y = pos[3 * i + 1];
    let z = pos[3 * i + 2];
    if (transform) {
      x = trans.x + x * scale;
      y = trans.y + y * scale;
      z = trans.z + z * scale;
    }
    P[3 * i] = x;
    P[3 * i + 1] = y;
    P[3 * i + 2] = z;
    if (nrm) {
      N[3 * i] = fx * nrm[3 * i];
      N[3 * i + 1] = nrm[3 * i + 1];
      N[3 * i + 2] = nrm[3 * i + 2];
    }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(P, 3));
  if (nrm) g.setAttribute('normal', new T.BufferAttribute(N, 3));
  if (shape.uvs) {
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      uv[2 * i] = shape.uvs[2 * i];
      uv[2 * i + 1] = flipV ? 1 - shape.uvs[2 * i + 1] : shape.uvs[2 * i + 1];
    }
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
  }
  // espelhar X inverte o sentido das faces: nesse caso a ordem de cada triângulo é trocada
  const tri = shape.triangles;
  const idx = new Uint32Array(tri.length);
  for (let i = 0; i < tri.length; i += 3) {
    idx[i] = tri[i];
    idx[i + 1] = flip ? tri[i + 2] : tri[i + 1];
    idx[i + 2] = flip ? tri[i + 1] : tri[i + 2];
  }
  g.setIndex(new T.BufferAttribute(idx, 1));
  if (!nrm) g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Monta o Mii: cabeça (malhas + rosto), corpo ava_body* opcional e a cabeça presa ao osso head_set. */
export class MiiOpponentBuilder {
  /**
   * @param {AssetStore} [store]  dados (padrão: store compartilhado de minigames/sports)
   * @param {object} [o]
   * @param {Function} [o.canvasFactory]  (w, h) => canvas com getContext('2d'). Obrigatório fora do navegador.
   * @param {Function} [o.loadImage]      path => imagem com width/height (padrão: store.image)
   */
  constructor(store = defaultStore(), { canvasFactory = defaultCanvas, loadImage = null } = {}) {
    this.store = store;
    this.canvasFactory = canvasFactory;
    this.loadImage = loadImage;
    this.ready = null;
    this.profileList = [];
    this.params = null;
    this.texMeta = null;
    this.images = new Map();
    this.textures = new Map();
  }

  /** Lê profiles.json, rfl_params.json e textures.json (uma vez). */
  async load() {
    if (!this.ready) {
      this.ready = Promise.all([
        this.store.json('Mii/profiles.json'),
        this.store.json('Mii/rfl_params.json'),
        this.store.json('Mii/textures.json'),
      ]).then(([index, rfl, tex]) => {
        this.profileList = index.profiles;
        this.params = { ...rfl.colors, eyeOutline: rfl.eyeOutline, moleColor: rfl.moleColor, eyeRotateOffset: rfl.eyeRotateOffset, eyebrowRotateOffset: rfl.eyebrowRotateOffset };
        this.texMeta = tex;
        return this;
      }).catch((e) => { this.ready = null; throw e; });
    }
    await this.ready;
    return this;
  }

  /** Índice de perfis (id, nome, sexo, altura, peso, cor favorita). Vazio antes de load(). */
  get profiles() { return this.profileList; }

  /** Perfil de IA (ver aiProfile). */
  aiProfile(profile, skill = 0.5) { return aiProfile(profile, skill); }

  findProfile(ref) {
    const e = typeof ref === 'number' ? this.profileList[ref] : this.profileList.find((x) => x.id === ref);
    if (!e) throw new Error(`perfil Mii desconhecido: ${ref}`);
    return e;
  }

  /**
   * Monta o Mii. Devolve um Group com userData.mii = { id, info, profile, head, body, bodyName, faceMesh,
   * faces (Map expressão -> CanvasTexture), expression, favoriteColor, attachedTo }.
   * @param {number|string|object} profileIdOrIndex  índice em profiles, id ("cpu_mii_000") ou um Mii montado no
   *        editor de personagens ({id, info} com os campos do .rcd decodificado, core/MiiEditor.js)
   * @param {object} [o]
   * @param {boolean} [o.body=true]  true: carrega o corpo ava_body* certo e prende a cabeça no osso head_set
   */
  async build(profileIdOrIndex, { body = true } = {}) {
    await this.load();
    const T = runtime.THREE;
    const p = this.params;
    const custom = profileIdOrIndex && typeof profileIdOrIndex === 'object' && profileIdOrIndex.info ? profileIdOrIndex : null;
    const info = custom ? custom.info : null;
    const entry = custom
      ? { id: custom.id || 'custom', name: info.name, sex: info.sex, favoriteColor: info.favoriteColor, height: info.height, build: info.build }
      : this.findProfile(profileIdOrIndex);
    return this._build(entry, info || (await this.store.json(`Mii/Profiles/${entry.id}.json`)).info, body, T, p);
  }

  async _build(entry, info, body, T, p) {

    const faceline = await this.shape('faceline', info.faceline.type);
    if (!faceline) throw new Error(`${entry.id}: faceline ${info.faceline.type} ausente`);
    const skin = at(p.facelineColor, info.faceline.color);
    const favorite = at(p.favoriteColor, info.favoriteColor);
    const hairColor = at(p.hairColor, info.hair.color);
    const beardColor = at(p.beardColor, info.beard.color);
    const glassColor = at(p.glassColor, info.glass.color);
    const anchor = (k) => new T.Vector3(...faceline.anchors[k]);
    const noseAt = anchor('nose');
    const noseScale = 0.4 + 0.175 * info.nose.scale;
    const noseTrans = new T.Vector3(noseAt.x, noseAt.y - 1.5 * (info.nose.y - 8), noseAt.z);
    const beardAt = anchor('beard');
    const hairAt = anchor('hair');

    const head = new T.Group();
    head.name = 'MiiHead';
    const std = (c, extra = {}) => new T.MeshStandardMaterial({ color: colorOf(c), roughness: 0.9, metalness: 0, ...extra });

    // opacos, na ordem do RFL (barba, nariz, testa, cabelo, boné, rosto)
    const beard = await this.shape('beard', info.beard.type);
    if (beard) addPart(head, 'Beard', beard, { transform: true, trans: beardAt }, std(beardColor));
    const nose = await this.shape('nose', info.nose.type);
    if (nose) addPart(head, 'Nose', nose, { transform: true, scale: noseScale, trans: noseTrans }, std(skin));
    const forehead = await this.shape('forehead', info.hair.type);
    if (forehead) addPart(head, 'Forehead', forehead, { transform: true, trans: hairAt, flip: info.hair.flip }, std(skin));
    const hair = await this.shape('hair', info.hair.type);
    if (hair) addPart(head, 'Hair', hair, { transform: true, trans: hairAt, flip: info.hair.flip }, std(hairColor));
    const cap = await this.shape('cap', info.hair.type);
    if (cap) {
      const capTex = await this.shapeTexture('cap_shape', info.hair.type);
      addPart(head, 'Cap', cap, { transform: true, trans: hairAt, flip: info.hair.flip }, std(favorite, { map: capTex, alphaTest: 0.5 }));
    }
    const facelineTex = await this.shapeTexture('faceline_shape', info.faceline.texture);
    addPart(head, 'Faceline', faceline, {}, std(skin, { map: facelineTex, alphaTest: 0.5 }), 0);

    // translúcidos: rosto (mask, com o CanvasTexture), linha do nariz, óculos
    const faceCanvas = await this.composeFace(info);
    const faceTex = this.faceTexture(faceCanvas);
    const mask = await this.shape('mask', info.faceline.type);
    const faceMesh = mask ? addPart(head, 'Mask', mask, { flipV: true },
      new T.MeshStandardMaterial({ color: new T.Color(1, 1, 1), map: faceTex, roughness: 0.9, transparent: true, depthWrite: false }), 10) : null;
    const noseline = await this.shape('noseline', info.nose.type);
    if (noseline) {
      const lineTex = await this.shapeTexture('noseline_shape', info.nose.type);
      addPart(head, 'Noseline', noseline, { transform: true, scale: noseScale, trans: noseTrans },
        std([0, 0, 0], { map: lineTex, transparent: true, depthWrite: false }), 11);
    }
    if (info.glass.type !== 0) {
      const glass = await this.shape('glass', 0);
      if (glass) {
        const glassTex = await this.shapeTexture('glass_shape', info.glass.type);
        const glassTrans = new T.Vector3(noseAt.x, noseAt.y + 5 - 1.5 * (info.glass.y - 11), noseAt.z + 2);
        addPart(head, 'Glass', glass, { transform: true, scale: 0.4 + 0.15 * info.glass.scale, trans: glassTrans },
          std(glassColor, { map: glassTex, transparent: true, depthWrite: false, side: T.DoubleSide }), 12);
      }
    }

    const group = new T.Group();
    group.name = `mii:${entry.id}`;
    const mii = {
      id: entry.id, info, profile: entry, head, body: null, bodyName: null, faceMesh,
      faces: new Map([['neutral', faceTex]]), expression: 'neutral', favoriteColor: favorite, attachedTo: null,
    };
    group.userData.mii = mii;

    if (body) {
      const bodyName = bodyNameFor(info);
      const model = await loadModel(this.store, `${BODY_DIR}${bodyName}__${bodyName}.nw4r.json`);
      paintBody(model, favorite, p.favoriteColor[PANTS_INDEX]);
      const s = bodyScale(info);
      model.scale.set(s.x, s.y, s.z);
      group.add(model);
      mii.body = model;
      mii.bodyName = bodyName;
      mii.attachedTo = attachHead(head, model);
    } else {
      head.scale.setScalar(HEAD_SCALE);
      group.add(head);
    }
    return group;
  }

  /**
   * Troca a expressão do rosto (smile, sad, angry, surprise, neutral). Cada expressão é composta uma vez e
   * guardada em userData.mii.faces.
   */
  async setExpression(group, name) {
    if (!EXPRESSIONS.includes(name)) throw new Error(`expressão desconhecida: ${name}`);
    const mii = group.userData.mii;
    if (!mii) throw new Error('setExpression: o grupo não é um Mii montado por build()');
    let tex = mii.faces.get(name);
    if (!tex) {
      const canvas = await this.composeFace(expressionInfo(mii.info, name, this.params));
      tex = this.faceTexture(canvas);
      mii.faces.set(name, tex);
    }
    if (mii.faceMesh) {
      mii.faceMesh.material.map = tex;
      mii.faceMesh.material.needsUpdate = true;
    }
    mii.expression = name;
    return tex;
  }

  /**
   * Desenha o rosto (MiiFaceTexture.Render) num canvas do tamanho FACE_RES. Cada quad é tingida num canvas
   * auxiliar (source-in) e desenhada com a matriz da quad.
   */
  async composeFace(info, res = FACE_RES) {
    const canvas = this.canvasFactory(res, res);
    const g = canvas.getContext('2d');
    for (const q of faceQuads(info, res, this.params)) {
      if (!this.hasTexture(q.folder, q.index)) continue; // RFL: textura ausente não desenha (Resources.Load = null)
      const img = await this.image(`Mii/Textures/${q.folder}/${pad2(q.index)}.png`);
      const W = img.width;
      const H = img.height;
      const sprite = q.mode === 'eye' ? this.layered(img, W, H, q.c0, q.c1, WHITE)   // R contorno, G íris, B branco
        : q.mode === 'mouth' ? this.layered(img, W, H, q.c1, q.c0, WHITE)               // R lábio, G interior, B dentes
          : this.tint(img, W, H, q.c0);
      const x0 = q.align === 0 ? -0.5 : q.align === 2 ? -1 : 0;
      const m = quadMatrix(q, x0, q.align === 1, W, H);
      g.save();
      g.setTransform(...m);
      g.drawImage(sprite, 0, 0, W, H);
      g.restore();
    }
    return canvas;
  }

  /** Canvas auxiliar com olho/boca compostos por canal (composeChannels), alfa da textura preservado. */
  layered(img, W, H, cR, cG, cB) {
    const c = this.canvasFactory(W, H);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H);
    composeChannels(d.data, cR, cG, cB);
    g.putImageData(d, 0, 0);
    return c;
  }

  /** Canvas auxiliar com a imagem pintada na cor dada (alfa da imagem preservado). */
  tint(img, W, H, color) {
    const c = this.canvasFactory(W, H);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, W, H);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = cssColor(color);
    g.fillRect(0, 0, W, H);
    return c;
  }

  /** CanvasTexture do rosto: canvas com a linha 0 em cima (flipY), como o PNG importado no Unity. */
  faceTexture(canvas) {
    const T = runtime.THREE;
    const t = new T.CanvasTexture(canvas);
    t.colorSpace = T.SRGBColorSpace;
    t.wrapS = T.ClampToEdgeWrapping;
    t.wrapT = T.ClampToEdgeWrapping;
    t.name = 'MiiFace';
    t.needsUpdate = true;
    return t;
  }

  hasTexture(folder, index) {
    const list = this.texMeta?.textures?.[folder];
    return !!list && index >= 0 && index < list.length;
  }

  /** Partes de forma: Shapes/<parte>.json, entrada index (null = parte vazia). */
  async shape(part, index) {
    const data = await this.store.json(`Mii/Shapes/${part}.json`);
    return data.parts[index] ?? null;
  }

  /** Textura de forma (I4/IA4/RGB5A3) com o wrap do GX; flipY = false, uv (s, t) como no AssetStore. */
  async shapeTexture(folder, index) {
    if (!this.hasTexture(folder, index)) return null;
    const key = `${folder}/${index}`;
    if (!this.textures.has(key)) {
      this.textures.set(key, (async () => {
        const meta = this.texMeta.textures[folder][index];
        const img = await this.image(`Mii/Textures/${folder}/${pad2(index)}.png`);
        const T = runtime.THREE;
        const t = new T.Texture(img);
        t.flipY = false;
        t.colorSpace = T.SRGBColorSpace;
        t.wrapS = wrapMode(T, meta.wrapS);
        t.wrapT = wrapMode(T, meta.wrapT);
        t.name = key;
        t.needsUpdate = true;
        return t;
      })());
    }
    return this.textures.get(key);
  }

  image(path) {
    if (!this.images.has(path)) {
      const p = this.loadImage ? this.loadImage(path) : this.store.image(path);
      this.images.set(path, Promise.resolve(p).catch((e) => { this.images.delete(path); throw e; }));
    }
    return this.images.get(path);
  }
}

/** Canvas padrão do navegador. Em Node é preciso injetar canvasFactory. */
function defaultCanvas(w, h) {
  if (typeof document === 'undefined') throw new Error('MiiOpponentBuilder: sem DOM; injete canvasFactory');
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function colorOf([r, g, b]) {
  return new (runtime.THREE.Color)().setRGB(r / 255, g / 255, b / 255, runtime.THREE.SRGBColorSpace);
}

function addPart(parent, name, shape, geoOpts, material, renderOrder = 0) {
  const T = runtime.THREE;
  const mesh = new T.Mesh(shapeGeometry(shape, geoOpts), material);
  mesh.name = name;
  mesh.renderOrder = renderOrder;
  parent.add(mesh);
  return mesh;
}

/**
 * Cor da camisa (favorita) em todos os materiais placeholder (dummy_tex_*) do corpo. A calça fica registrada
 * em userData.nw4r.pants; o mt_main é um material só, então não há região separada para ela.
 */
function paintBody(model, shirt, pants) {
  const shirtColor = colorOf(shirt);
  model.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (!m?.userData?.nw4r?.placeholder) continue;
      m.color.copy(shirtColor);
      m.userData.nw4r.shirt = shirt;
      m.userData.nw4r.pants = pants;
      m.needsUpdate = true;
    }
  });
}

/**
 * Prende a cabeça ao osso head_set (ou head). Porte de MiiCharacterBuilder.AttachHead: a pose de repouso é
 * restaurada antes; a rotação da cabeça alinha seus eixos aos do corpo; a escala compensa o osso.
 * Devolve o nome do osso.
 */
function attachHead(head, model) {
  const T = runtime.THREE;
  const bones = model.userData.nw4r.boneByName;
  const bone = bones.get('head_set') || bones.get('head');
  if (!bone) throw new Error('corpo sem o osso head_set nem head');
  resetPose(model);
  model.updateMatrixWorld(true);
  bone.add(head);
  head.position.set(0, 0, 0);
  bone.updateMatrixWorld(true);
  const bq = bone.getWorldQuaternion(new T.Quaternion());
  const mq = model.getWorldQuaternion(new T.Quaternion());
  head.quaternion.copy(bq.invert().multiply(mq));
  const bs = bone.getWorldScale(new T.Vector3());
  const ms = model.getWorldScale(new T.Vector3());
  head.scale.setScalar((HEAD_SCALE * ms.x) / (bs.x || 1));
  return bone.name;
}
