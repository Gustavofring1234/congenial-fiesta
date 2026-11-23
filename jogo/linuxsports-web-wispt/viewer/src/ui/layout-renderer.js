// Renderiza um .layout.json em HTML/CSS + <canvas> e toca .anim.json sobre ele.
//
// Coordenadas NW4R: origem no centro da tela, Y para cima. Cada painel é um "nó" sem tamanho,
// posicionado em relação ao ponto de origem do pai; o retângulo visível é deslocado conforme a
// origem do próprio painel (0..8: coluna = esq/centro/dir, linha = topo/centro/base).
//
// Cor (aproximação do TEV padrão do NW4R com uma textura):
//   cor = lerp(tevColor[0], tevColor[1], textura) × cor de vértice (bilinear) × cor do material
// Texto: o atlas da fonte faz o papel da textura, e a cor de topo/base do texto o da cor de vértice.
import { getJson } from '../engine/assets.js';

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const col = (o) => o % 3;           // 0 esq, 1 centro, 2 dir
const row = (o) => Math.floor(o / 3); // 0 topo, 1 centro, 2 base

export function sampleTrack(track, frame) {
  const k = track.keys;
  if (!k.length) return 0;
  if (frame <= k[0].frame) return k[0].value;
  const last = k[k.length - 1];
  if (frame >= last.frame) return last.value;
  let i = 0;
  while (i + 1 < k.length && k[i + 1].frame <= frame) i++;
  const a = k[i], b = k[i + 1];
  if (track.interpolation === 'step') return a.value;
  const dt = b.frame - a.frame;
  if (dt <= 0) return b.value;
  const t = (frame - a.frame) / dt, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * dt * (a.slope ?? 0)
    + (-2 * t3 + 3 * t2) * b.value + (t3 - t2) * dt * (b.slope ?? 0);
}

/**
 * Estado animável de um layout, sem DOM: { panes: nome -> estado, materials: nome -> estado }.
 * O estado de painel guarda transformação, tamanho, alfa, visibilidade, cores de vértice e materiais.
 */
export function createLayoutState(meta) {
  const materials = new Map();
  meta.materialDefs.forEach((def, i) => {
    materials.set(def.name, {
      index: i, def, panes: new Set(),
      tev: def.tevColors.map((c) => [...c]),
      color: def.color ? [...def.color] : [255, 255, 255, 255],
      texOverride: new Map(), // slot -> objeto de textura (RLTP)
      srt: def.texSrt.map((s) => ({ translate: [...s.translate], rotate: s.rotate, scale: [...s.scale] })),
    });
  });
  const matByIndex = [...materials.values()];
  const panes = new Map();
  const walk = (p) => {
    const s = {
      pane: p,
      t: [...p.translate], r: [...p.rotate], sc: [...p.scale], size: [...p.size],
      alpha: p.alpha, visible: p.visible,
      vtx: (p.picture ?? p.window?.content)?.vertexColors.map((c) => [...c]) ?? null,
      mats: [],
    };
    const matIdx = [p.picture?.material, p.text?.material, p.window?.content.material, ...(p.window?.frames.map((f) => f.material) ?? [])].filter((x) => x !== undefined);
    for (const i of matIdx) { const ms = matByIndex[i]; if (ms) { ms.panes.add(s); s.mats.push(ms); } }
    panes.set(p.name, s);
    p.children.forEach(walk);
  };
  if (meta.root) walk(meta.root);
  return { panes, materials };
}

/**
 * Liga os alvos de um .anim.json ao estado do layout, uma vez só.
 * Alvos sem painel/material correspondente (47 animações citam painéis que não existem no layout,
 * index/anim-missing-targets.json) ficam fora de `bound` e são ignorados em silêncio.
 */
export function bindAnimation(anim, state) {
  const bound = [], missing = [];
  for (const tg of anim?.targets ?? []) {
    const target = (tg.kind === 'material' ? state.materials : state.panes).get(tg.name);
    if (target) bound.push({ tg, target });
    else missing.push(tg.name);
  }
  return { bound, missing };
}

/**
 * Aplica o quadro `frame` ao estado. `animTextures[i]` são as texturas de troca (RLTP).
 * Devolve { moved, dirty }: painéis com transformação alterada e painéis a repintar.
 */
export function applyAnimationFrame(binding, frame, animTextures = []) {
  const dirty = new Set();
  const moved = new Set();
  for (const { tg, target } of binding.bound) {
    if (tg.kind === 'material') {
      const ms = target;
      for (const tr of tg.tracks) {
        const v = sampleTrack(tr, frame);
        const m = /^(\D+?)(\d)?\.([rgba])$/.exec(tr.property);
        if (m) {
          const ch = 'rgba'.indexOf(m[3]);
          if (m[1] === 'tevColor' && m[2] !== undefined) { if (ms.tev[+m[2]]) ms.tev[+m[2]][ch] = v; }
          else if (m[1] !== 'konstColor') ms.color[ch] = v;
        } else if (tr.property === 'textureIndex') {
          ms.texOverride.set(tr.index, animTextures[Math.round(v)] ?? null);
        } else if (ms.srt[tr.index]) {
          const srt = ms.srt[tr.index];
          if (tr.property === 'translateS') srt.translate[0] = v;
          else if (tr.property === 'translateT') srt.translate[1] = v;
          else if (tr.property === 'scaleS') srt.scale[0] = v;
          else if (tr.property === 'scaleT') srt.scale[1] = v;
          else if (tr.property === 'rotate') srt.rotate = v;
        }
      }
      ms.panes.forEach((p) => dirty.add(p));
    } else {
      const s = target;
      for (const tr of tg.tracks) {
        const v = sampleTrack(tr, frame);
        const prop = tr.property;
        const axis = { X: 0, Y: 1, Z: 2 }[prop.slice(-1)];
        if (prop.startsWith('translate')) { if (axis !== undefined) s.t[axis] = v; }
        else if (prop.startsWith('rotate')) { if (axis !== undefined) s.r[axis] = v; }
        else if (prop.startsWith('scale')) { if (axis !== undefined) s.sc[axis] = v; }
        else if (prop === 'width') { s.size[0] = v; dirty.add(s); }
        else if (prop === 'height') { s.size[1] = v; dirty.add(s); }
        else if (prop === 'visible') s.visible = v >= 0.5;
        else if (prop === 'alpha') s.alpha = clamp8(v);
        else if (prop.startsWith('vertexColor') && s.vtx) {
          const corner = { LT: 0, RT: 1, LB: 2, RB: 3 }[prop.slice(11, 13)];
          if (corner !== undefined) { s.vtx[corner]['rgba'.indexOf(prop.slice(-1))] = clamp8(v); dirty.add(s); }
        }
        moved.add(s);
      }
    }
  }
  return { moved, dirty };
}

export class LayoutView {
  constructor(lib, stage) {
    this.lib = lib;
    this.stage = stage;
    this.panes = new Map();     // nome -> estado (createLayoutState) + nó DOM
    this.materials = new Map(); // nome -> estado
    this.anim = null;
    this.binding = { bound: [], missing: [] };
    this.frame = 0;
  }

  async load(asset) {
    this.asset = asset;
    this.meta = await getJson(asset.main);
    const m = this.meta;
    // texturas e fontes em paralelo
    this.textures = await Promise.all(m.textures.map((t) => (t.ref ? this.lib.texture(t.ref).catch(() => null) : null)));
    this.fonts = await Promise.all(m.fonts.map((f) => (f.ref ? this.lib.font(f.ref).catch(() => null) : null)));
    this.build();
  }

  build() {
    const m = this.meta;
    this.stage.innerHTML = '';
    this.stage.style.width = `${m.screen.width}px`;
    this.stage.style.height = `${m.screen.height}px`;
    ({ panes: this.panes, materials: this.materials } = createLayoutState(m));
    const origin = document.createElement('div');
    origin.className = 'node';
    origin.style.transform = m.screen.centered ? `translate(${m.screen.width / 2}px, ${m.screen.height / 2}px)` : '';
    this.stage.append(origin);
    const walk = (p, parentEl) => {
      const s = this.attachPane(this.panes.get(p.name));
      parentEl.append(s.node);
      p.children.forEach((c) => walk(c, s.node));
    };
    if (m.root) walk(m.root, origin);
    for (const s of this.panes.values()) { this.applyTransform(s); this.paint(s); }
  }

  /** Cria o nó DOM (div de posição + retângulo/canvas) do estado de um painel. */
  attachPane(s) {
    const p = s.pane;
    s.node = document.createElement('div');
    s.node.className = 'node';
    s.rect = document.createElement(p.type === 'picture' || p.type === 'text' || p.type === 'window' ? 'canvas' : 'div');
    s.rect.className = `rect ${p.type}`;
    s.rect.title = `${p.type}: ${p.name}`;
    s.node.append(s.rect);
    return s;
  }

  applyTransform(s) {
    const [w, h] = s.size;
    s.node.style.transform = `translate(${s.t[0]}px, ${-s.t[1]}px) rotateX(${s.r[0]}deg) rotateY(${s.r[1]}deg) rotate(${-s.r[2]}deg) scale(${s.sc[0]}, ${s.sc[1]})`;
    s.node.style.display = s.visible ? '' : 'none';
    const o = s.pane.origin;
    s.rect.style.left = `${-[0, 0.5, 1][col(o)] * w}px`;
    s.rect.style.top = `${-[0, 0.5, 1][row(o)] * h}px`;
    s.rect.style.width = `${Math.abs(w)}px`;
    s.rect.style.height = `${Math.abs(h)}px`;
    // influencedAlpha: o alfa do painel afeta os filhos (opacity no nó); senão só o próprio retângulo
    const a = s.alpha / 255;
    if (s.pane.influencedAlpha) { s.node.style.opacity = a; s.rect.style.opacity = ''; }
    else { s.node.style.opacity = ''; s.rect.style.opacity = a; }
  }

  textureFor(ms, slot = 0) {
    if (ms.texOverride.has(slot)) return ms.texOverride.get(slot);
    const map = ms.def.textureMaps[slot];
    return map ? this.textures[map.texture] : null;
  }

  paint(s) {
    const p = s.pane;
    if (!(s.rect instanceof HTMLCanvasElement)) return;
    const W = Math.max(1, Math.round(Math.abs(s.size[0]))), H = Math.max(1, Math.round(Math.abs(s.size[1])));
    if (W * H > 4e6) return;
    const cv = s.rect;
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, W, H);
    if (p.type === 'picture') this.paintQuad(ctx, W, H, p.picture, s.mats[0], s.vtx);
    else if (p.type === 'window') this.paintWindow(ctx, W, H, p.window, s);
    else if (p.type === 'text') this.paintText(ctx, W, H, p.text, s.mats[0]);
  }

  /** Desenha um quad texturizado com UVs e combina as cores (fórmula do cabeçalho). */
  paintQuad(ctx, W, H, quad, ms, vtx, region = [0, 0, W, H], flip = 0) {
    if (!ms) return;
    const tex = this.textureFor(ms, 0);
    const [rx, ry, rw, rh] = region;
    if (rw <= 0 || rh <= 0) return;
    const tmp = new OffscreenCanvas(rw, rh);
    const t = tmp.getContext('2d', { willReadFrequently: true });
    if (tex?.img) {
      const uv = quad?.texCoords[0] ?? [[0, 0], [1, 0], [0, 1], [1, 1]];
      let [u0, v0] = uv[0], [u1, v1] = uv[3];
      const srt = ms.srt[0];
      if (srt) { u0 = u0 * srt.scale[0] + srt.translate[0]; u1 = u1 * srt.scale[0] + srt.translate[0]; v0 = v0 * srt.scale[1] - srt.translate[1]; v1 = v1 * srt.scale[1] - srt.translate[1]; }
      if (flip & 1) [u0, u1] = [u1, u0];
      if (flip & 2) [v0, v1] = [v1, v0];
      const iw = tex.img.naturalWidth, ih = tex.img.naturalHeight;
      const pat = t.createPattern(tex.img, 'repeat');
      const du = (u1 - u0) || 1e-6, dv = (v1 - v0) || 1e-6;
      pat.setTransform(new DOMMatrix().scale(rw / (du * iw), rh / (dv * ih)).translate(-u0 * iw, -v0 * ih));
      t.fillStyle = pat;
      t.fillRect(0, 0, rw, rh);
    } else {
      t.fillStyle = '#fff';
      t.fillRect(0, 0, rw, rh);
    }
    const img = t.getImageData(0, 0, rw, rh);
    const d = img.data;
    const c0 = ms.tev[0], c1 = ms.tev[1], mc = ms.color;
    const hasTex = !!tex?.img;
    const v = vtx ?? [[255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255], [255, 255, 255, 255]];
    for (let y = 0; y < rh; y++) {
      const fy = rh > 1 ? y / (rh - 1) : 0;
      for (let x = 0; x < rw; x++) {
        const fx = rw > 1 ? x / (rw - 1) : 0;
        const i = (y * rw + x) * 4;
        for (let k = 0; k < 4; k++) {
          const vc = (v[0][k] * (1 - fx) + v[1][k] * fx) * (1 - fy) + (v[2][k] * (1 - fx) + v[3][k] * fx) * fy;
          const base = hasTex ? c0[k] + (c1[k] - c0[k]) * d[i + k] / 255 : 255;
          d[i + k] = clamp8(base * (vc / 255) * (mc[k] / 255));
        }
      }
    }
    t.putImageData(img, 0, 0);
    ctx.drawImage(tmp, rx, ry);
  }

  /** Janela: conteúdo no retângulo todo + molduras nos cantos (aproximação). */
  paintWindow(ctx, W, H, win, s) {
    const matsByIdx = [...this.materials.values()];
    this.paintQuad(ctx, W, H, win.content, matsByIdx[win.content.material], s.vtx);
    const frames = win.frames;
    if (!frames.length) return;
    const corner = (fi, flip, x, y) => {
      const f = frames[fi];
      const ms = matsByIdx[f?.material];
      const tex = ms && this.textureFor(ms, 0);
      if (!tex?.img) return;
      const cw = Math.min(tex.img.naturalWidth, W / 2), ch = Math.min(tex.img.naturalHeight, H / 2);
      this.paintQuad(ctx, W, H, null, ms, null, [Math.round(x(cw)), Math.round(y(ch)), Math.round(cw), Math.round(ch)], flip ^ (f.flip ?? 0));
    };
    // 1 moldura: a mesma textura espelhada nos 4 cantos; 4 molduras: uma por canto
    const one = frames.length === 1;
    corner(0, 0, () => 0, () => 0);
    corner(one ? 0 : 1, one ? 1 : 0, (cw) => W - cw, () => 0);
    corner(one ? 0 : 2, one ? 2 : 0, () => 0, (ch) => H - ch);
    corner(one ? 0 : 3, one ? 3 : 0, (cw) => W - cw, (ch) => H - ch);
  }

  paintText(ctx, W, H, tx, ms) {
    const font = this.fonts[tx.font];
    if (!font || !tx.text) return;
    drawText(ctx, W, H, tx, font, ms ? ms.tev : [[0, 0, 0, 0], [255, 255, 255, 255]]);
  }

  // ------------------------------------------------------------ animação
  async setAnimation(asset) {
    this.build(); // volta ao estado original
    this.anim = asset ? await getJson(asset.main) : null;
    this.animTextures = this.anim ? await Promise.all(this.anim.textures.map((t) => (t.ref ? this.lib.texture(t.ref).catch(() => null) : null))) : [];
    this.frame = 0;
    this.binding = bindAnimation(this.anim, { panes: this.panes, materials: this.materials });
    this.missing = this.binding.missing.length;
    this.applyFrame(0);
  }

  applyFrame(frame) {
    if (!this.anim) return;
    this.frame = frame;
    const { moved, dirty } = applyAnimationFrame(this.binding, frame, this.animTextures);
    moved.forEach((s) => this.applyTransform(s));
    dirty.forEach((s) => this.paint(s));
  }
}

/** Desenha texto com o atlas BMFont. tev = [preto, branco] do material. */
export function drawText(ctx, W, H, tx, font, tev) {
  const meta = font.meta;
  const size = meta.info.size || meta.common.lineHeight;
  const sx = tx.fontSize[0] / size, sy = tx.fontSize[1] / size;
  const lineH = meta.common.lineHeight * sy + tx.lineSpace;
  const lines = tx.text.split('\n').map((l) => [...l].filter((ch) => ch.codePointAt(0) >= 0x20));
  const adv = (ch) => {
    const g = font.glyph(ch.codePointAt(0));
    return (g ? g.xadvance : meta.nw4r?.defaultWidth?.charWidth ?? size / 2) * sx + tx.charSpace;
  };
  const widths = lines.map((l) => l.reduce((w, ch) => w + adv(ch), 0));
  const blockW = Math.max(0, ...widths), blockH = lines.length * lineH;
  const ox = [0, (W - blockW) / 2, W - blockW][col(tx.textOrigin)];
  const oy = [0, (H - blockH) / 2, H - blockH][row(tx.textOrigin)];
  const align = tx.alignment === 0 ? col(tx.textOrigin) : tx.alignment - 1; // 0 = segue a origem
  const tmp = new OffscreenCanvas(W, H);
  const t = tmp.getContext('2d', { willReadFrequently: true });
  lines.forEach((l, li) => {
    let x = ox + [0, (blockW - widths[li]) / 2, blockW - widths[li]][Math.max(0, Math.min(2, align))];
    const y = oy + li * lineH;
    for (const ch of l) {
      const g = font.glyph(ch.codePointAt(0));
      if (g && g.width > 0) t.drawImage(font.img, g.x, g.y, g.width, g.height, x + g.xoffset * sx, y + g.yoffset * sy, g.width * sx, g.height * sy);
      x += adv(ch);
    }
  });
  const img = t.getImageData(0, 0, W, H), d = img.data;
  const [top, bottom] = tx.colors;
  const [c0, c1] = tev;
  for (let y = 0; y < H; y++) {
    const fy = H > 1 ? y / (H - 1) : 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] === 0) continue;
      for (let k = 0; k < 4; k++) {
        const tc = top[k] * (1 - fy) + bottom[k] * fy;
        d[i + k] = clamp8((c0[k] + (c1[k] - c0[k]) * d[i + k] / 255) * tc / 255);
      }
    }
  }
  t.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
}
