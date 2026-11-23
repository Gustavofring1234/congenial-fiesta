// Página jogável fora do WEBC (Etapa 5): menus da máquina de estados, as 5 modalidades e os recordes.
// ?esporte=bowling começa direto na partida; ?cpu=1 deixa a CPU jogar no seu lugar (usado pelo teste de navegador).
// window.__sportsGame expõe o jogo para o teste (tests/sports/browser-smoke.mjs).
import { runtime } from '../lib/runtime.js';
import { createSportsGame } from '../index.js';

const T = runtime.THREE;
const q = new URLSearchParams(location.search);
const canvas = document.getElementById('palco');
const renderer = new T.WebGLRenderer({ canvas, antialias: true });
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
const scene = new T.Scene();
scene.background = new T.Color(0x9cc8ff);
scene.add(new T.HemisphereLight(0xffffff, 0x445566, 1.2));
const camera = new T.PerspectiveCamera(45, 1, 0.5, 60000);
camera.position.set(0, 30, 80);

const S = (window.__sportsGame = { errors: [], frames: 0 });
addEventListener('error', (e) => S.errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => S.errors.push(String(e.reason && e.reason.message || e.reason)));

const game = createSportsGame({
  scene, camera, renderer, element: document.getElementById('jogo'),
  sport: q.get('esporte') || undefined,
  options: q.get('esporte') === 'bowling' ? { bowlingFrames: +(q.get('quadros') || 10), bowlingOpponents: 1 } : undefined,
  player: 'pagina-jogar', playerName: q.get('nome') || 'Você',
});
S.game = game;
game.ready.then(() => {
  if (q.get('cpu') === '1' && game.machine.session) {
    // a CPU joga no lugar do humano: troca o jogador local por uma CPU antes de a partida começar a avançar
    for (const p of game.machine.session.players) p.human = false;
  }
}).catch((e) => S.errors.push(e.message));

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (game.stage && game.stage.env) game.stage.env.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  if (game.stage && game.stage.libs.fx) game.stage.libs.fx.setCamera(camera, h * renderer.getPixelRatio());
}
addEventListener('resize', resize);
resize();

const clock = new T.Clock();
let lastStage = null;
renderer.setAnimationLoop(() => {
  const dt = Math.min(0.05, clock.getDelta()) * (+(q.get('velocidade') || 1));
  game.update(dt);
  if (game.stage !== lastStage) { lastStage = game.stage; resize(); }
  if (game.stage && game.stage.env) game.render(); else renderer.render(scene, camera);
  S.frames++;
  S.state = game.state;
  S.machine = game.machine ? game.machine.state : null;
  S.score = game.activity ? game.activity.hud.score : '';
  S.time = game.activity ? game.activity.time : 0;
  S.actors = game.stage ? game.stage.visuals.size : 0;
  S.programs = renderer.info.programs ? renderer.info.programs.length : 0;
  S.error = game.error ? String(game.error.message || game.error) : null;
});
