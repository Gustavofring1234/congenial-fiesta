// Dados de ambiente exportados por tools/export_environment.py (StreamingAssets/Environment/*.env.json):
// luzes do EGG::LightManager (.plight), light textures (.plmap), bloom (.pblm). Campos e significado em
// tools/nw4r/env.py (tirados dos leitores do main.dol). Coordenadas ficam no referencial do Wii; a conversão
// para o Unity é feita por quem usa (Nw4rCoordinates / espaço de câmera).
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Engine
{
    public enum Nw4rLightType { Point = 0, Directional = 1, Spot = 2 }

    /// <summary>Espaço da luz (LightObject+0x34, CalcView @ 8009da24).</summary>
    public enum Nw4rLightSpace
    {
        World = 0,          // posição/alvo no mundo
        WorldSpecular = 1,  // mundo + meio-vetor para o especular
        View = 2,           // posição/alvo já em coordenadas de câmera (luz presa à câmera)
        CameraFront = 3,    // na câmera, apontando para a frente (luz "de capacete")
        CameraBack = 4,     // atrás da cena, apontando para a câmera (contraluz / rim)
    }

    public sealed class Nw4rEnvLight
    {
        public int index, flags, spotFn, distAttnFn;
        public bool enabled, gx, lightTexture, colorEnable, alphaEnable, specular, manualAttnA, manualAttnK;
        public Nw4rLightType type;
        public Nw4rLightSpace space;
        public Vector3 positionWii, targetWii;
        public float intensity, spotCutoff, refDistance, refBrightness;
        public Color32 color, secondaryColor;

        /// <summary>Cor final do LightObject::Calc: rgb × intensidade, saturado em 255; alfa copiado.</summary>
        public Color32 FinalColor { get { return Scale(color, intensity); } }

        /// <summary>Vetor alvo - posição no referencial do Wii (comprimento = LightObject+0x38).</summary>
        public Vector3 DirectionWii { get { return targetWii - positionWii; } }

        public static Color32 Scale(Color32 c, float k)
        {
            return new Color32((byte)Mathf.Min(255f, c.r * k), (byte)Mathf.Min(255f, c.g * k),
                               (byte)Mathf.Min(255f, c.b * k), c.a);
        }

        internal static Nw4rEnvLight Parse(object o)
        {
            return new Nw4rEnvLight
            {
                index = J.Int(o, "index"), flags = J.Int(o, "flags"),
                spotFn = J.Int(o, "spotFn"), distAttnFn = J.Int(o, "distAttnFn"),
                enabled = J.Bool(o, "enabled"), gx = J.Bool(o, "gx"), lightTexture = J.Bool(o, "lightTexture"),
                colorEnable = J.Bool(o, "colorEnable"), alphaEnable = J.Bool(o, "alphaEnable"),
                specular = J.Bool(o, "specular"), manualAttnA = J.Bool(o, "manualAttnA"), manualAttnK = J.Bool(o, "manualAttnK"),
                type = ParseType(J.Str(o, "type")), space = ParseSpace(J.Str(o, "space")),
                positionWii = Vec(J.Floats(o, "position")), targetWii = Vec(J.Floats(o, "target")),
                intensity = J.F(o, "intensity", 1f), spotCutoff = J.F(o, "spotCutoff", 90f),
                refDistance = J.F(o, "refDistance", 0.5f), refBrightness = J.F(o, "refBrightness", 0.5f),
                color = Nw4rCoordinates.Color(J.Ints(o, "color")),
                secondaryColor = Nw4rCoordinates.Color(J.Ints(o, "secondaryColor")),
            };
        }

        private static Vector3 Vec(float[] v) { return v != null && v.Length >= 3 ? new Vector3(v[0], v[1], v[2]) : Vector3.zero; }

        private static Nw4rLightType ParseType(string s)
        {
            switch (s) { case "directional": return Nw4rLightType.Directional; case "spot": return Nw4rLightType.Spot; default: return Nw4rLightType.Point; }
        }

        private static Nw4rLightSpace ParseSpace(string s)
        {
            switch (s)
            {
                case "worldSpecular": return Nw4rLightSpace.WorldSpecular;
                case "view": return Nw4rLightSpace.View;
                case "cameraFront": return Nw4rLightSpace.CameraFront;
                case "cameraBack": return Nw4rLightSpace.CameraBack;
                default: return Nw4rLightSpace.World;
            }
        }
    }

    public struct Nw4rLightTextureEntry
    {
        public float weight;
        public int mode;
    }

    /// <summary>Um LTEX: a textura "lm_N" que o jogo redesenha a cada quadro a partir das luzes.</summary>
    public sealed class Nw4rLightTextureDef
    {
        public string name;
        public int drawType;
        public uint lightMask;
        public Nw4rLightTextureEntry[] entries;

        /// <summary>Teste de LightTexture::addLight: bit (1 &lt;&lt; índice da luz) na máscara.</summary>
        public bool UsesLight(int index) { return index >= 0 && index < 32 && (lightMask >> index & 1u) != 0; }

        /// <summary>Número do slot pelo nome ("lm_0" -> 0); -1 se o nome não seguir o padrão.</summary>
        public int Slot
        {
            get
            {
                int us = name == null ? -1 : name.LastIndexOf('_');
                int n;
                return us >= 0 && int.TryParse(name.Substring(us + 1), out n) ? n : -1;
            }
        }

        internal static Nw4rLightTextureDef Parse(object o)
        {
            var list = J.Arr(o, "entries");
            var e = new Nw4rLightTextureEntry[list == null ? 0 : list.Count];
            for (int k = 0; k < e.Length; k++) e[k] = new Nw4rLightTextureEntry { weight = J.F(list[k], "weight", 1f), mode = J.Int(list[k], "mode") };
            return new Nw4rLightTextureDef
            {
                name = J.Str(o, "name"), drawType = J.Int(o, "drawType"),
                lightMask = (uint)J.Num(o, "lightMask"), entries = e,
            };
        }
    }

    public sealed class Nw4rBloomData
    {
        public int version, flags, stageCount, mode;
        public float threshold;
        public Color32 thresholdColor, color;
        public float[] stageRadius = new float[3], stageIntensity = new float[3];
        public float[] composite = new float[2];

        /// <summary>Com limiar ≥ 1 nada passa pela máscara (textura - limiar, saturada); sem estágios ou
        /// com alfa 0 o resultado é nulo.</summary>
        public bool Enabled { get { return threshold < 1f && color.a > 0 && stageCount > 0; } }

        internal static Nw4rBloomData Parse(object o)
        {
            var b = new Nw4rBloomData
            {
                version = J.Int(o, "version", 1), flags = J.Int(o, "flags"), stageCount = J.Int(o, "stageCount"),
                mode = J.Int(o, "mode"), threshold = J.F(o, "threshold", 1f),
                thresholdColor = Nw4rCoordinates.Color(J.Ints(o, "thresholdColor")),
                color = Nw4rCoordinates.Color(J.Ints(o, "color")),
            };
            var st = J.Arr(o, "stages");
            for (int k = 0; st != null && k < st.Count && k < 3; k++)
            {
                b.stageRadius[k] = J.F(st[k], "radius");
                b.stageIntensity[k] = J.F(st[k], "intensity");
            }
            var c = J.Floats(o, "composite");
            if (c != null) for (int k = 0; k < c.Length && k < 2; k++) b.composite[k] = c[k];
            return b;
        }
    }

    public sealed class Nw4rEnvironmentData
    {
        public string name, sport;
        public Color32[] ambientColors = new Color32[0];
        public Color32 globalColor;
        public readonly List<Nw4rEnvLight> lights = new List<Nw4rEnvLight>();
        public readonly List<Nw4rLightTextureDef> lightTextures = new List<Nw4rLightTextureDef>();
        public Nw4rBloomData bloom;

        public Nw4rEnvLight FindLight(int index)
        {
            foreach (var l in lights) if (l.index == index) return l;
            return null;
        }

        public static Nw4rEnvironmentData Parse(object root)
        {
            var d = new Nw4rEnvironmentData { name = J.Str(root, "name"), sport = J.Str(root, "sport") };
            var light = J.Obj(root, "light");
            if (light != null)
            {
                var amb = J.Arr(light, "ambientColors");
                d.ambientColors = new Color32[amb == null ? 0 : amb.Count];
                for (int k = 0; k < d.ambientColors.Length; k++) d.ambientColors[k] = Nw4rCoordinates.Color(J.Ints(amb[k]));
                d.globalColor = Nw4rCoordinates.Color(J.Ints(light, "globalColor"));
                foreach (var l in J.Objs(light, "lights")) d.lights.Add(Nw4rEnvLight.Parse(l));
            }
            var lm = J.Obj(root, "lightmap");
            if (lm != null) foreach (var t in J.Objs(lm, "textures")) d.lightTextures.Add(Nw4rLightTextureDef.Parse(t));
            var bl = J.Obj(root, "bloom");
            if (bl != null) d.bloom = Nw4rBloomData.Parse(bl);
            return d;
        }
    }

    /// <summary>environment_index.json: presets, cena -> preset e as 10 rampas da LightTexture.</summary>
    public sealed class Nw4rEnvironmentIndex
    {
        public readonly Dictionary<string, string> presetFiles = new Dictionary<string, string>();
        public readonly Dictionary<string, string> scenePresets = new Dictionary<string, string>();
        public float[][] ramps = new float[0][];
        public int lightTextureSize = 64;

        public string PresetForScene(string scenePath)
        {
            if (string.IsNullOrEmpty(scenePath)) return null;
            string p;
            return scenePresets.TryGetValue(scenePath.Replace('\\', '/').TrimStart('/'), out p) ? p : null;
        }

        public static Nw4rEnvironmentIndex Parse(object root)
        {
            var x = new Nw4rEnvironmentIndex { lightTextureSize = J.Int(root, "lightTextureSize", 64) };
            foreach (var p in J.Objs(root, "presets")) x.presetFiles[J.Str(p, "name")] = J.Str(p, "file");
            var sc = J.Obj(root, "scenes");
            if (sc != null) foreach (var kv in sc) x.scenePresets[kv.Key] = kv.Value as string;
            var rl = J.Arr(root, "ramps");
            x.ramps = new float[rl == null ? 0 : rl.Count][];
            for (int k = 0; k < x.ramps.Length; k++) x.ramps[k] = J.Floats(rl[k], "values");
            return x;
        }
    }
}
