// Menu da máquina de estados (core/SportsStateMachine.js) em DOM: lista navegável por teclado (setas/Enter/Esc), toque,
// mouse e pelas ações do SportsInputBridge (move, confirm, back). Os layouts NW4R do estado ficam atrás do menu.
import { labelOf, State } from '../core/SportsStateMachine.js';
import { LayoutPlayer } from './LayoutPlayer.js';
import { defaultStore } from '../engine/assets/AssetStore.js';
import { CharacterPreview } from './CharacterPreview.js';

export class SportsMenu {
  /**
   * @param {object} [o.builder]  MiiOpponentBuilder para a pré-visualização 3D do editor de personagens
   */
  constructor(container, machine, { store = defaultStore(), layouts = true, builder = null } = {}) {
    this.builder = builder;
    this.preview = null;
    this.inputs = new Map();    // campos de texto mantidos entre redesenhos (não perdem o foco ao digitar)
    this.machine = machine;
    this.store = store;
    this.useLayouts = layouts;
    this.root = document.createElement('div');
    this.root.className = 'sp-menu';
    this.root.setAttribute('role', 'dialog');
    container.append(this.root);
    // os cliques no menu não chegam ao leitor de gestos do jogo (um toque curto lá vira "confirmar" no item focado)
    for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'contextmenu']) this.root.addEventListener(ev, (e) => e.stopPropagation());
    this.bg = document.createElement('div');
    this.bg.className = 'sp-menu-bg';
    container.prepend(this.bg);
    this.focus = 0;
    this.bgPlayers = [];
    this.bgKey = '';
    this.off = machine.on(() => this.render());
    this._moveCooldown = 0;
  }

  render() {
    const m = this.machine.menu, st = this.machine.state;
    this.root.hidden = !m;
    this._background(st);
    this._preview(m);
    if (!m) return;
    if (this._lastMenu !== m) { this.focus = Math.max(0, m.focus ?? 0); this._lastMenu = m; }
    const items = m.items;
    const focused = document.activeElement && this.root.contains(document.activeElement) ? document.activeElement : null;
    this.root.textContent = '';
    this.root.classList.toggle('sp-wide', !!m.wide);
    if (m.preview && this.preview) this.root.append(this.preview.canvas);
    const h = document.createElement('h2'); h.textContent = labelOf(m.title); this.root.append(h);
    const sub = labelOf(m.subtitle);
    if (sub) { const p = document.createElement('p'); p.className = 'sp-menu-sub'; p.textContent = sub; this.root.append(p); }
    const lines = labelOf(m.lines);
    if (lines && lines.length) { const ul = document.createElement('ul'); ul.className = 'sp-menu-lines'; for (const l of lines) { const li = document.createElement('li'); li.textContent = l; ul.append(li); } this.root.append(ul); }
    const list = document.createElement('div'); list.className = 'sp-menu-items';
    items.forEach((it, i) => {
      if (it.text) { list.append(this._textField(it, i)); return; }
      if (it.file) { list.append(this._fileField(it, i)); return; }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp-menu-item' + (i === this.focus ? ' sp-focus' : '');
      b.dataset.id = it.id;
      b.disabled = it.enabled === false;
      b.textContent = (it.adjust ? '‹ ' : '') + labelOf(it.label) + (it.adjust ? ' ›' : '');
      b.onclick = (e) => {
        this.focus = i;
        if (it.adjust) { const r = b.getBoundingClientRect(); it.adjust(e.clientX < r.left + r.width / 2 ? -1 : 1); } else if (it.select) it.select();
      };
      list.append(b);
    });
    this.root.append(list);
    if (focused && focused.tagName === 'INPUT' && this.root.contains(focused)) focused.focus();
    if (st === State.Results && m.newRecord) this.root.classList.add('sp-record'); else this.root.classList.remove('sp-record');
  }

  _textField(it, i) {
    let wrap = this.inputs.get(it.id);
    if (!wrap) {
      wrap = document.createElement('label');
      wrap.className = 'sp-menu-field';
      const span = document.createElement('span');
      const input = document.createElement('input');
      input.type = 'text';
      input.dataset.id = it.id;
      input.autocomplete = 'off';
      input.addEventListener('keydown', (e) => e.stopPropagation()); // as setas/Enter digitam, não navegam no menu
      input.addEventListener('keyup', (e) => e.stopPropagation());
      wrap.append(span, input);
      this.inputs.set(it.id, wrap);
    }
    const [span, input] = wrap.children;
    span.textContent = labelOf(it.label);
    if (it.maxLength) input.maxLength = it.maxLength;
    if (document.activeElement !== input) input.value = labelOf(it.text);
    input.oninput = () => it.onInput(input.value);
    input.onfocus = () => { this.focus = i; };
    wrap.classList.toggle('sp-focus', i === this.focus);
    return wrap;
  }

  _fileField(it, i) {
    const b = document.createElement('label');
    b.className = 'sp-menu-item sp-menu-file' + (i === this.focus ? ' sp-focus' : '');
    b.dataset.id = it.id;
    b.tabIndex = 0;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = it.file;
    input.hidden = true;
    input.onchange = () => { const f = input.files && input.files[0]; if (f) it.onFile(f); };
    b.append(labelOf(it.label), input);
    b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    this._fileInput = input;
    return b;
  }

  _preview(m) {
    const want = m && m.preview && m.preview.kind === 'mii' && this.builder;
    if (!want) { if (this.preview) { this.preview.dispose(); this.preview = null; } return; }
    if (!this.preview) this.preview = new CharacterPreview(this.root, this.builder);
    this.preview.show(m.preview.editor);
  }

  _background(state) {
    if (!this.useLayouts) return;
    const ids = this.machine.menu ? this.machine.layouts(state) : [];
    const key = ids.join(',');
    if (key === this.bgKey) return;
    this.bgKey = key;
    for (const p of this.bgPlayers) p.dispose();
    this.bgPlayers = [];
    this.bg.textContent = '';
    for (const id of ids) {
      const host = document.createElement('div');
      host.className = 'sp-menu-layout';
      this.bg.append(host);
      const p = new LayoutPlayer(host, { store: this.store });
      this.bgPlayers.push(p);
      p.load(id).then(() => { const a = p.animationNames[0]; if (a) p.play(a, { loop: true }).catch(() => {}); }).catch(() => host.remove());
    }
  }

  /** Comandos (teclado, gamepad, gestos). */
  move(dy, dx = 0) {
    const m = this.machine.menu;
    if (!m) return;
    const items = m.items;
    if (dx && items[this.focus] && items[this.focus].adjust) { items[this.focus].adjust(dx); return; }
    if (!dy) return;
    let i = this.focus;
    for (let k = 0; k < items.length; k++) { i = (i + dy + items.length) % items.length; if (items[i].enabled !== false) break; }
    this.focus = i;
    this.render();
  }

  confirm() {
    const m = this.machine.menu;
    if (!m) return;
    const it = m.items[this.focus];
    if (!it || it.enabled === false) return;
    if (it.file) { const el = this.root.querySelector(`[data-id="${it.id}"] input`); if (el) el.click(); return; }
    if (it.text) { const el = this.root.querySelector(`input[data-id="${it.id}"]`); if (el) el.focus(); return; }
    if (it.select) it.select(); else if (it.adjust) it.adjust(1);
  }

  back() { this.machine.back(); }

  /** Analógico/teclas contínuas (poll do bridge). */
  pollMove(move, dt) {
    this._moveCooldown -= dt;
    if (this._moveCooldown > 0) return;
    if (Math.abs(move.y) > 0.6) { this.move(move.y > 0 ? -1 : 1); this._moveCooldown = 0.22; }
    else if (Math.abs(move.x) > 0.6) { this.move(0, move.x > 0 ? 1 : -1); this._moveCooldown = 0.22; }
  }

  dispose() { this.off(); if (this.preview) this.preview.dispose(); for (const p of this.bgPlayers) p.dispose(); this.root.remove(); this.bg.remove(); }
}
