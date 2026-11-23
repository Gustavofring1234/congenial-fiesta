// Importação automática dos modelos NW4R no Editor (requer o pacote glTFast: com.unity.cloud.gltfast).
//
// Quando um .glb de Assets/Nw4r/Models (ou o sidecar .nw4r.json ao lado) é importado, este
// AssetPostprocessor monta Assets/Resources/Prefabs/Models/<assetId>.prefab:
//   1. Materiais por material NW4R (vínculo do MDL0 DrawOpa/DrawXlu, não a lista global do .model.json):
//      shader Nw4r/Lit, camada 0 do material como _BaseMap (Assets/Nw4r/Textures), repetição por camada,
//      translúcido (DrawXlu) -> mistura alfa, textura com alfa -> recorte, cull desligado se doubleSided.
//   2. Esqueleto (ossos do MDL0 na pose de repouso, convertidos para o Unity espelhando X).
//   3. Malhas: rigid -> o nó vira filho do osso; skinned -> SkinnedMeshRenderer com pesos dos envelopes;
//      blendshapes do SHP0. A ordem de vértices do .glb é a do sidecar (conferida pela contagem).
//   4. Nw4rModelInfo (ossos, materiais, malha->osso, texturas do PAT0) + Nw4rAnimationPlayer.
// Colisões (Assets/Nw4r/Collision/*.glb) viram Assets/Resources/Prefabs/Collision/<assetId>.prefab com MeshCollider.
using System;
using System.Collections.Generic;
using System.IO;
using LinuxSports.Core;
using LinuxSports.Engine;
using UnityEditor;
using UnityEngine;

namespace LinuxSports.EditorTools
{
    public sealed class Nw4rModelPostprocessor : AssetPostprocessor
    {
        public const string ModelsDir = "Assets/Nw4r/Models/";
        public const string CollisionDir = "Assets/Nw4r/Collision/";
        public const string TexturesDir = "Assets/Nw4r/Textures/";
        public const string PrefabModels = "Assets/Resources/Prefabs/Models/";
        public const string PrefabCollision = "Assets/Resources/Prefabs/Collision/";
        public const string MaterialsDir = "Assets/Nw4r/Materials/";
        public const string MeshesDir = "Assets/Nw4r/Meshes/";

        private static readonly HashSet<string> queueModels = new HashSet<string>();
        private static readonly HashSet<string> queueCollision = new HashSet<string>();
        private static bool scheduled;

        /// <summary>Desliga a montagem automática (útil durante importações em lote pelo menu).</summary>
        public static bool AutoBuild
        {
            get { return EditorPrefs.GetBool("Nw4r.AutoBuild", true); }
            set { EditorPrefs.SetBool("Nw4r.AutoBuild", value); }
        }

        private void OnPreprocessTexture()
        {
            if (!assetPath.StartsWith(TexturesDir) && !assetPath.StartsWith("Assets/Resources/Effects/")) return;
            var ti = (TextureImporter)assetImporter;
            ti.alphaIsTransparency = true;
            ti.mipmapEnabled = assetPath.StartsWith(TexturesDir);
            ti.sRGBTexture = true;
            ti.npotScale = TextureImporterNPOTScale.None;
            ti.textureCompression = TextureImporterCompression.Compressed;
            ti.wrapMode = assetPath.StartsWith(TexturesDir) ? TextureWrapMode.Repeat : TextureWrapMode.Clamp;
        }

        private static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
        {
            if (!AutoBuild) return;
            foreach (var p in imported)
            {
                if (p.StartsWith(ModelsDir) && (p.EndsWith(".glb") || p.EndsWith(".nw4r.json")))
                    queueModels.Add(p.EndsWith(".glb") ? p.Substring(0, p.Length - 4) + ".nw4r.json" : p);
                else if (p.StartsWith(CollisionDir) && p.EndsWith(".glb")) queueCollision.Add(p);
            }
            if ((queueModels.Count > 0 || queueCollision.Count > 0) && !scheduled)
            {
                scheduled = true;
                EditorApplication.delayCall += Flush;
            }
        }

        private static void Flush()
        {
            scheduled = false;
            var models = new List<string>(queueModels);
            var cols = new List<string>(queueCollision);
            queueModels.Clear();
            queueCollision.Clear();
            BuildModels(models);
            BuildCollisions(cols);
        }

        public static void BuildModels(IList<string> sidecars)
        {
            if (sidecars.Count == 0) return;
            // sem StartAssetEditing: o prefab referencia malhas/materiais criados no mesmo passo
            try
            {
                for (int i = 0; i < sidecars.Count; i++)
                {
                    if (EditorUtility.DisplayCancelableProgressBar("Nw4r: modelos", sidecars[i], i / (float)sidecars.Count)) break;
                    try { Nw4rModelBuilder.Build(sidecars[i]); }
                    catch (Exception e) { Debug.LogError("Nw4r: falha ao montar " + sidecars[i] + ": " + e); }
                }
            }
            finally
            {
                EditorUtility.ClearProgressBar();
                AssetDatabase.SaveAssets();
            }
        }

        public static void BuildCollisions(IList<string> glbs)
        {
            if (glbs.Count == 0) return;
            var index = new Dictionary<string, string>();
            string idxPath = CollisionDir + "collision_index.json";
            if (File.Exists(idxPath))
                foreach (var e in J.Objs(Json.Parse(File.ReadAllText(idxPath)), "entries")) index["Assets/" + J.Str(e, "glb")] = J.Str(e, "assetId");
            Directory.CreateDirectory(PrefabCollision);
            var debugMat = AssetDatabase.LoadAssetAtPath<Material>(MaterialsDir + "collision_debug.mat");
            if (debugMat == null)
            {
                Directory.CreateDirectory(MaterialsDir);
                debugMat = new Material(Shader.Find("Nw4r/Lit") ?? Shader.Find("Universal Render Pipeline/Lit")) { name = "collision_debug" };
                debugMat.SetColor("_BaseColor", new Color(0.2f, 0.8f, 0.3f, 1f));
                AssetDatabase.CreateAsset(debugMat, MaterialsDir + "collision_debug.mat");
            }
            foreach (var glb in glbs)
            {
                string id;
                if (!index.TryGetValue(glb, out id)) id = Path.GetFileNameWithoutExtension(glb);
                var src = AssetDatabase.LoadAssetAtPath<GameObject>(glb);
                if (src == null) { Debug.LogError("Nw4r: " + glb + " não importou como GameObject (o pacote glTFast está instalado?)"); continue; }
                var inst = UnityEngine.Object.Instantiate(src);
                inst.name = Path.GetFileNameWithoutExtension(glb);
                foreach (var mf in inst.GetComponentsInChildren<MeshFilter>())
                {
                    var mc = mf.gameObject.AddComponent<MeshCollider>();
                    mc.sharedMesh = mf.sharedMesh;
                    var r = mf.GetComponent<MeshRenderer>();
                    if (r != null) { r.sharedMaterial = debugMat; r.enabled = false; }
                }
                inst.isStatic = true;
                PrefabUtility.SaveAsPrefabAsset(inst, PrefabCollision + id + ".prefab");
                UnityEngine.Object.DestroyImmediate(inst);
            }
            AssetDatabase.SaveAssets();
        }
    }

    public static class Nw4rModelBuilder
    {
        private static string Safe(string s)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            return s.Replace('/', '_');
        }

        private static void EnsureDir(string assetDir)
        {
            if (!Directory.Exists(assetDir)) Directory.CreateDirectory(assetDir);
        }

        private static TextureWrapMode Wrap(string w) { return w == "repeat" ? TextureWrapMode.Repeat : w == "mirror" ? TextureWrapMode.Mirror : TextureWrapMode.Clamp; }

        /// <summary>Monta (ou remonta) o prefab de um modelo a partir do sidecar .nw4r.json.</summary>
        public static GameObject Build(string sidecarPath)
        {
            if (!File.Exists(sidecarPath)) { Debug.LogWarning("Nw4r: sidecar ausente " + sidecarPath); return null; }
            var sc = Json.Parse(File.ReadAllText(sidecarPath));
            string assetId = J.Str(sc, "assetId");
            string glbPath = "Assets/" + J.Str(sc, "glb");
            var src = AssetDatabase.LoadAssetAtPath<GameObject>(glbPath);
            if (src == null) { Debug.LogError("Nw4r: " + glbPath + " não importou como GameObject (instale com.unity.cloud.gltfast)"); return null; }

            var root = UnityEngine.Object.Instantiate(src);
            root.name = J.Str(sc, "model");
            try
            {
                var info = root.AddComponent<Nw4rModelInfo>();
                info.assetId = assetId;
                info.modelName = J.Str(sc, "model");
                info.brres = J.Str(sc, "brres");

                // ---------------------------------------------------------- materiais
                string matDir = MaterialsDir() + assetId + "/";
                EnsureDir(matDir);
                var mats = new Dictionary<string, Material>();
                foreach (var m in J.Objs(sc, "materials"))
                {
                    string name = J.Str(m, "name");
                    var mat = CreateMaterial(m, matDir + Safe(name) + ".mat");
                    mats[name] = mat;
                }
                var renderersByNode = new Dictionary<string, Renderer>();
                foreach (var r in root.GetComponentsInChildren<Renderer>(true))
                {
                    if (!renderersByNode.ContainsKey(r.gameObject.name)) renderersByNode[r.gameObject.name] = r;
                    var shared = r.sharedMaterials;
                    for (int k = 0; k < shared.Length; k++)
                    {
                        string mname = shared[k] != null ? shared[k].name.Replace(" (Instance)", "") : null;
                        Material repl;
                        if (mname != null && mats.TryGetValue(mname, out repl))
                        {
                            shared[k] = repl;
                            info.materials.Add(new Nw4rMaterialBinding { material = mname, renderer = r, index = k });
                        }
                    }
                    r.sharedMaterials = shared;
                }

                // ---------------------------------------------------------- esqueleto
                var boneObjs = new List<Transform>();
                var skeleton = new GameObject("skeleton").transform;
                skeleton.SetParent(root.transform, false);
                foreach (var b in J.Objs(sc, "bones"))
                {
                    var t = new GameObject(J.Str(b, "name")).transform;
                    int parent = J.Int(b, "parent", -1);
                    t.SetParent(parent >= 0 && parent < boneObjs.Count ? boneObjs[parent] : skeleton, false);
                    var s = J.Floats(b, "scale"); var rr = J.Floats(b, "rotate"); var tr = J.Floats(b, "translate");
                    var bi = new Nw4rBoneInfo
                    {
                        name = t.name, transform = t, parent = parent,
                        bindScale = new Vector3(s[0], s[1], s[2]), bindRotation = new Vector3(rr[0], rr[1], rr[2]),
                        bindTranslation = new Vector3(tr[0], tr[1], tr[2]),
                    };
                    t.localScale = bi.bindScale;
                    t.localRotation = Nw4rCoordinates.Rotation(rr[0], rr[1], rr[2]);
                    t.localPosition = Nw4rCoordinates.Position(bi.bindTranslation);
                    info.bones.Add(bi);
                    boneObjs.Add(t);
                }

                // ---------------------------------------------------------- malhas
                string meshDir = MeshesDir() + assetId + "/";
                foreach (var me in J.Objs(sc, "meshes"))
                {
                    string mname = J.Str(me, "name");
                    Renderer r;
                    if (!renderersByNode.TryGetValue(mname, out r)) { Debug.LogWarning("Nw4r " + info.modelName + ": nó '" + mname + "' não encontrado no .glb"); continue; }
                    string binding = J.Str(me, "binding", "static");
                    int bone = J.Int(me, "bone", -1);
                    var mf = r.GetComponent<MeshFilter>();
                    var mesh = mf != null ? mf.sharedMesh : null;
                    int expected = J.Int(me, "vertexCount");
                    var morphs = new List<Dictionary<string, object>>(J.Objs(me, "morphs"));
                    if (mesh != null && mesh.vertexCount != expected && binding == "skinned")
                    {
                        Debug.LogWarning("Nw4r " + info.modelName + "/" + mname + ": " + mesh.vertexCount + " vértices no Unity, " + expected + " no sidecar; usando o osso dominante");
                        binding = "rigid";
                        bone = DominantBone(J.Str(me, "skin"), expected);
                    }
                    if (binding == "rigid" && bone >= 0 && bone < boneObjs.Count)
                        r.transform.SetParent(boneObjs[bone], true);
                    Renderer finalRenderer = r;
                    if (mesh != null && (binding == "skinned" || (morphs.Count > 0 && mesh.vertexCount == expected)))
                    {
                        EnsureDir(meshDir);
                        var copy = UnityEngine.Object.Instantiate(mesh);
                        copy.name = mesh.name + "_nw4r";
                        Transform[] smrBones = null;
                        if (binding == "skinned")
                        {
                            copy.boneWeights = DecodeSkin(J.Str(me, "skin"), expected);
                            var bind = new Matrix4x4[boneObjs.Count];
                            for (int k = 0; k < boneObjs.Count; k++) bind[k] = boneObjs[k].worldToLocalMatrix * r.transform.localToWorldMatrix;
                            copy.bindposes = bind;
                            smrBones = boneObjs.ToArray();
                        }
                        foreach (var mo in morphs)
                        {
                            var deltas = DecodeVec3(J.Str(mo, "deltas"), expected);
                            if (deltas != null) copy.AddBlendShapeFrame(J.Str(mo, "name"), 100f, deltas, null, null);
                        }
                        string meshAsset = meshDir + Safe(mname) + ".asset";
                        AssetDatabase.DeleteAsset(meshAsset);
                        AssetDatabase.CreateAsset(copy, meshAsset);
                        var go = r.gameObject;
                        var materials = r.sharedMaterials;
                        var rebind = info.materials.FindAll(x => ReferenceEquals(x.renderer, r));
                        UnityEngine.Object.DestroyImmediate(r);
                        if (mf != null) UnityEngine.Object.DestroyImmediate(mf);
                        var smr = go.AddComponent<SkinnedMeshRenderer>();
                        smr.sharedMesh = copy;
                        smr.sharedMaterials = materials;
                        if (smrBones != null) { smr.bones = smrBones; smr.rootBone = skeleton; }
                        smr.updateWhenOffscreen = false;
                        smr.localBounds = copy.bounds;
                        finalRenderer = smr;
                        foreach (var mb in rebind) mb.renderer = smr;
                    }
                    info.meshes.Add(new Nw4rMeshBinding { mesh = mname, renderer = finalRenderer, bone = bone, binding = binding });
                }
                info.materials.RemoveAll(m => m.renderer == null);

                // ---------------------------------------------------------- PAT0
                foreach (var pt in J.Objs(sc, "patternTextures"))
                {
                    string png = J.Str(pt, "png");
                    var tex = png != null ? AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/" + png) : null;
                    if (tex != null) info.patternTextures.Add(new Nw4rNamedTexture { name = J.Str(pt, "name"), texture = tex });
                }
                if (root.GetComponent<Nw4rAnimationPlayer>() == null) root.AddComponent<Nw4rAnimationPlayer>().model = info;

                EnsureDir(Nw4rModelPostprocessor.PrefabModels);
                var prefab = PrefabUtility.SaveAsPrefabAsset(root, Nw4rModelPostprocessor.PrefabModels + assetId + ".prefab");
                return prefab;
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(root);
            }
        }

        private static string MaterialsDir() { return Nw4rModelPostprocessor.MaterialsDir; }
        private static string MeshesDir() { return Nw4rModelPostprocessor.MeshesDir; }

        public static Material CreateMaterial(object m, string path)
        {
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            var shader = Shader.Find("Nw4r/Lit");
            if (shader == null) { Debug.LogError("Nw4r: shader Nw4r/Lit não encontrado (Assets/Resources/Shaders)"); shader = Shader.Find("Universal Render Pipeline/Lit"); }
            bool created = mat == null;
            if (created) mat = new Material(shader);
            else mat.shader = shader;
            mat.name = Path.GetFileNameWithoutExtension(path);
            Texture2D tex = null;
            bool texAlpha = false;
            var layers = J.Arr(m, "layers");
            if (layers != null && layers.Count > 0)
            {
                var l0 = layers[0];
                string png = J.Str(l0, "png");
                texAlpha = J.Bool(l0, "alpha");
                if (png != null)
                {
                    string tp = "Assets/" + png;
                    var ti = AssetImporter.GetAtPath(tp) as TextureImporter;
                    if (ti != null)
                    {
                        var wu = Wrap(J.Str(l0, "wrapS")); var wv = Wrap(J.Str(l0, "wrapT"));
                        if (ti.wrapModeU != wu || ti.wrapModeV != wv) { ti.wrapModeU = wu; ti.wrapModeV = wv; ti.SaveAndReimport(); }
                    }
                    tex = AssetDatabase.LoadAssetAtPath<Texture2D>(tp);
                }
            }
            mat.SetTexture("_BaseMap", tex);
            mat.SetColor("_BaseColor", Color.white);
            // Camadas lm_0/lm_1 = EGG::LightTexture redesenhada em tempo de execução (Nw4rEnvironment).
            bool lightTex = false;
            if (layers != null) foreach (var l in layers) { var tn = J.Str(l, "texture"); if (tn != null && tn.StartsWith("lm_")) lightTex = true; }
            mat.SetFloat("_UseLightTexture", lightTex ? 1f : 0f);
            bool translucent = J.Bool(m, "translucent");
            bool doubleSided = J.Bool(m, "doubleSided");
            mat.SetFloat("_Cull", doubleSided ? (float)UnityEngine.Rendering.CullMode.Off : (float)UnityEngine.Rendering.CullMode.Back);
            if (translucent)
            {
                mat.SetFloat("_Surface", 1f);
                mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
                mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                mat.SetFloat("_ZWrite", 0f);
                mat.SetFloat("_AlphaClip", 0f);
                mat.DisableKeyword("_ALPHATEST_ON");
                mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;
                mat.SetOverrideTag("RenderType", "Transparent");
            }
            else
            {
                mat.SetFloat("_Surface", 0f);
                mat.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.One);
                mat.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.Zero);
                mat.SetFloat("_ZWrite", 1f);
                if (texAlpha)
                {
                    mat.SetFloat("_AlphaClip", 1f);
                    mat.EnableKeyword("_ALPHATEST_ON");
                    mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.AlphaTest;
                    mat.SetOverrideTag("RenderType", "TransparentCutout");
                }
                else
                {
                    mat.SetFloat("_AlphaClip", 0f);
                    mat.DisableKeyword("_ALPHATEST_ON");
                    mat.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Geometry;
                    mat.SetOverrideTag("RenderType", "Opaque");
                }
            }
            if (created) AssetDatabase.CreateAsset(mat, path);
            else EditorUtility.SetDirty(mat);
            return mat;
        }

        /// <summary>skin: base64 LE de N × [4×u16 osso, 4×f32 peso].</summary>
        public static BoneWeight[] DecodeSkin(string b64, int count)
        {
            var raw = Convert.FromBase64String(b64 ?? "");
            var w = new BoneWeight[count];
            for (int i = 0; i < count && (i + 1) * 24 <= raw.Length; i++)
            {
                int o = i * 24;
                w[i] = new BoneWeight
                {
                    boneIndex0 = BitConverter.ToUInt16(raw, o), boneIndex1 = BitConverter.ToUInt16(raw, o + 2),
                    boneIndex2 = BitConverter.ToUInt16(raw, o + 4), boneIndex3 = BitConverter.ToUInt16(raw, o + 6),
                    weight0 = BitConverter.ToSingle(raw, o + 8), weight1 = BitConverter.ToSingle(raw, o + 12),
                    weight2 = BitConverter.ToSingle(raw, o + 16), weight3 = BitConverter.ToSingle(raw, o + 20),
                };
            }
            return w;
        }

        private static int DominantBone(string b64, int count)
        {
            var w = DecodeSkin(b64, count);
            var tot = new Dictionary<int, float>();
            foreach (var x in w)
            {
                float v;
                tot.TryGetValue(x.boneIndex0, out v);
                tot[x.boneIndex0] = v + x.weight0;
            }
            int best = -1; float bw = -1;
            foreach (var kv in tot) if (kv.Value > bw) { bw = kv.Value; best = kv.Key; }
            return best;
        }

        /// <summary>deltas: base64 LE de N × 3×f32 no referencial do Wii -> Unity (X espelhado).</summary>
        public static Vector3[] DecodeVec3(string b64, int count)
        {
            var raw = Convert.FromBase64String(b64 ?? "");
            if (raw.Length < count * 12) return null;
            var v = new Vector3[count];
            for (int i = 0; i < count; i++)
                v[i] = new Vector3(-BitConverter.ToSingle(raw, i * 12), BitConverter.ToSingle(raw, i * 12 + 4), BitConverter.ToSingle(raw, i * 12 + 8));
            return v;
        }
    }
}
