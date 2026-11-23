// Demonstração das Etapas 1 e 2: cena com colisão, corpo Mii animado por CHR0, efeito de partículas e layout 2D.
// Também é a página usada pelo teste de navegador (tests/sports/browser-smoke.mjs): window.__sports guarda o estado.
import { runtime } from '../lib/runtime.js';
import { defaultStore } from '../engine/assets/AssetStore.js';
import { loadModel } from '../engine/assets/ModelLoader.js';
import { SceneLoader } from '../engine/scene/SceneLoader.js';
import { AnimationLibrary } from '../engine/animation/AnimationLibrary.js';
import { EffectLibrary } from '../engine/particles/Nw4rParticles.js';
import { LayoutPlayer } from '../ui/LayoutPlayer.js';
import { TextManager, webcLanguage } from '../ui/TextManager.js';
import { SceneEnvironment, loadEnvironment } from '../engine/scene/SceneEnvironment.js';
import { MiiOpponentBuilder } from '../entities/MiiOpponentBuilder.js';

const T = runtime.THREE;
const q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const estado = (t) => { $('estado').textContent = t; };
const S = (window.__sports = { ready: false, errors: [] });
window.addEventListener('error', (e) => S.errors.push(String(e.message)));

const store = defaultStore();
const canvas = $('palco');
const renderer = new T.WebGLRenderer({ canvas, antialias: true });
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
const scene = new T.Scene();
scene.background = new T.Color(0x9cc8ff);
const camera = new T.PerspectiveCamera(45, 1, 0.5, 60000);
// Etapa 4: luz, sombra PCF suave e bloom vêm do preset da cena (.plight/.pblm)
const env = new SceneEnvironment(renderer, scene, camera, { quality: q.get('qualidade') || 'medium' });
const mii = new MiiOpponentBuilder(store);
let opponent = null;

const fx = new EffectLibrary(store);
const anims = new AnimationLibrary(store);
const scenes = new SceneLoader(store);
let world = null, body = null, player = null, emitter = null;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fx.setCamera(camera, h * renderer.getPixelRatio());
  env.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
}
addEventListener('resize', resize);

function fill(sel, items, value) {
  sel.textContent = '';
  for (const it of items) sel.append(new Option(it, it, false, it === value));
}

async function loadScene(name) {
  estado(`cena ${name}…`);
  if (world) scene.remove(world.root);
  world = await scenes.load(name, { onProgress: (a, b) => estado(`cena ${name}: ${a}/${b}`) });
  scene.add(world.root);
  const box = new T.Box3().setFromObject(world.root);
  const c = box.getCenter(new T.Vector3());
  // o corpo Mii fica no tee (golfe) ou no centro, apoiado na colisão
  const tee = world.objects.find((o) => o.userData.pmp.kind === 'tee');
  const at = tee ? tee.position.clone() : c.clone();
  const g = world.collision?.heightNear(at.x, at.z, at.y) || world.collision?.groundAt(at.x, at.z);
  if (g) at.y = g.point.y;
  if (body) { body.position.copy(at); if (tee) body.quaternion.copy(tee.quaternion); }
  camera.position.copy(at).add(new T.Vector3(0, 18, -40).applyQuaternion(tee ? tee.quaternion : new T.Quaternion()));
  camera.lookAt(at.x, at.y + 8, at.z);
  env.apply(await loadEnvironment(store, world.scene.assetId), { focus: at.toArray(), radius: 60 });
  if (opponent) opponent.position.copy(at).add(new T.Vector3(14, 0, 0).applyQuaternion(tee ? tee.quaternion : new T.Quaternion()));
  world.root.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  S.env = { lights: scene.children.filter((o) => o.isLight).length, shadows: renderer.shadowMap.enabled };
  S.scene = { name, models: world.models.length, triangles: world.collision?.triangleCount || 0, ground: g?.surface || null };
}

async function playAnim(name) {
  if (!player) return;
  const ctl = await player.play(name, { loop: true });
  S.anim = ctl ? { name, type: ctl.entry.type } : null;
}

async function spawn(name) {
  if (emitter) emitter.stop();
  emitter = await fx.spawn(name, { at: body ? body.position.clone().add(new T.Vector3(0, 10, 0)) : new T.Vector3(), parent: scene });
  S.effect = name;
}

let layout = null;
async function showLayout(name, text) {
  if (!layout) layout = new LayoutPlayer($('hud'), { store });
  await layout.load(name);
  const a = layout.animationNames[0];
  if (a) await layout.play(a, { loop: true });
  S.layout = { name, animations: layout.animationNames.length, panes: layout.state.panes.size };
  if (text) for (const [pane, s] of layout.state.panes) if (s.pane.type === 'text') { layout.setText(pane, text.format('common_message', 0)); break; }
}

async function main() {
  await Promise.all([anims.load(), fx.load()]);
  const list = await scenes.list();
  const sceneName = q.get('cena') || 'glf_course_fc1';
  fill($('cena'), list.map((s) => s.name), sceneName);
  // corpo Mii de braços (família A1) com as animações de avatar
  const bodyEntry = anims.find('bbl_b_swing1R', 'CHR0');
  const sidecar = bodyEntry.models.find((m) => m.model === 'ava_bodyA1').sidecar;
  body = await loadModel(store, sidecar);
  body.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  scene.add(body);
  player = anims.player(body);
  // Etapa 3: oponente CPU (perfil .rcd) com cabeça Mii e rosto em CanvasTexture
  await mii.load();
  opponent = await mii.build(Number(q.get('mii') || 0), { body: true });
  opponent.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  scene.add(opponent);
  S.mii = { id: opponent.userData.mii.id, body: opponent.userData.mii.bodyName };
  const bodyAnims = anims.forModel(body, 'CHR0').map((a) => a.name);
  const animName = q.get('anim') || 'bbl_b_swing1R';
  fill($('anim'), bodyAnims, animName);
  fill($('efeito'), fx.names, q.get('efeito') || 'Bsb_ball_tail01');
  const layouts = await LayoutPlayer.list(store);
  fill($('layout'), layouts, q.get('layout') || 'sportsTop_00');
  const text = await TextManager.load(webcLanguage(), store);
  text.followWebc();
  await loadScene(sceneName);
  await playAnim(animName);
  await spawn($('efeito').value);
  await showLayout($('layout').value, text).catch((e) => S.errors.push('layout: ' + e.message));
  $('cena').onchange = (e) => loadScene(e.target.value).catch((x) => S.errors.push(x.message));
  $('anim').onchange = (e) => playAnim(e.target.value);
  $('efeito').onchange = (e) => spawn(e.target.value);
  $('layout').onchange = (e) => showLayout(e.target.value, text).catch((x) => S.errors.push(x.message));
  resize();
  const clock = new T.Clock();
  let frames = 0;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    player.update(dt);
    fx.update(dt);
    env.update(camera.position);
    env.render();
    if (++frames === 30) {
      S.ready = true;
      S.programs = renderer.info.programs.length;
      S.particles = [...fx.active].reduce((n, e) => n + e.live, 0);
      S.bone = body.userData.nw4r.boneByName.get('arm_r1').quaternion.toArray();
      estado(`${S.scene.name} · ${S.scene.models} modelos · ${S.scene.triangles} triângulos de colisão · ${S.anim?.name}`);
    }
  });
}

main().catch((e) => { S.errors.push(e.message); estado('erro: ' + e.message); console.error(e); });
