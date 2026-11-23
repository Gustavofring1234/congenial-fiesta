// HUD das partidas em DOM (prefixo sp-): título, placar em texto, dica, aviso grande (banner com tempo), barra de força
// e os layouts NW4R de cada modalidade (gameplay_data.json -> hud) pelo LayoutPlayer, com os textos dos painéis
// trocados pelo jogo (os textos embutidos nos layouts são placeholders em japonês). Lê eventos da partida local ou o
// instantâneo da sala (convidado).
import { LayoutPlayer } from './LayoutPlayer.js';
import { defaultStore } from '../engine/assets/AssetStore.js';

export class SportsHud {
  constructor(container, { store = defaultStore(), layouts = true } = {}) {
    this.store = store;
    this.root = document.createElement('div');
    this.root.className = 'sp-hud';
    this.root.innerHTML = '<div class="sp-hud-layouts"></div><div class="sp-hud-title"></div><pre class="sp-hud-score"></pre>'
      + '<div class="sp-hud-banner" hidden></div><div class="sp-hud-hint"></div><div class="sp-hud-meter" hidden><i></i></div>';
    container.append(this.root);
    this.el = (c) => this.root.querySelector('.sp-hud-' + c);
    this.useLayouts = layouts;
    this.layouts = new Map();   // assetId -> {host, player, ready}
    this.bannerUntil = 0;
    this.lastSeq = 0;
  }

  setTitle(t) { this.el('title').textContent = t || ''; }
  setScore(t) { this.el('score').textContent = t || ''; }
  setHint(t) { this.el('hint').textContent = t || ''; }

  banner(text, seconds = 1.5) {
    const b = this.el('banner');
    b.textContent = text;
    b.hidden = false;
    b.classList.remove('sp-pop');
    void b.offsetWidth;
    b.classList.add('sp-pop');
    this.bannerUntil = performance.now() + seconds * 1000;
  }

  meter(v) {
    const m = this.el('meter');
    m.hidden = v === null || v === undefined;
    if (!m.hidden) m.firstChild.style.width = `${Math.round(v * 100)}%`;
  }

  layout(id, on = true) {
    if (!this.useLayouts) return null;
    let l = this.layouts.get(id);
    if (!on) { if (l) l.host.hidden = true; return l; }
    if (!l) {
      const host = document.createElement('div');
      host.className = 'sp-hud-layout';
      this.el('layouts').append(host);
      const player = new LayoutPlayer(host, { store: this.store });
      l = { host, player, ready: null, pending: [] };
      l.ready = player.load(id).then(() => { const a = player.animationNames.find((n) => /in|start|loop/i.test(n)) || player.animationNames[0]; if (a) player.play(a).catch(() => {}); player.start && player.start(); for (const f of l.pending) f(); l.pending = []; }).catch(() => { host.remove(); });
      this.layouts.set(id, l);
    }
    l.host.hidden = false;
    return l;
  }

  _withLayout(id, f) { const l = this.layout(id); if (!l) return; if (l.player.state) f(l.player); else l.pending.push(() => f(l.player)); }

  onEvent(e) {
    if (e.seq && e.seq <= this.lastSeq) return;
    if (e.seq) this.lastSeq = e.seq;
    switch (e.type) {
      case 'banner': this.banner(e.text, e.seconds); break;
      case 'hint': this.setHint(e.text); break;
      case 'score': this.setScore(e.text); break;
      case 'title': this.setTitle(e.text); break;
      case 'layout': this.layout(e.layout, e.on); break;
      case 'pane': this._withLayout(e.layout, (p) => { try { p.setText(e.pane, e.text); } catch (x) { /* painel ausente */ } }); break;
      case 'visible': this._withLayout(e.layout, (p) => { for (const [k, v] of Object.entries(e.panes)) { try { p.setVisible(k, v); } catch (x) { /* painel ausente */ } } }); break;
      default: break;
    }
  }

  /** Convidado da sala: placar e dica vêm do instantâneo. */
  fromSnapshot(s) {
    if (!s || !s.h) return;
    if (this.el('score').textContent !== s.h[0]) this.setScore(s.h[0]);
    if (this.el('hint').textContent !== s.h[1]) this.setHint(s.h[1]);
  }

  update(activity) {
    if (this.bannerUntil && performance.now() > this.bannerUntil) { this.el('banner').hidden = true; this.bannerUntil = 0; }
    if (activity) this.meter(activity.hud.meter);
  }

  clear() {
    this.setTitle(''); this.setScore(''); this.setHint(''); this.meter(null);
    this.el('banner').hidden = true;
    for (const l of this.layouts.values()) { try { l.player.dispose(); } catch (e) { /* já descartado */ } l.host.remove(); }
    this.layouts.clear();
    this.lastSeq = 0;
  }

  dispose() { this.clear(); this.root.remove(); }
}
