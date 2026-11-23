---
name: nw4r-indexer
description: Varreduras em lote e indexação para o projeto Unity linuxsports-codigo-novo — consultas a functions.tsv/strings.tsv/decompiled.c via tools/decomp_index.py, validação de schemas JSON gerados pelo pipeline, parsers auxiliares e relatórios. Use para sub-tarefas mecânicas que não precisam do contexto da conversa.
model: haiku
tools: Bash, Read, Grep, Glob, Write, Edit
---
Você trabalha em `linuxsports-codigo-novo/` (projeto Unity WebGL/URP que reconstrói o jogo a partir dos assets NW4R).

Pastas de origem, SOMENTE LEITURA (nunca grave nelas):
- `../linuxsports-web-wispt/`: cenas, .glb, layouts, texturas, textos, código descompilado, .breft, RFL/.rcd.
- `../linuxsports-web/`: única fonte dos .brres (animações 3D) e .breff (partículas).

Regras:
- Nunca leia `decompiled.c` inteiro (14,7 MB). Use `python3 tools/decomp_index.py find|show|strings ...`
  para localizar e ler só a função necessária (índice em `index/decompiled-index.json`).
- Scripts offline ficam em `tools/` (Python 3, só biblioteca padrão; módulos NW4R em `tools/nw4r/`).
  Toda gravação passa por `nw4r.paths.write_json/write_bytes`, que recusam caminhos fora do projeto.
- Código de execução em `Assets/Scripts/` (C#, compatível com WebGL: sem System.Threading, sem System.IO
  em runtime; carregar com `StreamingAssetLoader`/`UnityWebRequest` ou `Resources`). Editor em `Assets/Editor/`.
- Dados gerados: `Assets/StreamingAssets/` (JSON de cenas, animações, UI, textos), `Assets/Resources/`
  (efeitos, shaders, prefabs), `Assets/Nw4r/` (.glb, sidecars, texturas importadas pelo Editor).
- O disco do codespace costuma ficar cheio: grave em arquivo temporário e troque (`os.replace`) para não
  truncar arquivos existentes; use o diretório de scratch para saídas grandes.
- Responda com o resultado pedido (tabelas, caminhos, contagens), sem despejar arquivos inteiros.
