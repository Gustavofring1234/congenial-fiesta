// Menu "Nw4r" do Editor: monta prefabs de modelos/colisões, importa animações 3D e partículas,
// e valida o resultado contra os relatórios do pipeline Python (index/*.json).
using System.Collections.Generic;
using System.IO;
using System.Text;
using LinuxSports.Core;
using LinuxSports.Engine;
using UnityEditor;
using UnityEngine;

namespace LinuxSports.EditorTools
{
    public static class Nw4rMenu
    {
        [MenuItem("Nw4r/1. Importar modelos e colisões (prefabs)")]
        public static void ImportModels()
        {
            var sidecars = new List<string>();
            foreach (var f in Directory.GetFiles(Nw4rModelPostprocessor.ModelsDir, "*.nw4r.json", SearchOption.AllDirectories))
                sidecars.Add(f.Replace('\\', '/'));
            sidecars.Sort();
            var glbs = new List<string>();
            foreach (var f in Directory.GetFiles(Nw4rModelPostprocessor.CollisionDir, "*.glb", SearchOption.AllDirectories))
                glbs.Add(f.Replace('\\', '/'));
            Nw4rModelPostprocessor.BuildModels(sidecars);
            Nw4rModelPostprocessor.BuildCollisions(glbs);
            Debug.Log("Nw4r: " + sidecars.Count + " modelos e " + glbs.Count + " colisões processados.");
        }

        [MenuItem("Nw4r/Importar tudo (1 + 2 + 3)")]
        public static void ImportEverything()
        {
            ImportModels();
            Nw4rAnimationImporter.ImportAll();
            Nw4rEffectImporter.ImportAll();
            Validate();
        }

        [MenuItem("Nw4r/Montagem automática ao importar .glb")]
        private static void ToggleAuto() { Nw4rModelPostprocessor.AutoBuild = !Nw4rModelPostprocessor.AutoBuild; }

        [MenuItem("Nw4r/Montagem automática ao importar .glb", true)]
        private static bool ToggleAutoValidate()
        {
            Menu.SetChecked("Nw4r/Montagem automática ao importar .glb", Nw4rModelPostprocessor.AutoBuild);
            return true;
        }

        [MenuItem("Nw4r/Validar importação")]
        public static void Validate()
        {
            var sb = new StringBuilder();
            int models = 0, missingPrefab = 0, noBones = 0, skinned = 0, clipsMissing = 0;
            foreach (var f in Directory.GetFiles(Nw4rModelPostprocessor.ModelsDir, "*.nw4r.json", SearchOption.AllDirectories))
            {
                models++;
                var sc = Json.Parse(File.ReadAllText(f));
                string id = J.Str(sc, "assetId");
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(Nw4rModelPostprocessor.PrefabModels + id + ".prefab");
                if (prefab == null) { missingPrefab++; sb.AppendLine("sem prefab: " + f); continue; }
                var info = prefab.GetComponent<Nw4rModelInfo>();
                if (info == null || info.bones.Count == 0) noBones++;
                skinned += prefab.GetComponentsInChildren<SkinnedMeshRenderer>(true).Length;
            }
            var manifestPath = Nw4rAnimationImporter.StreamingRoot + Nw4rAnimationPlayer.ManifestPath;
            int anims = 0;
            if (File.Exists(manifestPath))
            {
                foreach (var e in Nw4rAnimationEntry.ParseManifest(Json.Parse(File.ReadAllText(manifestPath))))
                {
                    anims++;
                    if (e.type == Nw4rAnimType.SCN0) continue;
                    if (e.modelAssetIds.Count == 0) { clipsMissing++; sb.AppendLine("animação sem modelo: " + e.id); continue; }
                    string clip = Nw4rAnimationImporter.OutRoot + e.modelAssetIds[0] + "/" + e.name + ".anim";
                    if (!File.Exists(clip)) { clipsMissing++; sb.AppendLine("clipe ausente: " + clip); }
                }
            }
            int effects = Directory.Exists(Nw4rEffectImporter.EffectsRoot + "Prefabs")
                ? Directory.GetFiles(Nw4rEffectImporter.EffectsRoot + "Prefabs", "*.prefab", SearchOption.AllDirectories).Length : 0;
            int collisions = Directory.Exists(Nw4rModelPostprocessor.PrefabCollision)
                ? Directory.GetFiles(Nw4rModelPostprocessor.PrefabCollision, "*.prefab").Length : 0;
            string summary = "Nw4r: " + models + " modelos (" + missingPrefab + " sem prefab, " + noBones + " sem ossos, " + skinned
                             + " SkinnedMeshRenderers), " + collisions + " colisões, " + anims + " animações (" + clipsMissing
                             + " sem clipe), " + effects + " prefabs de partícula.";
            Debug.Log(summary + (sb.Length > 0 ? "\n" + sb : ""));
        }
    }
}
