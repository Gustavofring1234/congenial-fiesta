# linuxsports-web

Versão web interligada dos assets do `linuxsports-game`. Gerada por:

```bash
cd linuxsports-game/tools/nw4r-web
npm run build:web        # = tsx src/build-project.ts ../.. -o ../../../linuxsports-web
```

O build leva ~10 s e é determinístico. O `linuxsports-game` só é lido, nunca alterado. Rodar de novo regrava os arquivos por cima, sem apagar a pasta.

## Visualizador

```bash
python3 -m http.server -d /workspaces/codespaces-blank/linuxsports-web 8080
# abra http://localhost:8080/viewer/
```

HTML, CSS e JavaScript puros, com three.js local em `viewer/vendor/` (funciona sem internet). O código-fonte fica em `linuxsports-game/tools/nw4r-web/viewer/` e é copiado pelo build. Abas:
- **Telas:** os 138 layouts renderizados em HTML/CSS/Canvas, com as animações tocando (play/pausa/quadro a quadro).
- **Cenas 3D:** os 32 estágios com modelos, colisão (cor por flag) e objetos do `.pmp`.
- **Modelos:** os 259 `.glb`, com a origem e as animações 3D pendentes de cada um.
- **Texturas:** as 615 texturas convertidas, com os apelidos semânticos.
- **Fontes:** as 8 fontes, com texto de teste editável.
- **Inventário:** os 3.100 arquivos do projeto, a situação de cada formato e como completar a conversão do que falta, mais os arquivos que o código do jogo carrega.

Testado no Chromium: as 6 abas e os 138 layouts abrem sem erros no console. As telas são uma aproximação do TEV do Wii: materiais com estágios TEV próprios (vários botões, por exemplo) saem com cores diferentes das do jogo, e as molduras de janela mostram só os cantos.

**Escopo:** é um visualizador, não um jogo. A lógica de jogo está no `main.dol` e não é reimplementada aqui. Para jogar, use a imagem do disco original no Dolphin.

## Conteúdo

| Tipo | Qtde | Arquivos | Liga com |
|---|---|---|---|
| `texture` | 615 | `assets/**.png` + `.tex.json` | — |
| `font` | 8 | `assets/**.atlas.png` + `.font.json` (BMFont) | — |
| `layout` | 138 | `assets/**.layout.json` | texturas e fontes (754 refs) |
| `animation` | 647 | `assets/**.anim.json` (inclui `.brlpa/.brlvi/.brlmc`) | layout (647/647) e texturas de troca |
| `collision` | 21 | `assets/**.glb` (do `.kcl`) | — |
| `model` | 259 | `models/**.glb` + `.model.json` | origem `.brres`, texturas, animações 3D |
| `scene` | 32 | `scenes/**.scene.json` | modelos, colisão, objetos do `.pmp`, luz |
| `binary` | 1.416 | `raw/**` (sem conversor; inclui docs, scripts, config, código decompilado, `main.dol` e os PNGs renomeados) | `.brres`→modelos, `.breff`→`.breft`, `.plmap`→`.bti` |

`manifest.json` é **um único bundle global**, porque muitas referências cruzam contêineres: os layouts de todos os esportes usam as fontes de `Font/font.carc`, e algumas animações de menu usam texturas de outro `.arc`. Todo `assetId` é determinístico (`<prefixo>_<fnv1a64(tipo:caminho)>`), e todos os caminhos são POSIX relativos.

**Validação cruzada** (`validateBundle`): 0 erros. A única referência sem destino é `te_wiiSportsLogo_00.tpl`, citada por `playAdvice_00.brlyt` mas inexistente no projeto.

### Layout (`.layout.json`)
Traz a cena inteira da tela, não só nomes:
- **Tela:** `screen` (608×456 ou 640×480, origem no centro, Y para cima).
- **Painéis:** árvore `root` com `pane`/`picture`/`text`/`window`/`bounding`, cada um com translação, rotação, escala, tamanho, origem (0–8), alfa e visibilidade.
- **Imagens:** cores de vértice e UVs por quad.
- **Textos:** string UTF-16, fonte (índice em `fonts`), tamanho, espaçamento, alinhamento e cores de topo e base.
- **Janelas:** conteúdo e molduras.
- **Materiais:** `materialDefs` com texturas (índice em `textures` mais o modo de repetição), SRT de textura, cor do material, registradores TEV (preto/branco para texturas I/IA) e modos de mistura.
- **Grupos:** `groups`.

### Cena (`.scene.json`)
- **Conteúdo:** `models` (assets `model`), `collision` (`.glb` de colisão), `objects` (posicionamento do `.pmp`) e `data` (`.plight`, `.plmap`, `.pblm`, `.pmmisc`, `.bti`).
- **Objetos do `.pmp`:** só nos cursos de golfe. São 1.361 objetos, cada um com `position`, `scale` e `axes` (eixos X/Y/Z, que formam as colunas da matriz de rotação). `model` fica `null`, porque o arquivo guarda só um id numérico de tipo, sem nome.

### Índices (`index/`)
- `layout-animations.json`: animações que apontam para cada layout.
- `anim-missing-targets.json`: 47 animações citam painéis que não existem no layout atual (ex.: `menuBg_00_*` pede `P_pre_00`). Isso vem dos próprios dados; o player deve ignorar esses alvos.
- `code-refs.json`: nomes de arquivo citados no código decompilado (`strings.tsv`) → assets. 639 de 752 resolvem, incluindo padrões como `glf_course_%s.carc`. Os que não resolvem são arquivos ausentes do projeto, como os bancos `rp_*_sound.brsar`.
- `texture-aliases.json`: nomes semânticos (de `docs/mapa_renomeacoes.json`) para 959 texturas. Usa só as entradas não duplicadas, porque nas duplicadas o nome veio de outra textura idêntica.
- `analise_haiku/`: relatórios brutos da análise feita por agentes Haiku (layouts, modelos, mapas, efeitos/código).
- `inventory.json`: todos os 3.100 arquivos do projeto, com situação e destino na pasta web.
- `formats.json`: situação de cada formato e como completar a conversão.
- `build-summary.json`: números do último build.

## Uso no frontend

```ts
import { WebAssetLoader } from '../linuxsports-game/tools/nw4r-web/src/web-runtime/WebAssetLoader.ts';
const lib = await WebAssetLoader.fromUrl('/linuxsports-web/manifest.json');

const layout = await lib.resolveLayout(id);            // .meta.root (árvore), .textures[i].texture, .fonts[i].font
const anims = lib.animationsFor(id);                   // animações deste layout
const scene = await lib.resolveScene(sceneId);         // .models[i].glb, .collision[i].glb, .meta.objects
// three.js: new GLTFLoader().parse(scene.models[0].glb.buffer, '', gltf => scene3d.add(gltf.scene))
```

## Limitações conhecidas
- **Animações 3D** (CHR0/SRT0/PAT0/CLR0/VIS0/SHP0/SCN0, 301 ao todo) não foram convertidas: estão listadas em `.model.json` e ficam no `.brres` original. 119 não puderam ser atribuídas a um modelo; a maioria vem de `.brres` só de animação, como `*_avatar_anim`.
- **Modelos:** o `.model.json` lista as texturas TEX0 do `.brres` de origem (todas as texturas usadas estão no próprio arquivo), não a lista exata por material.
- **Ordem dos eixos no `.pmp`:** a leitura Z, Y, X dá determinante +1 em todos os 1.361 objetos, mas é uma hipótese. Não foi confirmada no código do jogo.
- **Luz e efeitos:** `.plight`, `.pblm`, `.rcd` (dados de Mii), `.bmg`, `.breff` e `.breft` foram identificados, mas não decodificados.
- **Áudio:** o código cita 8 bancos `rp_*_sound.brsar` que não estão no projeto.

## Ferramentas e testes (wispt)

| Script | O que faz | Saída |
|---|---|---|
| `tools/decomp_index.py build\|find\|show\|strings` | índice por função do `decompiled.c` (lê só o trecho pedido) | `index/decompiled-index.json` |
| `tools/gemini_client.py ping\|ask\|rename` | Gemini API (chave em `.env`, veja `.env.example`) | cache em `tools/.cache/gemini/` |
| `tools/link_model_materials.py` | material → texturas (todas as camadas) a partir do MDL0 em `../linuxsports-web` | `materials` em cada `.model.json`, `index/model-materials.json` |
| `tools/validate_pmp.py` | calibra os objetos `.pmp` contra a colisão | `index/pmp-calibration.json` |
| `tools/bmg_extract.py` | extrai os `.bmg` (substitui os `.tsv` parciais de `raw/docs/textos`, que têm tags desalinhadas) | `assets/text/<idioma>/*.text.json`, `index/text-index.json` |

Runtime em `viewer/src/` (`config/`, `engine/`, `ui/`, e `entities/`, `activities/` para as próximas etapas). Testes: `node --test tests/*.test.mjs`.
