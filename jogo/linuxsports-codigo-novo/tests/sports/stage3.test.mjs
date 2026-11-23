// Etapa 3 no three.js: 60 Mii dos adversários (cabeça + rosto), corpo ava_body* com a cabeça no osso head_set,
// perfil de IA determinístico e o adaptador do avatar VRM do WEBC (movimentos, expressões, spring bones).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, mod, json, syntheticVrm1 } from './helpers.mjs';

const { THREE, VRM, store } = await setup();
const { MiiOpponentBuilder, aiProfile, bodyNameFor, bodyScale, stableHash, expressionInfo } = await mod('entities/MiiOpponentBuilder.js');
const { WebcAvatarAdapter } = await mod('entities/WebcAvatarAdapter.js');
const { VrmaLibrary } = await mod('engine/animation/VrmaPlayer.js');

// Canvas falso: registra cada operação (com o canvas de origem) para conferir as chamadas do rosto.
function fakeCanvas() {
  const ops = [];
  const factory = (w, h) => {
    const canvas = { kind: 'canvas', width: w, height: h };
    const ctx = {
      globalCompositeOperation: 'source-over',
      fillStyle: '#000000',
      save() { ops.push({ canvas, op: 'save' }); },
      restore() { ops.push({ canvas, op: 'restore' }); },
      setTransform(...m) { ops.push({ canvas, op: 'setTransform', args: m }); },
      drawImage(src, ...args) { ops.push({ canvas, op: 'drawImage', src, args }); },
      fillRect(...args) { ops.push({ canvas, op: 'fillRect', args, fill: this.fillStyle, comp: this.globalCompositeOperation }); },
      getImageData(x, y, w2, h2) { ops.push({ canvas, op: 'getImageData' }); return { data: new Uint8ClampedArray(w2 * h2 * 4), width: w2, height: h2 }; },
      putImageData(d) { ops.push({ canvas, op: 'putImageData' }); },
    };
    canvas.getContext = () => ctx;
    return canvas;
  };
  return { ops, factory };
}
// imagem falsa: só largura e altura (o Node não decodifica PNG com createImageBitmap)
const loadImage = async (path) => ({ kind: 'image', path, width: 32, height: 32 });

const log = fakeCanvas();
const builder = new MiiOpponentBuilder(store, { canvasFactory: log.factory, loadImage });
await builder.load();
const tex = await json('Mii/textures.json');
const rfl = await json('Mii/rfl_params.json');

const hex = (rgba) => rgba.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');

async function vrm1() {
  const loader = new VRM.GLTFLoader();
  loader.register((p) => new VRM.VRMLoaderPlugin(p));
  const g = await loader.parseAsync(syntheticVrm1(), '');
  return g.userData.vrm;
}

test('perfis: 60 perfis CPU no índice, com id, nome, sexo, altura, peso e cor favorita', () => {
  assert.equal(builder.profiles.length, 60);
  for (const e of builder.profiles) {
    for (const k of ['id', 'name', 'sex', 'height', 'build', 'favoriteColor']) assert.ok(k in e, `${e.id} sem ${k}`);
  }
});

test('60 perfis: cada um monta uma cabeça com malhas e um CanvasTexture do rosto', async () => {
  for (let i = 0; i < 60; i++) {
    log.ops.length = 0;
    const g = await builder.build(i, { body: false });
    assert.ok(g instanceof THREE.Group, `perfil ${i}`);
    const mii = g.userData.mii;
    const meshes = [];
    mii.head.traverse((o) => { if (o.isMesh) meshes.push(o); });
    assert.ok(meshes.length >= 5, `${mii.id}: só ${meshes.length} malhas`);
    assert.ok(mii.faceMesh, `${mii.id}: sem máscara do rosto`);
    assert.ok(mii.faceMesh.material.map instanceof THREE.CanvasTexture, `${mii.id}: rosto não é CanvasTexture`);
    assert.equal(mii.faceMesh.material.map.colorSpace, THREE.SRGBColorSpace);

    // quads esperadas, contadas de forma independente dos campos do perfil (com as texturas existentes)
    const info = mii.info;
    const has = (folder, index) => index < tex.textures[folder].length;
    let quads = 0, layered = 0;
    if (info.beard.mustache !== 0 && has('mustache', info.beard.mustache)) quads += 2;
    if (has('mouth', info.mouth.type)) { quads += 1; layered += 1; }
    if (has('eyebrow', info.eyebrow.type)) quads += 2;
    if (has('eye', info.eye.type)) { quads += 2; layered += 2; }
    if (info.mole.type !== 0 && has('mole', 1)) quads += 1;

    const face = mii.faceMesh.material.map.image;
    const onFace = log.ops.filter((o) => o.canvas === face);
    assert.equal(onFace.filter((o) => o.op === 'setTransform').length, quads, `${mii.id}: setTransform`);
    assert.equal(onFace.filter((o) => o.op === 'drawImage').length, quads, `${mii.id}: drawImage no rosto`);
    // sobrancelha/bigode/pinta: tinta sólida (fillRect); olho e boca: composição por canal (putImageData)
    assert.equal(log.ops.filter((o) => o.op === 'fillRect').length, quads - layered, `${mii.id}: fillRect das tintas`);
    assert.equal(log.ops.filter((o) => o.op === 'putImageData').length, layered, `${mii.id}: olho/boca por canal`);
    assert.ok(quads >= 3, `${mii.id}: rosto com poucas peças (${quads})`);
  }
});

test('rosto: cada quad usa a matriz do RFL (finita) e a tinta é source-in com a cor do campo', async () => {
  const g = await builder.build(0, { body: false });
  const face = g.userData.mii.faceMesh.material.map.image;
  const transforms = log.ops.filter((o) => o.canvas === face && o.op === 'setTransform');
  for (const t of transforms) assert.ok(t.args.every(Number.isFinite), 'matriz não finita');
  const fills = log.ops.filter((o) => o.op === 'fillRect' && o.comp === 'source-in');
  assert.ok(fills.length > 0);
  for (const f of fills) assert.match(f.fill, /^rgba\(\d+,\d+,\d+,[\d.]+\)$/);
});

test('corpo: ava_body* pelo sexo e peso, cabeça presa ao osso head_set e acompanha a animação', async () => {
  const g = await builder.build(0, { body: true });
  const mii = g.userData.mii;
  assert.equal(mii.bodyName, 'ava_bodyA2'); // sexo 0, peso 64 -> k = 2
  assert.equal(mii.attachedTo, 'head_set');
  const bone = mii.head.parent;
  assert.ok(bone.isBone);
  assert.equal(bone.name, 'head_set');
  assert.equal(bone, mii.body.userData.nw4r.boneByName.get('head_set'));

  // a cabeça segue o osso: a origem da cabeça fica na origem do osso, então o que muda é a orientação no mundo
  g.updateMatrixWorld(true);
  const before = mii.head.getWorldQuaternion(new THREE.Quaternion());
  bone.rotateZ(0.8);
  g.updateMatrixWorld(true);
  const after = mii.head.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(before.angleTo(after) > 0.1, 'a cabeça não acompanhou o osso');
  bone.rotateZ(-0.8);

  // camisa (favorita) nos materiais placeholder do corpo
  const fav = hex(mii.favoriteColor);
  let placeholders = 0;
  mii.body.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (!m.userData.nw4r?.placeholder) continue;
      placeholders++;
      assert.equal(m.color.getHexString(THREE.SRGBColorSpace), fav);
    }
  });
  assert.ok(placeholders > 0, 'corpo sem material placeholder');
});

test('corpo: feminino e pesos extremos escolhem o sidecar certo; a escala segue altura e peso', () => {
  assert.equal(bodyNameFor({ sex: 0, build: 0 }), 'ava_bodyA0');
  assert.equal(bodyNameFor({ sex: 0, build: 64 }), 'ava_bodyA2');
  assert.equal(bodyNameFor({ sex: 1, build: 127 }), 'ava_bodyB3');
  const s = bodyScale({ height: 127, build: 0 });
  assert.ok(s.y > 1 && s.x < 1 && s.x > 0.85 && s.y < 1.11);
});

test('setExpression: troca o rosto por expressão e volta ao neutro com a mesma textura', async () => {
  const g = await builder.build(1, { body: false });
  const mii = g.userData.mii;
  const neutral = mii.faceMesh.material.map;
  log.ops.length = 0;
  const smile = await builder.setExpression(g, 'smile');
  assert.notEqual(smile, neutral);
  assert.equal(mii.faceMesh.material.map, smile);
  assert.equal(mii.expression, 'smile');
  assert.ok(log.ops.length > 0, 'a expressão não desenhou nada');
  const again = await builder.setExpression(g, 'neutral');
  assert.equal(again, neutral);
  await assert.rejects(() => builder.setExpression(g, 'nope'));
});

test('expressionInfo: smile troca o olho para o tipo 48 e angry sobe a boca para 10', () => {
  const info = { eye: { type: 3, rotate: 2 }, eyebrow: { rotate: 5, y: 1 }, mouth: { type: 1 } };
  const sm = expressionInfo(info, 'smile', rfl);
  assert.equal(sm.eye.type, 48);
  assert.ok(sm.eye.rotate >= 0 && sm.eye.rotate <= 7);
  assert.equal(info.eye.type, 3, 'o perfil original não pode mudar');
  assert.equal(expressionInfo(info, 'angry', rfl).mouth.type, 10);
  assert.equal(expressionInfo(info, 'surprise', rfl).eyebrow.y, 31);
});

test('aiProfile: determinístico, campos numéricos em [0,1] para os 60 perfis e 3 forças', async () => {
  const seen = new Set();
  for (const entry of builder.profiles) {
    const full = (await json(`Mii/Profiles/${entry.id}.json`)).info;
    for (const s of [0, 0.5, 1]) {
      const a = aiProfile(entry, s);
      assert.deepEqual(a, aiProfile(entry, s), `${entry.id}: não determinístico`);
      assert.deepEqual(a, builder.aiProfile(entry, s));
      assert.deepEqual(a, aiProfile({ ...full, id: entry.id }, s), `${entry.id}: índice e perfil completo divergem`);
      for (const [k, v] of Object.entries(a)) {
        assert.equal(typeof v, 'number', `${entry.id}.${k}`);
        assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${entry.id}.${k} = ${v}`);
      }
      seen.add(a.accuracy.toFixed(4));
    }
  }
  assert.ok(seen.size > 20, 'precisão quase igual para todos os perfis');
});

test('stableHash: FNV-1a de 32 bits (vetor conhecido de "a"), sempre positivo', () => {
  assert.equal(stableHash('a'), 0xe40c292c & 0x7fffffff);
  assert.equal(stableHash('cpu_mii_000'), stableHash('cpu_mii_000'));
  assert.ok(stableHash('qualquer nome') >= 0);
});

test('WebcAvatarAdapter: altura em metros, sportScale e movimento .vrma do catálogo', async () => {
  const vrm = await vrm1();
  const lib = await new VrmaLibrary(store).load();
  const ad = new WebcAvatarAdapter(vrm, { library: lib });
  const h = ad.height;
  assert.ok(h > 1 && h < 2, `altura ${h}`);
  assert.equal(ad.sportScale(), 10);
  const entry = lib.entries[0];
  const action = await ad.play(entry.name);
  assert.ok(action, `play(${entry.name}) não devolveu ação`);
  assert.equal(await ad.play('nao_existe'), null);
  ad.update(1 / 60);
  ad.stop();
  ad.update(0.5);
  assert.equal(new WebcAvatarAdapter({ scene: new THREE.Group() }, { library: lib }).height, 0);
});

test('WebcAvatarAdapter: expressões ausentes não lançam erro e o VRM sem humanoide tem altura 0', async () => {
  const vrm = await vrm1();
  const ad = new WebcAvatarAdapter(vrm, { library: new VrmaLibrary(store) });
  assert.equal(ad.celebrate(), null);
  assert.equal(ad.lose(), null);
  assert.equal(ad.neutral(), null);
  assert.doesNotThrow(() => ad.update(0.016));
});

test('WebcAvatarAdapter: nomes VRM 0.x (joy) com fade, e atributos atualizados só para expressões existentes', () => {
  const weights = {};
  const em = {
    getExpression: (n) => (n === 'joy' ? { name: 'joy' } : null),
    setValue: (n, v) => { weights[n] = v; },
  };
  const ad = new WebcAvatarAdapter({ scene: new THREE.Group(), expressionManager: em, humanoid: null }, { library: new VrmaLibrary(store) });
  assert.equal(ad.height, 0);
  assert.equal(ad.celebrate(), 'joy');
  ad.update(0.05);
  const w1 = weights.joy;
  ad.update(0.05);
  const w2 = weights.joy;
  assert.ok(w1 > 0 && w2 > w1 && w2 <= 1, `fade ${w1} -> ${w2}`);
  assert.equal(ad.lose(), null);
  for (let i = 0; i < 200; i++) ad.update(0.05);
  assert.ok(weights.joy < 0.01, 'expressão não voltou a zero');
  assert.equal(Object.keys(weights).join(), 'joy');
});

test('WebcAvatarAdapter: attach, teleport e dispose mexem só na cena (o VRM é do WEBC)', async () => {
  const vrm = await vrm1();
  const ad = new WebcAvatarAdapter(vrm, { library: new VrmaLibrary(store) });
  const parent = new THREE.Group();
  ad.attach(parent, [1, 2, 3], [0, 0, 0, 1]);
  assert.ok(parent.children.includes(vrm.scene));
  assert.deepEqual(vrm.scene.position.toArray(), [1, 2, 3]);
  ad.teleport(new THREE.Vector3(4, 5, 6));
  assert.deepEqual(vrm.scene.position.toArray(), [4, 5, 6]);
  ad.dispose();
  assert.ok(!parent.children.includes(vrm.scene));
  assert.equal(ad.play('x').constructor.name, 'Promise');
  assert.equal(await ad.play('x'), null);
});

test('rosto: olho e boca compostos por canal (branco do olho preservado)', async () => {
  const { composeChannels } = await mod('entities/MiiOpponentBuilder.js');
  const outline = [0, 0, 0, 255], iris = [40, 90, 200, 255], white = [255, 255, 255, 255];
  // pixels reais de eye/00.png: contorno preto, branco (azul), íris (verde), transparente
  const d = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 255, 255, 0, 255, 0, 255, 0, 0, 0, 0]);
  composeChannels(d, outline, iris, white);
  assert.deepEqual([...d], [0, 0, 0, 255, 255, 255, 255, 255, 40, 90, 200, 255, 0, 0, 0, 0]);
});
