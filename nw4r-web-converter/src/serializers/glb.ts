import { FormatError, LEWriter, decodeUtf8, encodeUtf8 } from '../core/binary.ts';

export interface GlbMeshInput {
  name: string;
  /** xyz triplets, non-indexed triangle list unless `indices` is given. */
  positions: Float32Array;
  normals?: Float32Array;
  indices?: Uint32Array;
  extras?: Record<string, unknown>;
}

export interface GlbInput {
  meshes: GlbMeshInput[];
  sceneName?: string;
  sceneExtras?: Record<string, unknown>;
  generator?: string;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const UINT32 = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** Build a binary glTF 2.0 (.glb) file without external dependencies. One node per mesh. */
export function buildGlb(input: GlbInput): Uint8Array {
  const bin = new LEWriter();
  const bufferViews: any[] = [];
  const accessors: any[] = [];
  const meshes: any[] = [];
  const nodes: any[] = [];

  const addView = (bytes: Uint8Array, target: number) => {
    bin.align(4);
    const byteOffset = bin.length;
    bin.bytes(bytes);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target });
    return bufferViews.length - 1;
  };

  for (const m of input.meshes) {
    if (m.positions.length % 3) throw new FormatError('GLB', `mesh ${m.name}: positions not a multiple of 3`);
    const count = m.positions.length / 3;
    if (count === 0) continue;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) {
      const v = m.positions[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
    const attributes: Record<string, number> = {};
    accessors.push({
      bufferView: addView(new Uint8Array(m.positions.buffer, m.positions.byteOffset, m.positions.byteLength), ARRAY_BUFFER),
      componentType: FLOAT, count, type: 'VEC3', min, max,
    });
    attributes.POSITION = accessors.length - 1;
    if (m.normals) {
      if (m.normals.length !== m.positions.length) throw new FormatError('GLB', `mesh ${m.name}: normals/positions length mismatch`);
      accessors.push({
        bufferView: addView(new Uint8Array(m.normals.buffer, m.normals.byteOffset, m.normals.byteLength), ARRAY_BUFFER),
        componentType: FLOAT, count, type: 'VEC3',
      });
      attributes.NORMAL = accessors.length - 1;
    }
    const primitive: any = { attributes, mode: 4 };
    if (m.indices) {
      accessors.push({
        bufferView: addView(new Uint8Array(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength), ELEMENT_ARRAY_BUFFER),
        componentType: UINT32, count: m.indices.length, type: 'SCALAR',
      });
      primitive.indices = accessors.length - 1;
    }
    meshes.push({ name: m.name, primitives: [primitive], ...(m.extras ? { extras: m.extras } : {}) });
    nodes.push({ name: m.name, mesh: meshes.length - 1 });
  }
  bin.align(4);
  const binBytes = bin.finish();

  const gltf: any = {
    asset: { version: '2.0', generator: input.generator ?? 'nw4r-web-converter' },
    scene: 0,
    scenes: [{ name: input.sceneName ?? 'Scene', nodes: nodes.map((_, i) => i), ...(input.sceneExtras ? { extras: input.sceneExtras } : {}) }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binBytes.length }],
  };
  if (meshes.length === 0) {
    delete gltf.accessors; delete gltf.bufferViews; delete gltf.buffers; delete gltf.meshes;
  }

  let json = encodeUtf8(JSON.stringify(gltf));
  const jsonPad = (4 - (json.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(json.length + jsonPad).fill(0x20);
    padded.set(json);
    json = padded;
  }

  const w = new LEWriter();
  const total = 12 + 8 + json.length + (meshes.length ? 8 + binBytes.length : 0);
  w.u32(GLB_MAGIC); w.u32(2); w.u32(total);
  w.u32(json.length); w.u32(CHUNK_JSON); w.bytes(json);
  if (meshes.length) { w.u32(binBytes.length); w.u32(CHUNK_BIN); w.bytes(binBytes); }
  return w.finish();
}

/** Parse a .glb back into its JSON document and BIN chunk (for validation/tests/runtime). */
export function readGlb(glb: Uint8Array): { json: any; bin: Uint8Array | null } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.length < 20 || dv.getUint32(0, true) !== GLB_MAGIC) throw new FormatError('GLB', 'missing glTF magic');
  if (dv.getUint32(4, true) !== 2) throw new FormatError('GLB', 'only glTF 2.0 is supported');
  if (dv.getUint32(8, true) !== glb.length) throw new FormatError('GLB', 'length field does not match file size');
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== CHUNK_JSON) throw new FormatError('GLB', 'first chunk is not JSON');
  const json = JSON.parse(decodeUtf8(glb.subarray(20, 20 + jsonLen)));
  let bin: Uint8Array | null = null;
  const o = 20 + jsonLen;
  if (o + 8 <= glb.length && dv.getUint32(o + 4, true) === CHUNK_BIN) {
    bin = glb.subarray(o + 8, o + 8 + dv.getUint32(o, true));
  }
  return { json, bin };
}
