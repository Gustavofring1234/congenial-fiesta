// Etapa 4 no three.js: ambiente (.plight/.pblm) nas cenas, bloom próprio, entrada híbrida (ponteiro, teclado,
// gamepad e câmera) e áudio (síntese procedural e carregamento dos 5 .wav do menu Home).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, mod, json } from './helpers.mjs';

const { THREE, store } = await setup();
const { loadEnvironment, parseEnvironment, resolvePreset, alcanceDaLuz, SceneEnvironment, QUALITY, LOCAL_INTENSITY } =
  await mod('engine/scene/SceneEnvironment.js');
const { BloomPass, bloomSettings, planBloomLevels, gaussianKernel, levelSigma, KMAX } = await mod('engine/scene/BloomPass.js');
const { SportsInputBridge, swipeMeasure, frameFromResult, stepGestures, createGestureState, flickStep, createFlickState,
  aimFromResult, keyMove, POINTER_CFG, CAMERA_CFG } = await mod('engine/input/SportsInputBridge.js');
const { synthImpact, synthWhistle, synthAmbient, makeRng, IMPACT_KINDS, SportsAudioManager } = await mod('engine/audio/SportsAudioManager.js');

// ── renderer falso: só o que o SceneEnvironment toca sem GPU ─────────────────────
const rendererFalso = () => ({ shadowMap: {}, capabilities: {} });
const cena = () => new THREE.Scene();
const camera = () => { const c = new THREE.PerspectiveCamera(55, 1, 0.1, 600); c.position.set(0, 1.5, 10); c.lookAt(0, 1, 0); return c; };

const indice = await json('Environment/environment_index.json');
const indiceCenas = await json('Scenes/scenes_index.json');

// ── ambiente ──────────────────────────────────────────────────────────────────

test('21 presets carregam e apply() cria sol com sombra e no máximo N luzes locais (todas as qualidades)', async () => {
  assert.equal(indice.presets.length, 21);
  for (const p of indice.presets) {
    const env = await loadEnvironment(store, p.name);
    assert.equal(env.preset, p.name);
    for (const quality of Object.keys(QUALITY)) {
      const sc = cena(), cam = camera(), r = rendererFalso();
      const se = new SceneEnvironment(r, sc, cam, { quality, shadows: true, bloom: true });
      se.apply(env, { focus: [0, 0, 0], radius: 60 });
      assert.equal(r.shadowMap.type, THREE.PCFSoftShadowMap, p.name);
      assert.equal(r.shadowMap.enabled, true, p.name);
      assert.ok(se.sun.isDirectionalLight, `${p.name}: sol é direcional`);
      assert.equal(se.sun.castShadow, true, `${p.name}: sol faz sombra`);
      assert.equal(se.sun.shadow.mapSize.x, QUALITY[quality].shadowMap, `${p.name}: shadow map da qualidade`);
      const locais = sc.children.filter((o) => o.isPointLight || o.isSpotLight);
      assert.ok(locais.length <= QUALITY[quality].localLights, `${p.name}/${quality}: ${locais.length} locais`);
      se.dispose();
    }
  }
});

test('preset sem luz de mundo (rpcommon): sol existe com intensidade 0 e não ilumina', async () => {
  const env = await loadEnvironment(store, 'rpcommon');
  assert.equal(env.lights.filter((l) => l.enabled && l.gx && l.colorEnable).length, 0);
  const se = new SceneEnvironment(rendererFalso(), cena(), camera(), { quality: 'low' }).apply(env);
  assert.equal(se.sun.castShadow, true);
  assert.equal(se.sun.intensity, 0);
});

test('golfe: sol segue a direção Wii (alvo − posição) e a cor da luz e do ambiente vêm do .plight', async () => {
  const env = await loadEnvironment(store, 'golf');
  const l0 = env.lights[0];
  const sc = cena();
  const se = new SceneEnvironment(rendererFalso(), sc, camera(), { quality: 'medium' }).apply(env, { focus: [0, 0, 0], radius: 50 });
  const dir = se.sun.target.position.clone().sub(se.sun.position).normalize();
  const esperado = new THREE.Vector3(l0.target[0] - l0.position[0], l0.target[1] - l0.position[1], l0.target[2] - l0.position[2]).normalize();
  assert.ok(dir.distanceTo(esperado) < 1e-5, `direção ${dir.toArray()} vs ${esperado.toArray()}`);
  assert.ok(Math.abs(se.sun.color.r - l0.color[0]) < 1e-6);
  const amb = sc.children.find((o) => o.isAmbientLight);
  assert.ok(amb, 'há AmbientLight');
  assert.ok(Math.abs(amb.color.r - env.ambientColors[0][0]) < 1e-6);
});

test('luzes locais: só as N mais perto da câmera; ao andar a câmera, o conjunto troca', () => {
  const T = THREE;
  const luz = (x, tipo = 'point') => ({
    index: 0, enabled: true, gx: true, colorEnable: true, lightTexture: true, type: tipo, space: 'world',
    position: [x, 2, 0], target: [x, 0, 0], color: [1, 0.5, 0.25], spotCutoff: 45, refDistance: 0.5, refBrightness: 0.5,
    manualAttnA: false, manualAttnK: false, distAttnFn: 1,
  });
  const env = {
    ambientColors: [[0.2, 0.2, 0.2]], globalColor: [0, 0, 0], lightTextures: [], bloom: null,
    lights: [luz(0), luz(10), luz(20), luz(30, 'spot'), luz(40), luz(50)],
  };
  const sc = cena(), cam = camera();
  cam.position.set(0, 1.5, 0);
  const se = new SceneEnvironment(rendererFalso(), sc, cam, { quality: 'low' });
  se.apply(env, { focus: [0, 0, 0], radius: 30 });
  const contar = () => sc.children.filter((o) => o.isPointLight || o.isSpotLight);
  assert.equal(contar().length, 2);
  const x = (lista) => lista.map((o) => o.position.x).sort((a, b) => a - b);
  assert.deepEqual(x(contar()), [0, 10]);
  se.update(new T.Vector3(45, 1.5, 0));
  assert.equal(contar().length, 2, 'continua no limite');
  assert.deepEqual(x(contar()), [40, 50]);
  se.dispose();
  assert.equal(sc.children.filter((o) => o.isPointLight || o.isSpotLight).length, 0, 'dispose tira as luzes');
});

test('alcance como o C#: refDist = refDistance × |alvo − posição|, alcance = refDist / (1 − refBrightness)', () => {
  const l = { refDistance: 0.5, refBrightness: 0.5, manualAttnK: false, distAttnFn: 1 };
  assert.ok(Math.abs(alcanceDaLuz(l, 10) - 10) < 1e-9);
  assert.equal(alcanceDaLuz({ ...l, manualAttnK: true }, 10), 0, 'sem atenuação = sem corte');
  assert.equal(alcanceDaLuz({ ...l, distAttnFn: 0 }, 10), 0);
  assert.ok(LOCAL_INTENSITY > 0);
});

test('loadEnvironment aceita nome de preset, assetId de cena, caminho .scene.json e a cena carregada', async () => {
  const cen = indiceCenas.scenes.find((s) => s.name === 'ballpark00');
  const porId = await loadEnvironment(store, cen.assetId);
  assert.equal(porId.preset, indice.scenes[cen.file]);
  assert.equal(porId.preset, 'baseball');
  assert.equal((await loadEnvironment(store, cen.file)).preset, 'baseball');
  assert.equal((await loadEnvironment(store, { assetId: cen.assetId })).preset, 'baseball');
  assert.equal((await loadEnvironment(store, { file: cen.file })).preset, 'baseball');
  await assert.rejects(loadEnvironment(store, 'cena_que_nao_existe'), /nenhum preset/);
  assert.throws(() => resolvePreset(indice, indiceCenas, 42), /informe/);
});

test('parseEnvironment: cor final = min(255, cor × intensidade), como FinalColor', () => {
  const env = parseEnvironment({ light: { ambientColors: [[255, 0, 128, 255]], lights: [{
    index: 1, enabled: true, gx: true, colorEnable: true, type: 'point', space: 'world', intensity: 2,
    color: [200, 100, 10, 255], position: [0, 0, 0], target: [1, 0, 0],
  }] } });
  assert.deepEqual(env.lights[0].color.map((v) => Math.round(v * 255)), [255, 200, 20]);
  assert.deepEqual(env.ambientColors[0].map((v) => Math.round(v * 255)), [255, 0, 128]);
  assert.equal(env.bloom, null);
});

// ── bloom ──────────────────────────────────────────────────────────────────────

test('pesos do gaussiano somam 1, são simétricos e zeram fora de 3σ (limitado a KMAX)', () => {
  for (const s of [0.5, 1, 2, 5, 8, 40]) {
    const w = gaussianKernel(s);
    assert.equal(w.length, 2 * KMAX + 1);
    const soma = w.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(soma - 1) < 1e-5, `σ=${s}: soma ${soma}`);
    for (let i = 0; i <= KMAX; i++) assert.ok(Math.abs(w[KMAX - i] - w[KMAX + i]) < 1e-7, `σ=${s} simétrico`);
    assert.ok(w[KMAX] >= w[KMAX - 1], 'pico no centro');
  }
  assert.equal(gaussianKernel(1)[0], 0, 'cauda zerada além de 3σ');
});

test('bloomSettings: parâmetros do .pblm do tênis (alfa 1, estágio de 0,25, intensityScale 4 = intensidade 1)', async () => {
  const env = await loadEnvironment(store, 'tennis');
  const s = bloomSettings(env.bloom);
  assert.equal(s.active, true);
  assert.ok(Math.abs(s.threshold - 0.4) < 1e-9);
  assert.ok(Math.abs(s.intensity - 1) < 1e-9, `intensidade ${s.intensity}`);
  assert.equal(s.stages.length, 1);
  assert.ok(Math.abs(s.stages[0].weight - 1) < 1e-9);
  assert.equal(s.stages[0].radius, 1.5);
  assert.ok(Math.abs(s.tint[1] - 200 / 255) < 1e-9);
  assert.ok(s.scatter > 0.4 && s.scatter < 0.95);
});

test('bloomSettings: intensidade = alfa × Σ estágios × escala, com pesos que somam a intensidade', async () => {
  const env = await loadEnvironment(store, 'baseball');
  const p = env.bloom;
  const soma = p.stages.slice(0, p.stageCount).reduce((a, s) => a + s.intensity, 0);
  const s = bloomSettings(p);
  assert.ok(Math.abs(s.intensity - (p.color[3] / 255) * soma * 4) < 1e-9);
  assert.ok(Math.abs(s.stages.reduce((a, st) => a + st.weight, 0) - s.intensity) < 1e-9);
  assert.ok(Math.abs(bloomSettings(p, 2).intensity - s.intensity / 2) < 1e-9, 'intensityScale muda a intensidade');
});

test('bloom desligado: limiar >= 1, alfa 0, sem estágios ou sem .pblm', () => {
  const base = { threshold: 0.3, thresholdColor: [255, 255, 255, 255], color: [255, 255, 255, 255], stageCount: 1, stages: [{ radius: 1, intensity: 0.5 }] };
  assert.equal(bloomSettings(null).active, false);
  assert.equal(bloomSettings({ ...base, threshold: 1 }).active, false);
  assert.equal(bloomSettings({ ...base, color: [0, 0, 0, 0] }).active, false);
  assert.equal(bloomSettings({ ...base, stageCount: 0 }).active, false);
  assert.equal(bloomSettings(base).active, true);
});

test('planBloomLevels: estágios excedentes somam o peso no último nível (soma preservada)', () => {
  const estagios = [{ weight: 0.2, radius: 1 }, { weight: 0.3, radius: 8 }, { weight: 0.1, radius: 16 }];
  const plano = planBloomLevels(estagios, 2);
  assert.equal(plano.length, 2);
  assert.ok(Math.abs(plano.reduce((a, p) => a + p.weight, 0) - 0.6) < 1e-12);
  assert.equal(plano[1].radius, 16);
  assert.equal(planBloomLevels(estagios, 4).length, 3);
  assert.ok(levelSigma(0) >= 1 && levelSigma(1000) <= 8, 'σ limitado');
});

test('BloomPass: cálculo sem renderer não cria alvos nem materiais', () => {
  const bp = new BloomPass({ levels: 3 });
  assert.equal(bp.gpu, null);
  const pblm = { threshold: 0.4, thresholdColor: [255, 255, 255, 255], color: [255, 200, 160, 255], stageCount: 1,
    stages: [{ radius: 1.5, intensity: 0.25 }, { radius: 8, intensity: 0 }, { radius: 16, intensity: 0 }] };
  bp.setPblm(pblm);
  assert.equal(bp.active, true);
  assert.equal(bp.plan.length, 1);
  assert.equal(bp.gpu, null, 'sem renderer real: nada de GPU');
  bp.setPblm(null);
  assert.equal(bp.active, false);
  bp.enabled = false;
  assert.equal(new BloomPass().setPblm(pblm).active, true);
});

// ── detecção de gestos (câmera) ─────────────────────────────────────────────────

const FPS = 30;
const DT = 1 / FPS;
const VIS = 1;

/** Ponto canônico (x esquerda da pessoa, y para cima, z para a frente) -> ponto do MediaPipe (metros). */
const bruto = (c, v = VIS) => [c.x, -c.y, -c.z, v];

/**
 * Resultado no formato de captura.ouvir: corpo.mundo com 33 pontos, maos e t em ms.
 * Esqueleto parado: ombros em y=1.4 (x ±0.18), nariz em (0, 1.55, 0.05), pulsos no quadril (y=1.0).
 */
function resultado(t, { direito = null, esquerdo = null, nariz = { x: 0, y: 1.55, z: 0.05 }, ombros = true } = {}) {
  const P = Array.from({ length: 33 }, () => ({ x: 0, y: 1.0, z: 0 }));
  P[0] = nariz;
  P[11] = { x: 0.18, y: 1.4, z: 0 };
  P[12] = { x: -0.18, y: 1.4, z: 0 };
  P[13] = { x: 0.2, y: 1.2, z: 0.05 };
  P[14] = { x: -0.2, y: 1.2, z: 0.05 };
  P[15] = esquerdo || { x: 0.25, y: 1.0, z: 0 };
  P[16] = direito || { x: -0.25, y: 1.0, z: 0 };
  const mundo = P.map((c, i) => bruto(c, !ombros && (i === 11 || i === 12) ? 0 : VIS));
  const imagem = mundo.map((m) => [0.5 + m[0] * 0.1, 0.5 + m[1] * 0.1, m[3]]);
  return { t: t * 1000, corpo: { mundo, imagem }, maos: [] };
}

/** Sequência de quadros a 30 fps: pos(i, t) dá o pulso direito em cada instante. */
function sequencia(duracao, pos, extra = {}) {
  const out = [];
  const n = Math.round(duracao * FPS);
  for (let i = 0; i <= n; i++) {
    const t = i * DT;
    out.push(resultado(t, { direito: pos(t), ...extra }));
  }
  return out;
}

/** Roda os quadros pelo detector e junta os eventos. */
function rodar(quadros, kind) {
  const st = createGestureState();
  const eventos = [];
  for (const r of quadros) eventos.push(...stepGestures(st, frameFromResult(r), kind));
  return eventos;
}

test('gesto swing: arco do pulso em volta do ombro dispara uma vez, na mão direita', () => {
  // raio 0,6 m, 2 rad em 0,4 s: ~4 m/s na ponta, bem acima do limiar de 4 larguras de ombro por segundo
  const quadros = sequencia(0.5, (t) => {
    const th = Math.min(2.0, (t / 0.4) * 2.0);
    return { x: 0.6 * Math.cos(th), y: 1.4 + 0.6 * Math.sin(th), z: 0 };
  });
  const ev = rodar(quadros, 'swing').filter((e) => e.kind === 'swing');
  assert.equal(ev.length, 1, `eventos: ${JSON.stringify(ev)}`);
  assert.equal(ev[0].hand, 'R');
  assert.ok(ev[0].force > 0 && ev[0].force <= 1);
  assert.ok(Math.hypot(ev[0].dir.x, ev[0].dir.y) > 0.99);
  assert.equal(rodar(quadros, 'throw').filter((e) => e.kind === 'throw').length, 0, 'o mesmo movimento não é arremesso');
});

test('gesto throw: pulso de trás para frente abaixo do ombro (boliche) dispara na mão direita', () => {
  // abaixo do ombro (0,8 m = 2,2 larguras), de z = −0,3 a +0,4 m em 0,25 s
  const quadros = sequencia(0.5, (t) => {
    const k = Math.min(1, Math.max(0, (t - 0.05) / 0.25));
    return { x: -0.25, y: 0.6, z: -0.3 + 0.7 * k };
  });
  const ev = rodar(quadros, 'throw').filter((e) => e.kind === 'throw');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].hand, 'R');
  assert.equal(rodar(quadros, 'strike').length, 0, 'abaixo do ombro não é soco');
});

test('gesto strike: extensão rápida à frente, na altura do peito (boxe) dispara', () => {
  // na altura do ombro, de z = 0,1 a 0,85 m em 0,15 s (~5 m/s)
  const quadros = sequencia(0.5, (t) => {
    const k = Math.min(1, Math.max(0, (t - 0.1) / 0.15));
    return { x: -0.25, y: 1.4, z: 0.1 + 0.75 * k };
  });
  const ev = rodar(quadros, 'strike').filter((e) => e.kind === 'strike');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].hand, 'R');
  assert.equal(rodar(quadros, 'throw').length, 0);
});

test('guarda: os dois pulsos perto do nariz ligam a guarda uma vez e a desligam ao afastar', () => {
  const perto = { x: 0.1, y: 1.5, z: 0.2 };
  const pertoE = { x: -0.1, y: 1.5, z: 0.2 };
  const quadros = [];
  for (let i = 0; i < 30; i++) quadros.push(resultado(i * DT, { direito: pertoE, esquerdo: perto }));
  for (let i = 0; i < 30; i++) quadros.push(resultado((30 + i) * DT, { direito: { x: -0.3, y: 1.0, z: 0 }, esquerdo: { x: 0.3, y: 1.0, z: 0 } }));
  const st = createGestureState();
  const guardas = [];
  for (const r of quadros) for (const e of stepGestures(st, frameFromResult(r), 'swing')) if (e.kind === 'guard') guardas.push(e.on);
  assert.deepEqual(guardas, [true, false]);
});

test('ruído parado (jitter de ±5 mm, 3 s) não dispara gesto nem guarda', () => {
  let semente = 7;
  const rnd = makeRng(semente);
  const j = () => rnd() * 0.005;
  const quadros = [];
  for (let i = 0; i < 90; i++) {
    quadros.push(resultado(i * DT, {
      direito: { x: -0.25 + j(), y: 1.0 + j(), z: j() },
      esquerdo: { x: 0.25 + j(), y: 1.0 + j(), z: j() },
      nariz: { x: j(), y: 1.55 + j(), z: 0.05 + j() },
    }));
  }
  for (const kind of ['swing', 'throw', 'strike']) {
    const ev = rodar(quadros, kind);
    assert.deepEqual(ev.filter((e) => e.kind !== 'guard'), [], kind);
    assert.equal(ev.filter((e) => e.kind === 'guard' && e.on).length, 0, 'sem guarda');
  }
});

test('frameFromResult e aimFromResult: pontos inválidos não contam; mira espelhada pelo indicador', () => {
  const r = resultado(0, { direito: { x: -0.25, y: 1, z: 0 } });
  const f = frameFromResult(r);
  assert.equal(f.ok, true);
  assert.ok(Math.abs(f.sw - 0.36) < 1e-6);
  assert.equal(frameFromResult(resultado(0, { ombros: false })).ok, false, 'sem ombros visíveis, quadro inválido');
  assert.equal(frameFromResult({ corpo: null }).ok, false);
  const com = { ...r, maos: [{ lado: 'Right', imagem: Array.from({ length: 21 }, () => [0.25, 0.75]) }] };
  const mira = aimFromResult(com);
  assert.ok(Math.abs(mira.x - 0.5) < 1e-9 && Math.abs(mira.y + 0.5) < 1e-9, JSON.stringify(mira));
  assert.equal(aimFromResult({ corpo: { imagem: [] }, maos: [] }), null);
});

// ── entrada: funções puras ─────────────────────────────────────────────────────

test('swipeMeasure: arrasto rápido é gesto (força e direção); toque curto é tap; devagar não conta', () => {
  // 0,1 altura a cada 0,02 s = 5 alturas/s (força 1)
  const rapido = [0, 0.02, 0.04, 0.06, 0.08, 0.1].map((t, i) => ({ t, x: i * 0.1, y: 0 }));
  const m = swipeMeasure(rapido);
  assert.equal(m.valid, true);
  assert.ok(m.force > 0.9 && m.dir.x > 0.99 && Math.abs(m.dir.y) < 1e-9);
  const toque = swipeMeasure([{ t: 0, x: 0, y: 0 }, { t: 0.1, x: 0.001, y: 0 }]);
  assert.equal(toque.tap, true);
  assert.equal(toque.valid, false);
  const devagar = swipeMeasure([0, 0.5, 1].map((t) => ({ t, x: t * 0.1, y: 0 })));
  assert.equal(devagar.valid, false, 'velocidade abaixo de minSpeed');
  assert.ok(POINTER_CFG.minSpeed > 0);
});

test('flickStep: peteleco que sai do repouso e chega ao disparo rápido gera gesto; lento não', () => {
  let st = createFlickState();
  let gesto = null;
  const tempos = [[0, 0], [0.05, 0], [0.1, 0.2], [0.13, 0.95]];
  for (const [t, mag] of tempos) {
    const r = flickStep(st, mag, 0, t);
    st = r.state;
    if (r.gesto) gesto = r.gesto;
  }
  assert.ok(gesto && gesto.force > 0 && gesto.dir.x > 0.99);
  let lento = createFlickState();
  let disparou = false;
  for (const [t, mag] of [[0, 0], [0.5, 0.3], [0.7, 0.95]]) {
    const r = flickStep(lento, mag, 0, t);
    lento = r.state;
    if (r.gesto) disparou = true;
  }
  assert.equal(disparou, false, 'subida em 0,2 s passa do maxTime');
});

test('keyMove: WASD e setas, y para cima', () => {
  assert.deepEqual(keyMove(new Set(['KeyD', 'KeyW'])), { x: 1, y: 1 });
  assert.deepEqual(keyMove(new Set(['ArrowLeft', 'ArrowDown'])), { x: -1, y: -1 });
  assert.deepEqual(keyMove(new Set()), { x: 0, y: 0 });
});

// ── entrada: a classe só conecta eventos ────────────────────────────────────────

/** Elemento com ponteiro: EventTarget com getBoundingClientRect (400×400 px). */
function elementoFalso() {
  const el = new EventTarget();
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 });
  el.style = {};
  return el;
}
const evPonteiro = (tipo, x, y, extra = {}) => Object.assign(new Event(tipo), {
  clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', ...extra,
});

test('SportsInputBridge: arrasto do mouse vira gesto da modalidade; toque curto vira confirm; segurar vira carga', () => {
  let agora = 0;
  const el = elementoFalso();
  const br = new SportsInputBridge(el, { gestureKind: 'swing', clock: () => agora });
  const recebidos = { swing: [], confirm: [], aim: [] };
  br.on('swing', (d) => recebidos.swing.push(d));
  br.on('confirm', (d) => recebidos.confirm.push(d));
  br.on('aim', (d) => recebidos.aim.push(d));

  // toque curto -> confirm
  el.dispatchEvent(evPonteiro('pointerdown', 200, 200)); agora = 0.1;
  el.dispatchEvent(evPonteiro('pointerup', 200, 200));
  assert.equal(recebidos.confirm.length, 1);

  // arrasto rápido (200 px em 0,1 s = 5 alturas/s) -> gesto com direção +x
  agora = 1; el.dispatchEvent(evPonteiro('pointerdown', 100, 200));
  for (let i = 1; i <= 5; i++) { agora = 1 + i * 0.02; el.dispatchEvent(evPonteiro('pointermove', 100 + i * 40, 200)); }
  el.dispatchEvent(evPonteiro('pointerup', 300, 200));
  assert.equal(recebidos.swing.length, 1);
  assert.equal(recebidos.swing[0].source, 'mouse');
  assert.ok(recebidos.swing[0].dir.x > 0.99);
  assert.ok(recebidos.aim.length >= 6, 'mira emitida a cada movimento');

  // segurar sem arrastar por 0,6 s -> carga de 0,6 ao soltar
  agora = 3; el.dispatchEvent(evPonteiro('pointerdown', 200, 200));
  agora = 3.6;
  assert.ok(Math.abs(br.poll().charge - 0.6) < 1e-9, 'carga durante a pressão');
  el.dispatchEvent(evPonteiro('pointerup', 200, 200));
  assert.equal(recebidos.swing.length, 2);
  assert.ok(Math.abs(recebidos.swing[1].force - 0.6) < 1e-9);
  br.dispose();
});

test('SportsInputBridge: botão direito e dois dedos emitem back; câmera entrega gesto e guarda no poll()', () => {
  let agora = 0;
  const el = elementoFalso();
  let quadro = null;
  const captura = { ouvir(f) { quadro = f; return () => { quadro = null; }; } };
  const br = new SportsInputBridge(el, { captura, gestureKind: 'throw', clock: () => agora });
  let voltou = 0, gestos = [];
  br.on('back', () => voltou++);
  br.on('throw', (d) => gestos.push(d));
  el.dispatchEvent(evPonteiro('pointerdown', 10, 10, { button: 2 }));
  assert.equal(voltou, 1);

  el.dispatchEvent(evPonteiro('pointerdown', 10, 10, { pointerType: 'touch', pointerId: 5 }));
  el.dispatchEvent(evPonteiro('pointerdown', 20, 20, { pointerType: 'touch', pointerId: 6 }));
  assert.equal(voltou, 2, 'dois dedos = back');

  // arremesso pela câmera: mesmo quadro do teste de throw, entregue por captura.ouvir
  const seq = sequencia(0.5, (t) => {
    const k = Math.min(1, Math.max(0, (t - 0.05) / 0.25));
    return { x: -0.25, y: 0.6, z: -0.3 + 0.7 * k };
  });
  for (const r of seq) { agora = r.t / 1000; quadro(r); }
  assert.equal(gestos.length, 1);
  assert.equal(gestos[0].source, 'camera');
  assert.equal(gestos[0].hand, 'R');

  for (const r of Array.from({ length: 10 }, (_, i) => resultado(10 + i * DT, { direito: { x: 0.1, y: 1.5, z: 0.2 }, esquerdo: { x: -0.1, y: 1.5, z: 0.2 } }))) {
    agora = r.t / 1000; quadro(r);
  }
  assert.equal(br.poll().guard, true);
  br.dispose();
  assert.equal(quadro, null, 'dispose desassina a captura');
});

test('SportsInputBridge: gestureKind inválido é recusado', () => {
  assert.throws(() => new SportsInputBridge(elementoFalso(), { gestureKind: 'chute' }), /gestureKind/);
});

// ── áudio ─────────────────────────────────────────────────────────────────────

const SR = 44100;

/** Maior diferença entre amostras vizinhas (no percentil 99): a escala de "salto" natural do sinal. */
function saltoTipico(s) {
  const d = [];
  for (let i = 1; i < s.length; i++) d.push(Math.abs(s[i] - s[i - 1]));
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length * 0.99)];
}

test('síntese: impactos, apito, torcida e vento são finitos, em [-1,1] e determinísticos pela semente', () => {
  const gera = [
    ...Object.entries(IMPACT_KINDS).map(([k, p]) => [`impact:${k}`, (sem) => synthImpact(SR, sem, p)]),
    ['whistle', (sem) => synthWhistle(SR, sem)],
    ['crowd', (sem) => synthAmbient('crowd', SR, sem)],
    ['wind', (sem) => synthAmbient('wind', SR, sem)],
  ];
  for (const [nome, f] of gera) {
    const a = f(11), b = f(11), c = f(12);
    assert.ok(a.length > 1000, nome);
    let finito = true, pico = 0;
    for (const v of a) { if (!Number.isFinite(v)) finito = false; pico = Math.max(pico, Math.abs(v)); }
    assert.ok(finito, `${nome}: valores finitos`);
    assert.ok(pico <= 1 && pico > 0.05, `${nome}: pico ${pico} em [-1,1]`);
    assert.deepEqual(Array.from(a), Array.from(b), `${nome}: mesma semente, mesmo som`);
    assert.notDeepEqual(Array.from(a), Array.from(c), `${nome}: outra semente, outro som`);
  }
});

test('loop sem salto: a última amostra de torcida e vento segue a primeira', () => {
  for (const kind of ['crowd', 'wind']) {
    const s = synthAmbient(kind, SR, 37);
    const salto = Math.abs(s[0] - s[s.length - 1]);
    assert.ok(salto <= 2 * saltoTipico(s), `${kind}: salto ${salto} vs típico ${saltoTipico(s)}`);
  }
});

test('makeRng: sequência determinística em [-1, 1)', () => {
  const a = makeRng(99), b = makeRng(99);
  for (let i = 0; i < 1000; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= -1 && v < 1);
  }
});

test('SportsAudioManager sem AudioContext: métodos seguros; tipo de impacto desconhecido é erro', () => {
  const am = new SportsAudioManager();
  assert.equal(am.play('HOMESE_CONNECTED'), null);
  assert.equal(am.playImpact(1, 'ball'), null);
  assert.throws(() => am.playImpact(1, 'chute'), /tipo desconhecido/);
  am.setVolume(0.5, 0.5, 0.5);
  am.dispose();
});

test('SportsAudioManager.load: decodifica os 5 .wav do menu Home e liga o nome do som do .brsar', async () => {
  // contexto mínimo: decodifica devolvendo um buffer vazio com a duração do arquivo
  const ctx = {
    sampleRate: SR, state: 'running', destination: {},
    createGain: () => ({ gain: { value: 1, setTargetAtTime() {} }, connect() { return this; } }),
    createBufferSource: () => ({ buffer: null, loop: false, playbackRate: { value: 1 }, connect() { return this; }, start() {}, stop() {} }),
    createBuffer: (c, n) => ({ length: n, copyToChannel() {} }),
    decodeAudioData: async (ab) => ({ byteLength: ab.byteLength }),
  };
  const am = new SportsAudioManager({ context: ctx });
  const n = await am.load(store);
  assert.equal(n, 5);
  assert.equal(am.cues.get('HOMESE_CONNECTED'), 'SpeakerSe_connect1');
  assert.equal(am.cues.get('HOMESE_VOLUME_PLUS'), 'SpeakerSe_volume');
  assert.ok(am.bancosAusentes.includes('rp_Common_Sports'));
  assert.ok(am.play('HOMESE_CONNECTED'), 'toca pelo nome do som');
  assert.ok(am.playImpact(0.5, 'pin'), 'impacto sintetizado com o contexto');
  assert.equal(am.falhas.length, 0);
  am.dispose();
});
