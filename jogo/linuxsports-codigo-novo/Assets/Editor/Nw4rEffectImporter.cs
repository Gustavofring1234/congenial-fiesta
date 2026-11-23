// Gera prefabs de ParticleSystem nativo para os 380 emissores NW4R (.breff decodificados em
// Assets/Resources/Effects/<pacote>/<pacote>.effect.json, texturas .breft em PNG ao lado).
// Saída: Assets/Resources/Effects/Prefabs/<pacote>/<emissor>.prefab e materiais em
// Assets/Resources/Effects/Materials/<pacote>/. A configuração é a mesma do runtime
// (Nw4rParticleFactory.Configure), então prefab e geração em execução ficam idênticos.
using System.Collections.Generic;
using System.IO;
using LinuxSports.Core;
using LinuxSports.Engine;
using UnityEditor;
using UnityEngine;

namespace LinuxSports.EditorTools
{
    public static class Nw4rEffectImporter
    {
        public const string EffectsRoot = "Assets/Resources/Effects/";

        [MenuItem("Nw4r/3. Gerar prefabs de partículas (.breff)")]
        public static void ImportAll()
        {
            string idxPath = EffectsRoot + "effects_index.json";
            if (!File.Exists(idxPath)) { Debug.LogError("Nw4r: " + idxPath + " ausente (rode tools/export_effects.py)"); return; }
            var shader = Shader.Find("Nw4r/Particle");
            if (shader == null) { Debug.LogError("Nw4r: shader Nw4r/Particle não encontrado"); return; }
            var packs = new List<Dictionary<string, object>>(J.Objs(Json.Parse(File.ReadAllText(idxPath)), "packs"));
            int made = 0;
            try
            {
                for (int pi = 0; pi < packs.Count; pi++)
                {
                    string pack = J.Str(packs[pi], "pack");
                    string docPath = "Assets/Resources/" + J.Str(packs[pi], "resource") + ".effect.json";
                    if (!File.Exists(docPath)) { Debug.LogWarning("Nw4r: " + docPath + " ausente"); continue; }
                    var doc = Json.Parse(File.ReadAllText(docPath));
                    string prefabDir = EffectsRoot + "Prefabs/" + pack + "/";
                    string matDir = EffectsRoot + "Materials/" + pack + "/";
                    Directory.CreateDirectory(prefabDir);
                    Directory.CreateDirectory(matDir);
                    var emitters = new List<Dictionary<string, object>>(J.Objs(doc, "emitters"));
                    for (int ei = 0; ei < emitters.Count; ei++)
                    {
                        var em = emitters[ei];
                        string name = J.Str(em, "name");
                        EditorUtility.DisplayProgressBar("Nw4r: partículas", pack + "/" + name, (pi + ei / (float)emitters.Count) / packs.Count);
                        var mat = MaterialFor(em, matDir, shader);
                        var go = new GameObject(name);
                        try
                        {
                            var ps = go.AddComponent<ParticleSystem>();
                            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
                            Nw4rParticleFactory.Configure(ps, em, mat);
                            var tag = go.AddComponent<Nw4rEffectTag>();
                            tag.pack = pack;
                            tag.emitter = name;
                            tag.category = J.Str(em, "category");
                            PrefabUtility.SaveAsPrefabAsset(go, prefabDir + Safe(name) + ".prefab");
                            made++;
                        }
                        finally { Object.DestroyImmediate(go); }
                    }
                }
            }
            finally
            {
                EditorUtility.ClearProgressBar();
                AssetDatabase.SaveAssets();
            }
            Debug.Log("Nw4r: " + made + " prefabs de partícula gerados.");
        }

        private static string Safe(string s)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            return s;
        }

        private static Material MaterialFor(object em, string matDir, Shader shader)
        {
            var res = J.Arr(J.Obj(em, "particle"), "textureResources");
            string texRes = res != null && res.Count > 0 ? res[0] as string : null;
            bool additive = Nw4rParticleFactory.IsAdditive(J.Str(em, "category"));
            string matName = (texRes != null ? Path.GetFileName(texRes) : "none") + (additive ? "_add" : "_alpha");
            string path = matDir + Safe(matName) + ".mat";
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            bool created = mat == null;
            if (created) mat = new Material(shader) { name = matName };
            var tex = texRes != null ? AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Resources/" + texRes + ".png") : null;
            Nw4rParticleFactory.SetupMaterial(mat, tex, additive);
            if (created) AssetDatabase.CreateAsset(mat, path);
            else EditorUtility.SetDirty(mat);
            return mat;
        }
    }
}
