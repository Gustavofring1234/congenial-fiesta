/**
 * Schema unificado do bundle web. Todo arquivo gerado (manifest, .tex.json, .font.json,
 * .anim.json, .layout.json, extras do .glb) é descrito e validado aqui.
 */
import { z } from 'zod';
import { isSafeRelativePosix } from '../binary/ids.ts';

export const SCHEMA_VERSION = 1;

const posixPath = z.string().refine(isSafeRelativePosix, { message: 'caminho deve ser relativo, POSIX (/), sem "..", "." ou barra inicial' });
const assetId = z.string().regex(/^(tex|fnt|anm|col|lyt|mdl|scn|bin)_[0-9a-f]{16}$/, 'assetId inválido');
const assetKind = z.enum(['texture', 'font', 'animation', 'collision', 'layout', 'model', 'scene', 'binary']);

/** Referência por nome do formato original, resolvida (ou não) para um assetId. */
export const NamedRef = z.object({
  name: z.string(),
  ref: assetId.nullable(),
});

// ------------------------------------------------------------------ .tex.json
export const TexImage = z.object({
  index: z.number().int().nonnegative(),
  file: posixPath,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  format: z.string(),
  formatId: z.number().int(),
  palette: z.object({ format: z.string(), entryCount: z.number().int() }).nullable(),
  wrapS: z.enum(['CLAMP', 'REPEAT', 'MIRROR']),
  wrapT: z.enum(['CLAMP', 'REPEAT', 'MIRROR']),
  minFilter: z.string(),
  magFilter: z.string(),
  lodBias: z.number(),
  minLod: z.number().int(),
  maxLod: z.number().int(),
  mipmapCount: z.number().int().positive(),
  webgl: z.object({ wrapS: z.number().int(), wrapT: z.number().int(), minFilter: z.number().int(), magFilter: z.number().int() }),
});
export const TexJson = z.object({
  format: z.literal('nw4r-tex'),
  version: z.literal(SCHEMA_VERSION),
  assetId,
  source: posixPath,
  images: z.array(TexImage).min(1),
});
export type TexJson = z.infer<typeof TexJson>;

// ----------------------------------------------------------------- .font.json (BMFont JSON)
export const BmChar = z.object({
  id: z.number().int().nonnegative(),
  char: z.string(),
  index: z.number().int().nonnegative(),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  xoffset: z.number().int(),
  yoffset: z.number().int(),
  xadvance: z.number().int(),
  page: z.number().int().nonnegative(),
  chnl: z.number().int(),
});
export const FontJson = z.object({
  format: z.literal('bmfont-json'),
  version: z.literal(SCHEMA_VERSION),
  assetId,
  source: posixPath,
  pages: z.array(posixPath).min(1),
  info: z.object({
    face: z.string(), size: z.number().int(), bold: z.number().int(), italic: z.number().int(), charset: z.string(),
    unicode: z.number().int(), stretchH: z.number().int(), smooth: z.number().int(), aa: z.number().int(),
    padding: z.array(z.number().int()).length(4), spacing: z.array(z.number().int()).length(2),
  }),
  common: z.object({
    lineHeight: z.number().int(), base: z.number().int(), scaleW: z.number().int().positive(), scaleH: z.number().int().positive(),
    pages: z.number().int().positive(), packed: z.number().int(),
  }),
  chars: z.array(BmChar),
  kernings: z.array(z.object({ first: z.number().int(), second: z.number().int(), amount: z.number().int() })),
  nw4r: z.object({
    encoding: z.string(), fontType: z.number().int(), alterCharIndex: z.number().int(),
    defaultWidth: z.object({ left: z.number().int(), glyphWidth: z.number().int(), charWidth: z.number().int() }),
    cellWidth: z.number().int(), cellHeight: z.number().int(), baselinePos: z.number().int(), maxCharWidth: z.number().int(),
    sheetFormat: z.string(), sheetCount: z.number().int(), sheetWidth: z.number().int(), sheetHeight: z.number().int(),
    unmappedCodes: z.number().int(),
  }),
});
export type FontJson = z.infer<typeof FontJson>;

// ----------------------------------------------------------------- .anim.json
export const AnimKey = z.object({ frame: z.number(), value: z.number(), slope: z.number() });
export const AnimTrack = z.object({
  group: z.enum(['RLPA', 'RLTS', 'RLVC', 'RLMC', 'RLVI', 'RLTP', 'RLIM']),
  groupName: z.string(),
  index: z.number().int().nonnegative(),
  target: z.number().int().nonnegative(),
  property: z.string(),
  interpolation: z.enum(['step', 'hermite']),
  keys: z.array(AnimKey).min(1),
});
export const AnimJson = z.object({
  format: z.literal('nw4r-anim'),
  version: z.literal(SCHEMA_VERSION),
  assetId,
  source: posixPath,
  frameSize: z.number().int().nonnegative(),
  loop: z.boolean(),
  /** RLTP.textureIndex aponta para esta lista */
  textures: z.array(NamedRef),
  /** layout (.brlyt) ao qual a animação se aplica, se encontrado */
  layout: NamedRef.nullable(),
  targets: z.array(z.object({ name: z.string(), kind: z.enum(['pane', 'material']), tracks: z.array(AnimTrack) })),
});
export type AnimJson = z.infer<typeof AnimJson>;

// --------------------------------------------------------------- .layout.json
const rgba = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const vec2 = z.tuple([z.number(), z.number()]);
const texQuad = z.tuple([vec2, vec2, vec2, vec2]);
const LayoutQuad = z.object({ material: z.number().int().nonnegative(), vertexColors: z.tuple([rgba, rgba, rgba, rgba]), texCoords: z.array(texQuad) });

export const LayoutMaterial = z.object({
  name: z.string(),
  tevColors: z.tuple([rgba, rgba, rgba]),
  konstColors: z.tuple([rgba, rgba, rgba, rgba]),
  color: rgba.nullable(),
  /** texture = índice em LayoutJson.textures; wrap 0 CLAMP, 1 REPEAT, 2 MIRROR */
  textureMaps: z.array(z.object({ texture: z.number().int().nonnegative(), wrapS: z.number().int(), wrapT: z.number().int() })),
  texSrt: z.array(z.object({ translate: vec2, rotate: z.number(), scale: vec2 })),
  texCoordGenCount: z.number().int(),
  tevStageCount: z.number().int(),
  alphaCompare: z.array(z.number()).nullable(),
  blendMode: z.array(z.number()).nullable(),
});

export interface LayoutPaneJson {
  type: 'pane' | 'picture' | 'text' | 'window' | 'bounding';
  name: string;
  userData: string;
  visible: boolean;
  influencedAlpha: boolean;
  locationAdjust: boolean;
  origin: number;
  alpha: number;
  translate: [number, number, number];
  rotate: [number, number, number];
  scale: [number, number];
  size: [number, number];
  picture?: z.infer<typeof LayoutQuad>;
  text?: {
    material: number; font: number; text: string; maxChars: number; textOrigin: number; alignment: number;
    colors: [z.infer<typeof rgba>, z.infer<typeof rgba>]; fontSize: [number, number]; charSpace: number; lineSpace: number;
  };
  window?: { inflation: [number, number, number, number]; content: z.infer<typeof LayoutQuad>; frames: { material: number; flip: number }[] };
  children: LayoutPaneJson[];
}

export const LayoutPane: z.ZodType<LayoutPaneJson> = z.lazy(() => z.object({
  type: z.enum(['pane', 'picture', 'text', 'window', 'bounding']),
  name: z.string(),
  userData: z.string(),
  visible: z.boolean(),
  influencedAlpha: z.boolean(),
  locationAdjust: z.boolean(),
  origin: z.number().int().min(0).max(8),
  alpha: z.number().int().min(0).max(255),
  translate: z.tuple([z.number(), z.number(), z.number()]),
  rotate: z.tuple([z.number(), z.number(), z.number()]),
  scale: vec2,
  size: vec2,
  picture: LayoutQuad.optional(),
  text: z.object({
    material: z.number().int().nonnegative(), font: z.number().int().nonnegative(), text: z.string(), maxChars: z.number().int(),
    textOrigin: z.number().int(), alignment: z.number().int(), colors: z.tuple([rgba, rgba]), fontSize: vec2, charSpace: z.number(), lineSpace: z.number(),
  }).optional(),
  window: z.object({
    inflation: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    content: LayoutQuad,
    frames: z.array(z.object({ material: z.number().int().nonnegative(), flip: z.number().int() })),
  }).optional(),
  children: z.array(LayoutPane),
}));

export interface LayoutGroupJson { name: string; panes: string[]; children: LayoutGroupJson[] }
export const LayoutGroup: z.ZodType<LayoutGroupJson> = z.lazy(() => z.object({ name: z.string(), panes: z.array(z.string()), children: z.array(LayoutGroup) }));

export const LayoutJson = z.object({
  format: z.literal('nw4r-layout-refs'),
  version: z.literal(SCHEMA_VERSION),
  assetId,
  source: posixPath,
  textures: z.array(NamedRef),
  fonts: z.array(NamedRef),
  /** nomes dos materiais (alvos de animação do tipo material) */
  materials: z.array(z.string()),
  /** nomes de todos os painéis, em pré-ordem (alvos de animação do tipo painel) */
  panes: z.array(z.string()),
  /** tela virtual do layout; centered = origem (0,0) no centro, eixo Y para cima */
  screen: z.object({ width: z.number(), height: z.number(), centered: z.boolean() }),
  materialDefs: z.array(LayoutMaterial),
  root: LayoutPane.nullable(),
  groups: z.array(LayoutGroup),
});
export type LayoutJson = z.infer<typeof LayoutJson>;

// --------------------------------------------------------------- .model.json
/** Modelo 3D (MDL0 de um .brres) já convertido para .glb, com o que o .glb não carrega. */
export const ModelJson = z.object({
  format: z.literal('nw4r-model'),
  version: z.literal(SCHEMA_VERSION),
  assetId,
  source: posixPath,
  /** .brres de origem e nome do MDL0 dentro dele */
  brres: posixPath,
  model: z.string(),
  glb: posixPath,
  /** texturas TEX0 usadas pelos materiais (já embutidas no .glb); foundIn = .brres onde foram achadas */
  textures: z.array(z.object({ name: z.string(), foundIn: posixPath.nullable() })),
  /** animações do .brres atribuídas a este modelo (ainda não convertidas: ficam no binário original) */
  animations: z.array(z.object({ type: z.enum(['CHR0', 'SRT0', 'PAT0', 'CLR0', 'VIS0', 'SHP0', 'SCN0']), name: z.string() })),
});
export type ModelJson = z.infer<typeof ModelJson>;

// --------------------------------------------------------------- .scene.json
/** Estágio (Stage/*.carc): junta modelos, colisão, posicionamento e arquivos de luz/câmera. */
export const SceneJson = z.object({
  format: z.literal('nw4r-scene'),
  version: z.literal(SCHEMA_VERSION),
  assetId,
  source: posixPath,
  sport: z.string(),
  /** ref -> asset 'model' */
  models: z.array(NamedRef),
  /** ref -> asset 'collision' */
  collision: z.array(NamedRef),
  /** objetos posicionados (só quando o formato de posicionamento foi decodificado com confiança) */
  objects: z.array(z.object({
    /** id de tipo do objeto no .pmp (o arquivo não guarda nomes) */
    typeId: z.number().int(),
    variant: z.number().int(),
    /** modelo do objeto, quando for possível associar (null = tipo sem nome conhecido) */
    model: assetId.nullable(),
    position: z.tuple([z.number(), z.number(), z.number()]),
    scale: z.tuple([z.number(), z.number(), z.number()]),
    /** eixos locais X/Y/Z no espaço do mundo (no .pmp ficam na ordem Z, Y, X; colunas de uma matriz de rotação) */
    axes: z.object({ x: z.tuple([z.number(), z.number(), z.number()]), y: z.tuple([z.number(), z.number(), z.number()]), z: z.tuple([z.number(), z.number(), z.number()]) }),
  })),
  /** arquivos sem conversor (luz, mapa de luz, bloom, câmera...), ref -> asset 'binary' */
  data: z.array(z.object({ role: z.string(), name: z.string(), ref: assetId.nullable() })),
});
export type SceneJson = z.infer<typeof SceneJson>;

// ----------------------------------------------------------- extras do .glb (KCL)
export const CollisionMeshExtras = z.object({
  collisionFlag: z.number().int().min(0).max(0xffff),
  collisionFlagHex: z.string().regex(/^0x[0-9a-f]{4}$/),
  triangleCount: z.number().int().positive(),
});

// --------------------------------------------------------------- manifest.json
export const AssetEntry = z.object({
  assetId,
  kind: assetKind,
  /** caminho do arquivo original dentro do contêiner */
  source: posixPath,
  /** arquivo principal convertido (json/glb) ou o binário original */
  main: posixPath,
  /** todos os arquivos produzidos para este asset */
  files: z.array(posixPath).min(1),
  /** assetIds referenciados (devem existir no manifest) */
  refs: z.array(assetId),
  /** nomes que não puderam ser resolvidos dentro do bundle (ex.: fonte em outro .carc) */
  unresolved: z.array(z.string()),
  /** binário original preservado, quando incluído */
  raw: posixPath.nullable(),
  error: z.string().optional(),
});
export type AssetEntry = z.infer<typeof AssetEntry>;

export const Manifest = z.object({
  format: z.literal('nw4r-web-bundle'),
  version: z.literal(SCHEMA_VERSION),
  generator: z.string(),
  source: z.object({
    name: z.string(),
    container: z.enum(['u8', 'directory', 'file']),
    compression: z.enum(['yaz0', 'none']),
  }),
  assets: z.array(AssetEntry),
});
export type Manifest = z.infer<typeof Manifest>;

export const SCHEMA_BY_KIND = {
  texture: TexJson, font: FontJson, animation: AnimJson, layout: LayoutJson, model: ModelJson, scene: SceneJson,
} as const;

// ------------------------------------------------------------ validação cruzada
export interface ValidationResult { ok: boolean; errors: string[]; warnings: string[] }

/**
 * Valida o manifest e todos os arquivos que ele cita.
 * `read(path)` devolve os bytes do arquivo do bundle (ou undefined se não existir).
 */
export function validateBundle(manifestInput: unknown, read: (path: string) => Uint8Array | undefined): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = Manifest.safeParse(manifestInput);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `manifest: ${i.path.join('.')}: ${i.message}`), warnings };
  }
  const m = parsed.data;
  const byId = new Map<string, AssetEntry>();
  const owners = new Map<string, string>();
  for (const a of m.assets) {
    if (byId.has(a.assetId)) errors.push(`assetId duplicado: ${a.assetId}`);
    byId.set(a.assetId, a);
    if (!a.files.includes(a.main)) errors.push(`${a.assetId}: "main" (${a.main}) não está em "files"`);
    for (const f of [...a.files, ...(a.raw ? [a.raw] : [])]) {
      if (owners.has(f) && owners.get(f) !== a.assetId) errors.push(`arquivo ${f} pertence a dois assets`);
      owners.set(f, a.assetId);
      if (!read(f)) errors.push(`${a.assetId}: arquivo ausente no bundle: ${f}`);
    }
    if (a.error) warnings.push(`${a.source}: convertido como binário (${a.error})`);
  }
  const dec = new TextDecoder();
  for (const a of m.assets) {
    for (const r of a.refs) {
      if (!byId.has(r)) errors.push(`${a.assetId} (${a.source}): referência quebrada para ${r}`);
    }
    for (const u of a.unresolved) warnings.push(`${a.source}: referência externa não resolvida "${u}"`);
    const schema = (SCHEMA_BY_KIND as Record<string, z.ZodTypeAny>)[a.kind];
    if (!schema || a.error) continue;
    const bytes = read(a.main);
    if (!bytes) continue;
    let json: unknown;
    try { json = JSON.parse(dec.decode(bytes)); } catch { errors.push(`${a.main}: JSON inválido`); continue; }
    const res = schema.safeParse(json);
    if (!res.success) { errors.push(...res.error.issues.slice(0, 5).map((i) => `${a.main}: ${i.path.join('.')}: ${i.message}`)); continue; }
    const doc = res.data as { assetId: string; source: string };
    if (doc.assetId !== a.assetId) errors.push(`${a.main}: assetId interno (${doc.assetId}) difere do manifest (${a.assetId})`);
    if (doc.source !== a.source) errors.push(`${a.main}: source interno difere do manifest`);
    const expectKind = (ref: string | null, kind: string, ctx: string) => {
      if (ref === null) return;
      const t = byId.get(ref);
      if (!t) errors.push(`${a.main}: ${ctx} aponta para ${ref}, que não existe`);
      else if (t.kind !== kind) errors.push(`${a.main}: ${ctx} aponta para um asset "${t.kind}", esperado "${kind}"`);
      if (!a.refs.includes(ref)) errors.push(`${a.main}: ${ctx} (${ref}) não está listado em refs do manifest`);
    };
    if (a.kind === 'texture') {
      for (const img of (res.data as TexJson).images) if (!a.files.includes(img.file)) errors.push(`${a.main}: imagem ${img.file} não listada em files`);
    } else if (a.kind === 'font') {
      const f = res.data as FontJson;
      for (const p of f.pages) if (!a.files.includes(p)) errors.push(`${a.main}: página ${p} não listada em files`);
      for (const c of f.chars) {
        if (c.page >= f.pages.length || c.x + c.width > f.common.scaleW || c.y + c.height > f.common.scaleH) {
          errors.push(`${a.main}: glifo ${c.id} fora do atlas`); break;
        }
      }
    } else if (a.kind === 'animation') {
      const an = res.data as AnimJson;
      an.textures.forEach((t, i) => expectKind(t.ref, 'texture', `textures[${i}]`));
      if (an.layout) expectKind(an.layout.ref, 'layout', 'layout');
      for (const t of an.targets) for (const tr of t.tracks) {
        if (tr.group === 'RLTP') for (const k of tr.keys) {
          if (k.value >= an.textures.length) { errors.push(`${a.main}: ${t.name} RLTP usa textura ${k.value} de ${an.textures.length}`); break; }
        }
      }
    } else if (a.kind === 'model') {
      const md = res.data as ModelJson;
      if (!a.files.includes(md.glb)) errors.push(`${a.main}: glb ${md.glb} não listado em files`);
    } else if (a.kind === 'scene') {
      const sc = res.data as SceneJson;
      sc.models.forEach((x, i) => expectKind(x.ref, 'model', `models[${i}]`));
      sc.collision.forEach((x, i) => expectKind(x.ref, 'collision', `collision[${i}]`));
      sc.objects.forEach((x, i) => expectKind(x.model, 'model', `objects[${i}]`));
      sc.data.forEach((x, i) => expectKind(x.ref, 'binary', `data[${i}]`));
    } else if (a.kind === 'layout') {
      const l = res.data as LayoutJson;
      l.textures.forEach((t, i) => expectKind(t.ref, 'texture', `textures[${i}]`));
      l.fonts.forEach((t, i) => expectKind(t.ref, 'font', `fonts[${i}]`));
      l.materialDefs.forEach((m) => m.textureMaps.forEach((t) => {
        if (t.texture >= l.textures.length) errors.push(`${a.main}: material ${m.name} usa textura ${t.texture} de ${l.textures.length}`);
      }));
      const walk = (p: LayoutPaneJson) => {
        const mats = [p.picture?.material, p.text?.material, p.window?.content.material, ...(p.window?.frames.map((f) => f.material) ?? [])];
        for (const m of mats) if (m !== undefined && m >= l.materialDefs.length) errors.push(`${a.main}: painel ${p.name} usa material ${m} de ${l.materialDefs.length}`);
        if (p.text && p.text.font >= l.fonts.length) errors.push(`${a.main}: painel ${p.name} usa fonte ${p.text.font} de ${l.fonts.length}`);
        p.children.forEach(walk);
      };
      if (l.root) walk(l.root);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
