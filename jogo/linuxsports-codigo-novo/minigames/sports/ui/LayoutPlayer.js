// Player dos 138 layouts NW4R (.layout.json) e das 647 animações 2D (.anim.json) em HTML/CSS + <canvas>.
//
// Coordenadas NW4R: origem no centro da tela, Y para cima. Cada painel é um nó sem tamanho, posicionado em
// relação ao pai; o retângulo visível é deslocado pela origem do painel (0..8: coluna esq/centro/dir,
// linha topo/centro/base). Cor (TEV padrão com uma textura):
//   cor = lerp(tevColor[0], tevColor[1], textura) × cor de vértice (bilinear) × cor do material
// Texto: o atlas BMFont faz o papel da textura; as cores de topo/base do texto, o da cor de vértice.
//
// Resiliência: 47 animações citam painéis/materiais que não existem no layout (UI/ui_manifest.json,
// missingTargets). Esses alvos ficam fora do vínculo e são ignorados em silêncio; textura ou fonte que não
// carrega vira um quadro branco/sem texto, sem exceção. A tela inteira escala para caber no contêiner
// (desktop ou celular, retrato ou paisagem) mantendo a proporção do layout.
import { defaultStore } from '../engine/assets/AssetStore.js';

const UI = 'UI/';
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const col = (o) => o % 3;
const row = (o) => Math.floor(o / 3);

/** Amostra uma trilha de layout: Hermite (slope por quadro) ou degrau. */
export function sampleTrack(track, frame) {
  const k = track.keys;
  if (!k || !k.length) return 0;
  if (frame <= k[0].frame) return k[0].value;
  const last = k[k.length - 1];
  if (frame >= last.frame) return last.value;
  let lo = 0, hi = k.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (k[mid].frame <= frame) lo = mid; else hi = mid; }
  const a = k[lo], b = k[hi];
  if (track.interpolation === 'step') return a.value;
  const dt = b.frame - a.frame;
  if (dt <= 0) return b.value;
  const t = (frame - a.frame) / dt, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * dt * (a.slope ?? 0)
    + (-2 * t3 + 3 * t2) * b.value + (t3 - t2) * dt * (b.slope ?? 0);
}

/** Estado animável de um layout, sem DOM: {panes: nome -> estado, materials: nome -> estado}. */
export function createLayoutState(meta) {
  const materials = new Map();
  (meta.materialDefs || []).forEach((def, i) => {
    materials.set(def.name, {
      index: i, def, panes: new Set(),
      tev: (def.tevColors || [[0, 0, 0, 0], [255, 255, 255, 255]]).map((c) => [...c]),
      color: def.color ? [...def.color] : [255, 255, 255, 255],
      texOverride: new Map(),
      srt: (def.texSrt || []).map((s) => ({ translate: [...s.translate], rotate: s.rotate, scale: [...s.scale] })),
    });
  });
  const matByIndex = [...materials.values()];
  const panes = new Map();
  const walk = (p) => {
    const s = {
      pane: p, t: [...p.translate], r: [...p.rotate], sc: [...p.scale], size: [...p.size],
      alpha: p.alpha, visible: p.visible,
      vtx: (p.picture ?? p.window?.content)?.vertexColors?.map((c) => [...c]) ?? null,
      mats: [], text: p.text?.text ?? null,
    };
    const matIdx = [p.picture?.material, p.text?.material, p.window?.content?.material, ...(p.window?.frames?.map((f) => f.material) ?? [])].filter((x) => x !== undefined);
    for (const i of matIdx) { const ms = matByIndex[i]; if (ms) { ms.panes.add(s); s.mats.push(ms); } }
    panes.set(p.name, s);
    (p.children || []).forEach(walk);
  };
  if (meta.root) walk(meta.root);
  return { panes, materials, matByIndex };
}

/** Liga os alvos de uma animação ao estado. Alvos ausentes vão para `missing` e são ignorados. */
export function bindAnimation(anim, state) {
  const bound = [], missing = [];
  for (const tg of anim?.targets ?? []) {
    const target = (tg.kind === 'material' ? state.materials : state.panes).get(tg.name);
    if (target) bound.push({ tg, target });
    else missing.push(tg.name);
  }
  return { bound, missing };
}

/** Aplica o quadro ao estado. Devolve {moved, dirty} (painéis com transformação nova / a repintar). */
export function applyAnimationFrame(binding, frame, animTextures = []) {
  const dirty = new Set(), moved = new Set();
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
          ms.texOverride.set(tr.index ?? 0, animTextures[Math.round(v)] ?? null);
        } else if (ms.srt[tr.index ?? 0]) {
          const srt = ms.srt[tr.index ?? 0];
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

/** Lê uma fonte BMFont-JSON: {meta, img, glyph(codePoint)}. */
export async function loadFont(store, path) {
  const meta = await store.json(UI + path);
  const img = await store.image(UI + meta.pages[0]);
  const map = new Map(meta.chars.map((c) => [c.id, c]));
  const alt = meta.nw4r?.alterCharIndex;
  return { meta, img, glyph: (cp) => map.get(cp) || (alt !== undefined ? meta.chars[alt] : null) || null };
}

async function loadTex(store, png) {
  if (!png) return null;
  try { const img = await store.image(UI + png); return { img, width: img.width, height: img.height }; } catch (e) { return null; }
}

function canvas2d(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

export class LayoutPlayer {
  /**
   * @param {HTMLElement} container  onde a tela do layout aparece (escala para caber)
   * @param {object} [o] { store, fit: 'contain' | 'none' }
   */
  constructor(container, { store = defaultStore(), fit = 'contain' } = {}) {
    this.store = store;
    this.container = container;
    this.fit = fit;
    this.stage = document.createElement('div');
    this.stage.className = 'sp-lyt-stage';
    container.classList.add('sp-lyt-host');
    container.append(this.stage);
    this.state = null;
    this.entry = null;
    this.anims = new Map();      // nome -> {entry, anim, textures, binding}
    this.playing = [];           // [{a, frame, loop, speed, done}]
    this.raf = 0;
    this.last = 0;
    if (fit === 'contain' && typeof ResizeObserver === 'function') {
      this.resizer = new ResizeObserver(() => this.layoutFit());
      this.resizer.observe(container);
    }
  }

  static async manifest(store = defaultStore()) { return store.json(UI + 'ui_manifest.json'); }

  /** Nomes dos layouts disponíveis. */
  static async list(store = defaultStore()) { return (await LayoutPlayer.manifest(store)).layouts.map((l) => l.name); }

  /** Carrega um layout por nome (ex.: 'sportsTop_00') ou assetId e monta o DOM. */
  async load(nameOrId) {
    const man = await LayoutPlayer.manifest(this.store);
    const entry = man.layouts.find((l) => l.name === nameOrId || l.assetId === nameOrId);
    if (!entry) throw new Error(`layout não encontrado: ${nameOrId}`);
    this.entry = entry;
    this.meta = await this.store.json(UI + entry.file);
    this.textures = await Promise.all(entry.textures.map((t) => loadTex(this.store, t.png)));
    this.fonts = await Promise.all(entry.fonts.map((f) => (f.font ? loadFont(this.store, f.font).catch(() => null) : null)));
    this.anims.clear();
    this.playing = [];
    this.build();
    return this;
  }

  /** Nomes das animações deste layout. */
  get animationNames() { return this.entry ? this.entry.animations.map((a) => a.name) : []; }

  build() {
    const m = this.meta;
    this.stage.textContent = '';
    this.stage.style.width = `${m.screen.width}px`;
    this.stage.style.height = `${m.screen.height}px`;
    this.state = createLayoutState(m);
    const origin = document.createElement('div');
    origin.className = 'sp-lyt-node';
    origin.style.transform = m.screen.centered !== false ? `translate(${m.screen.width / 2}px, ${m.screen.height / 2}px)` : '';
    this.stage.append(origin);
    const walk = (p, parentEl) => {
      const s = this.attachPane(this.state.panes.get(p.name));
      parentEl.append(s.node);
      (p.children || []).forEach((c) => walk(c, s.node));
    };
    if (m.root) walk(m.root, origin);
    for (const s of this.state.panes.values()) { this.applyTransform(s); this.paint(s); }
    this.layoutFit();
  }

  layoutFit() {
    if (this.fit !== 'contain' || !this.meta) return;
    const W = this.meta.screen.width, H = this.meta.screen.height;
    const cw = this.container.clientWidth || W, ch = this.container.clientHeight || H;
    const k = Math.min(cw / W, ch / H);
    this.stage.style.transform = `translate(${(cw - W * k) / 2}px, ${(ch - H * k) / 2}px) scale(${k})`;
  }

  attachPane(s) {
    const p = s.pane;
    s.node = document.createElement('div');
    s.node.className = 'sp-lyt-node';
    s.node.dataset.pane = p.name;
    const drawn = p.type === 'picture' || p.type === 'text' || p.type === 'window';
    s.rect = document.createElement(drawn ? 'canvas' : 'div');
    s.rect.className = `sp-lyt-rect sp-lyt-${p.type}`;
    s.node.append(s.rect);
    return s;
  }

  applyTransform(s) {
    const [w, h] = s.size;
    s.node.style.transform = `translate(${s.t[0]}px, ${-s.t[1]}px) rotateX(${s.r[0]}deg) rotateY(${s.r[1]}deg) rotate(${-s.r[2]}deg) scale(${s.sc[0]}, ${s.sc[1]})`;
    s.node.style.display = s.visible ? '' : 'none';
    const o = s.pane.origin ?? 4;
    s.rect.style.left = `${-[0, 0.5, 1][col(o)] * w}px`;
    s.rect.style.top = `${-[0, 0.5, 1][row(o)] * h}px`;
    s.rect.style.width = `${Math.abs(w)}px`;
    s.rect.style.height = `${Math.abs(h)}px`;
    const a = s.alpha / 255;
    if (s.pane.influencedAlpha) { s.node.style.opacity = a; s.rect.style.opacity = ''; }
    else { s.node.style.opacity = ''; s.rect.style.opacity = a; }
  }

  textureFor(ms, slot = 0) {
    if (ms.texOverride.has(slot)) return ms.texOverride.get(slot);
    const map = ms.def.textureMaps?.[slot];
    return map ? this.textures[map.texture] : null;
  }

  paint(s) {
    const p = s.pane;
    if (typeof HTMLCanvasElement === 'undefined' || !(s.rect instanceof HTMLCanvasElement)) return;
    const W = Math.max(1, Math.round(Math.abs(s.size[0]))), H = Math.max(1, Math.round(Math.abs(s.size[1])));
    if (W * H > 4e6) return;
    const cv = s.rect;
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, W, H);
    if (p.type === 'picture') this.paintQuad(ctx, W, H, p.picture, s.mats[0], s.vtx);
    else if (p.type === 'window') this.paintWindow(ctx, W, H, p.window, s);
    else if (p.type === 'text') this.paintText(ctx, W, H, p.text, s.mats[0], s.text);
  }

  paintQuad(ctx, W, H, quad, ms, vtx, region = [0, 0, W, H], flip = 0) {
    if (!ms) return;
    const tex = this.textureFor(ms, 0);
    const [rx, ry, rw, rh] = region;
    if (rw <= 0 || rh <= 0) return;
    const tmp = canvas2d(rw, rh);
    const t = tmp.getContext('2d', { willReadFrequently: true });
    if (tex?.img) {
      const uv = quad?.texCoords?.[0] ?? [[0, 0], [1, 0], [0, 1], [1, 1]];
      let [u0, v0] = uv[0], [u1, v1] = uv[3];
      const srt = ms.srt[0];
      if (srt) { u0 = u0 * srt.scale[0] + srt.translate[0]; u1 = u1 * srt.scale[0] + srt.translate[0]; v0 = v0 * srt.scale[1] - srt.translate[1]; v1 = v1 * srt.scale[1] - srt.translate[1]; }
      if (flip & 1) [u0, u1] = [u1, u0];
      if (flip & 2) [v0, v1] = [v1, v0];
      const pat = t.createPattern(tex.img, 'repeat');
      const du = (u1 - u0) || 1e-6, dv = (v1 - v0) || 1e-6;
      pat.setTransform(new DOMMatrix().scale(rw / (du * tex.width), rh / (dv * tex.height)).translate(-u0 * tex.width, -v0 * tex.height));
      t.fillStyle = pat;
    } else t.fillStyle = '#fff';
    t.fillRect(0, 0, rw, rh);
    const img = t.getImageData(0, 0, rw, rh);
    const d = img.data;
    const c0 = ms.tev[0], c1 = ms.tev[1] || [255, 255, 255, 255], mc = ms.color;
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

  paintWindow(ctx, W, H, win, s) {
    const mats = this.state.matByIndex;
    this.paintQuad(ctx, W, H, win.content, mats[win.content.material], s.vtx);
    const frames = win.frames || [];
    if (!frames.length) return;
    const corner = (fi, flip, x, y) => {
      const f = frames[fi];
      const ms = mats[f?.material];
      const tex = ms && this.textureFor(ms, 0);
      if (!tex?.img) return;
      const cw = Math.min(tex.width, W / 2), ch = Math.min(tex.height, H / 2);
      this.paintQuad(ctx, W, H, null, ms, null, [Math.round(x(cw)), Math.round(y(ch)), Math.round(cw), Math.round(ch)], flip ^ (f.flip ?? 0));
    };
    const one = frames.length === 1;
    corner(0, 0, () => 0, () => 0);
    corner(one ? 0 : 1, one ? 1 : 0, (cw) => W - cw, () => 0);
    corner(one ? 0 : 2, one ? 2 : 0, () => 0, (ch) => H - ch);
    corner(one ? 0 : 3, one ? 3 : 0, (cw) => W - cw, (ch) => H - ch);
  }

  paintText(ctx, W, H, tx, ms, text) {
    const font = this.fonts[tx.font];
    if (!font || !text) return;
    drawText(ctx, W, H, { ...tx, text }, font, ms ? ms.tev : [[0, 0, 0, 0], [255, 255, 255, 255]]);
  }

  /** Troca o texto de um painel de texto (ex.: mensagem do TextManager no idioma do WEBC). */
  setText(paneName, text) {
    const s = this.state?.panes.get(paneName);
    if (!s || s.pane.type !== 'text') return false;
    s.text = String(text ?? '');
    this.paint(s);
    return true;
  }

  setVisible(paneName, visible) {
    const s = this.state?.panes.get(paneName);
    if (!s) return false;
    s.visible = !!visible;
    this.applyTransform(s);
    return true;
  }

  // ------------------------------------------------------------ animação
  async prepare(name) {
    if (this.anims.has(name)) return this.anims.get(name);
    const entry = this.entry?.animations.find((a) => a.name === name || a.assetId === name);
    if (!entry) return null;
    const anim = await this.store.json(UI + entry.file);
    const textures = await Promise.all((entry.textures || []).map((p) => loadTex(this.store, p)));
    const binding = bindAnimation(anim, this.state);
    const a = { entry, anim, textures, binding, frames: anim.frameSize ?? entry.frames ?? 0 };
    this.anims.set(name, a);
    return a;
  }

  /**
   * Toca uma animação do layout. Animação inexistente resolve null sem erro (layouts de outra versão).
   * @param {object} [o] { loop: padrão do arquivo, speed: 1, from: 0, onEnd }
   */
  async play(name, { loop, speed = 1, from = 0, onEnd = null } = {}) {
    const a = await this.prepare(name);
    if (!a) return null;
    this.playing = this.playing.filter((p) => p.a !== a);
    const p = { a, frame: from, loop: loop ?? !!a.anim.loop, speed, onEnd, done: false };
    this.playing.push(p);
    this.applyFrame(a, from);
    this.start();
    return p;
  }

  stop(name) {
    this.playing = name ? this.playing.filter((p) => p.a.entry.name !== name) : [];
    if (!this.playing.length) this.halt();
  }

  applyFrame(a, frame) {
    const { moved, dirty } = applyAnimationFrame(a.binding, frame, a.textures);
    moved.forEach((s) => this.applyTransform(s));
    dirty.forEach((s) => this.paint(s));
  }

  /** Avança dt segundos (a 60 quadros/s). Use este ou o laço interno (start). */
  update(dt) {
    for (const p of this.playing) {
      if (p.done) continue;
      p.frame += dt * 60 * p.speed;
      const n = p.a.frames;
      if (n > 0 && p.frame >= n) {
        if (p.loop) p.frame %= n;
        else { p.frame = n; p.done = true; }
      }
      this.applyFrame(p.a, p.frame);
      if (p.done && p.onEnd) p.onEnd();
    }
    this.playing = this.playing.filter((p) => !p.done);
  }

  start() {
    if (this.raf || typeof requestAnimationFrame !== 'function') return;
    this.last = performance.now();
    const step = (now) => {
      this.update(Math.min(0.1, (now - this.last) / 1000));
      this.last = now;
      this.raf = this.playing.length ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }

  halt() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  dispose() {
    this.halt();
    this.resizer?.disconnect();
    this.stage.remove();
  }
}

/** Desenha texto com o atlas BMFont. tev = [preto, branco] do material. */
export function drawText(ctx, W, H, tx, font, tev) {
  const meta = font.meta;
  const size = meta.info.size || meta.common.lineHeight;
  const sx = tx.fontSize[0] / size, sy = tx.fontSize[1] / size;
  const lineH = meta.common.lineHeight * sy + (tx.lineSpace || 0);
  const lines = tx.text.split('\n').map((l) => [...l].filter((ch) => ch.codePointAt(0) >= 0x20));
  const adv = (ch) => {
    const g = font.glyph(ch.codePointAt(0));
    return (g ? g.xadvance : meta.nw4r?.defaultWidth?.charWidth ?? size / 2) * sx + (tx.charSpace || 0);
  };
  const widths = lines.map((l) => l.reduce((w, ch) => w + adv(ch), 0));
  const blockW = Math.max(0, ...widths), blockH = lines.length * lineH;
  const to = tx.textOrigin ?? 4;
  const ox = [0, (W - blockW) / 2, W - blockW][col(to)];
  const oy = [0, (H - blockH) / 2, H - blockH][row(to)];
  const align = !tx.alignment ? col(to) : tx.alignment - 1;
  const tmp = canvas2d(W, H);
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
  const [top, bottom] = tx.colors || [[255, 255, 255, 255], [255, 255, 255, 255]];
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
