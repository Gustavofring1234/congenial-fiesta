import { Lib, el, fmtBytes, getJson, short, url } from './engine/assets.js';
import { LayoutView, drawText } from './ui/layout-renderer.js';

const $ = (id) => document.getElementById(id);
const status = (t) => { $('status').textContent = t; };

let lib;
const inited = new Set();

async function main() {
  try {
    lib = await Lib.load();
  } catch (e) {
    status('erro');
    document.querySelector('main').prepend(el('div', { class: 'notice' },
      'Não foi possível ler ../manifest.json. Sirva a pasta linuxsports-web por HTTP (ex.: ',
      el('code', {}, 'python3 -m http.server -d linuxsports-web 8080'), ') e abra /viewer/. ', String(e.message ?? e)));
    return;
  }
  const counts = {};
  for (const a of lib.manifest.assets) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
  status(`${lib.manifest.assets.length} assets · ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')}`);
  addEventListener('hashchange', route);
  route();
}

function route() {
  const tab = (location.hash.slice(1) || 'telas').split('/')[0];
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${tab}`));
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  if (!inited.has(tab)) { inited.add(tab); ({ telas: initLayouts, cenas: initScenes, modelos: initModels, texturas: initTextures, fontes: initFonts, textos: initTexts, inventario: initInventory })[tab]?.(); }
}

/** Lista lateral agrupada pela pasta do contêiner. */
function fillList(ul, items, { group, label, sub, onPick, filterInput }) {
  const render = () => {
    const q = filterInput?.value.toLowerCase() ?? '';
    ul.innerHTML = '';
    let last = null;
    for (const it of items) {
      if (q && !`${label(it)} ${sub?.(it) ?? ''} ${group(it)}`.toLowerCase().includes(q)) continue;
      const g = group(it);
      if (g !== last) { ul.append(el('li', { class: 'group' }, g)); last = g; }
      const li = el('li', { onclick: () => { ul.querySelectorAll('.active').forEach((x) => x.classList.remove('active')); li.classList.add('active'); onPick(it); } },
        label(it), sub ? el('span', { class: 'sub' }, sub(it)) : null);
      ul.append(li);
    }
  };
  filterInput?.addEventListener('input', render);
  render();
}

const containerOf = (src) => {
  const m = /([^/]+\.(?:carc|arc\.d))\//.exec(src);
  const sport = /(?:minigames|maps|effects)\/([^/]+)/.exec(src)?.[1] ?? /shared\/([^/]+)/.exec(src)?.[1] ?? '';
  return `${sport} · ${m ? m[1] : ''}`;
};

// ------------------------------------------------------------------ Telas (layouts)
function initLayouts() {
  const view = new LayoutView(lib, $('layout-stage'));
  let playing = false, raf = 0, last = 0, animMeta = null;
  const layouts = lib.of('layout').sort((a, b) => a.source.localeCompare(b.source));
  const frameInput = $('anim-frame');

  const stop = () => { playing = false; cancelAnimationFrame(raf); $('anim-play').textContent = '▶ tocar'; };
  const loop = (t) => {
    if (!playing || !animMeta) return;
    const dt = last ? (t - last) / 1000 : 0;
    last = t;
    let f = view.frame + dt * 60;
    if (f > animMeta.frameSize) f = animMeta.loop ? f % Math.max(1, animMeta.frameSize) : (stop(), animMeta.frameSize);
    view.applyFrame(f);
    frameInput.value = f;
    $('anim-info').textContent = `quadro ${f.toFixed(0)} / ${animMeta.frameSize}${animMeta.loop ? ' (loop)' : ''}`;
    raf = requestAnimationFrame(loop);
  };

  $('anim-play').onclick = () => {
    if (!animMeta) return;
    if (playing) return stop();
    playing = true; last = 0;
    $('anim-play').textContent = '❚❚ pausar';
    raf = requestAnimationFrame(loop);
  };
  frameInput.oninput = () => { stop(); view.applyFrame(+frameInput.value); $('anim-info').textContent = `quadro ${(+frameInput.value).toFixed(0)} / ${animMeta?.frameSize ?? 0}`; };
  $('show-bounds').onchange = (e) => $('layout-stage').classList.toggle('bounds', e.target.checked);
  $('layout-zoom').oninput = (e) => { $('layout-stage').style.transform = `scale(${e.target.value})`; };

  $('anim-select').onchange = async (e) => {
    stop();
    const a = lib.byId.get(e.target.value);
    await view.setAnimation(a ?? null);
    animMeta = view.anim;
    frameInput.max = animMeta?.frameSize ?? 0;
    frameInput.value = 0;
    $('anim-info').textContent = animMeta
      ? `${animMeta.frameSize} quadros${animMeta.loop ? ', loop' : ''}${view.missing ? ` · ${view.missing} alvo(s) não existem neste layout (ignorados)` : ''}`
      : '';
  };

  fillList($('layout-list'), layouts, {
    group: (a) => containerOf(a.source),
    label: (a) => short(a.source),
    filterInput: $('layout-filter'),
    onPick: async (a) => {
      stop();
      status(`carregando ${short(a.source)}…`);
      await view.load(a);
      animMeta = null;
      const anims = (lib.layoutAnims[a.assetId] ?? []).map((id) => lib.byId.get(id)).sort((x, y) => x.source.localeCompare(y.source));
      $('anim-select').innerHTML = '';
      $('anim-select').append(el('option', { value: '' }, `(sem animação) — ${anims.length} disponíveis`), ...anims.map((x) => el('option', { value: x.assetId }, short(x.source))));
      $('anim-info').textContent = '';
      showLayoutDetails(a, view.meta, anims);
      status(`${short(a.source)} · ${view.meta.panes.length} painéis`);
    },
  });
}

function showLayoutDetails(a, m, anims) {
  const counts = {};
  const walk = (p) => { counts[p.type] = (counts[p.type] ?? 0) + 1; p.children.forEach(walk); };
  if (m.root) walk(m.root);
  const ref = (r) => (r.ref ? el('span', {}, r.name) : el('span', { style: 'color:var(--bad)' }, `${r.name} (não encontrado)`));
  $('layout-details').replaceChildren(
    el('h3', {}, a.source),
    el('table', { class: 'kv' },
      el('tr', {}, el('td', {}, 'tela'), el('td', {}, `${m.screen.width}×${m.screen.height}`)),
      el('tr', {}, el('td', {}, 'painéis'), el('td', {}, Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '))),
      el('tr', {}, el('td', {}, 'materiais'), el('td', {}, String(m.materialDefs.length))),
      el('tr', {}, el('td', {}, 'texturas'), el('td', {}, ...m.textures.flatMap((t, i) => [i ? ', ' : '', ref(t)]))),
      el('tr', {}, el('td', {}, 'fontes'), el('td', {}, ...m.fonts.flatMap((t, i) => [i ? ', ' : '', ref(t)]))),
      el('tr', {}, el('td', {}, 'animações'), el('td', {}, String(anims.length))),
      el('tr', {}, el('td', {}, 'grupos'), el('td', {}, m.groups.map((g) => g.name).join(', ') || '—')),
    ),
    el('p', { class: 'muted' }, 'Aproximações: estágios TEV customizados, molduras de janela (só os cantos) e gradiente de texto por painel inteiro.'),
  );
}

// ------------------------------------------------------------------ Cenas 3D
async function initScenes() {
  const { Viewer3D } = await import('./engine/scene-viewer.js');
  const v = new Viewer3D($('scene-canvas'));
  ['models', 'collision', 'objects'].forEach((k) => { $(`show-${k}`).onchange = (e) => v.setVisible(k, e.target.checked); });
  const scenes = lib.of('scene').sort((a, b) => a.source.localeCompare(b.source));
  fillList($('scene-list'), scenes, {
    group: (a) => a.source.split('/')[a.source.startsWith('assets/maps') ? 2 : 2] ?? '',
    label: (a) => short(a.source),
    sub: (a) => a.source.split('/').slice(0, -1).join('/'),
    onPick: async (a) => {
      status(`carregando ${short(a.source)}…`);
      const sj = await getJson(a.main);
      const models = await Promise.all(sj.models.filter((m) => m.ref).map(async (m) => (await getJson(lib.byId.get(m.ref).main)).glb));
      const collision = sj.collision.filter((c) => c.ref).map((c) => lib.byId.get(c.ref).main);
      ['models', 'collision', 'objects'].forEach((k) => v.setVisible(k, $(`show-${k}`).checked));
      const errors = await v.show({ models, collision, objects: sj.objects });
      $('scene-info').textContent = `${models.length} modelos · ${collision.length} colisão · ${sj.objects.length} objetos`;
      const types = {};
      sj.objects.forEach((o) => { types[o.typeId] = (types[o.typeId] ?? 0) + 1; });
      $('scene-details').replaceChildren(
        el('h3', {}, `${a.source} (${sj.sport})`),
        el('table', { class: 'kv' },
          el('tr', {}, el('td', {}, 'modelos'), el('td', {}, sj.models.map((m) => m.name).join(', ') || '—')),
          el('tr', {}, el('td', {}, 'colisão'), el('td', {}, sj.collision.map((c) => c.name).join(', ') || '—')),
          el('tr', {}, el('td', {}, 'objetos (.pmp)'), el('td', {}, sj.objects.length ? `${sj.objects.length} — por tipo: ${Object.entries(types).map(([t, n]) => `#${t}: ${n}`).join(', ')}. O .pmp guarda só o id do tipo; sem a tabela id→modelo (no executável) eles aparecem como caixas coloridas.` : '—')),
          el('tr', {}, el('td', {}, 'dados sem conversor'), el('td', {}, sj.data.length ? sj.data.map((d) => `${d.name} (${d.role})`).join(', ') : '—')),
        ),
        errors.length ? el('p', { style: 'color:var(--bad)' }, errors.join('; ')) : '',
        el('p', { class: 'muted' }, 'Modelos na pose de repouso, só com a 1ª camada de textura; luzes, lightmaps e animações 3D ainda não convertidos (ver Inventário).'),
      );
      status(short(a.source));
    },
  });
}

// ------------------------------------------------------------------ Modelos
async function initModels() {
  const { Viewer3D } = await import('./engine/scene-viewer.js');
  const v = new Viewer3D($('model-canvas'));
  const models = lib.of('model').sort((a, b) => a.source.localeCompare(b.source));
  fillList($('model-list'), models, {
    group: (a) => containerOf(a.source),
    label: (a) => a.source.split('/').slice(-1)[0],
    sub: (a) => short(a.source.split('/').slice(0, -1).join('/')),
    filterInput: $('model-filter'),
    onPick: async (a) => {
      const mj = await getJson(a.main);
      await v.show({ models: [mj.glb] });
      const byType = {};
      mj.animations.forEach((x) => (byType[x.type] ??= []).push(x.name));
      $('model-details').replaceChildren(
        el('h3', {}, `${mj.model}`),
        el('table', { class: 'kv' },
          el('tr', {}, el('td', {}, '.brres'), el('td', {}, mj.brres)),
          el('tr', {}, el('td', {}, '.glb'), el('td', {}, el('a', { href: url(mj.glb), download: '' }, mj.glb))),
          el('tr', {}, el('td', {}, 'materiais'), el('td', {}, ...(mj.materials ?? []).map((m) => el('div', {},
            el('strong', {}, m.name), m.translucent ? ' (translúcido)' : '', ': ',
            m.layers.length ? m.layers.map((l, i) => `${i}:${l.texture ?? '—'}${lib.aliases[`${mj.brres}#${l.texture}`] ? ` (${short(lib.aliases[`${mj.brres}#${l.texture}`])})` : ''}`).join(', ') : 'sem textura',
            el('span', { class: 'muted' }, ` · ${m.objects.length} polígono(s)`))))),
          el('tr', {}, el('td', {}, 'texturas sem uso'), el('td', {}, mj.textures.filter((t) => !t.materials?.length).map((t) => t.name).join(', ') || '—')),
          el('tr', {}, el('td', {}, 'animações 3D'), el('td', {}, mj.animations.length ? Object.entries(byType).map(([k, list]) => `${k}: ${list.join(', ')}`).join(' · ') + ' — ainda não convertidas (ver Inventário, .brres)' : '—')),
        ),
      );
    },
  });
}

// ------------------------------------------------------------------ Texturas
async function initTextures() {
  const texs = lib.of('texture').sort((a, b) => a.source.localeCompare(b.source));
  const metas = await Promise.all(texs.map((a) => getJson(a.main)));
  const items = texs.map((a, i) => ({ a, m: metas[i], alias: lib.aliases[a.assetId] ?? '' }));
  const render = () => {
    const q = $('tex-filter').value.toLowerCase();
    const list = items.filter((x) => !q || `${x.a.source} ${x.alias} ${x.m.images[0].format}`.toLowerCase().includes(q));
    $('tex-count').textContent = `${list.length} de ${items.length}`;
    $('tex-grid').replaceChildren(...list.slice(0, 400).map((x) => el('div', { class: 'tile', title: x.a.source },
      el('div', { class: 'img' }, el('img', { src: url(x.m.images[0].file), loading: 'lazy', alt: '' })),
      el('div', { class: 'name' }, short(x.a.source)),
      x.alias ? el('div', { class: 'alias' }, short(x.alias)) : null,
      el('div', { class: 'muted' }, `${x.m.images[0].width}×${x.m.images[0].height} · ${x.m.images[0].format}`))));
    if (list.length > 400) $('tex-grid').append(el('div', { class: 'muted' }, `… mais ${list.length - 400}; refine o filtro.`));
  };
  $('tex-filter').oninput = render;
  render();
}

// ------------------------------------------------------------------ Fontes
async function initFonts() {
  const fonts = await Promise.all(lib.of('font').map((a) => lib.font(a.assetId)));
  const render = () => {
    const text = $('font-text').value;
    $('font-list').replaceChildren(...fonts.map((f) => {
      const tx = { text, fontSize: [f.meta.info.size, f.meta.info.size], lineSpace: 0, charSpace: 0, textOrigin: 4, alignment: 0, colors: [[255, 255, 255, 255], [255, 255, 255, 255]] };
      const cv = el('canvas', { width: 900, height: Math.ceil(f.meta.common.lineHeight * 1.6) });
      drawText(cv.getContext('2d'), cv.width, cv.height, tx, f, [[0, 0, 0, 0], [255, 255, 255, 255]]);
      return el('div', { class: 'font-card' },
        el('strong', {}, short(f.asset.source)), ' ',
        el('span', { class: 'muted' }, `${f.meta.chars.length} glifos · linha ${f.meta.common.lineHeight}px · ${f.meta.nw4r?.sheetFormat ?? ''} · usada por ${lib.of('layout').filter((l) => l.refs.includes(f.asset.assetId)).length} layouts`),
        el('div', {}, cv), el('img', { class: 'atlas', src: url(f.meta.pages[0]), alt: 'atlas' }));
    }));
  };
  $('font-text').oninput = render;
  render();
}

// ------------------------------------------------------------------ Textos (.bmg)
async function initTexts() {
  const { TextManager } = await import('./ui/TextManager.js');
  const tm = await TextManager.load();
  const files = [...tm.files.keys()];
  $('text-file').append(...files.map((f) => el('option', { value: f }, f)));
  const render = () => {
    const list = tm.search($('text-filter').value, { file: $('text-file').value || null, limit: 500 });
    $('text-count').textContent = `${list.length}${list.length === 500 ? '+' : ''} mensagens`;
    $('text-table').replaceChildren(el('table', { class: 'table' },
      el('tr', {}, ...['arquivo', 'id', 'índice', 'texto', 'argumentos'].map((h) => el('th', {}, h))),
      ...list.map((m) => el('tr', {}, el('td', {}, m.file), el('td', {}, el('code', {}, `0x${m.id.toString(16)}`)), el('td', {}, String(m.index)),
        el('td', { style: 'white-space:pre-wrap' }, m.text || el('span', { class: 'muted' }, '(vazio)')), el('td', {}, (m.args ?? []).join(', '))))));
  };
  $('text-filter').oninput = render;
  $('text-file').onchange = render;
  render();
}

// ------------------------------------------------------------------ Inventário
async function initInventory() {
  const [formats, inventory, codeRefs] = await Promise.all([getJson('index/formats.json'), getJson('index/inventory.json'), getJson('index/code-refs.json').catch(() => [])]);
  const badge = (s) => el('span', { class: `badge ${s}` }, { convertido: 'convertido', parcial: 'parcial', 'nao-convertido': 'não convertido', referencia: 'referência' }[s] ?? s);

  const rows = Object.entries(formats).sort((a, b) => b[1].count - a[1].count);
  $('format-table').replaceChildren(el('table', { class: 'table' },
    el('tr', {}, ...['ext', 'arquivos', 'formato', 'situação', 'o que é', 'saída na pasta web', 'como completar a conversão'].map((h) => el('th', {}, h))),
    ...rows.map(([e, f]) => el('tr', {}, el('td', {}, el('code', {}, e || '—')), el('td', {}, String(f.count)), el('td', {}, f.name), el('td', {}, badge(f.status)), el('td', {}, f.what), el('td', {}, f.output), el('td', {}, f.howToConvert || '—')))));

  const renderRefs = () => {
    const q = $('coderef-filter').value.toLowerCase();
    const list = codeRefs.filter((c) => !q || c.string.toLowerCase().includes(q));
    $('coderef-table').replaceChildren(el('table', { class: 'table' },
      el('tr', {}, el('th', {}, 'string no código'), el('th', {}, 'assets')),
      ...list.slice(0, 300).map((c) => el('tr', {}, el('td', {}, el('code', {}, c.string)),
        el('td', {}, c.assets.length ? c.assets.slice(0, 6).map((id) => short(lib.byId.get(id)?.source ?? id)).join(', ') + (c.assets.length > 6 ? ` (+${c.assets.length - 6})` : '') : el('span', { style: 'color:var(--bad)' }, 'não está no projeto'))))),
    el('p', { class: 'muted' }, `${codeRefs.filter((c) => c.assets.length).length} de ${codeRefs.length} resolvidos${list.length > 300 ? ' · mostrando 300; refine o filtro' : ''}`));
  };
  $('coderef-filter').oninput = renderRefs;
  renderRefs();

  const statuses = [...new Set(inventory.map((i) => i.status))];
  $('inv-status').append(...statuses.map((s) => el('option', { value: s }, s)));
  const renderInv = () => {
    const q = $('inv-filter').value.toLowerCase(), s = $('inv-status').value;
    const list = inventory.filter((i) => (!q || i.path.toLowerCase().includes(q)) && (!s || i.status === s));
    $('inv-count').textContent = `${list.length} de ${inventory.length} arquivos`;
    $('inv-table').replaceChildren(el('table', { class: 'table' },
      el('tr', {}, ...['arquivo no jogo', 'tamanho', 'situação', 'tipo', 'na pasta web'].map((h) => el('th', {}, h))),
      ...list.slice(0, 500).map((i) => el('tr', {}, el('td', {}, el('code', {}, i.path)), el('td', {}, fmtBytes(i.bytes)), el('td', {}, badge(i.status)), el('td', {}, i.kind ?? '—'),
        el('td', {}, i.output ? el('a', { href: url(i.output), target: '_blank' }, short(i.output)) : '—')))));
    if (list.length > 500) $('inv-table').append(el('p', { class: 'muted' }, `mostrando 500 de ${list.length}; refine o filtro.`));
  };
  $('inv-filter').oninput = renderInv;
  $('inv-status').onchange = renderInv;
  renderInv();
}

main();
