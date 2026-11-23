# linuxsports-codigo-novo — Linux Sports para o WEBC (Three.js 0.180, ES Modules) + projeto Unity legado

Origens **somente leitura** (nenhum script grava nelas): `../linuxsports-web-wispt/` (cenas, .glb, layouts,
texturas, textos, código descompilado, .breft) e `../linuxsports-web/` (única fonte dos `.brres` e `.breff`).

## Situação (alvo atual: WEBC, `minigames/sports/` — ver `minigames/sports/README.md`)
| Etapa | WEBC / Three.js | Unity (legado, `Assets/`) |
|---|---|---|
| 1. Materiais, `.pmp`, UI 2D, textos | **Concluída** — `engine/assets`, `engine/scene`, `ui/` | concluída |
| 2. Animações 3D, `.vrma`, partículas | **Concluída** — `engine/animation`, `engine/particles`, `tools/export_vrma.py` | concluída |
| 3. Avatares VRM + Mii (`.rcd`/`RFL_Res.dat`) | **Concluída** — `entities/MiiOpponentBuilder.js`, `entities/WebcAvatarAdapter.js` | concluída |
| 4. Luz/BVH/entrada híbrida/áudio | **Concluída** — `engine/scene/SceneEnvironment.js`, `BloomPass.js`, `engine/input/SportsInputBridge.js`, `engine/audio/SportsAudioManager.js` | concluída |
| 5. Estados, sala 120 ms, física, IA | pendente | concluída |

### Etapas 1 e 2 no Three.js (conferido em `tests/sports/`: 13 testes em Node + navegador real)
- Pipeline Python com saída web: `NW4R_TARGET=web` (padrão) grava tudo em `minigames/sports/assets/` no referencial
  do Wii, que é o do glTF/three.js (nada espelhado). `NW4R_TARGET=unity` mantém o projeto Unity.
- Materiais: 914/914 materiais do glTF casam com o sidecar; 888 têm camada base com PNG do TEX0, 26 não têm textura
  no MDL0 (`M_Kiwa_Black`, `col_WATER`); `dummy_tex_*` (corpos Mii) fica branco neutro até a Etapa 3.
- Rig: os `.glb` não têm esqueleto; o `ModelLoader` monta ossos (Euler `ZYX`), `SkinnedMesh` com os envelopes e
  morphs SHP0. As 1.249 matrizes de mundo do MDL0 são reproduzidas (diferença < 1e-3).
- **Segment scale compensate** (flag 0x20 dos ossos do MDL0) agora é aplicado (JS e Python): os braços esticados do
  boxe (escala X = 2) não entortam mais o antebraço. O player Unity não aplicava.
- `.pmp` no espaço three: 1.359/1.361 objetos sobre a colisão (mediana ≤ 0,89 u), +Z do tee para os pinos em 12/12
  (`index/pmp-three-calibration.json`). Colisão: 21 malhas na MeshBVH do pacote do WEBC, flag KCL por vértice
  (a BVH reordena os triângulos); os 14 tees caem na flag 1 (tee).
- UI: 138 layouts e 647 animações 2D; as 47 com painéis ausentes tocam sem erro. Textos: 1.333 mensagens `.bmg`
  por ID; pt/ja por `tools/translate_texts.py` (offline) com reserva no inglês e no `.tsv`.
- Animações: 301 (CHR0 158, SRT0 56, CLR0 39, SCN0 32, PAT0 11, SHP0 4, VIS0 1); 119 órfãs associadas (113 por
  estrutura, 6 SCN0 por cena). O mixer reproduz as curvas Hermite do NW4R.
- VRM: 106 `.vrma` (VRMC_vrm_animation 1.0; famílias A1 57, C0 31, A0 18 com IK de dois ossos para as mãos
  flutuantes). Lidos pelo `VRMAnimationLoaderPlugin` do WEBC; num VRM 1.0 de teste a direção dos braços/pernas
  segue a do Mii com erro médio < 2° e pior < 6°. Orientação conferida pela malha: o Mii olha para +Z e `_l` é a
  esquerda do personagem.
- Partículas: 10 pacotes, 380 emissores, emissor em `THREE.Points` (shader próprio, sRGB).
- Limitações: 12 SRT0 só movem camadas indiretas/ambiente (`*_ind`, `*_env`, ondas) que o TEV aproximado não
  desenha; CLR0 `kon*` só no alfa (vira opacidade: letreiros win/lose/tie/nice), RGB de konst e `tev2` ignorados;
  textos embutidos nos layouts são placeholders japoneses (o jogo os troca por `.bmg` no código: Etapa 5).

### Etapas 3 e 4 no Three.js (57 testes em Node + demo no Chromium/WebGL 2 com sombra PCF e bloom)
- Mii: 60 oponentes CPU com cabeça (malhas do RFL), rosto em CanvasTexture e corpo ava_body* preso ao osso
  `head_set`; olho e boca compostos pelas máscaras de canal do RGB5A3 (R contorno/lábio, G íris/interior, B branco);
  perfil de IA determinístico pelo `.rcd`. Avatar do WEBC: `.vrma` + expressões happy/sad (joy/sorrow no VRM 0.x),
  spring bones reiniciados só ao teletransportar.
- Luz por preset (`.plight`), sombras PCF suaves (1024/2048/4096 por qualidade), N luzes locais mais próximas, bloom
  próprio (o pacote do WEBC não tem EffectComposer) pelo `.pblm`. Entrada: mouse/teclado/toque/gamepad + gestos da
  câmera (swing/throw/strike/guard) sobre `captura.ouvir()`. Áudio: 5 `.wav` + síntese determinística.
- Limitações: lightmaps `.plmap` (lm_0/lm_1) não desenhados; intensidades das luzes e limiares dos gestos não
  calibrados com o Wii nem com dados reais do MediaPipe; calça do Mii sem região UV própria (só a cor favorita
  aparece); escala da cabeça 0,125 vem da calibração do Unity, não do código.

## Projeto Unity (legado)
## Como usar
1. Unity 2022.3 LTS com URP. `Packages/manifest.json` já pede URP 14, Input System, uGUI e **glTFast**
   (`com.unity.cloud.gltfast`, obrigatório: importa os `.glb` espelhando X, convenção usada em todo o código).
   Crie e atribua um URP Asset em Project Settings > Graphics.
2. (Opcional) regenerar os dados, a partir desta pasta:
   ```bash
   python3 tools/export_models.py        # .glb + texturas por material + rig/skin/blendshapes
   python3 tools/export_animations.py    # 301 animações + animations_manifest.json
   python3 tools/export_effects.py       # .breff/.breft -> Resources/Effects
   python3 tools/stage_unity_assets.py   # cenas (.pmp convertido), colisões, UI, textos
   python3 tools/export_mii.py           # RFL_Res.dat + .rcd -> Resources/Mii (formas, texturas, perfis)
   python3 tools/export_environment.py   # .plight/.plmap/.pblm/.pmmisc/.bti -> StreamingAssets/Environment
   python3 tools/export_audio.py         # 5 .wav do menu Home -> StreamingAssets/Audio
   python3 tools/export_gameplay.py      # Etapa 5: StreamingAssets/Gameplay/gameplay_data.json
   python3 tools/validate_outputs.py     # checa os schemas que o C# espera
   ```
3. Em Project Settings > Player, deixe *Active Input Handling* = Input System Package (ou Both).
   No Editor, menu **Nw4r > Importar tudo** (ou os passos 1, 2 e 3 separados). Gera
   `Resources/Prefabs/Models|Collision`, `Resources/Animations` (clips + controllers) e `Resources/Effects/Prefabs`.
   Depois disso, um `.glb` reimportado em `Assets/Nw4r/Models` remonta o prefab sozinho (AssetPostprocessor).
4. Em execução: `Nw4rSceneLoader` (cena), `Nw4rAnimationPlayer.Play("nome")`, `Nw4rEffectLibrary.Instance.Spawn(...)`,
   `Nw4rLayoutLibrary.Instance.Create(...)` + `PlayAnimation(...)`, `TextManager.Load("us", ...)`,
   `MiiCharacterBuilder` (perfil `cpu_mii_NNN` ou `.rcd`/`.mii` de 74 bytes; com `body` = prefab `ava_body*`, a cabeça
   vai para o osso `head_set` e segue as animações CHR0 do corpo) + `SetExpression(MiiExpression.Smile)`.
   Etapa 4: `Nw4rEnvironment` (ponha no mesmo objeto do `Nw4rSceneLoader` e ligue `sceneLoader`; ou defina
   `presetName`, ex. `golf_fc1`), `InputRouter.Instance` (`Gesture`, `Aim`, `Move`, `Confirmed`, `BackPressed`;
   a modalidade define `gestureKind`) e `AudioManager.Instance` (`Play("HOMESE_CONNECTED")`, `PlayImpact(força)`,
   `PlayAmbient(SfxKind.Crowd)`, `RegisterBank(...)` para bancos externos). No WebGL ative o pós-processamento
   no URP Asset (o `Nw4rEnvironment` liga `renderPostProcessing` na câmera).

5. Jogo completo: menu **Nw4r > Criar cena do jogo** (gera `Assets/Scenes/LinuxSports.unity` com a
   `GameStateMachine` e a põe no Build Settings) e **Nw4r > Gerar build WebGL** (saída em `Builds/WebGL`).
   A `GameStateMachine` funciona em qualquer cena vazia: cria câmera, HUD, `InputRouter` e `AudioManager`.

## Etapa 5: fluxo, física, regras e IA
Fluxo (`Core/Game/GameStateMachine.cs`): Boot (título RPST) -> Menu principal -> Modalidade -> Mii (60 perfis
`.rcd`) -> Opções -> Partida -> Resultados -> Recordes. Cada estado mostra os layouts NW4R listados em
`gameplay_data.json -> stateLayouts` (SpTitle, sportsTop, menuBg/menuFrame, playerSelect, pause, trainingResult,
pIRecord...) e cada modalidade os seus HUDs (vsScoreServer, bblVsGame, score/pin, golf_00/glfScorecard, boxGauge).
Menus por teclado/gamepad/toque/sensores (Move/Confirm/Back) e por ponteiro. Pausa com Voltar.
Nomes das modalidades vêm do `common_message.bmg` via `TextManager` (IDs 77056..78080).

Dados (`tools/export_gameplay.py` -> `StreamingAssets/Gameplay/gameplay_data.json`), consultando `strings.tsv`,
`functions.tsv` e o `main.dol`:
- Por modalidade, só os nomes que o código cita em `strings.tsv` E que existem nos dados convertidos: 109 animações
  CHR0 (todas casam com os corpos `ava_body*`), 128 emissores de partículas, 120 modelos, 26 layouts de HUD.
- Escala 10 u = 1 m, conferida em 4 medidas: pino de boliche 3,81 u, pino 1 a 182,8 u da linha de falta (18,29 m),
  bola de boliche 2,2 u, rede de tênis 136 u (12,8 m).
- Boliche: X das 7 pistas de fundo lido de `DAT_803ca6c8..e0` (a tabela de `Bowling::CheckBallLaneIntersection`).
- Golfe: tee/pinos dos 14 cursos (objetos `.pmp` 0 e 1), distância e par; superfície por flag do KCL (as malhas de
  colisão guardam um nó `collision_0xNNNN` por flag): 1 = tee (os 14 tees), 6/11 = green (os pinos), 3 = banca,
  2 = fairway, 4/5 = rough, 12 = água, 7/13 = fora dos limites (camada de base). Evidência em
  `index/gameplay-export.json`; o mapeamento de 2/3/4/5/7/12/13 é inferido (tamanho, cota, posição), não lido do código.
- Beisebol: muro do estádio (distância por ângulo de 5 em 5 graus, 80-98 m) tirado das paredes da malha `bbl_Field_a`.
- Recordes: campos dos getters/setters de `RPSportsPlayerData` (BowStandardBest, GolAceCount, BsbRenzokuBest,
  TnsSuccess, SkillLevel, StandardPlayCount...), gravados por perfil no `PlayerPrefs` (`RecordStore`).

Modalidades (`Assets/Scripts/Activities/`), todas com regras puras separadas em `Activities/Rules/`:
- Boliche: pista/canaletas/fosso como colliders, pinos e bola `Rigidbody` (PhysX roda no WebGL), gancho só no
  último terço (seco) da pista, súmula de 10 quadros (strike/spare/10º quadro/split), 1-4 jogadores com CPUs.
  Controle: posição, mira, gesto Throw (força = velocidade, lateral = efeito).
- Golfe: voo com arrasto, backspin e efeito lateral (`BallFlight`), vento por buraco, quique/rolamento por superfície,
  copo, bandeira, água/fora dos limites (+1), limite de 10 tacadas; 4 tacos (driver ~206 m, ferro ~144 m, wedge
  ~88 m de carry); joga quem está mais longe; CPU resolve a força por busca binária na simulação.
- Tênis: simples ou duplas, jogadores correm sozinhos até o ponto de interceptação previsto; o momento do gesto dá a
  direção (adiantado = cruzado), a força dá a velocidade, para cima = topspin, para baixo lento = lob; saque em 2
  tempos com saque-foguete no topo; faltas, dupla falta, rede, fora, dois quiques; contagem com iguais/vantagem.
- Beisebol: a CPU arremessa 5 tipos (spin -> quebra pelo Magnus), o jogador rebate pelo tempo do gesto (janela de
  ±0,13 s; adiantado puxa); a bola voa até o muro real; foul, home run, rasteira cortada, bola alta apanhada (alcance
  dos 7 defensores pelo tempo de voo), simples/dupla/tripla, queimada dupla, voo de sacrifício, walk-off; o jogador
  arremessa na outra metade (tipo pelo direcional, força e lado pelo gesto) contra a CPU rebatedora.
- Boxe: golpe pelo gesto Strike (lado = mão, para cima = uppercut, lateral = cruzado), guarda e esquiva, contra-ataque
  ×1,4, vida com parte recuperável, quedas com contagem, K.O./nocaute técnico (3 quedas)/pontos em 1-5 rounds.
- IA: `AiProfile` a partir do `.rcd` (altura -> alcance, peso -> força/velocidade, hash do nome/perfil -> estilo e
  lado preferido); a força vem dos pontos de habilidade do jogador (Elo, `SkillRating`), como o RPSports escolhe
  adversários. Erro gaussiano proporcional à imprecisão.
- Integração: animações CHR0 nos corpos Mii (`SportActor`), cabeça montada pelo `MiiCharacterBuilder`, partículas
  `Nw4rEffectLibrary` (ex.: `Bow_pin_hit`, `Gol_bunker_fall`, `Tns_ball_rocketserve`, `Box_hit03_red`), iluminação
  URP por cena (`Nw4rEnvironment`), sons sintetizados (`AudioManager`, sons `SE_TR_Common_Sports_*` ligados a
  efeitos procedurais porque o `.brsar` não veio com o jogo).

Testes: `cd tests/csharp && dotnet run` (67 verificações: regras das 5 modalidades, Elo, IA com os 60 perfis,
balística dos tacos, solucionadores de tênis e arremesso). O C# puro compila com `UnityShim.cs` (Vector3/Mathf
gerenciados), porque as DLLs da Unity no NuGet são só de referência. `tools/validate_outputs.py` confere o
`gameplay_data.json` contra os manifestos (seção 11).

## Conversão de coordenadas (Wii -> Unity)
Igual à do glTFast: posição `(-x, y, z)`, quaternion `(x, -y, -z, w)`. Rotação de osso NW4R = Rz·Ry·Rx (graus):
compondo os SRT locais nessa ordem, as matrizes de mundo do MDL0 são reproduzidas em 1.249/1.249 ossos.
Objetos `.pmp`: registro Z,Y,X = colunas da rotação; no espaço do Unity, 1.359/1.361 objetos ficam sobre a
colisão (mediana ≤ 0,89) e o +Z do tee aponta para os pinos em 12/12 cursos (`index/pmp-unity-calibration.json`).

## Números conferidos
- Geometria: a ordem de vértices dos 259 `.glb` é reproduzida exatamente (nome, contagem, 1º vértice).
- Materiais: 914 materiais, 1.783 camadas de textura, 1.073 PNG decodificados do TEX0 (0 ausentes); 147 texturas de PAT0.
- Rig: 1.249 ossos, 1.374 malhas rígidas, 66 com skin (envelopes NodeMix), 60 blendshapes (SHP0).
- Animações: 301 lidas (CHR0 158, SRT0 56, CLR0 39, SCN0 32, PAT0 11, SHP0 4, VIS0 1); as 119 sem modelo no
  próprio `.brres` foram associadas (113 por estrutura de ossos/materiais, 6 SCN0 por cena). As animações de avatar
  caem nos corpos Mii (`ava_body*`).
- Partículas: 10 pacotes, 380 emissores, 1.174 curvas, 143 texturas `.breft` (0 ausentes).
- UI: 138 layouts, 647 animações 2D (47 com alvos ausentes, ignorados em silêncio). Textos: 1.333 mensagens.
- Ambiente: 70/70 arquivos lidos (21 `.plight`, 19 `.plmap`, 17 `.pblm`, 3 `.pmmisc`, 10 `.bti`) em 21 presets;
  32/32 cenas ligadas a um preset. Light textures: o gerador C# bate com uma implementação Python independente
  em 1.548.288 canais (21 presets × 2 texturas × 3 câmeras; diferença máxima 1/255).
- Entrada e áudio: 16 testes da lógica pura (arrasto, toque, peteleco, pico de aceleração, eixos da tela,
  7 sons sintetizados: faixa, determinismo, loop sem salto); `.jslib` exercitado num navegador simulado (Node):
  leitura dos sensores, liberação do AudioContext no 1º gesto e pedido de permissão do iOS só dentro do gesto.

## Limitações conhecidas
- Etapa 5: a lógica de tênis, beisebol, golfe e boxe do jogo original fica em ~6.500 funções sem nome (`FUN_*`) do
  descompilado; só o boliche tem nomes (`Bowling::*`). Por isso as regras seguem as regras oficiais de cada esporte,
  e a física usa constantes reais (massa, arrasto, Magnus) com a escala da cena. Os números internos do jogo
  (velocidades, janelas de tempo, chances da IA) não foram extraídos. O que veio do código/dados: nomes de animações,
  efeitos, modelos, layouts e sons; campos de recorde; X das pistas de boliche; geometria das cenas e colisões.
  As Activities ainda não rodaram dentro do Editor (compilam contra as DLLs da Unity; a lógica pura tem testes).
- O C# (runtime + Editor) compila com 0 erros/0 avisos no .NET contra as DLLs de referência reais da Unity
  (NuGet `UnityEngine.Modules` 2021.3.33, `Unity3D.UnityEngine.UI`, `UnityEditor.dll` de `Unity3D.SDK` 2021.1);
  o decodificador `.rcd` em C# (`MiiCharInfo.FromRaw`) bate com o Python em 2.580/2.580 campos dos 60 perfis.
  O código da Etapa 4 também compila contra o `Unity.InputSystem.dll` 1.7.0 compilado do código-fonte do pacote;
  para o URP (pacote fora do registro público) usei stubs com as assinaturas conferidas no repositório
  Unity-Technologies/Graphics (ramo 2022.3). Ainda **não** foi aberto num Editor Unity 2022.3 real nem gerou build WebGL/IL2CPP; shaders
  (`Assets/Resources/Shaders`) não foram compilados.
- TEV do Wii aproximado: `lerp(tev0, tev1, textura) × cor de vértice × cor do material` (UI e modelos).
- CHR0: billboard e "segment scale compensate" não são aplicados.
- `.breff` v7: o EmitterDesc bate campo a campo com o layout v9; os alvos das curvas de gravidade/resistência do ar
  são inferidos pelos valores (marcados `interpretation` no JSON). A mistura (aditiva/alfa) vem da categoria do
  emissor pelo nome, porque os bytes de "draw settings" ficam brutos (`drawSettingsRaw`).
- SCN0: layout das luzes deduzido dos dados (posição, alvo, cor, corte); 28 câmeras vazias são marcadas `placeholder`.
- Etapa 4: o TEV dos materiais dos avatares não é decodificado; `base × lm_0 + lm_1` é a combinação inferida pelo
  conteúdo das duas texturas (difusa e especular), não lida do MDL0. Não há como conferir a light texture contra o
  hardware: os `lm_0/lm_1.bti` do jogo são texturas de reserva mais claras que qualquer preset. Luzes de ponto na
  light texture usam o vetor posição−alvo (como direcional). Bloom: `intensityScale = 4` é a única constante
  calibrada (tênis = intensidade 1 no URP). Alcance das luzes de ponto/spot = refDist/(1−refBright), aproximação da
  atenuação do GX. As curvas de distância/spot (`distAttnFn`/`spotFn`) não são reproduzidas. Sensores só funcionam
  em HTTPS (exigência do navegador); no iOS o usuário precisa tocar a tela uma vez para conceder a permissão.
- Mii: a escala da cabeça em relação ao corpo é aplicada fora do RFL e não foi achada no código; `headScale = 0,125`
  é calibrado pela proporção (rosto ≈ 2 larguras do `ava_body`). A escolha do corpo por sexo/altura/peso e a cor
  favorita na camisa (`mt_main`) ficam em classes virtuais de cada esporte e não foram reproduzidas: escolha o
  prefab do corpo à mão; `FavoriteColor` fica exposto. A luz é Lambert + SH do URP, não os canais de luz do RFL.
  Nenhum dos 60 perfis usa cabelo invertido, então esse caminho só foi conferido pela lógica.

## Ambiente, entrada e áudio (Etapa 4)
Formatos tirados dos leitores do `main.dol` (detalhes em `tools/nw4r/env.py`; rotinas truncadas pelo
descompilador foram desmontadas com capstone, inclusive as instruções paired-single do Gekko):
- `.plight` (`EGG::LightManager`): 16 LOBJ de 0x50 bytes; tipo GX (ponto/direcional/spot), espaço (mundo,
  mundo+especular, câmera, "capacete" e contraluz presos à câmera), flags (GX 0x40, light texture 0x20, cor/alfa
  0x200/0x400, atenuação manual 0x80/0x100), cor × intensidade, corte do spot, atenuação por distância.
  `Nw4rEnvironment` cria um `Light` por luz GX e aplica a cor ambiente (`RenderSettings` + sonda SH).
- `.plmap` (`EGG::LightTexture`): é o que ilumina os avatares Mii. O jogo redesenha `lm_0` (difusa) e `lm_1`
  (especular/contraluz) a cada quadro como uma esfera de normais: Σ cor × peso × rampa(N·L), com 10 rampas de 64
  texels (linear, t², t⁴, t⁸, t¹⁶, 1-(1-t)², faixas deslocadas) lidas do código. `Nw4rLightTextureGenerator` faz o
  mesmo na CPU quando a câmera gira; `Nw4r/Lit` com `_UseLightTexture` (ligado pelo importador nos materiais com
  camadas `lm_*`) usa cor = base × lm_0 + lm_1 por mapeamento esférico da normal em espaço de câmera.
- `.pblm` (`EGG::DrawPathBloom`): limiar, cor do limiar, cor/força, até 3 estágios de blur -> `Bloom` do URP num
  `Volume` global. O golfe comum tem limiar 1,0 (bloom desligado no jogo); os cursos têm bloom próprio.
- `.pmmisc`: exportado só como registro; `RPGrpModelMisc::SetBinaryInner` é um `blr` (o jogo ignora o arquivo).
- `.bti`: 10 texturas avulsas em `Resources/Environment/Textures` (inclui os `lm_0`/`lm_1` padrão do jogo).
- Entrada: `InputRouter` (Input System) + `WebGLSensors.jslib`; ações `Swing`/`Throw`/`Strike` (gesto com
  velocidade normalizada, ângulo e duração), `Aim`, `Move`, `Confirm`, `Back`, de mouse+teclado, toque, gamepad e
  DeviceMotion/DeviceOrientation (tabela no topo de `InputRouter.cs`).
- Áudio: `AudioManager` carrega os 5 `.wav` do HomeButtonSe (ligados aos nomes `HOMESE_*` do `.brsar`) e sintetiza
  batida, deslocamento de ar, cliques, confirmação/cancelamento, plateia e vento com `AudioClip.Create` + `SetData`
  (o WebGL não roda `OnAudioFilterRead`). Os 8 bancos `.brsar` que o jogo carrega ficam em `missingBanks`, prontos
  para `RegisterBank`.

## Mii (Etapa 3)
Formato tirado do RFL ligado ao `main.dol` (nomes em `functions.tsv`). Rotinas que o descompilador truncou
(`RFLiInitCharModelRes`, `RFLiSetFaceParts`, `RFLiDrawQuad`) foram desmontadas direto do DOL; as fórmulas estão
nos comentários de `MiiCharacterBuilder.cs` e `MiiFaceTexture.cs`, e o formato do arquivo em `tools/nw4r/rfl.py`.
- `RFL_Res.dat`: 18 arquivos internos; 188 formas (9 tipos) e 211 texturas (BTI). Orientação dos triângulos
  conferida pelas normais de vértice: 100% coerente em todas as formas (`index/mii-export.json`).
- `.rcd` = RFLCharData; a conversão para RFLiCharInfo replica `convertRaw2InfoCore_`. C# e Python dão o mesmo
  resultado nos 60 perfis.
- Cores, rotações-base e contornos vêm de tabelas do DOL (`rfl_params.json` registra os endereços).
- Textura do rosto: composta em RenderTexture (GL + `Nw4r/MiiFacePart`), uma por expressão (7, como `RFLiMakeTexture`).

## Arquivos
- `tools/`: `export_models.py`, `export_animations.py`, `export_effects.py`, `stage_unity_assets.py`,
  `validate_outputs.py`; `nw4r/` (`paths.py`, `brres.py`, `mdl0.py`, `anim.py`, `effects.py`, `gx.py`);
  da Etapa 1: `decomp_index.py`, `gemini_client.py`, `link_model_materials.py`, `validate_pmp.py`, `bmg_extract.py`;
  da Etapa 3: `export_mii.py`, `nw4r/rfl.py`, `nw4r/dol.py`.
- `Assets/Scripts/Core`: `Json.cs`, `StreamingAssetLoader.cs`, `Nw4rCoordinates.cs`.
- `Assets/Scripts/Engine`: `Nw4rAnimationData.cs`, `Nw4rAnimationPlayer.cs`, `Nw4rModelInfo.cs`, `Nw4rSceneLoader.cs`,
  `PmpObject.cs`, `Nw4rSceneLighting.cs`, `Nw4rParticleFactory.cs`, `Nw4rEffectLibrary.cs`, `Nw4rEffectTag.cs`.
- `Assets/Scripts/Entities/Mii`: `MiiCharInfo.cs`, `MiiResources.cs`, `MiiFaceTexture.cs`, `MiiCharacterBuilder.cs`.
- `Assets/Scripts/UI`: `TextManager.cs`, `Nw4rLayoutData.cs`, `LytMaterialState.cs`, `Nw4rQuadGraphic.cs`,
  `Nw4rTextGraphic.cs`, `Nw4rLayout.cs`, `Nw4rLayoutLibrary.cs`.
- `Assets/Editor`: `Nw4rModelPostprocessor.cs`, `Nw4rAnimationImporter.cs`, `Nw4rEffectImporter.cs`, `Nw4rMenu.cs`,
  `MiiTexturePostprocessor.cs`.
- `Assets/Resources/Shaders`: `Nw4rLit.shader`, `Nw4rUI.shader`, `Nw4rParticle.shader`,
  `Nw4rMii.shader`, `Nw4rMiiFacePart.shader`.
- Etapa 4: `tools/export_environment.py`, `tools/export_audio.py`, `tools/nw4r/env.py`;
  `Assets/Scripts/Engine/Environment` (`Nw4rEnvironmentData.cs`, `Nw4rLightTextureGenerator.cs`, `Nw4rBloom.cs`,
  `Nw4rEnvironment.cs`); `Assets/Scripts/Core/Input` (`GestureRecognition.cs`, `WebGLSensors.cs`, `InputRouter.cs`);
  `Assets/Scripts/Core/Audio` (`ProceduralAudio.cs`, `AudioManager.cs`); `Assets/Plugins/WebGL/WebGLSensors.jslib`.
  Dados: `StreamingAssets/Environment` (21 presets + índice), `StreamingAssets/Audio`, `Resources/Environment/Textures`.
- Gemini: `tools/gemini_client.py` lê só `os.getenv("GEMINI_API_KEY")` (veja `.env.example`); a chave não entra no C# nem no build.
- Subagente Haiku para tarefas em lote: `.claude/agents/nw4r-indexer.md`.
- Etapa 5: `tools/export_gameplay.py`; `Assets/Scripts/Core/Game` (`GameplayData.cs`, `GameSession.cs`,
  `RecordStore.cs`, `SkillRating.cs`, `GameStateMachine.cs`); `Assets/Scripts/UI` (`GameHud.cs`, `MenuView.cs`);
  `Assets/Scripts/Activities/Rules` (`BowlingScore.cs`, `TennisScore.cs`, `BaseballGame.cs`, `GolfScorecard.cs`,
  `BoxingBout.cs`); `Activities/Common` (`SportActivity.cs`, `SportActor.cs`, `BallFlight.cs`, `BallBody.cs`,
  `ModelSpawner.cs`, `AiProfile.cs`, `AiProfileMii.cs`); `Activities/Bowling|Golf|Tennis|Baseball|Boxing`;
  `Assets/Editor/GameSceneMenu.cs`; `tests/csharp`. Dados: `StreamingAssets/Gameplay/gameplay_data.json`.
