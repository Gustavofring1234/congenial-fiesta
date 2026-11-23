// Modelo do editor de personagens no estilo do Wii (sem tela): um Mii é o mesmo objeto `info` que o .rcd decodificado
// dá (Mii/Profiles/*.json -> info), então o MiiOpponentBuilder monta o personagem criado com as MESMAS peças dos 60
// oponentes (Shapes/ e Textures/ do RFL). Cada campo do editor tem faixa e rótulo; a tela (SportsMenu + CharacterPreview)
// só chama set(campo, valor) / step(campo, ±1) e redesenha.

/** Campos editáveis: faixas = quantidade de peças/cores exportadas (Mii/Shapes, Mii/Textures, rfl_params.json). */
export const MII_FIELDS = Object.freeze([
  { id: 'sex', label: 'Gênero', min: 0, max: 1, names: ['Masculino', 'Feminino'] },
  { id: 'height', label: 'Altura', min: 0, max: 127, step: 8 },
  { id: 'build', label: 'Porte físico', min: 0, max: 127, step: 8 },
  { id: 'favoriteColor', label: 'Cor da roupa', min: 0, max: 11, names: ['Vermelho', 'Laranja', 'Amarelo', 'Verde-claro', 'Verde', 'Azul', 'Azul-claro', 'Rosa', 'Roxo', 'Marrom', 'Branco', 'Preto'] },
  { id: 'faceline.type', label: 'Formato do rosto', min: 0, max: 7 },
  { id: 'faceline.color', label: 'Cor da pele', min: 0, max: 5 },
  { id: 'faceline.texture', label: 'Detalhes do rosto', min: 0, max: 11 },
  { id: 'hair.type', label: 'Cabelo', min: 0, max: 71 },
  { id: 'hair.color', label: 'Cor do cabelo', min: 0, max: 7 },
  { id: 'hair.flip', label: 'Repartido', min: 0, max: 1, names: ['Esquerda', 'Direita'] },
  { id: 'eyebrow.type', label: 'Sobrancelhas', min: 0, max: 23 },
  { id: 'eyebrow.color', label: 'Cor das sobrancelhas', min: 0, max: 7 },
  { id: 'eye.type', label: 'Olhos', min: 0, max: 47 },
  { id: 'eye.color', label: 'Cor dos olhos', min: 0, max: 5 },
  { id: 'nose.type', label: 'Nariz', min: 0, max: 11 },
  { id: 'mouth.type', label: 'Boca', min: 0, max: 23 },
  { id: 'mouth.color', label: 'Cor da boca', min: 0, max: 2 },
  { id: 'glass.type', label: 'Óculos', min: 0, max: 8, names: ['Sem óculos'] },
  { id: 'glass.color', label: 'Cor dos óculos', min: 0, max: 5 },
  { id: 'beard.mustache', label: 'Bigode', min: 0, max: 3, names: ['Sem bigode'] },
  { id: 'beard.type', label: 'Barba', min: 0, max: 3, names: ['Sem barba'] },
  { id: 'beard.color', label: 'Cor da barba e bigode', min: 0, max: 7 },
]);

export const MAX_NAME = 10; // o nome do Mii no .rcd tem 10 caracteres

/** Mii padrão (o rosto neutro do editor do Wii) para o gênero dado. */
export function defaultMiiInfo(sex = 0, name = '') {
  return {
    name: name || (sex === 1 ? 'Jogadora' : 'Jogador'), creator: '', sex, birthMonth: 0, birthDay: 0, favoriteColor: sex === 1 ? 7 : 5,
    favorite: 0, height: 64, build: 64, createId: '',
    faceline: { type: 0, color: 0, texture: 0 },
    hair: { type: sex === 1 ? 12 : 33, color: 1, flip: 0 },
    eye: { type: sex === 1 ? 4 : 2, color: 0, scale: 4, rotate: sex === 1 ? 3 : 4, x: 2, y: 12 },
    eyebrow: { type: sex === 1 ? 0 : 6, color: 1, scale: 4, rotate: 6, x: 2, y: 10 },
    nose: { type: 1, scale: 4, y: 9 },
    mouth: { type: sex === 1 ? 19 : 23, color: 0, scale: 4, y: 13 },
    beard: { mustache: 0, type: 0, color: 0, scale: 4, y: 10 },
    glass: { type: 0, color: 0, scale: 4, y: 10 },
    mole: { type: 0, scale: 4, x: 2, y: 20 },
  };
}

const field = (id) => MII_FIELDS.find((f) => f.id === id);
const getPath = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
function setPath(o, path, v) {
  const ks = path.split('.');
  let t = o;
  for (let i = 0; i < ks.length - 1; i++) t = t[ks[i]] = t[ks[i]] || {};
  t[ks[ks.length - 1]] = v;
}

export class MiiEditor {
  constructor(info = null) {
    this.info = info ? JSON.parse(JSON.stringify(info)) : defaultMiiInfo(0);
    this.version = 0;           // muda a cada edição (a pré-visualização remonta quando muda)
  }

  get(id) { return getPath(this.info, id); }

  set(id, value) {
    const f = field(id);
    if (!f) throw new Error('campo desconhecido: ' + id);
    const v = Math.max(f.min, Math.min(f.max, Math.round(+value || 0)));
    if (v === this.get(id)) return false;
    setPath(this.info, id, v);
    this.version++;
    return true;
  }

  /** Passo para trás/frente (circular nas peças; com limite nas medidas de corpo). */
  step(id, d) {
    const f = field(id);
    const n = f.max - f.min + 1, k = f.step || 1;
    const cur = this.get(id);
    const next = f.step ? Math.max(f.min, Math.min(f.max, cur + d * k)) : f.min + ((((cur - f.min + d) % n) + n) % n);
    return this.set(id, next);
  }

  setName(name) {
    const v = String(name || '').replace(/[\u0000-\u001f]/g, '').slice(0, MAX_NAME);
    if (v === this.info.name) return false;
    this.info.name = v;
    this.version++;
    return true;
  }

  /** Texto do valor de um campo para o menu (nome da opção ou "n/total"). */
  valueText(id) {
    const f = field(id), v = this.get(id);
    if (f.names && f.names[v - f.min] !== undefined) return f.names[v - f.min];
    if (f.step) return `${v}/${f.max}`;
    return `${v - f.min + 1}/${f.max - f.min + 1}`;
  }

  /** Mii sorteado (botão "Aleatório"). rng: () => [0,1). */
  randomize(rng = Math.random) {
    for (const f of MII_FIELDS) setPath(this.info, f.id, f.min + Math.floor(rng() * (f.max - f.min + 1)));
    this.info.height = 20 + Math.floor(rng() * 90);
    this.info.build = 20 + Math.floor(rng() * 90);
    this.version++;
  }

  /** Cópia para guardar (sem referências ao editor). */
  toInfo() { const c = JSON.parse(JSON.stringify(this.info)); c.name = c.name.trim() || (c.sex === 1 ? 'Jogadora' : 'Jogador'); return c; }
}
