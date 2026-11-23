# nw4r-web-converter

Biblioteca TypeScript pura (só `ArrayBuffer` / `DataView` / `Uint8Array`) que converte binários Nintendo Wii/GameCube (NW4R) em assets web interoperáveis. Roda igual em **Node.js**, **browser** e **Web Workers**. Dependências de runtime: `fflate` (zip/deflate) e `zod/mini` (schema); ambas são JS puro.

| Entrada | Saída |
|---|---|
| `.carc` / `.arc` / `.szs` (Yaz0 e/ou U8, inclusive aninhados) | `.zip` com `manifest.json` na raiz + todos os arquivos internos convertidos |
| `.tpl` | `.png` (um por imagem) + `.tex.json` (formato GX, wrap/filtros GX **e** WebGL, mipmaps, paleta) |
| `.brfnt` | `.atlas.png` + `.font.json` (layout BMFont JSON: `chars`, `common`, `info`, UVs, além de métricas NW4R) |
| `.brlan` (+ variantes divididas `.brlpa/.brlvi/.brlmc/.brlts/...`) | `.anim.json` (trilhas, keys Hermite, segmentos Bézier, easing `cubic-bezier()`) |
| `.kcl` | `.glb` glTF 2.0 (uma mesh/nó por `collisionFlag`, metadados em `mesh.extras`) |
| qualquer outro arquivo | copiado como asset `raw` (ex.: `.brlyt`, `.brsar`) |

Formatos GX suportados: `I4, I8, IA4, IA8, RGB565, RGB5A3, RGBA8, CI4, CI8, CI14X2, CMPR` e paletas TLUT `IA8, RGB565, RGB5A3`.

## CLI

```bash
npm install
npx tsx src/cli.ts convert <arquivo_entrada> -o <pasta_saida>

# exemplos
npx tsx src/cli.ts convert local.carc -o out              # -> out/local.zip
npx tsx src/cli.ts convert local.carc -o out --unpacked   # -> out/local.zip + out/local/**
npx tsx src/cli.ts convert font.brfnt -o out              # -> out/font.font.json, out/font.atlas.png, out/manifest.json
npx tsx src/cli.ts convert extracted_dir/ -o out          # pasta já extraída tratada como arquivo
npx tsx src/cli.ts validate out/local.zip                 # validação cruzada do bundle
npx tsx src/cli.ts inspect file.tpl                       # dump dos cabeçalhos em JSON
```

Arquivos que falham na conversão nunca abortam o bundle: os bytes originais são mantidos como `raw` e um aviso vai para `manifest.warnings`. O exit code é `1` se a validação cruzada encontrar erros.

## Estrutura

```
src/
  core/        binary.ts (leitor BE / escritores), ids.ts (paths POSIX, assetId FNV-1a 64)
  parsers/     yaz0, u8, gx-texture, tpl, brfnt, brlan, kcl   (binário -> dados estruturados)
  serializers/ png, glb, yaz0, u8 (encoders) + texture, font, anim, collision (dados -> arquivos web)
  schemas/     bundle.schema.ts  (schema unificado + validateBundle)
  web-runtime/ WebAssetLoader.ts, anim-sampler.ts  (para o frontend)
  convert.ts   detecção por magic, Yaz0->U8 recursivo, resolução de referências, zip
  cli.ts       único arquivo que usa APIs do Node
tests/         fixtures sintéticos codificados do zero + testes com arquivos reais (opcionais)
```

## Regras de interoperabilidade

- **Caminhos**: todo caminho no `manifest.json` é POSIX relativo à raiz do bundle e já normalizado (sem `\`, `.`, `..` ou `/` inicial). Dentro de `.tex.json`/`.font.json`, os caminhos são relativos ao próprio JSON.
- **IDs determinísticos**: `assetId = <kind>-<fnv1a64("<kind>:" + lowercase(sourcePath))>`, ex.: `texture-33788e246fd57365`. A mesma entrada gera o mesmo ID em qualquer máquina ou runtime. O `.zip` também sai byte a byte idêntico, porque o mtime é fixo e a ordem é estável.
- **Referências cruzadas**: `anim.json.textures[i].assetId` aponta para assets `texture`; as trilhas `texturePattern` usam `value` como índice nessa tabela. A resolução imita o resource accessor do NW4R: primeiro procura `<raiz_do_arc>/timg/<nome>`, depois a mesma pasta e, por fim, o mesmo nome em qualquer lugar do bundle (vence o prefixo de diretório mais próximo). O que não for encontrado vai para `unresolvedRefs` e vira um aviso. Nunca se gera um ID que não exista.
- **`validateBundle(manifest, files)`** verifica: schema de cada JSON, IDs únicos e determinísticos, existência de todos os arquivos, posse única de cada arquivo, `refs` existentes, caminhos relativos de páginas/imagens, tipo correto de cada referência e índices de textura dentro do intervalo.

### manifest.json (resumido)

```json
{
  "format": "nw4r-web-bundle", "version": 1,
  "generator": { "name": "nw4r-web-converter", "version": "0.1.0" },
  "source": { "name": "local.carc", "format": "u8", "compression": "yaz0", "byteLength": 120425 },
  "assets": [{
    "assetId": "animation-…", "kind": "animation", "name": "menu_in.brlan",
    "sourcePath": "menuCommon.arc/anim/menu_in.brlan", "sourceFormat": "brlan",
    "primary": "menuCommon.arc/anim/menu_in.anim.json",
    "files": { "meta": "menuCommon.arc/anim/menu_in.anim.json" },
    "refs": ["texture-…"], "unresolvedRefs": [], "summary": { "frameCount": 30 }
  }],
  "warnings": []
}
```

## Frontend: `WebAssetLoader`

```ts
import { WebAssetLoader, toWaapiKeyframes } from 'nw4r-web-converter/web-runtime';

const loader = await WebAssetLoader.fromZip(await (await fetch('/assets/local.zip')).arrayBuffer());
// ou: await WebAssetLoader.fromManifestUrl('/assets/local/manifest.json');

const anim = await loader.getAnimation(loader.list('animation')[0].assetId);
anim.textures[0]?.getImageBitmap();         // textura referenciada, já resolvida e em cache
const pose = anim.sample(12);               // { paneName: { 'translate.x': …, visible: 1, texture: 0 } }

const font = await loader.getFont(fontId);
font.glyph('A');                            // { x, y, width, height, xoffset, yoffset, xadvance, uv }
font.measure('Hello');

const col = await loader.getCollision(kclId);  // col.glb (bytes) + col.gltf (JSON, extras com flags)

// Web Animations API / GSAP:
el.animate(toWaapiKeyframes(track, anim.meta.frameCount).map(k => ({ offset: k.offset, easing: k.easing, translate: `${k.value}px` })),
           { duration: anim.meta.frameCount / anim.meta.fps * 1000 });
```

`fromZip` valida o bundle inteiro antes de liberar o uso (use `{ strict: false }` para só registrar os problemas). Bundle do runtime para o browser (esbuild, minificado): cerca de 44 KB. A biblioteca completa, com conversores, para rodar em um Web Worker: cerca de 81 KB.

## Notas de formato

- **TPL**: só o nível 0 vira PNG; os níveis de mipmap ficam listados em `mipmaps` (use `parseTpl(data, { decodeMipmaps: true })` se precisar deles). CMPR usa interpolação DXT1 de 1/3 e 2/3.
- **BRFNT**: todas as folhas viram um único atlas em grade. Folhas `I4`/`I8` viram glifos brancos com alfa = intensidade (como o NW4R renderiza), prontos para tingir. Folhas `IA4`/`IA8` mantêm a intensidade, que preserva contornos. `yoffset = ascent - baselinePos`. Fontes SJIS/CP1252 são mapeadas para Unicode via `TextDecoder`.
- **BRLAN**: `fps = 60`. `segments[i]` traz os pontos de controle Bézier exatos (P1 = P0 + s0·dt/3, P2 = P3 − s1·dt/3) e um `cubic-bezier()` normalizado quando `v0 ≠ v1`. Se `v0 = v1` mas a curva tem inclinação, `easing` é `null` e `toWaapiKeyframes` amostra o segmento.
- **KCL**: triângulos reconstruídos dos prismas (`B = A + (en2×fn)·h/((en2×fn)·en3)`, idem para C), com winding CCW corrigido pela normal da face. A octree não é exportada porque não serve para engines web. O significado dos flags varia por jogo, então o valor bruto é preservado em `mesh.extras`.

## Testes

```bash
npm test          # vitest
npm run typecheck
```

- Fixtures sintéticos codificam cada formato do zero, de forma independente dos parsers: todos os formatos GX (com tiles de borda parciais), TLUT, mipmaps, os 3 métodos de CMAP, Hermite→Bézier, prismas KCL, Yaz0 (incluindo um stream montado à mão) e U8.
- Bundle ponta a ponta: Yaz0 → U8 → U8 aninhado → zip → `WebAssetLoader`, determinismo do zip, e manifests corrompidos de propósito (ref quebrada, arquivo ausente, ID não determinístico, caminho não-POSIX, índice de textura fora do intervalo).
- `tests/real-samples.test.ts` roda contra arquivos reais em `../linuxsports-game` ou `$NW4R_SAMPLES`, e é pulado se eles não existirem.
- `tests/portability.test.ts` garante que nada fora de `cli.ts` importa APIs do Node.
