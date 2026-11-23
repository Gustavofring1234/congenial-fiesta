# nw4r-web

Converte formatos binários NW4R/Wii em arquivos web interoperáveis. TypeScript puro: só `ArrayBuffer`, `DataView` e `Uint8Array`, sem módulos nativos. Funciona no Node (CLI) e no browser ou em Web Workers (`src/index.ts` não importa nada do Node).

Dependências de execução: `fflate` (zip/zlib) e `zod` (schemas).

| Entrada | Saída |
|---|---|
| `.carc` / `.arc` / `.szs` (Yaz0 + U8, inclusive `.arc` aninhados) ou pasta extraída | `.zip` com `manifest.json` e todos os arquivos convertidos |
| `.tpl` | `.png` (um por imagem) + `.tex.json` (wrap, filtros, formato GX, paleta, mipmaps, constantes WebGL) |
| `.brfnt` | atlas `.png` + `.font.json` (BMFont JSON: métricas, UVs, mapa Unicode) |
| `.brlan` | `.anim.json` (trilhas RLPA/RLTS/RLVC/RLMC/RLVI/RLTP/RLIM com chaves Hermite `frame/value/slope` ou degrau) |
| `.brlyt` | `.layout.json` (só as referências: texturas, fontes, materiais, panes) |
| `.kcl` | `.glb` (uma malha por flag de colisão; `collisionFlag` em `mesh.extras`) |

## CLI

```bash
npm install
npx tsx src/cli.ts convert <entrada> -o <pasta_saida> [--no-raw]
npx tsx src/cli.ts validate <bundle.zip | manifest.json>
npx tsx src/cli.ts info <arquivo>
npm test          # vitest
npm run typecheck
```

## Bundle

```
manifest.json
assets/<caminho original sem extensão>.{png,tex.json,font.json,anim.json,layout.json,glb}
raw/<caminho original>          # binários originais (desligue com --no-raw)
```

- **Caminhos:** POSIX, relativos e sem `..`. Um `.arc` aninhado vira a pasta `<nome>.arc.d/`.
- **`assetId`:** `prefixo_` + FNV-1a 64 de `tipo:caminho`. É determinístico, então duas conversões geram o mesmo zip byte a byte.
- **Referências cruzadas:** guardam o nome original e o `ref` (assetId ou `null`):
  - texturas de animação, incluindo as de outro `.arc` do mesmo `.carc`;
  - layout da animação;
  - texturas e fontes do layout.

  O que não existe no bundle vai para `unresolved`. Exemplo: fontes ficam em `font.carc`.
- **Validação:** `validateBundle()` (`src/schemas/bundle.schema.ts`) confere:
  - schema de cada arquivo;
  - IDs únicos;
  - arquivos presentes;
  - refs existentes e do tipo certo;
  - índices `RLTP` dentro da lista de texturas;
  - glifos dentro do atlas.
- **Falhas de conversão:** o arquivo é mantido como `binary`, com o campo `error` preenchido.

## Frontend

```ts
import { WebAssetLoader, evaluateTrack, paneKeyframes } from 'nw4r-web';

const lib = await WebAssetLoader.fromZip(await (await fetch('/local.carc.zip')).arrayBuffer());
const anim = await lib.resolveAnimation(lib.list('animation')[0].assetId);
anim.textures[0].texture?.images[0];               // ImageBitmap no browser
const kf = paneKeyframes(anim.meta, 'N_button_00');
if (kf) element.animate(kf.keyframes, kf.options);  // Web Animations API
```

Também disponíveis: `hermiteToBezier()` (segmentos Bézier para GSAP/curvas próprias) e `sampleTrack()`.

## Limitações

- **TPL:** só o nível base de mip é decodificado. Os demais aparecem só como contagem em `mipmapCount`.
- **BRFNT:** folhas comprimidas (bit 0x8000) não são suportadas. O atlas empilha as folhas na vertical.
- **BRLYT:** só a lista de referências é lida. Panes e materiais não são renderizados.
- **KCL:** o significado de cada flag depende do jogo, por isso o valor é exportado cru.
