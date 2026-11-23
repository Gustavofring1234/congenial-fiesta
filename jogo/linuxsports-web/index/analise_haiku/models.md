# Analise dos .brres (somente leitura)

Saidas: `models.json` (detalhe por arquivo), este resumo. Scripts: `analisar.py`, `renomeacoes.py`.

## Visao geral
- 152 `.brres` lidos sem erro; 139 contem MDL0 (259 modelos, todos parseados).
- 259 `.glb` existentes em `assets/models_glb/`: todos casam com um modelo; 0 GLB orfaos; 0 modelos sem GLB.
- Regerando os GLB em rascunho, os nomes batem 1:1 com os existentes.
- Regra de nome: modelo unico com mesmo nome do arquivo -> `<base>.glb`; senao `<base>__<modelo>.glb`.

## Texturas dos modelos
- 1248 referencias (modelo x textura, sem repeticao por modelo); 1247 resolvidas.
- Todas as resolucoes estao no mesmo `.brres`. Nenhuma textura vem de outro arquivo da pasta.
- Texturas TEX0 totais: 1196, todas decodificaveis (formatos suportados por `wii_texturas.py`).
- Unica faltante: `P_sun_spreadline5_2` usada por `sun_model` em
  `src/minigames/baseball/common/common.carc/model/G3D/sun.brres`. O nome nao aparece em nenhum `.brres`
  do projeto nem em `src/`, `assets/` ou `docs/` fora do relatorio, que ja registra a falta.

## Animacoes (301 no total)
| Tipo | Qtd | Sem modelo guessado |
|------|-----|---------------------|
| CHR0 (esqueleto) | 158 | 88 |
| SRT0 (textura SRT) | 56 | 0 |
| PAT0 (troca de textura) | 11 | 0 |
| CLR0 (cor) | 39 | 0 |
| VIS0 (visibilidade) | 1 | 0 |
| SHP0 (forma) | 4 | 0 |
| SCN0 (cena, nao pedido) | 32 | 6 |

- Metodo do guess: maior prefixo comum com o nome do modelo, no mesmo `.brres`. Se o `.brres` tem um
  unico modelo, usa esse. Depois procura em `.brres` irmao da mesma pasta.
- Os 94 sem guess sao quase todos de arquivos sem MDL0 (animacoes isoladas de esqueleto, como
  `bbl_avatar_anim.brres`, `bwg_avatar_anim.brres`, `tns_avatar_anim.brres`, `box_avatarC0.brres`).
  O alvo fica em outro arquivo, e o nome nao casa com nenhum modelo do projeto.
- PAT0: 11 entradas em 9 arquivos. Os nomes de textura vêm de uma heuristica (strings na area da
  entrada que batem com TEX0 do mesmo arquivo). Quatro entradas sem nome encontrado (`box_ball_bad`, `box_hall`, `sp_titleBG_00` x2).
  `box_ball_bwg` lista 23 texturas (`ball.0`...`ball.N`, `Light_map3`).
  Validar antes de usar esses nomes como verdade.

## Assets de textura (docs/mapa_renomeacoes.json)
- 1821 entradas em `texturas_renomeadas`. Todos os PNG novos existem em `assets/textures/` (971 arquivos
  no disco, 0 sem mapa). Todos os `nome_material_original` tem `fonte_nome = gemini_texto`.
- Origem do PNG (`caminho_antigo`):
  - 1196 vem de pasta `G3D` (TEX0 de `.brres`). Para 1221 entradas com `base__textura`, o nome existe
    no `.brres` homonimo e as dimensoes do PNG batem com o TEX0.
  - 615 vem de pastas `timg` (formato `.tpl`). Ha exatamente 615 `.tpl` no projeto.
  - 10 vem de outros caminhos (ex.: `RPGolScene/common/FaceDummy*.png`).
- Os nomes finais sao renomeacoes semanticas feitas a partir de texto (Gemini). Nao sao nomes TEX0.
  598 nomes nao tem homonimo no TEX0, por exemplo `FaceDummy1`, `block`, `shadow`, `logo_model__LinuxSports_logo`.
  Para mapear PNG -> TEX0 use o caminho antigo, nao o nome novo.

## Arquivos
- `/tmp/claude-1000/-workspaces-codespaces-blank/58390c4b-9c02-45b6-bfaf-025fee58e880/scratchpad/analysis/models.json`
- `/tmp/claude-1000/-workspaces-codespaces-blank/58390c4b-9c02-45b6-bfaf-025fee58e880/scratchpad/analysis/models.md`
- `/tmp/claude-1000/-workspaces-codespaces-blank/58390c4b-9c02-45b6-bfaf-025fee58e880/scratchpad/analysis/renomeacoes_resumo.json`
