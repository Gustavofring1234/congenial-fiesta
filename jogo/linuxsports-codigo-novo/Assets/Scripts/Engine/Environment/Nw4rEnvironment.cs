// Aplica um preset de ambiente (StreamingAssets/Environment) à cena Unity:
//   1. luzes GX (bits 0x01|0x40 e cor habilitada) -> componentes Light; as de espaço de câmera ficam presas
//      à câmera alvo; ambiente = ambientColors[ambientIndex] (RenderSettings + sonda SH);
//   2. light textures lm_N -> Texture2D globais _Nw4rLightTexN, redesenhadas quando a câmera gira
//      (Nw4rLightTextureGenerator; usadas por Nw4r/Lit com _UseLightTexture = 1);
//   3. bloom -> Volume global do URP (Nw4rBloom).
// O preset vem de `presetName` ou, com `sceneLoader`, do mapeamento cena -> preset do environment_index.json.
using System;
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;
using UnityEngine.Rendering;

namespace LinuxSports.Engine
{
    [DisallowMultipleComponent]
    public sealed class Nw4rEnvironment : MonoBehaviour
    {
        public const string IndexPath = "Environment/environment_index.json";
        public static readonly int ReadyId = Shader.PropertyToID("_Nw4rLightTexReady");
        public static readonly int[] LightTexIds = { Shader.PropertyToID("_Nw4rLightTex0"), Shader.PropertyToID("_Nw4rLightTex1") };

        [Tooltip("Preset (ex.: golf, golf_fc1, tennis_b, boxing_main). Vazio = usar o da cena do sceneLoader.")]
        public string presetName;
        public Nw4rSceneLoader sceneLoader;
        [Tooltip("Câmera usada para o espaço de câmera (luzes presas à câmera e light textures). Vazio = Camera.main.")]
        public Camera targetCamera;
        public bool loadOnStart = true;
        public bool createLights = true;
        public bool applyAmbient = true;
        [Range(0, 7)] public int ambientIndex;
        public bool applyBloom = true;
        public float bloomIntensityScale = Nw4rBloom.DefaultIntensityScale;
        public bool updateLightTextures = true;
        [Tooltip("Sombra da primeira luz direcional de mundo (o Wii usa um sistema de sombra à parte).")]
        public bool mainLightShadows;

        public event Action<Nw4rEnvironment> Loaded;

        public Nw4rEnvironmentData Data { get; private set; }
        public Nw4rEnvironmentIndex Index { get; private set; }
        public Volume BloomVolume { get; private set; }
        public readonly List<Light> Lights = new List<Light>();

        private readonly Texture2D[] lightTex = new Texture2D[2];
        private readonly Color32[][] lightPix = new Color32[2][];
        private Quaternion lastCamRot = new Quaternion(2f, 2f, 2f, 2f);
        private Transform lightsRoot;

        public Texture2D LightTexture(int slot) { return slot >= 0 && slot < lightTex.Length ? lightTex[slot] : null; }

        private Camera Cam { get { return targetCamera != null ? targetCamera : Camera.main; } }

        private void Start()
        {
            if (sceneLoader != null) sceneLoader.Loaded += OnSceneLoaded;
            if (!loadOnStart) return;
            if (!string.IsNullOrEmpty(presetName)) LoadPreset(presetName);
            else if (sceneLoader != null && !string.IsNullOrEmpty(sceneLoader.scenePath)) LoadForScene(sceneLoader.scenePath);
        }

        private void OnDestroy()
        {
            if (sceneLoader != null) sceneLoader.Loaded -= OnSceneLoaded;
            for (int k = 0; k < lightTex.Length; k++) if (lightTex[k] != null) Destroy(lightTex[k]);
            if (lightTex[0] != null) Shader.SetGlobalFloat(ReadyId, 0f);
        }

        private void OnSceneLoaded(Nw4rSceneLoader s)
        {
            if (string.IsNullOrEmpty(presetName)) LoadForScene(s.scenePath);
        }

        public void LoadForScene(string scenePath)
        {
            WithIndex(ix =>
            {
                string p = ix.PresetForScene(scenePath);
                if (p == null) { Debug.LogWarning("Nw4rEnvironment: cena sem preset " + scenePath + "; usando rpcommon"); p = "rpcommon"; }
                LoadPreset(p);
            });
        }

        public void LoadPreset(string name)
        {
            WithIndex(ix =>
            {
                string file;
                if (!ix.presetFiles.TryGetValue(name, out file)) { Debug.LogError("Nw4rEnvironment: preset desconhecido " + name); return; }
                StreamingAssetLoader.Instance.LoadJson(file, root => Apply(Nw4rEnvironmentData.Parse(root)),
                                                       err => Debug.LogError("Nw4rEnvironment: " + err));
            });
        }

        private void WithIndex(Action<Nw4rEnvironmentIndex> then)
        {
            if (Index != null) { then(Index); return; }
            StreamingAssetLoader.Instance.LoadJson(IndexPath, root => { Index = Nw4rEnvironmentIndex.Parse(root); then(Index); },
                                                   err => Debug.LogError("Nw4rEnvironment: " + err));
        }

        public void Apply(Nw4rEnvironmentData data)
        {
            Data = data;
            presetName = string.IsNullOrEmpty(presetName) ? data.name : presetName;
            if (createLights) BuildLights();
            if (applyAmbient) ApplyAmbient();
            if (applyBloom && data.bloom != null) BloomVolume = Nw4rBloom.Apply(transform, data.bloom, Cam, bloomIntensityScale);
            else if (BloomVolume != null) { Destroy(BloomVolume.gameObject); BloomVolume = null; }
            InitLightTextures();
            lastCamRot = new Quaternion(2f, 2f, 2f, 2f);
            RefreshLightTextures(true);
            if (Loaded != null) Loaded(this);
        }

        private void ApplyAmbient()
        {
            if (Data.ambientColors.Length == 0) return;
            Color32 a = Data.ambientColors[Mathf.Clamp(ambientIndex, 0, Data.ambientColors.Length - 1)];
            var c = new Color(a.r / 255f, a.g / 255f, a.b / 255f, 1f);
            RenderSettings.ambientMode = AmbientMode.Flat;
            RenderSettings.ambientLight = c;
            var sh = new SphericalHarmonicsL2();
            sh.AddAmbientLight(c);
            RenderSettings.ambientProbe = sh;
        }

        private void ClearLights()
        {
            foreach (var l in Lights) if (l != null) Destroy(l.gameObject);
            Lights.Clear();
        }

        private void BuildLights()
        {
            ClearLights();
            if (lightsRoot == null)
            {
                lightsRoot = new GameObject("[Nw4rLights]").transform;
                lightsRoot.SetParent(transform, false);
            }
            bool shadowGiven = false;
            var cam = Cam;
            foreach (var e in Data.lights)
            {
                if (!e.enabled || !e.gx || !e.colorEnable) continue;
                bool cameraSpace = e.space == Nw4rLightSpace.View || e.space == Nw4rLightSpace.CameraFront || e.space == Nw4rLightSpace.CameraBack;
                var go = new GameObject("LOBJ_" + e.index + "_" + e.type + "_" + e.space);
                go.transform.SetParent(cameraSpace && cam != null ? cam.transform : lightsRoot, false);
                var light = go.AddComponent<Light>();
                ConfigureLight(light, e);
                if (!cameraSpace && e.type == Nw4rLightType.Directional && mainLightShadows && !shadowGiven)
                {
                    light.shadows = LightShadows.Soft;
                    shadowGiven = true;
                }
                Lights.Add(light);
            }
        }

        /// <summary>Um LOBJ -> Light. Posição/direção convertidas para o Unity (espelho X no mundo; espaço de
        /// câmera GX (x, y, z) -> local da câmera do Unity (x, y, -z)).</summary>
        public static void ConfigureLight(Light light, Nw4rEnvLight e)
        {
            Color32 c = e.FinalColor;
            light.color = new Color(c.r / 255f, c.g / 255f, c.b / 255f, 1f);
            light.intensity = 1f;
            light.shadows = LightShadows.None;
            Vector3 pos, dir;
            switch (e.space)
            {
                case Nw4rLightSpace.CameraFront: pos = Vector3.zero; dir = Vector3.forward; break;
                case Nw4rLightSpace.CameraBack: pos = Vector3.zero; dir = Vector3.back; break;
                case Nw4rLightSpace.View:
                    pos = new Vector3(e.positionWii.x, e.positionWii.y, -e.positionWii.z);
                    var d = e.DirectionWii;
                    dir = new Vector3(d.x, d.y, -d.z);
                    break;
                default:
                    pos = Nw4rCoordinates.Position(e.positionWii);
                    dir = Nw4rCoordinates.Position(e.DirectionWii);
                    break;
            }
            if (dir.sqrMagnitude < 1e-10f) dir = Vector3.down;
            light.transform.localRotation = Quaternion.LookRotation(dir.normalized);
            float len = e.DirectionWii.magnitude;
            switch (e.type)
            {
                case Nw4rLightType.Directional:
                    light.type = LightType.Directional;
                    light.transform.localPosition = Vector3.zero;
                    break;
                case Nw4rLightType.Spot:
                    light.type = e.manualAttnA ? LightType.Point : LightType.Spot;
                    light.transform.localPosition = pos;
                    if (!e.manualAttnA) light.spotAngle = Mathf.Clamp(e.spotCutoff * 2f, 1f, 179f);
                    light.range = Range(e, len);
                    break;
                default:
                    light.type = LightType.Point;
                    light.transform.localPosition = pos;
                    light.range = Range(e, len);
                    break;
            }
        }

        /// <summary>GXInitLightDistAttn(refDist × |alvo - pos|, refBright): o brilho cai a refBright em refDist;
        /// o URP zera no alcance, então alcance = refDist / (1 - refBright). AttnK manual (k = 0 no arquivo,
        /// valores de LightObject::Reset) = sem atenuação.</summary>
        private static float Range(Nw4rEnvLight e, float len)
        {
            if (e.manualAttnK || e.distAttnFn == 0) return 1e5f;
            float refDist = Mathf.Max(1e-3f, e.refDistance * Mathf.Max(len, 1e-3f));
            float rb = Mathf.Clamp(e.refBrightness, 0.01f, 0.99f);
            return refDist / (1f - rb);
        }

        private void InitLightTextures()
        {
            int size = Index != null ? Mathf.Clamp(Index.lightTextureSize, 8, 256) : 64;
            for (int k = 0; k < lightTex.Length; k++)
            {
                if (lightTex[k] == null || lightTex[k].width != size)
                {
                    if (lightTex[k] != null) Destroy(lightTex[k]);
                    lightTex[k] = new Texture2D(size, size, TextureFormat.RGBA32, false)
                    {
                        name = "lm_" + k, wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear,
                    };
                    lightPix[k] = new Color32[size * size];
                }
                Shader.SetGlobalTexture(LightTexIds[k], lightTex[k]);
            }
            Shader.SetGlobalFloat(ReadyId, 1f);
        }

        private void LateUpdate()
        {
            if (updateLightTextures) RefreshLightTextures(false);
        }

        /// <summary>Redesenha lm_0/lm_1. Só a rotação da câmera muda o resultado (luzes direcionais).</summary>
        public void RefreshLightTextures(bool force)
        {
            if (Data == null || Index == null || lightTex[0] == null) return;
            var cam = Cam;
            Quaternion rot = cam != null ? cam.transform.rotation : Quaternion.identity;
            if (!force && Quaternion.Dot(rot, lastCamRot) > 0.999999f) return;
            lastCamRot = rot;
            Matrix4x4 view = cam != null ? cam.worldToCameraMatrix : Matrix4x4.Scale(new Vector3(1f, 1f, -1f));
            foreach (var def in Data.lightTextures)
            {
                int slot = def.Slot;
                if (slot < 0 || slot >= lightTex.Length) continue;
                Nw4rLightTextureGenerator.Fill(lightPix[slot], lightTex[slot].width, Data, def, Index.ramps, view);
                lightTex[slot].SetPixels32(lightPix[slot]);
                lightTex[slot].Apply(false, false);
            }
        }
    }
}
