// Gera AnimationClip e AnimatorController nativos a partir das 301 animações NW4R convertidas
// (Assets/StreamingAssets/animations_manifest.json + Animations/**.json, ver tools/export_animations.py).
//
// Por modelo (prefab em Resources/Prefabs/Models/<assetId>.prefab, montado pelo Nw4rModelPostprocessor):
//   Assets/Resources/Animations/<assetId>/<nome>.anim   um clipe por NOME, juntando os tipos com o mesmo
//                                                      nome (CHR0 + SRT0 + CLR0 + PAT0 + VIS0 + SHP0)
//   Assets/Resources/Animations/<assetId>/<modelo>.controller   um estado por clipe
// SCN0 (câmeras): Assets/Resources/Animations/Scenes/<brres>/<nome>_<câmera>.anim, para um objeto com Camera.
//
// Conversão (igual ao runtime, Nw4rAnimationData.cs): trilhas amostradas quadro a quadro a 60 Hz no
// referencial do Wii e convertidas para o Unity (posição (-x,y,z); rotação Euler XYZ -> quaternion espelhado).
// Rotações viram curvas m_LocalRotation com continuidade de quaternion garantida.
// Os estados do controller não escrevem valores padrão (writeDefaultValues = false), para conviver
// com o Nw4rAnimationPlayer no mesmo objeto.
using System;
using System.Collections.Generic;
using System.IO;
using LinuxSports.Core;
using LinuxSports.Engine;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace LinuxSports.EditorTools
{
    public static class Nw4rAnimationImporter
    {
        public const string StreamingRoot = "Assets/StreamingAssets/";
        public const string OutRoot = "Assets/Resources/Animations/";
        public const float MinScore = 0.5f;

        [MenuItem("Nw4r/2. Importar animações 3D (AnimationClip + Animator)")]
        public static void ImportAll()
        {
            var manifestPath = StreamingRoot + Nw4rAnimationPlayer.ManifestPath;
            if (!File.Exists(manifestPath)) { Debug.LogError("Nw4r: " + manifestPath + " ausente (rode tools/export_animations.py)"); return; }
            var entries = Nw4rAnimationEntry.ParseManifest(Json.Parse(File.ReadAllText(manifestPath)));
            // modelo -> nome -> entradas
            var perModel = new Dictionary<string, Dictionary<string, List<Nw4rAnimationEntry>>>();
            var scenes = new List<Nw4rAnimationEntry>();
            foreach (var e in entries)
            {
                if (e.type == Nw4rAnimType.SCN0) { scenes.Add(e); continue; }
                for (int i = 0; i < e.modelAssetIds.Count; i++)
                {
                    if (e.modelScores[i] < MinScore) continue;
                    Dictionary<string, List<Nw4rAnimationEntry>> byName;
                    if (!perModel.TryGetValue(e.modelAssetIds[i], out byName)) perModel[e.modelAssetIds[i]] = byName = new Dictionary<string, List<Nw4rAnimationEntry>>();
                    List<Nw4rAnimationEntry> l;
                    if (!byName.TryGetValue(e.name, out l)) byName[e.name] = l = new List<Nw4rAnimationEntry>();
                    l.Add(e);
                }
            }
            var cache = new Dictionary<string, Nw4rAnimation>();
            int done = 0, clips = 0, total = perModel.Count + scenes.Count;
            try
            {
                foreach (var kv in perModel)
                {
                    if (EditorUtility.DisplayCancelableProgressBar("Nw4r: animações", kv.Key, done++ / (float)total)) break;
                    clips += ImportModel(kv.Key, kv.Value, cache);
                }
                foreach (var e in scenes)
                {
                    EditorUtility.DisplayProgressBar("Nw4r: câmeras SCN0", e.id, done++ / (float)total);
                    clips += ImportScene(e, cache);
                }
            }
            finally
            {
                EditorUtility.ClearProgressBar();
                AssetDatabase.SaveAssets();
            }
            Debug.Log("Nw4r: " + clips + " AnimationClips gerados para " + perModel.Count + " modelos e " + scenes.Count + " SCN0.");
        }

        private static Nw4rAnimation Load(Nw4rAnimationEntry e, Dictionary<string, Nw4rAnimation> cache)
        {
            Nw4rAnimation a;
            if (cache.TryGetValue(e.file, out a)) return a;
            string path = StreamingRoot + e.file;
            if (!File.Exists(path)) { Debug.LogWarning("Nw4r: " + path + " ausente"); return null; }
            a = Nw4rAnimation.Parse(Json.Parse(File.ReadAllText(path)));
            cache[e.file] = a;
            return a;
        }

        private static string Safe(string s)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            return s;
        }

        private static int ImportModel(string assetId, Dictionary<string, List<Nw4rAnimationEntry>> byName, Dictionary<string, Nw4rAnimation> cache)
        {
            string prefabPath = Nw4rModelPostprocessor.PrefabModels + assetId + ".prefab";
            if (!File.Exists(prefabPath)) { Debug.LogWarning("Nw4r: prefab " + prefabPath + " ausente (rode Nw4r > 1. Importar modelos)"); return 0; }
            var root = PrefabUtility.LoadPrefabContents(prefabPath);
            int count = 0;
            try
            {
                var info = root.GetComponent<Nw4rModelInfo>();
                if (info == null) return 0;
                string dir = OutRoot + assetId + "/";
                Directory.CreateDirectory(dir);
                var controllerPath = dir + Safe(info.modelName) + ".controller";
                AssetDatabase.DeleteAsset(controllerPath);
                var controller = AnimatorController.CreateAnimatorControllerAtPath(controllerPath);
                var sm = controller.layers[0].stateMachine;
                var idle = sm.AddState("Bind");
                idle.writeDefaultValues = false;
                sm.defaultState = idle;
                foreach (var kv in byName)
                {
                    var anims = new List<Nw4rAnimation>();
                    foreach (var e in kv.Value) { var a = Load(e, cache); if (a != null) anims.Add(a); }
                    if (anims.Count == 0) continue;
                    var clip = BuildClip(kv.Key, anims, root, info, dir);
                    string clipPath = dir + Safe(kv.Key) + ".anim";
                    var existing = AssetDatabase.LoadAssetAtPath<AnimationClip>(clipPath);
                    if (existing != null) { EditorUtility.CopySerialized(clip, existing); clip = existing; }
                    else AssetDatabase.CreateAsset(clip, clipPath);
                    var st = sm.AddState(kv.Key);
                    st.motion = clip;
                    st.writeDefaultValues = false;
                    count++;
                }
                var animator = root.GetComponent<Animator>();
                if (animator == null) animator = root.AddComponent<Animator>();
                animator.runtimeAnimatorController = controller;
                animator.applyRootMotion = false;
                animator.cullingMode = AnimatorCullingMode.CullUpdateTransforms;
                PrefabUtility.SaveAsPrefabAsset(root, prefabPath);
            }
            finally
            {
                PrefabUtility.UnloadPrefabContents(root);
            }
            return count;
        }

        private static string PathOf(Transform t, Transform root) { return AnimationUtility.CalculateTransformPath(t, root); }

        private sealed class CurveSet
        {
            public readonly Dictionary<string, AnimationCurve> curves = new Dictionary<string, AnimationCurve>();
            public readonly Dictionary<string, EditorCurveBinding> bindings = new Dictionary<string, EditorCurveBinding>();

            public AnimationCurve Get(string path, Type type, string prop)
            {
                string key = path + "|" + type.Name + "|" + prop;
                AnimationCurve c;
                if (!curves.TryGetValue(key, out c))
                {
                    curves[key] = c = new AnimationCurve();
                    bindings[key] = EditorCurveBinding.FloatCurve(path, type, prop);
                }
                return c;
            }
        }

        private static void AddSmooth(AnimationCurve c, float t, float v) { c.AddKey(new Keyframe(t, v)); }

        private static AnimationClip BuildClip(string name, List<Nw4rAnimation> anims, GameObject root, Nw4rModelInfo info, string dir)
        {
            var clip = new AnimationClip { name = name, frameRate = Nw4rCoordinates.FrameRate };
            var set = new CurveSet();
            int frames = 1;
            bool loop = false;
            foreach (var a in anims) { frames = Mathf.Max(frames, a.frames); loop |= a.loop; }
            var rt = root.transform;
            foreach (var a in anims)
            {
                switch (a.type)
                {
                    case Nw4rAnimType.CHR0:
                        foreach (var bt in a.bones)
                        {
                            int bi = info.BoneIndex(bt.bone);
                            if (bi < 0 || info.bones[bi].transform == null) continue;
                            var b = info.bones[bi];
                            string path = PathOf(b.transform, rt);
                            Quaternion prev = Quaternion.identity;
                            for (int f = 0; f <= a.frames; f++)
                            {
                                Vector3 s, p; Quaternion q;
                                Nw4rAnimation.SampleBone(bt, f, b.bindScale, b.bindRotation, b.bindTranslation, out s, out q, out p);
                                if (f > 0 && Quaternion.Dot(prev, q) < 0f) q = new Quaternion(-q.x, -q.y, -q.z, -q.w);
                                prev = q;
                                float t = f / Nw4rCoordinates.FrameRate;
                                AddSmooth(set.Get(path, typeof(Transform), "m_LocalPosition.x"), t, p.x);
                                AddSmooth(set.Get(path, typeof(Transform), "m_LocalPosition.y"), t, p.y);
                                AddSmooth(set.Get(path, typeof(Transform), "m_LocalPosition.z"), t, p.z);
                                AddSmooth(set.Get(path, typeof(Transform), "m_LocalRotation.x"), t, q.x);
                                AddSmooth(set.Get(path, typeof(Transform), "m_LocalRotation.y"), t, q.y);
                                AddSmooth(set.Get(path, typeof(Transform), "m_LocalRotation.z"), t, q.z);
                                AddSmooth(set.Get(path, typeof(Transform), "m_LocalRotation.w"), t, q.w);
                                AddSmooth(set.Get(path, typeof(Transform), "m_LocalScale.x"), t, s.x);
                                AddSmooth(set.Get(path, typeof(Transform), "m_LocalScale.y"), t, s.y);
                                AddSmooth(set.Get(path, typeof(Transform), "m_LocalScale.z"), t, s.z);
                            }
                        }
                        break;
                    case Nw4rAnimType.SRT0:
                        foreach (var tt in a.texSrt)
                        {
                            if (tt.slot != 0) continue;
                            var mbs = info.MaterialBindings(tt.material);
                            if (mbs == null) continue;
                            foreach (var mb in mbs)
                            {
                                string path = PathOf(mb.renderer.transform, rt);
                                var type = mb.renderer.GetType();
                                for (int f = 0; f <= a.frames; f++)
                                {
                                    float rot;
                                    Vector4 st = Nw4rAnimation.SampleTexSrt(tt, f, out rot);
                                    float t = f / Nw4rCoordinates.FrameRate;
                                    AddSmooth(set.Get(path, type, "material._BaseMap_ST.x"), t, st.x);
                                    AddSmooth(set.Get(path, type, "material._BaseMap_ST.y"), t, st.y);
                                    AddSmooth(set.Get(path, type, "material._BaseMap_ST.z"), t, st.z);
                                    AddSmooth(set.Get(path, type, "material._BaseMap_ST.w"), t, st.w);
                                    AddSmooth(set.Get(path, type, "material._BaseMapRotation"), t, rot);
                                }
                            }
                        }
                        break;
                    case Nw4rAnimType.CLR0:
                        foreach (var ct in a.colors)
                        {
                            var mbs = info.MaterialBindings(ct.material);
                            if (mbs == null) continue;
                            string prop = ClrProperty(ct.target);
                            if (prop == null) continue;
                            bool keepAlpha = (ct.mask & 0xFF) != 0;
                            foreach (var mb in mbs)
                            {
                                string path = PathOf(mb.renderer.transform, rt);
                                var type = mb.renderer.GetType();
                                int n = ct.IsConstant ? 1 : ct.frames.Length;
                                for (int f = 0; f < Mathf.Max(n, 1); f++)
                                {
                                    Color c = ct.Sample(f);
                                    float t = f / Nw4rCoordinates.FrameRate;
                                    AddSmooth(set.Get(path, type, "material." + prop + ".r"), t, c.r);
                                    AddSmooth(set.Get(path, type, "material." + prop + ".g"), t, c.g);
                                    AddSmooth(set.Get(path, type, "material." + prop + ".b"), t, c.b);
                                    if (!keepAlpha) AddSmooth(set.Get(path, type, "material." + prop + ".a"), t, c.a);
                                    if (prop == "_TevColor0" || prop == "_TevColor1") AddSmooth(set.Get(path, type, "material._UseTevLerp"), t, 1f);
                                }
                            }
                        }
                        break;
                    case Nw4rAnimType.VIS0:
                        foreach (var vt in a.visibility)
                        {
                            int bi = info.BoneIndex(vt.bone);
                            if (bi < 0) continue;
                            foreach (var r in info.RenderersOfBone(bi))
                            {
                                string path = PathOf(r.transform, rt);
                                var c = set.Get(path, r.GetType(), "m_Enabled");
                                for (int f = 0; f <= a.frames; f++) c.AddKey(new Keyframe(f / Nw4rCoordinates.FrameRate, vt.Sample(f) ? 1f : 0f, float.PositiveInfinity, float.PositiveInfinity));
                            }
                        }
                        break;
                    case Nw4rAnimType.SHP0:
                        foreach (var sh in a.shapes)
                            foreach (var mb in info.meshes)
                            {
                                var smr = mb.renderer as SkinnedMeshRenderer;
                                if (smr == null || smr.sharedMesh == null || smr.sharedMesh.GetBlendShapeIndex(sh.target) < 0) continue;
                                string path = PathOf(smr.transform, rt);
                                for (int f = 0; f <= a.frames; f++)
                                    AddSmooth(set.Get(path, typeof(SkinnedMeshRenderer), "blendShape." + sh.target), f / Nw4rCoordinates.FrameRate, Mathf.Clamp01(sh.weight.Sample(f)) * 100f);
                            }
                        break;
                    case Nw4rAnimType.PAT0:
                        AddPatternCurves(clip, a, root, info, dir);
                        break;
                }
            }
            foreach (var kv in set.curves)
            {
                var c = kv.Value;
                if (IsFlat(c)) { var k0 = c.keys[0]; c = new AnimationCurve(new Keyframe(0f, k0.value), new Keyframe(frames / Nw4rCoordinates.FrameRate, k0.value)); }
                else SmoothTangents(c);
                AnimationUtility.SetEditorCurve(clip, set.bindings[kv.Key], c);
            }
            clip.EnsureQuaternionContinuity();
            var settings = AnimationUtility.GetAnimationClipSettings(clip);
            settings.loopTime = loop;
            settings.stopTime = frames / Nw4rCoordinates.FrameRate;
            AnimationUtility.SetAnimationClipSettings(clip, settings);
            return clip;
        }

        private static string ClrProperty(string target)
        {
            switch (target)
            {
                case "mat0": case "mat1": return "_BaseColor";
                case "amb0": case "amb1": return "_AmbientColor";
                case "tev0": return "_TevColor0";
                case "tev1": return "_TevColor1";
                case "tev2": return "_TevColor2";
                case "kon0": case "kon1": case "kon2": case "kon3": return "_KonstColor0";
                default: return null;
            }
        }

        private static bool IsFlat(AnimationCurve c)
        {
            if (c.length <= 1) return true;
            float v = c.keys[0].value;
            foreach (var k in c.keys) if (Mathf.Abs(k.value - v) > 1e-6f) return false;
            return true;
        }

        private static void SmoothTangents(AnimationCurve c)
        {
            var keys = c.keys;
            for (int i = 0; i < keys.Length; i++)
            {
                if (float.IsInfinity(keys[i].inTangent)) continue;
                float tan;
                if (i == 0) tan = (keys[1].value - keys[0].value) / Mathf.Max(1e-6f, keys[1].time - keys[0].time);
                else if (i == keys.Length - 1) tan = (keys[i].value - keys[i - 1].value) / Mathf.Max(1e-6f, keys[i].time - keys[i - 1].time);
                else tan = (keys[i + 1].value - keys[i - 1].value) / Mathf.Max(1e-6f, keys[i + 1].time - keys[i - 1].time);
                keys[i].inTangent = tan;
                keys[i].outTangent = tan;
            }
            c.keys = keys;
        }

        /// <summary>PAT0: um material variante por textura e curva de referência em m_Materials.Array.data[i].</summary>
        private static void AddPatternCurves(AnimationClip clip, Nw4rAnimation a, GameObject root, Nw4rModelInfo info, string dir)
        {
            string patDir = dir + "pat/";
            Directory.CreateDirectory(patDir);
            foreach (var pt in a.patterns)
            {
                if (pt.slot != 0) continue;
                var mbs = info.MaterialBindings(pt.material);
                if (mbs == null) continue;
                var keys = new List<ObjectReferenceKeyframe>();
                var variants = new Dictionary<string, Material>();
                int n = pt.keyFrames != null ? pt.keyFrames.Length : 1;
                foreach (var mb in mbs)
                {
                    var baseMat = mb.renderer.sharedMaterials.Length > mb.index ? mb.renderer.sharedMaterials[mb.index] : null;
                    if (baseMat == null) continue;
                    keys.Clear();
                    for (int k = 0; k < n; k++)
                    {
                        string tex = pt.keyFrames != null ? pt.keyTextures[k] : pt.constTexture;
                        float frame = pt.keyFrames != null ? Mathf.Max(0f, pt.keyFrames[k]) : 0f;
                        var t2d = info.PatternTexture(tex);
                        if (t2d == null) continue;
                        string vkey = baseMat.name + "__" + tex;
                        Material v;
                        if (!variants.TryGetValue(vkey, out v))
                        {
                            string vp = patDir + Safe(vkey) + ".mat";
                            v = AssetDatabase.LoadAssetAtPath<Material>(vp);
                            if (v == null) { v = new Material(baseMat); AssetDatabase.CreateAsset(v, vp); }
                            else v.CopyPropertiesFromMaterial(baseMat);
                            v.SetTexture("_BaseMap", t2d);
                            EditorUtility.SetDirty(v);
                            variants[vkey] = v;
                        }
                        keys.Add(new ObjectReferenceKeyframe { time = frame / Nw4rCoordinates.FrameRate, value = v });
                    }
                    if (keys.Count == 0) continue;
                    var binding = EditorCurveBinding.PPtrCurve(AnimationUtility.CalculateTransformPath(mb.renderer.transform, root.transform),
                                                               mb.renderer.GetType(), "m_Materials.Array.data[" + mb.index + "]");
                    AnimationUtility.SetObjectReferenceCurve(clip, binding, keys.ToArray());
                }
            }
        }

        /// <summary>SCN0: um clipe por câmera (posição, rotação e campo de visão) para um objeto com Camera.</summary>
        private static int ImportScene(Nw4rAnimationEntry e, Dictionary<string, Nw4rAnimation> cache)
        {
            var a = Load(e, cache);
            if (a == null) return 0;
            string dir = OutRoot + "Scenes/" + Path.GetFileNameWithoutExtension(e.brres) + "/";
            Directory.CreateDirectory(dir);
            int n = 0;
            var probe = new GameObject("scn0_probe");
            var cam = probe.AddComponent<Camera>();
            try
            {
                foreach (var c in a.cameras)
                {
                    if (c.placeholder) continue;
                    var clip = new AnimationClip { name = a.name + "_" + c.name, frameRate = Nw4rCoordinates.FrameRate };
                    var curves = new Dictionary<string, AnimationCurve>();
                    Func<string, AnimationCurve> get = p => { AnimationCurve cv; if (!curves.TryGetValue(p, out cv)) curves[p] = cv = new AnimationCurve(); return cv; };
                    Quaternion prev = Quaternion.identity;
                    for (int f = 0; f <= Mathf.Max(1, a.frames); f++)
                    {
                        c.Apply(cam, f);
                        var q = probe.transform.localRotation;
                        if (f > 0 && Quaternion.Dot(prev, q) < 0f) q = new Quaternion(-q.x, -q.y, -q.z, -q.w);
                        prev = q;
                        var p = probe.transform.localPosition;
                        float t = f / Nw4rCoordinates.FrameRate;
                        get("m_LocalPosition.x").AddKey(t, p.x); get("m_LocalPosition.y").AddKey(t, p.y); get("m_LocalPosition.z").AddKey(t, p.z);
                        get("m_LocalRotation.x").AddKey(t, q.x); get("m_LocalRotation.y").AddKey(t, q.y);
                        get("m_LocalRotation.z").AddKey(t, q.z); get("m_LocalRotation.w").AddKey(t, q.w);
                        get("field of view").AddKey(t, cam.fieldOfView);
                    }
                    foreach (var kv in curves)
                    {
                        SmoothTangents(kv.Value);
                        var type = kv.Key == "field of view" ? typeof(Camera) : typeof(Transform);
                        AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("", type, kv.Key), kv.Value);
                    }
                    clip.EnsureQuaternionContinuity();
                    var settings = AnimationUtility.GetAnimationClipSettings(clip);
                    settings.loopTime = a.loop;
                    AnimationUtility.SetAnimationClipSettings(clip, settings);
                    string path = dir + Safe(clip.name) + ".anim";
                    AssetDatabase.DeleteAsset(path);
                    AssetDatabase.CreateAsset(clip, path);
                    n++;
                }
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(probe);
            }
            return n;
        }
    }
}
