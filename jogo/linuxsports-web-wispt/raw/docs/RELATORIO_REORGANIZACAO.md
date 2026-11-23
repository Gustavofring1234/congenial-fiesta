# Relatório de reorganização — linuxsports-game

Data: 2026-11-16 · Lista arquivo a arquivo: [`mapa_renomeacoes.json`](mapa_renomeacoes.json)

## Integridade do `main.dol`

O `main.dol` não foi movido, renomeado nem modificado. Ele foi apenas lido para calcular o hash.

| | Valor |
|---|---|
| SHA-256 (antes e depois) | `dd68fe55d6c3d558ecb5a648457ca050dda9c1f6e403c02626017c729a575354` |
| SHA-1 | `8bb422971b88b5551a37de98db69557df7b46637` |
| Tamanho | 3.995.168 bytes |

A etapa do `inspecionar_dol.py` foi pulada a pedido. O script não existia no workspace.

## Estrutura nova

```
main.dol                         intacto, no local original
assets/maps/<esporte>/           cenários de Stage/ (.carc inteiros: .brres, .kcl colisão, .pmp objetos, iluminação)
assets/textures/<categoria>/     971 PNGs únicos com nome traduzido em snake_case
assets/shaders/effects/<cena>/   efeitos .breff/.breft e materiais/animações de layout .brlmc/.brlpa/.brlvi
assets/audio/raw/                .bwav e .brsar originais
assets/audio/decoded/            WAVs decodificados e símbolos do .brsar
src/minigames/<esporte>/{common,us}/   bowling, boxing, baseball, golf, tennis, fitness, training
src/core/shared/<Cena>/{common,us}/    SportsStatic, RPCommon, RPSportsCommon, RPSportsTitle, Kokeshi, Font, Message
src/core/decompiled/             decompiled.c, functions.tsv, names_demangled.tsv, strings.tsv
docs/textos/                     mensagens do jogo (.bmg) exportadas em TSV
config/dolphin/                  perfil de teclado para o Wii Remote emulado
scripts/renomear_texturas.py     script de tradução dos nomes de textura
```

## Resumo das operações

| Operação | Arquivos | Responsável |
|---|---|---|
| Movidos para a nova estrutura | 1.811 (minigames 830, core 812, maps 109, shaders 50, audio 6, decompiled 4) | Subagente Haiku 4 |
| Texturas renomeadas e movidas | 1.821 entradas → 971 arquivos únicos (850 cópias idênticas removidas, verificadas por SHA-256) | Opus (script) |
| Decodificados | 5 WAV, 1 lista de símbolos, 2 TSV de mensagens | Subagente Haiku 1 |
| Removidos (detecção do controle) | 55 | Opus |
| Criados | perfil Dolphin, script, este relatório, JSON | Opus |

Total: 3.688 arquivos no início e 2.794 no fim. A pasta passou de 144 MB para 125 MB.

## Detalhes e limitações

### Texturas
- Os nomes vieram da tradução do nome original de cada arquivo, que mistura abreviações em inglês e romaji japonês. A tradução foi feita pela Gemini (`gemini-flash-lite-latest`) em modo texto, sem enviar as imagens, em 6 lotes. Nenhum nome precisou de fallback.
- A primeira tentativa analisava cada imagem e foi interrompida a pedido. Ela também esbarrava no limite de requisições (HTTP 429). Nenhum arquivo tinha sido movido por ela.
- 41 arquivos receberam sufixo `_2`, `_3`… porque o nome traduzido coincidiu com outro.
- O nome original de cada material fica em `nome_material_original` no JSON.
- As texturas são PNGs derivados. Nenhum arquivo do jogo aponta para eles, então renomear não quebra nada.

### Containers `.carc`
- Os `.carc` de `Stage/` foram movidos inteiros.
- Os efeitos (`.breff` etc.) e os áudios foram retirados dos seus `.carc` e levados para `assets/shaders` e `assets/audio`. Por isso, 11 containers ficaram divididos entre pastas: os `common.carc` de cada cena, mais `US/RPBsbScene/local.carc` e `US/RPTnsScene/local.carc`.
- Para reempacotar, use o campo `disc_path` do JSON. Ele indica o arquivo do disco original de cada item.

### Detecção do controle (removida)
- Foram removidos `RPCommon/local.carc/rimoconEntry.arc` (tela "conecte o Wii Remote") e `nunchukCheck.arc` (verificação do Nunchuk), junto com as pastas extraídas e as texturas desses layouts.
- Há cópias em `../linuxsports-re/assets/` e em `../linuxsports-game.zip`.
- O jogo roda a partir do `main.dol`/ISO. Apagar esses arquivos nesta pasta não altera a execução.
- Se um disco for reempacotado sem eles, o executável (que não pode ser alterado) falha ao tentar carregar essas telas. Nesse caso, use os originais do backup.
- A detecção em si fica no código do `main.dol`. As strings `"Nintendo RVL-CNT"` são o nome Bluetooth do Wii Remote e foram mantidas.

### Teclado no lugar do controle
- Como o `.dol` não pode ser modificado, a troca é feita no emulador.
- `config/dolphin/Profiles/Wiimote/linuxsports_teclado.ini` configura um Wii Remote emulado com teclado e mouse no Dolphin. O jogo continua "vendo" um controle, então nada quebra.

| Função | Tecla |
|---|---|
| A / B | Z / X |
| 1 / 2 | 1 / 2 |
| − / + | Q / E |
| Home | Enter |
| Direcional | setas |
| Ponteiro | mouse |
| Movimento (swing) | W A S D F G |
| Agitar | Espaço |
| Inclinação | I J K L |
| Nunchuk: C / Z | C / V |
| Nunchuk: analógico | T Y U B |
| Nunchuk: agitar | H |

- Instalação: copie o `.ini` para `~/.local/share/dolphin-emu/Config/Profiles/Wiimote/`. No Dolphin, configure o Wii Remote 1 como "Emulated Wii Remote" e carregue o perfil.

### Áudio e mensagens
- O `craft-anything-cli` não reconhece BWAV, BRSAR nem BMG. Foram usados decodificadores em Python, só com a biblioteca padrão.
- Os `.bwav` do HOME Menu não têm cabeçalho. O conteúdo é PCM16 big-endian.
- A taxa de amostragem não está no arquivo. Os WAVs usam 32.000 Hz como suposição; se o som tocar em velocidade errada, ajuste a taxa.
- `HomeButtonSe.brsar`: os 27 nomes de som foram listados. As ondas não estão nesse arquivo.
- As mensagens `.bmg` foram exportadas em `docs/textos/` sem alterar o texto. Os códigos de controle aparecem como `{tag:…}`.

### Referências à Nintendo
- Foram mantidas, a pedido.
- O aviso `© 2006-2007 Nintendo` está em `src/core/shared/RPSportsTitle/us/local.carc/SpTitle.arc*`.
- As strings de hardware estão em `src/core/decompiled/`.

### Referências de caminho
- Nenhum script ou documento do projeto apontava para os caminhos antigos.
- Os scripts em `../linuxsports-re/scripts/` usam a cópia que fica lá e não foram afetados.

## Conversor BRRES → GLB (2026-11-17)

`scripts/brres2glb.py` usa só a biblioteca padrão e reaproveita o decodificador de texturas de `scripts/wii_texturas.py`.

```
python3 scripts/brres2glb.py arquivo.brres -o saida/
python3 scripts/brres2glb.py assets/maps -o assets/models_glb/assets/maps   # pasta inteira
```

Opções:
- `--escala F`: muda a escala do modelo.
- `--unlit`: ignora a iluminação. Útil para cenários com luz pré-calculada nas cores de vértice.
- `--sem-texturas`: exporta só a geometria.

**O que é convertido** (MDL0 v8/v9 e TEX0):
- posições, normais, cores de vértice, UV0 e todos os formatos de primitiva GX;
- materiais com a primeira camada de textura, embutida como PNG, com modo de repetição, transparência (DrawXlu → BLEND; alfa → MASK) e face dupla;
- texturas que ficam em outro `.brres` da mesma pasta.

Os vértices saem na pose de repouso: vértices ligados a um único osso recebem a matriz desse osso, e vértices com peso em vários ossos já estão no espaço do modelo.

**Resultado:** 152 `.brres` geraram 259 modelos em `assets/models_glb/` (52 MB). O validador oficial do Khronos (`gltf-validator`) não apontou erros nem avisos. Também conferi a contagem de triângulos com o cabeçalho e o sentido das faces pelo volume de malhas fechadas.

**Limitações:**
- Não exporta esqueleto/skin nem animações (CHR0, SRT0, CLR0, PAT0, VIS0, SHP0).
- Ignora a matriz de textura (SRT) dos materiais. Por isso, texturas repetidas, como a grama do golfe, podem aparecer com escala diferente da do jogo.
- Usa só a primeira camada de textura e o primeiro conjunto de UV. Efeitos de reflexo e lightmaps não são combinados.
- Os Miis (`Kokeshi`) usam texturas provisórias, porque a cor é aplicada durante a execução, e por isso aparecem escuros.
- A textura `P_sun_spreadline5_2` de `sun_model` (beisebol) não existe nos `.brres` da pasta.

## Biblioteca `tools/nw4r-web` (2026-11-17)

Biblioteca TypeScript (Node e browser) que converte `.carc`/`.arc` → `.zip` + `manifest.json`, `.tpl` → PNG + `.tex.json`, `.brfnt` → BMFont, `.brlan` → `.anim.json` e `.kcl` → `.glb`. Detalhes em `tools/nw4r-web/README.md`.

Verificação:
- **Testes:** 54 testes (vitest) passam. A checagem de tipos (`tsc`) está limpa.
- **Arquivos reais:** os parsers leram todos os arquivos do projeto: 615 `.tpl`, 617 `.brlan`, 138 `.brlyt`, 21 `.kcl`, 8 `.brfnt` e 47 `.arc`.
- **GLBs de colisão:** os 21 aprovados pelo `gltf-validator`, sem erros.
- **Bundle de teste:** um `.carc` montado com Yaz0 + U8 passa na validação cruzada e gera saída idêntica byte a byte em duas execuções.
- **Detecção de erros:** os testes confirmam que a validação acusa referência quebrada, arquivo ausente, tipo errado e caminho inseguro.

## Projeto web interligado `../linuxsports-web` (2026-11-17)

Gerado por `tools/nw4r-web` (`npm run build:web`) num único `manifest.json` global, validado sem erros. Detalhes em `../linuxsports-web/README.md`.

- **Análise prévia:** 4 agentes Haiku (layouts, modelos, mapas, efeitos/código), coordenados pelo Opus. Os relatórios estão em `linuxsports-web/index/analise_haiku/`. A Gemini não foi usada.
- **Correção em `tools/nw4r-web`:** o parser `.brlyt` lia o nome dos painéis em `+0x18`; o certo é `+0x0C`.
- **Novos parsers:** `.brlyt` completo (árvore, materiais, textos, janelas, grupos), `.pmp` (posicionamento no golfe) e índice de `.brres`.
- **Novos tipos de asset:** `model` (os 259 `.glb` de `assets/models_glb`) e `scene` (32 estágios).
- **Animações divididas:** `.brlpa`, `.brlvi` e `.brlmc` agora são convertidas.
- **Testes:** 60 passam e o `tsc` está limpo.
