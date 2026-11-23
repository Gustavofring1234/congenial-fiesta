# Alterações: linuxsports-web -> linuxsports-web-wispt

Origem `linuxsports-web/` (somente leitura). `linuxsports-web-wispt/` é a cópia transformada.
Mapeamento completo `caminho original -> caminho novo` em `ALTERACOES.json` (campo `map`); contentores mantidos e achatados em `containers`.

## 1. Reversão do movimento anterior (Fase 1)
- 209 arquivos Wii devolvidos a `linuxsports-web/<caminho relativo>`; tamanho e sha256 conferidos em cada um.
- `manifest.json` e `index/inventory.json` restaurados de `json_backup/`; sem chave `movedTo` e sem strings `../linuxsports-web_originais_wii`.
- Pasta `linuxsports-web_originais_wii/` apagada somente após a verificação.

## 2. Contagens da cópia
- Arquivos na origem: 4046; copiados: 3837; excluídos (formato Wii): 209
  - `.arc`: 46
  - `.breff`: 10
  - `.brres`: 152
  - `.brsar`: 1
- Diretórios-contentor na origem: 171; mantidos como stem: 34; achatados: 137
- Contentores divididos (arquivos do mesmo contentor em locais inconsistentes): 0
- Arquivos dentro de contentores: 2743; caminhos alterados: 2775
- Nomes de arquivo com token de contentor removido: 46; arquivos com '_' por colisão: 0
- Segmentos renomeados (RPSportsTitle -> RPST): 0
- Grupos de colisão (regra padrão): 235, com 661 arquivos; resolvidos por contentor em 2 iteração(ões). Grupos com bytes idênticos (mantidos ambos, caminhos únicos): 72
- Caminhos de destino únicos: sim (3837 arquivos; sem duplicatas, nem ignorando caixa).

## 3. JSON
- JSON copiados: 1715; reescritos: 899; copiados byte a byte: 816.
- Strings de caminho reescritas: 7406 exatas e 0 com prefixo ../ ./ /. Strings renomeadas no total: 7602; chaves renomeadas: 11.
- `manifest.json`: assets de 3136 para 3026; removidos: 110; marcados com `main=null`, `files=[]`, `removed=true`: 99.
- `index/inventory.json`: 3100 entradas; 209 com `output=null` e `status="removido"`.
- Formatação preservada (indentação, quebra de linha final, estilo compacto). Falhas de ida e volta: 0.

## 4. Visualizador
- Sem caminhos com contentor ou nomes antigos. As ocorrências de `.brres` em `viewer/app.js` (linhas 195, 197, 198) são rótulos de interface e não foram alteradas.
- O visualizador carrega pelo `main` do manifesto; os 99 assets marcados são do tipo `binary`, que ele não carrega.

## 5. Anomalias
- Em 1082 arquivos JSON (fora de manifesto/inventário) há 9812 strings terminadas em extensões excluídas, em sua maioria nomes de layout (ex.: `baseballCommon_00.brlyt`). Não foram alteradas, pois não são caminhos de arquivos copiados.
- Nenhum arquivo `.arc.d` na origem e nenhum link simbólico.

## 6. Validação
- 0 arquivos com extensões excluídas; 0 diretórios com sufixo de contentor; 0 segmentos com rpsportstitle/wiisport/nintendo (sem diferenciar caixa).
- Arquivos em DST: 3839 (3837 copiados + 2 relatórios). Todos os valores do `map` existem em DST.
- Todos os `main`/`files` do manifesto e `output` do inventário não nulos apontam para arquivos existentes: 9626 verificados, 0 faltando.
- Todos os JSON de DST fazem parse. `grep` por rpsportstitle/wiisport/nintendo: 0 ocorrências nos JSON copiados; a única ocorrência é em `ALTERACOES.json`, cujo campo `map` contém os caminhos originais (chaves) por definição.
- Origem `linuxsports-web/` inalterada desde o fim da Fase 1 (4046 arquivos, 181315440 bytes).
- Contentores divididos: 0 (cada contentor tem todos os arquivos no mesmo local, com ou sem a pasta-stem).
