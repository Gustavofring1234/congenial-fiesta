# minigames/sports — módulos ES para o WEBC (Three.js 0.180, sem build)

JavaScript puro (`import`/`export`), sem bundler, sem import map. Os módulos usam o **mesmo** three.js do WEBC:
`window.THREE` e `window.CompanhiaVRM` (GLTFLoader, VRMLoaderPlugin, VRMAnimationLoaderPlugin, MeshBVH), que o
`apps/companhia/vendor/three-vrm-pacote.min.js` já define. Nenhuma chave de API entra aqui.

## Acoplar ao WEBC
1. Copie (ou sirva) `minigames/sports/` ao lado de `apps/companhia/` e gere os dados (abaixo) em `minigames/sports/assets/`.
2. Depois dos `<script>` do WEBC:
   ```html
   <link rel="stylesheet" href="minigames/sports/ui/sports-ui.css">
   <script type="module">
     import { SceneLoader } from './minigames/sports/engine/scene/SceneLoader.js';
     import { AnimationLibrary } from './minigames/sports/engine/animation/AnimationLibrary.js';
     import { VrmaPlayer } from './minigames/sports/engine/animation/VrmaPlayer.js';
     const cena = await new SceneLoader().load('glf_course_fc1');      // modelos + colisão BVH + objetos .pmp
     palco.cena.add(cena.root);
     const golpe = new VrmaPlayer(palco.vrm);                           // avatar .vrm ativo do jogador
     await golpe.play('bbl_b_swing1R');                                 // chame golpe.update(dt) antes do vrm.update(dt)
   </script>
   ```
   Outra raiz de dados: `setDefaultStore(new AssetStore({ base: 'https://.../assets/' }))`.

## O que existe (Etapas 1 a 4)
| Módulo | Função |
|---|---|
| `lib/runtime.js` | acesso aos globais do WEBC (`useRuntime` para testes) |
| `engine/assets/AssetStore.js` | JSON/PNG/GLB com cache; texturas sRGB, `flipY=false` |
| `engine/assets/Nw4rMaterial.js` | vínculo textura-material pelo MDL0 (camada base por material), TEV `lerp(tev0,tev1,tex)` |
| `engine/assets/ModelLoader.js` | .glb + sidecar: ossos (Euler ZYX), SkinnedMesh, malhas rígidas, morphs SHP0, *segment scale compensate* |
| `engine/scene/SceneLoader.js` | 32 cenas, objetos `.pmp` com quaternion pronto |
| `engine/scene/CollisionWorld.js` | 21 malhas de colisão numa MeshBVH: `raycast`, `groundAt`, `heightNear`, `sphereContact`, superfície pela flag KCL |
| `engine/animation/Nw4rClipFactory.js` | CHR0/VIS0/SHP0 → `THREE.AnimationClip` |
| `engine/animation/Nw4rMaterialAnimator.js` | SRT0, CLR0, PAT0, SCN0 (câmera/luzes) por quadro |
| `engine/animation/AnimationLibrary.js` | 301 animações, 119 órfãs associadas, player por modelo |
| `engine/animation/VrmaPlayer.js` | 106 `.vrma` (CHR0 → humanoide VRM 0.x/1.0) no avatar do WEBC |
| `engine/particles/Nw4rParticles.js` | 380 emissores `.breff` + texturas `.breft`, emissor leve em `THREE.Points` |
| `ui/TextManager.js` | mensagens `.bmg` por ID em pt/en/ja (segue `<html data-idioma>` do WEBC), reserva `.tsv` |
| `ui/LayoutPlayer.js` | 138 layouts e 647 animações 2D em DOM/canvas, alvos ausentes ignorados, escala para celular |
| `entities/MiiOpponentBuilder.js` | 60 oponentes CPU (`.rcd` + `RFL_Res.dat`): cabeça, rosto em CanvasTexture, corpo, `aiProfile` |
| `entities/WebcAvatarAdapter.js` | avatar `.vrm` do WEBC: movimentos `.vrma`, expressões de vitória/derrota, spring bones |
| `engine/scene/SceneEnvironment.js`, `BloomPass.js` | luz do `.plight`, sombras PCF suaves, luzes locais por proximidade, bloom do `.pblm` |
| `engine/input/SportsInputBridge.js` | swing/aim/throw/strike/move/confirm/back: câmera (MediaPipe do WEBC), mouse/teclado, toque, gamepad |
| `engine/audio/SportsAudioManager.js` | 5 `.wav` do menu Home + síntese (impacto, apito, torcida, ambiente), bancos externos |
| `demo/` | página de demonstração (cena com luz/sombra/bloom + Mii animado + oponente CPU + partículas + layout) |

## Dados (`assets/`, gerados offline a partir das pastas de origem somente leitura)
```bash
python3 tools/export_models.py       # Models/, Textures/ (sidecars com materiais, ossos+flags, skin, morphs)
python3 tools/export_animations.py   # Animations/, animations_manifest.json
python3 tools/export_effects.py      # Effects/
python3 tools/stage_web_assets.py    # Scenes/, Collision/, UI/, Text/
python3 tools/export_vrma.py         # Vrma/*.vrma + vrma_manifest.json
python3 tools/export_mii.py          # Mii/ (60 perfis, formas e texturas do RFL)
python3 tools/export_environment.py  # Environment/ (21 presets de luz/bloom)
python3 tools/export_audio.py        # Audio/ (5 .wav do menu Home)
python3 tools/translate_texts.py pt ja   # opcional: Text/pt, Text/ja (Gemini; GEMINI_API_KEY só no ambiente)
```
Todos usam `NW4R_TARGET=web` por padrão (`NW4R_TARGET=unity` regrava o projeto Unity legado em `Assets/`).

## Etapa 5: os 5 esportes jogáveis (estados, sala, física, regras, IA)
| Módulo | Função |
|---|---|
| `index.js` | `registerWebcGames()` registra tênis/beisebol/boliche/golfe/boxe em `C.minijogos`; `createSportsGame()` para qualquer página |
| `core/GameplayData.js` | `assets/Gameplay/gameplay_data.json` (geometria, 14 cursos, muro, HUD, campos de recorde) |
| `core/SportsStateMachine.js` | Boot → Menu → Modalidade → Personagem → Opções → Sala → Partida ⇄ Pausa → Resultado → Recordes (menu-modelo) |
| `core/RecordStore.js` | campos do RPSportsPlayerData em localStorage + cópia no IndexedDB; habilidade 0..2000 por Elo |
| `core/RoomSync.js` | campo `sp` no estado da sala (120 ms): anfitrião autoritativo, quadro-chave a cada 1 s + deltas, interpolação pelo relógio da sala, gestos do convidado |
| `activities/common/` | `BallFlight` (arrasto + Magnus), `BallBody` (colisão com a BVH da cena ou plano), `AiProfile` (perfil pelos .rcd + Elo), `SportActivity` (partida como gerador), `ActivityStage` (tela 3D) |
| `activities/<esporte>/` | regras puras + física + IA de cada modalidade (porte do C# legado, sem espelhar X) |
| `ui/SportsHud.js`, `ui/SportsMenu.js` | HUD (placar, aviso, barra, layouts NW4R com textos trocados) e menu navegável |
| `demo/jogar.html` | página jogável fora do WEBC (`?esporte=golf`, `?cpu=1`, `?velocidade=2`) |

No WEBC (depois de `js/minijogos.js` e do pacote vendor):
```html
<script type="module">
  import { registerWebcGames } from './minigames/sports/index.js';
  registerWebcGames();   // aparecem na página JOGOS como "Tênis (Linux Sports)" etc.
</script>
```
Sala: a `Sala` do WEBC fica dentro do `app.js`; para jogar em sala a página precisa expô-la em `C.salaAtiva`
(ou passar `registerWebcGames({ getSala: () => minhaSala })`). Avatar: `C.palco.vrm` ou `getAvatar`. Captura: `C.captura` ou `getCaptura`.

Dados: `python3 tools/export_gameplay.py` (padrão `NW4R_TARGET=web`) grava `assets/Gameplay/gameplay_data.json`.

## Testes
```bash
node --test tests/sports/*.test.mjs                 # 79 testes em Node com o pacote vendor do WEBC (22 da Etapa 5)
PLAYWRIGHT_CORE=.../playwright-core CHROMIUM_PATH=.../chrome node tests/sports/browser-smoke.mjs saida.png
PLAYWRIGHT_CORE=.../playwright-core CHROMIUM_PATH=.../chrome node tests/sports/browser-play.mjs pasta-das-fotos
```
