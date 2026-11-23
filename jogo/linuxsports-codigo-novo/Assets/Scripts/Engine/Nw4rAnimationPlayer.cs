// Player de animações NW4R em tempo de execução (inclui as 119 animações sem modelo no próprio .brres,
// associadas por tools/export_animations.py em StreamingAssets/animations_manifest.json).
//
// Uso: adicione a um modelo montado pelo Editor (tem Nw4rModelInfo). Play("tns_waitR") toca TODAS as
// animações com esse nome ligadas ao modelo (CHR0 + SRT0 + CLR0 + PAT0 + VIS0 + SHP0 podem coexistir).
// SCN0 é aplicado à câmera/luzes informadas em `sceneCamera`/`sceneLights`.
// Carrega os JSON sob demanda via UnityWebRequest (compatível com WebGL). Sem threads.
using System;
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Engine
{
    [DisallowMultipleComponent]
    public sealed class Nw4rAnimationPlayer : MonoBehaviour
    {
        public const string ManifestPath = "animations_manifest.json";

        [Tooltip("Modelo alvo; vazio = Nw4rModelInfo deste objeto.")]
        public Nw4rModelInfo model;
        [Tooltip("assetId de modelo cujas animações também valem para este (ex.: corpo Mii que recebe animações de avatar).")]
        public string extraAssetId;
        [Tooltip("Câmera para SCN0.")]
        public Camera sceneCamera;
        [Tooltip("Luzes nomeadas como no SCN0 (Main_Light, ...).")]
        public List<Light> sceneLights = new List<Light>();
        public string playOnStart;
        public float speed = 1f;
        public bool loopOverride;
        [Tooltip("Aceitar correspondências estruturais com pontuação a partir deste valor.")]
        [Range(0f, 1.1f)] public float minimumMatchScore = 0.5f;

        public event Action<string> Finished;

        public bool IsReady { get; private set; }
        public string Current { get; private set; }
        public float Frame { get; private set; }
        public bool IsPlaying { get; private set; }

        private static List<Nw4rAnimationEntry> manifest;
        private static readonly List<Action> manifestWaiters = new List<Action>();
        private static bool manifestLoading;
        private static readonly Dictionary<string, Nw4rAnimation> cache = new Dictionary<string, Nw4rAnimation>();

        private readonly Dictionary<string, List<Nw4rAnimationEntry>> byName = new Dictionary<string, List<Nw4rAnimationEntry>>();
        private readonly List<Nw4rAnimation> active = new List<Nw4rAnimation>();
        private int pendingLoads;
        private bool currentLoop;
        private int currentFrames;
        private MaterialPropertyBlock block;
        private readonly Dictionary<string, int> blendShapeIndex = new Dictionary<string, int>();

        public IEnumerable<string> AnimationNames => byName.Keys;

        private void Awake()
        {
            if (model == null) model = GetComponent<Nw4rModelInfo>();
            block = new MaterialPropertyBlock();
        }

        private void Start()
        {
            EnsureManifest(() =>
            {
                BuildIndex();
                IsReady = true;
                if (!string.IsNullOrEmpty(playOnStart)) Play(playOnStart);
            });
        }

        public static void EnsureManifest(Action onReady)
        {
            if (manifest != null) { onReady(); return; }
            manifestWaiters.Add(onReady);
            if (manifestLoading) return;
            manifestLoading = true;
            StreamingAssetLoader.Instance.LoadJson(ManifestPath, root =>
            {
                manifest = Nw4rAnimationEntry.ParseManifest(root);
                manifestLoading = false;
                var w = manifestWaiters.ToArray();
                manifestWaiters.Clear();
                foreach (var a in w) a();
            }, err =>
            {
                Debug.LogError(err);
                manifest = new List<Nw4rAnimationEntry>();
                manifestLoading = false;
                var w = manifestWaiters.ToArray();
                manifestWaiters.Clear();
                foreach (var a in w) a();
            });
        }

        private void BuildIndex()
        {
            byName.Clear();
            string id = model != null ? model.assetId : null;
            foreach (var e in manifest)
            {
                bool ok = false;
                for (int i = 0; i < e.modelAssetIds.Count; i++)
                {
                    string m = e.modelAssetIds[i];
                    if ((m == id || (!string.IsNullOrEmpty(extraAssetId) && m == extraAssetId)) && e.modelScores[i] >= minimumMatchScore) { ok = true; break; }
                }
                if (!ok && e.type == Nw4rAnimType.SCN0 && sceneCamera != null) ok = true;
                if (!ok) continue;
                List<Nw4rAnimationEntry> l;
                if (!byName.TryGetValue(e.name, out l)) byName[e.name] = l = new List<Nw4rAnimationEntry>();
                l.Add(e);
            }
        }

        public bool Has(string name) { return byName.ContainsKey(name); }

        /// <summary>Toca a animação pelo nome NW4R. Retorna false se não houver animação com esse nome para o modelo.</summary>
        public bool Play(string name, float startFrame = 0f)
        {
            if (!IsReady) { playOnStart = name; return true; }
            List<Nw4rAnimationEntry> entries;
            if (!byName.TryGetValue(name, out entries)) { Debug.LogWarning("Nw4rAnimationPlayer: '" + name + "' não existe para " + (model != null ? model.modelName : name)); return false; }
            Stop();
            Current = name;
            Frame = startFrame;
            currentLoop = false;
            currentFrames = 0;
            pendingLoads = 0;
            foreach (var e in entries)
            {
                currentLoop |= e.loop;
                currentFrames = Mathf.Max(currentFrames, e.frames);
                Nw4rAnimation a;
                if (cache.TryGetValue(e.file, out a)) { active.Add(a); continue; }
                pendingLoads++;
                string file = e.file, wanted = name;
                StreamingAssetLoader.Instance.LoadJson(file, root =>
                {
                    Nw4rAnimation parsed;
                    try { parsed = Nw4rAnimation.Parse(root); }
                    catch (FormatException ex) { Debug.LogWarning(file + ": " + ex.Message); pendingLoads--; return; }
                    cache[file] = parsed;
                    if (Current == wanted) active.Add(parsed);
                    pendingLoads--;
                }, err => { Debug.LogWarning(err); pendingLoads--; });
            }
            IsPlaying = true;
            return true;
        }

        public void Stop()
        {
            active.Clear();
            IsPlaying = false;
            Current = null;
        }

        private void Update()
        {
            if (!IsPlaying || active.Count == 0) return;
            Frame += Time.deltaTime * Nw4rCoordinates.FrameRate * speed;
            bool loop = currentLoop || loopOverride;
            int len = Mathf.Max(1, currentFrames);
            if (Frame >= len)
            {
                if (loop) Frame %= len;
                else
                {
                    Frame = len;
                    ApplyAll(Frame);
                    if (pendingLoads == 0)
                    {
                        IsPlaying = false;
                        string done = Current;
                        if (Finished != null) Finished(done);
                    }
                    return;
                }
            }
            ApplyAll(Frame);
        }

        /// <summary>Aplica o quadro atual sem avançar o tempo (útil para scrubbing).</summary>
        public void ApplyAll(float frame)
        {
            for (int i = 0; i < active.Count; i++) Apply(active[i], frame);
        }

        private void Apply(Nw4rAnimation a, float f)
        {
            switch (a.type)
            {
                case Nw4rAnimType.CHR0: ApplyChr(a, f); break;
                case Nw4rAnimType.SRT0: ApplySrt(a, f); break;
                case Nw4rAnimType.CLR0: ApplyClr(a, f); break;
                case Nw4rAnimType.PAT0: ApplyPat(a, f); break;
                case Nw4rAnimType.VIS0: ApplyVis(a, f); break;
                case Nw4rAnimType.SHP0: ApplyShp(a, f); break;
                case Nw4rAnimType.SCN0: ApplyScn(a, f); break;
            }
        }

        private void ApplyChr(Nw4rAnimation a, float f)
        {
            if (model == null) return;
            foreach (var t in a.bones)
            {
                int bi = model.BoneIndex(t.bone);
                if (bi < 0) continue;
                var b = model.bones[bi];
                if (b.transform == null) continue;
                Vector3 s, p;
                Quaternion r;
                Nw4rAnimation.SampleBone(t, f, b.bindScale, b.bindRotation, b.bindTranslation, out s, out r, out p);
                b.transform.localScale = s;
                b.transform.localRotation = r;
                b.transform.localPosition = p;
            }
        }

        private void WithBlock(Nw4rMaterialBinding mb, Action<MaterialPropertyBlock> edit)
        {
            if (mb.renderer == null) return;
            mb.renderer.GetPropertyBlock(block, mb.index);
            edit(block);
            mb.renderer.SetPropertyBlock(block, mb.index);
        }

        private void ApplySrt(Nw4rAnimation a, float f)
        {
            if (model == null) return;
            foreach (var t in a.texSrt)
            {
                if (t.slot != 0) continue; // o shader Nw4r/Lit usa a camada 0 como base
                var list = model.MaterialBindings(t.material);
                if (list == null) continue;
                float rot;
                Vector4 st = Nw4rAnimation.SampleTexSrt(t, f, out rot);
                foreach (var mb in list) WithBlock(mb, b => { b.SetVector(ShaderIds.BaseMapST, st); b.SetFloat(ShaderIds.BaseMapRotation, rot); });
            }
        }

        private void ApplyClr(Nw4rAnimation a, float f)
        {
            if (model == null) return;
            foreach (var t in a.colors)
            {
                var list = model.MaterialBindings(t.material);
                if (list == null) continue;
                Color32 c = t.Sample(f);
                int prop = ShaderIds.ForClrTarget(t.target);
                if (prop == 0) continue;
                bool keepAlpha = (t.mask & 0xFF) != 0;
                foreach (var mb in list)
                    WithBlock(mb, b =>
                    {
                        Color col = c;
                        if (keepAlpha && mb.renderer.sharedMaterials.Length > mb.index && mb.renderer.sharedMaterials[mb.index] != null
                            && mb.renderer.sharedMaterials[mb.index].HasProperty(prop))
                            col.a = mb.renderer.sharedMaterials[mb.index].GetColor(prop).a;
                        else if (keepAlpha) col.a = 1f;
                        b.SetColor(prop, col);
                        if (prop == ShaderIds.TevColor0 || prop == ShaderIds.TevColor1) b.SetFloat(ShaderIds.UseTevLerp, 1f);
                    });
            }
        }

        private void ApplyPat(Nw4rAnimation a, float f)
        {
            if (model == null) return;
            foreach (var t in a.patterns)
            {
                if (t.slot != 0) continue;
                var tex = model.PatternTexture(t.Sample(f));
                if (tex == null) continue;
                var list = model.MaterialBindings(t.material);
                if (list == null) continue;
                foreach (var mb in list) WithBlock(mb, b => b.SetTexture(ShaderIds.BaseMap, tex));
            }
        }

        private void ApplyVis(Nw4rAnimation a, float f)
        {
            if (model == null) return;
            foreach (var t in a.visibility)
            {
                int bi = model.BoneIndex(t.bone);
                if (bi < 0) continue;
                bool v = t.Sample(f);
                foreach (var r in model.RenderersOfBone(bi)) r.enabled = v;
            }
        }

        private void ApplyShp(Nw4rAnimation a, float f)
        {
            if (model == null) return;
            foreach (var t in a.shapes)
            {
                float w = Mathf.Clamp01(t.weight.Sample(f)) * 100f;
                foreach (var mb in model.meshes)
                {
                    var smr = mb.renderer as SkinnedMeshRenderer;
                    if (smr == null || smr.sharedMesh == null) continue;
                    int idx;
                    string key = smr.GetInstanceID() + "/" + t.target;
                    if (!blendShapeIndex.TryGetValue(key, out idx)) blendShapeIndex[key] = idx = smr.sharedMesh.GetBlendShapeIndex(t.target);
                    if (idx >= 0) smr.SetBlendShapeWeight(idx, w);
                }
            }
        }

        private void ApplyScn(Nw4rAnimation a, float f)
        {
            if (sceneCamera != null)
            {
                foreach (var c in a.cameras)
                {
                    if (c.placeholder) continue;
                    c.Apply(sceneCamera, f);
                    break;
                }
            }
            foreach (var lt in a.lights)
            {
                var light = sceneLights.Find(l => l != null && l.name == lt.name);
                if (light == null) continue;
                Vector3 start = new Vector3(lt.startX.Sample(f), lt.startY.Sample(f), lt.startZ.Sample(f));
                Vector3 end = new Vector3(lt.endX.Sample(f), lt.endY.Sample(f), lt.endZ.Sample(f));
                Nw4rSceneLighting.ApplyLight(light, lt.kind, start, end, lt.Color(f), lt.cutoffDeg);
            }
        }
    }

    /// <summary>Ids das propriedades dos shaders Nw4r/* (Assets/Resources/Shaders).</summary>
    public static class ShaderIds
    {
        public static readonly int BaseMap = Shader.PropertyToID("_BaseMap");
        public static readonly int BaseMapST = Shader.PropertyToID("_BaseMap_ST");
        public static readonly int BaseMapRotation = Shader.PropertyToID("_BaseMapRotation");
        public static readonly int BaseColor = Shader.PropertyToID("_BaseColor");
        public static readonly int AmbientColor = Shader.PropertyToID("_AmbientColor");
        public static readonly int TevColor0 = Shader.PropertyToID("_TevColor0");
        public static readonly int TevColor1 = Shader.PropertyToID("_TevColor1");
        public static readonly int TevColor2 = Shader.PropertyToID("_TevColor2");
        public static readonly int KonstColor0 = Shader.PropertyToID("_KonstColor0");
        public static readonly int UseTevLerp = Shader.PropertyToID("_UseTevLerp");

        /// <summary>Alvo do CLR0 (mat0, amb0, tev0..2, kon0..3) -> propriedade do shader (0 = sem equivalente).</summary>
        public static int ForClrTarget(string target)
        {
            switch (target)
            {
                case "mat0": case "mat1": return BaseColor;
                case "amb0": case "amb1": return AmbientColor;
                case "tev0": return TevColor0;
                case "tev1": return TevColor1;
                case "tev2": return TevColor2;
                case "kon0": case "kon1": case "kon2": case "kon3": return KonstColor0;
                default: return 0;
            }
        }
    }
}
