/** Construtor mínimo de glTF 2.0 binário (.glb), sem dependências. */
export class GlbBuilder {
  private bin: number[] = [];
  private chunks: Uint8Array[] = [];
  private binLength = 0;
  readonly json: Record<string, any> = {
    asset: { version: '2.0', generator: 'nw4r-web' },
    scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [],
  };

  private addView(data: Uint8Array, target?: number): number {
    const pad = (4 - (this.binLength % 4)) % 4;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.binLength += pad; }
    const view: Record<string, number> = { buffer: 0, byteOffset: this.binLength, byteLength: data.length };
    if (target) view.target = target;
    this.chunks.push(data);
    this.binLength += data.length;
    this.json.bufferViews.push(view);
    return this.json.bufferViews.length - 1;
  }

  addFloatAttribute(values: Float32Array, type: 'VEC2' | 'VEC3' | 'VEC4', withBounds = false): number {
    const n = { VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const le = new Uint8Array(values.length * 4);
    const dv = new DataView(le.buffer);
    values.forEach((v, i) => dv.setFloat32(i * 4, v, true));
    const acc: Record<string, unknown> = { bufferView: this.addView(le, 34962), componentType: 5126, count: values.length / n, type };
    if (withBounds) {
      const min = Array(n).fill(Infinity), max = Array(n).fill(-Infinity);
      for (let i = 0; i < values.length; i++) { const k = i % n; min[k] = Math.min(min[k], values[i]); max[k] = Math.max(max[k], values[i]); }
      acc.min = min.map(Math.fround); acc.max = max.map(Math.fround);
    }
    this.json.accessors.push(acc);
    return this.json.accessors.length - 1;
  }

  addIndices(idx: Uint32Array): number {
    const le = new Uint8Array(idx.length * 4);
    const dv = new DataView(le.buffer);
    idx.forEach((v, i) => dv.setUint32(i * 4, v, true));
    this.json.accessors.push({ bufferView: this.addView(le, 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
    return this.json.accessors.length - 1;
  }

  addMaterial(m: Record<string, unknown>): number {
    this.json.materials.push(m);
    return this.json.materials.length - 1;
  }

  addMeshNode(name: string, primitive: Record<string, unknown>, extras?: Record<string, unknown>): number {
    this.json.meshes.push({ name, primitives: [primitive], ...(extras ? { extras } : {}) });
    this.json.nodes.push({ name, mesh: this.json.meshes.length - 1, ...(extras ? { extras } : {}) });
    const node = this.json.nodes.length - 1;
    this.json.scenes[0].nodes.push(node);
    return node;
  }

  build(): Uint8Array {
    const j = { ...this.json };
    for (const k of Object.keys(j)) if (Array.isArray(j[k]) && j[k].length === 0 && k !== 'scenes') delete j[k];
    const binPad = (4 - (this.binLength % 4)) % 4;
    const binLen = this.binLength + binPad;
    if (binLen) j.buffers = [{ byteLength: binLen }];
    let js = new TextEncoder().encode(JSON.stringify(j));
    const jsPad = (4 - (js.length % 4)) % 4;
    const jsonChunk = new Uint8Array(js.length + jsPad).fill(0x20);
    jsonChunk.set(js);
    const total = 12 + 8 + jsonChunk.length + (binLen ? 8 + binLen : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsonChunk.length, true); dv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonChunk, 20);
    if (binLen) {
      let o = 20 + jsonChunk.length;
      dv.setUint32(o, binLen, true); dv.setUint32(o + 4, 0x004e4942, true);
      o += 8;
      for (const c of this.chunks) { out.set(c, o); o += c.length; }
    }
    js = new Uint8Array(0);
    return out;
  }
}
