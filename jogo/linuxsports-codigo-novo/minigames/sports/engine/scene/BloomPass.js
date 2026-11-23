// Bloom próprio para o WEBC. O pacote vendor do WEBC não traz EffectComposer nem UnrealBloomPass, então a
// cadeia inteira está aqui: limiar -> reduções à metade em cada nível -> blur gaussiano separável em cada nível ->
// composição aditiva na tela, com o tone mapping e o espaço de cor de saída do próprio renderer.
//
// Parâmetros vêm do .pblm (EGG::DrawPathBloom, exportado por tools/nw4r/env.py) pela mesma conta do
// Nw4rBloom.cs: intensidade = alfa/255 × Σ intensidade dos estágios × intensityScale (4). Cada estágio
// vira um nível da pirâmide com o seu peso; o raio do estágio define o σ do blur daquele nível.
//
// As funções de cálculo (bloomSettings, planBloomLevels, gaussianKernel) são puras: não tocam o THREE nem
// a GPU. Os alvos de renderização e os materiais só são criados no primeiro render() com um renderer real.
import { runtime } from '../../lib/runtime.js';

/** Escala de intensidade do Nw4rBloom.cs (compensa a normalização diferente dos dois blurs). */
export const DEFAULT_INTENSITY_SCALE = 4;
/** Nº máximo de níveis (cada um reduz a metade o anterior). */
export const MAX_LEVELS = 4;
/** Raio máximo do kernel gaussiano em texels do nível: 2·KMAX+1 = 25 taps por passada. */
export const KMAX = 12;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * Converte um .pblm (objeto do env.json: threshold, color RGBA 0..255, stageCount, stages[{radius, intensity}])
 * nos parâmetros do bloom. active = false quando o jogo não liga o bloom (limiar >= 1, alfa 0, sem estágios).
 * @returns {{active, threshold, thresholdColor:number[], tint:number[], intensity, scatter, stages:{radius,weight}[]}}
 */
export function bloomSettings(pblm, intensityScale = DEFAULT_INTENSITY_SCALE) {
  const off = { active: false, threshold: 1, thresholdColor: [1, 1, 1], tint: [1, 1, 1], intensity: 0, scatter: 0.7, stages: [] };
  if (!pblm) return off;
  const alpha = (pblm.color ? pblm.color[3] : 0) / 255;
  const n = clamp(pblm.stageCount | 0, 0, 3);
  if (!(pblm.threshold < 1 && alpha > 0 && n > 0)) return off;
  let sum = 0, radius = 0;
  const usados = [];
  for (let k = 0; k < n; k++) {
    const st = pblm.stages[k];
    const w = Math.max(0, st.intensity);
    sum += w;
    radius = Math.max(radius, st.radius);
    if (w > 0) usados.push({ radius: st.radius, w });
  }
  if (!(sum > 0)) return off;
  const intensity = alpha * sum * intensityScale;
  return {
    active: true,
    threshold: Math.max(0, pblm.threshold),
    thresholdColor: pblm.thresholdColor.slice(0, 3).map((v) => v / 255),
    tint: pblm.color.slice(0, 3).map((v) => v / 255),
    intensity,
    // espalhamento: raio 1 -> 0,4 ... raio 16 -> 0,95 (como Nw4rBloom.cs)
    scatter: clamp(0.4 + 0.55 * Math.log(Math.max(1, radius)) / Math.log(16), 0.05, 0.95),
    // pesos que somam `intensity`: cada estágio entra com a sua fração da intensidade total
    stages: usados.map((s) => ({ radius: s.radius, weight: intensity * s.w / sum })),
  };
}

/** Se há mais estágios que níveis, os excedentes somam o peso no último nível (raio = o maior). */
export function planBloomLevels(stages, maxLevels = MAX_LEVELS) {
  const out = [];
  for (const s of stages) {
    if (out.length < maxLevels) out.push({ weight: s.weight, radius: s.radius });
    else {
      const last = out[out.length - 1];
      last.weight += s.weight;
      last.radius = Math.max(last.radius, s.radius);
    }
  }
  return out;
}

/** σ do blur de um nível, em texels do próprio nível: raio 0 -> 1, raio 16 -> 5, limitado a [1, 8]. */
export function levelSigma(radius) {
  return clamp(1 + radius / 4, 1, 8);
}

/**
 * Kernel gaussiano de 2·KMAX+1 posições (centrado em KMAX), normalizado: a soma dos pesos é 1.
 * Fora do raio 3σ (limitado a KMAX) os pesos são zero, então a mesma uniform serve para qualquer σ.
 * @returns {Float32Array}
 */
export function gaussianKernel(sigma) {
  const s = Math.max(1e-3, sigma);
  const R = Math.min(KMAX, Math.ceil(3 * s));
  const w = new Float32Array(2 * KMAX + 1);
  let soma = 0;
  for (let i = -R; i <= R; i++) {
    const v = Math.exp(-(i * i) / (2 * s * s));
    w[i + KMAX] = v;
    soma += v;
  }
  for (let i = -R; i <= R; i++) w[i + KMAX] /= soma;
  return w;
}

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Limiar (opcional) + média 2×2: as 4 amostras caem no centro dos texels de origem (offset de meio texel).
const FRAG_REDUZ = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uUsaLimiar;
uniform float uLimiar;
uniform vec3 uCorLimiar;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv + vec2(-0.5, -0.5) * uTexel).rgb
         + texture2D(tSrc, vUv + vec2( 0.5, -0.5) * uTexel).rgb
         + texture2D(tSrc, vUv + vec2(-0.5,  0.5) * uTexel).rgb
         + texture2D(tSrc, vUv + vec2( 0.5,  0.5) * uTexel).rgb;
  c *= 0.25;
  // PostEffectMask do Wii: textura - limiar × cor do limiar, saturado
  if (uUsaLimiar > 0.5) c = max(c - uLimiar * uCorLimiar, vec3(0.0));
  gl_FragColor = vec4(c, 1.0);
}`;

// Blur gaussiano de 25 taps ao longo de uPasso (texel de origem na direção do blur).
const FRAG_BLUR = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uPasso;
uniform float uKernel[${2 * KMAX + 1}];
varying vec2 vUv;
void main() {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${2 * KMAX + 1}; i++) {
    float o = float(i - ${KMAX});
    acc += texture2D(tSrc, vUv + o * uPasso).rgb * uKernel[i];
  }
  gl_FragColor = vec4(acc, 1.0);
}`;

// Composição: cena + Σ peso_k × blur_k (com a tinta). Depois do cálculo linear, o tone mapping e a conversão
// para o espaço de saída (sRGB) do renderer, como o próprio three faz no fim de um material comum.
const FRAG_COMPOR = /* glsl */`
uniform sampler2D tCena;
uniform sampler2D tB0;
uniform sampler2D tB1;
uniform sampler2D tB2;
uniform sampler2D tB3;
uniform float wB0;
uniform float wB1;
uniform float wB2;
uniform float wB3;
uniform vec3 uTinta;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tCena, vUv).rgb;
  vec3 b = texture2D(tB0, vUv).rgb * wB0
         + texture2D(tB1, vUv).rgb * wB1
         + texture2D(tB2, vUv).rgb * wB2
         + texture2D(tB3, vUv).rgb * wB3;
  gl_FragColor = vec4(c + b * uTinta, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class BloomPass {
  /** @param {{levels?: number}} [o] níveis da pirâmide (2 a 4; a qualidade escolhe) */
  constructor({ levels = 3 } = {}) {
    this.levels = clamp(levels | 0, 1, MAX_LEVELS);
    this.enabled = true;
    this.settings = bloomSettings(null);
    this.plan = [];                // níveis com peso > 0: {weight, radius, sigma}
    this.width = 0;
    this.height = 0;
    this.gpu = null;               // alvos e materiais: criados só em render() com renderer real
  }

  /** Liga o .pblm da cena (ou desliga, com null). */
  setPblm(pblm, intensityScale = DEFAULT_INTENSITY_SCALE) {
    this.settings = bloomSettings(pblm, intensityScale);
    this.plan = this.settings.active ? planBloomLevels(this.settings.stages, this.levels) : [];
    for (const p of this.plan) p.sigma = levelSigma(p.radius);
    if (this.gpu) this._atualizarUniformes();
    return this;
  }

  /** true quando há bloom a desenhar (ligado e com algum estágio de peso > 0). */
  get active() { return this.enabled && this.settings.active && this.plan.length > 0; }

  /** Tamanho do buffer de desenho (pixels reais, não de CSS). */
  setSize(w, h) {
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    if (this.gpu) this._redimensionar();
    return this;
  }

  /**
   * Desenha a cena com bloom na tela (alvo nulo). Sem bloom ativo, é um renderer.render comum.
   * Preserva o alvo de renderização e o autoClear do renderer.
   */
  render(renderer, scene, camera) {
    if (!this.active) { renderer.render(scene, camera); return; }
    const gpu = this._garantirGpu(renderer);
    if (!this.width || !this.height) {
      const v = renderer.getDrawingBufferSize(new runtime.THREE.Vector2());
      this.setSize(v.x, v.y);
    }
    if (gpu.w !== this.width || gpu.h !== this.height) this._redimensionar();

    const alvoAnterior = renderer.getRenderTarget();
    const autoAnterior = renderer.autoClear;
    renderer.autoClear = true;
    try {
      // 1. cena em HDR (linear, sem tone mapping: ele entra só na composição)
      renderer.setRenderTarget(gpu.cena);
      renderer.render(scene, camera);

      // só os níveis com peso no plano entram no cálculo (os demais não custam nada)
      const n = this.plan.length;

      // 2. limiar + primeira redução; depois reduções 2×2 em cascata
      const r = gpu.reduz.uniforms;
      r.tSrc.value = gpu.cena.texture;
      r.uTexel.value.set(1 / this.width, 1 / this.height);
      r.uUsaLimiar.value = 1;
      this._passe(renderer, gpu.reduz, gpu.niveis[0]);
      r.uUsaLimiar.value = 0;
      for (let k = 1; k < n; k++) {
        const src = gpu.niveis[k - 1];
        r.tSrc.value = src.texture;
        r.uTexel.value.set(1 / src.width, 1 / src.height);
        this._passe(renderer, gpu.reduz, gpu.niveis[k]);
      }

      // 3. blur separável em cada nível (horizontal para o temporário, vertical para o resultado)
      const b = gpu.blur.uniforms;
      for (let k = 0; k < n; k++) {
        const nv = gpu.niveis[k];
        b.uKernel.value = gpu.nucleos[k];
        b.tSrc.value = nv.texture;
        b.uPasso.value.set(1 / nv.width, 0);
        this._passe(renderer, gpu.blur, gpu.temp[k]);
        b.tSrc.value = gpu.temp[k].texture;
        b.uPasso.value.set(0, 1 / nv.height);
        this._passe(renderer, gpu.blur, gpu.borrado[k]);
      }

      // 4. composição na tela: níveis sem peso recebem a própria cena com peso zero
      renderer.setRenderTarget(null);
      const c = gpu.compor.uniforms;
      c.tCena.value = gpu.cena.texture;
      for (let k = 0; k < 4; k++) {
        c[`tB${k}`].value = k < n ? gpu.borrado[k].texture : gpu.cena.texture;
        c[`wB${k}`].value = k < this.plan.length ? this.plan[k].weight : 0;
      }
      c.uTinta.value.set(...this.settings.tint);
      gpu.quadro.material = gpu.compor;
      renderer.render(gpu.quadroCena, gpu.quadroCam);
    } finally {
      renderer.setRenderTarget(alvoAnterior);
      renderer.autoClear = autoAnterior;
    }
  }

  /** Libera alvos, materiais e geometria (o renderer continua do dono do chamador). */
  dispose() {
    if (!this.gpu) return;
    const g = this.gpu;
    g.cena.dispose();
    for (const rt of [...g.niveis, ...g.temp, ...g.borrado]) rt.dispose();
    g.reduz.dispose();
    g.blur.dispose();
    g.compor.dispose();
    g.geo.dispose();
    this.gpu = null;
  }

  // ── internos ────────────────────────────────────────────────────

  _passe(renderer, material, alvo) {
    renderer.setRenderTarget(alvo);
    this.gpu.quadro.material = material;
    renderer.render(this.gpu.quadroCena, this.gpu.quadroCam);
  }

  /** Kernels e parâmetros de limiar/tinta a partir do plano atual. */
  _atualizarUniformes() {
    const g = this.gpu;
    g.nucleos = [];
    for (let k = 0; k < this.levels; k++) {
      const p = this.plan[k];
      g.nucleos.push(gaussianKernel(p ? p.sigma : 2));
    }
    g.reduz.uniforms.uLimiar.value = this.settings.threshold;
    g.reduz.uniforms.uCorLimiar.value.set(...this.settings.thresholdColor);
  }

  _redimensionar() {
    const g = this.gpu;
    g.w = this.width;
    g.h = this.height;
    g.cena.setSize(this.width, this.height);
    for (let k = 0; k < this.levels; k++) {
      const w = Math.max(1, this.width >> (k + 1));
      const h = Math.max(1, this.height >> (k + 1));
      g.niveis[k].setSize(w, h);
      g.temp[k].setSize(w, h);
      g.borrado[k].setSize(w, h);
    }
  }

  _garantirGpu(renderer) {
    if (this.gpu) return this.gpu;
    const T = runtime.THREE;
    // HDR em meia precisão quando o contexto a suporta (sem isso o bloom satura em 1)
    const meia = !!(renderer.extensions && renderer.extensions.has && renderer.extensions.has('EXT_color_buffer_float'));
    const tipo = meia ? T.HalfFloatType : T.UnsignedByteType;
    const alvo = (depth, amostras) => new T.WebGLRenderTarget(1, 1, {
      type: tipo, depthBuffer: depth, samples: amostras, minFilter: T.LinearFilter, magFilter: T.LinearFilter,
    });
    const material = (frag, uniforms) => new T.ShaderMaterial({
      vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
    });
    // triângulo de tela cheia: cobre o quadrado de clip (-1..1) com um só triângulo
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const quadro = new T.Mesh(geo, null);
    quadro.frustumCulled = false;
    const quadroCena = new T.Scene();
    quadroCena.add(quadro);
    const quadroCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const reduz = material(FRAG_REDUZ, {
      tSrc: { value: null }, uTexel: { value: new T.Vector2() }, uUsaLimiar: { value: 0 },
      uLimiar: { value: 1 }, uCorLimiar: { value: new T.Vector3(1, 1, 1) },
    });
    const blur = material(FRAG_BLUR, {
      tSrc: { value: null }, uPasso: { value: new T.Vector2() }, uKernel: { value: new Float32Array(2 * KMAX + 1) },
    });
    const compor = material(FRAG_COMPOR, {
      tCena: { value: null }, tB0: { value: null }, tB1: { value: null }, tB2: { value: null }, tB3: { value: null },
      wB0: { value: 0 }, wB1: { value: 0 }, wB2: { value: 0 }, wB3: { value: 0 },
      uTinta: { value: new T.Vector3(1, 1, 1) },
    });
    compor.toneMapped = true; // o tone mapping do renderer vale só para a composição na tela

    const niveis = [], temp = [], borrado = [];
    for (let k = 0; k < this.levels; k++) {
      niveis.push(alvo(false, 0));
      temp.push(alvo(false, 0));
      borrado.push(alvo(false, 0));
    }
    this.gpu = {
      w: 0, h: 0, geo, quadro, quadroCena, quadroCam, reduz, blur, compor,
      cena: alvo(true, 4), niveis, temp, borrado, nucleos: [],
    };
    this._atualizarUniformes();
    return this.gpu;
  }
}
