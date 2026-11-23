// Monta uma cena convertida (StreamingAssets/Scenes/**.scene.json) em tempo de execução:
// modelos e colisões a partir dos prefabs gerados pelo Editor (Resources/Prefabs/...) e os objetos do
// .pmp (cursos de golfe) com posição/rotação/escala já no referencial do Unity.
//
// Calibração do .pmp (index/pmp-unity-calibration.json, gerado por tools/stage_unity_assets.py):
//   - registro Z,Y,X -> colunas X,Y,Z da rotação; Unity = espelho em X (igual ao glTFast nos .glb);
//   - 1.359 de 1.361 objetos caem sobre a colisão espelhada (mediana da altura ≤ 0,89 unidade);
//   - o +Z do tee aponta para os pinos em 12 de 12 cursos.
// O tipo do objeto (typeId) é só um número no .pmp; `objectPrefabs` liga tipos a prefabs (tee, pino...).
using System;
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Engine
{
    [Serializable]
    public sealed class PmpTypePrefab
    {
        public int typeId;
        public GameObject prefab;
        public string label;
    }

    public sealed class Nw4rSceneLoader : MonoBehaviour
    {
        [Tooltip("Caminho relativo a StreamingAssets, ex.: Scenes/assets/maps/golf/glf_course_E3.scene.json")]
        public string scenePath;
        public bool loadOnStart = true;
        public bool loadModels = true;
        public bool loadCollision = true;
        [Tooltip("Mostrar a malha de colisão (depuração).")]
        public bool showCollision;
        public List<PmpTypePrefab> objectPrefabs = new List<PmpTypePrefab>();
        [Tooltip("Cria marcadores para tipos sem prefab.")]
        public bool markersForUnknownTypes = true;

        public event Action<Nw4rSceneLoader> Loaded;

        public Transform ModelsRoot { get; private set; }
        public Transform CollisionRoot { get; private set; }
        public Transform ObjectsRoot { get; private set; }
        public readonly List<PmpObject> Objects = new List<PmpObject>();
        public readonly List<MeshCollider> Colliders = new List<MeshCollider>();
        public string AssetId { get; private set; }
        public string Sport { get; private set; }
        public object Raw { get; private set; }

        private void Start()
        {
            if (loadOnStart && !string.IsNullOrEmpty(scenePath)) Load(scenePath);
        }

        public void Load(string path)
        {
            scenePath = path;
            StreamingAssetLoader.Instance.LoadJson(path, Build, err => Debug.LogError(err));
        }

        public void Clear()
        {
            foreach (Transform t in new[] { ModelsRoot, CollisionRoot, ObjectsRoot })
                if (t != null) Destroy(t.gameObject);
            Objects.Clear();
            Colliders.Clear();
        }

        private Transform Group(string name)
        {
            var go = new GameObject(name);
            go.transform.SetParent(transform, false);
            return go.transform;
        }

        private void Build(object root)
        {
            Clear();
            Raw = root;
            AssetId = J.Str(root, "assetId");
            Sport = J.Str(root, "sport");
            ModelsRoot = Group("Models");
            CollisionRoot = Group("Collision");
            ObjectsRoot = Group("PmpObjects");
            if (loadModels)
            {
                foreach (var m in J.Objs(root, "models"))
                {
                    string prefab = J.Str(m, "prefab");
                    var go = prefab != null ? Resources.Load<GameObject>(prefab) : null;
                    if (go == null) { Debug.LogWarning("Cena " + scenePath + ": prefab ausente " + prefab + " (rode o menu Nw4r > Importar modelos)"); continue; }
                    Instantiate(go, ModelsRoot, false).name = J.Str(m, "name", go.name);
                }
            }
            if (loadCollision)
            {
                foreach (var c in J.Objs(root, "collision"))
                {
                    string prefab = J.Str(c, "prefab");
                    var go = prefab != null ? Resources.Load<GameObject>(prefab) : null;
                    if (go == null) { Debug.LogWarning("Cena " + scenePath + ": colisão ausente " + prefab); continue; }
                    var inst = Instantiate(go, CollisionRoot, false);
                    inst.name = J.Str(c, "name", go.name);
                    Colliders.AddRange(inst.GetComponentsInChildren<MeshCollider>());
                    foreach (var r in inst.GetComponentsInChildren<Renderer>()) r.enabled = showCollision;
                }
            }
            int i = 0;
            foreach (var o in J.Objs(root, "objects"))
            {
                int type = J.Int(o, "typeId");
                var pos = J.Floats(o, "position");
                var rot = J.Floats(o, "rotation");
                var scl = J.Floats(o, "scale");
                GameObject prefab = null;
                string label = null;
                foreach (var tp in objectPrefabs) if (tp.typeId == type) { prefab = tp.prefab; label = tp.label; break; }
                GameObject go;
                if (prefab != null) go = Instantiate(prefab, ObjectsRoot, false);
                else if (markersForUnknownTypes)
                {
                    go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    go.transform.SetParent(ObjectsRoot, false);
                    var col = go.GetComponent<Collider>();
                    if (col != null) Destroy(col);
                    go.transform.localScale = Vector3.one * 4f;
                }
                else { i++; continue; }
                go.name = (label ?? ("pmp_type" + type)) + "_" + i;
                go.transform.localPosition = new Vector3(pos[0], pos[1], pos[2]);
                go.transform.localRotation = new Quaternion(rot[0], rot[1], rot[2], rot[3]);
                if (prefab != null) go.transform.localScale = new Vector3(scl[0], scl[1], scl[2]);
                var po = go.AddComponent<PmpObject>();
                po.typeId = type;
                po.variant = J.Int(o, "variant");
                po.index = i++;
                Objects.Add(po);
            }
            if (Loaded != null) Loaded(this);
        }

        /// <summary>Objetos do .pmp de um tipo (0 = tee e 1 = pino nos cursos de golfe).</summary>
        public List<PmpObject> ObjectsOfType(int typeId)
        {
            return Objects.FindAll(o => o.typeId == typeId);
        }

        /// <summary>Altura do terreno (colisão) sob um ponto, via raycast nas MeshColliders da cena.</summary>
        public bool GroundHeight(Vector3 p, out float y, float probe = 5000f)
        {
            RaycastHit best = default(RaycastHit);
            bool found = false;
            var ray = new Ray(new Vector3(p.x, p.y + probe * 0.5f, p.z), Vector3.down);
            foreach (var c in Colliders)
            {
                RaycastHit h;
                if (c != null && c.Raycast(ray, out h, probe) && (!found || h.distance < best.distance)) { best = h; found = true; }
            }
            y = found ? best.point.y : p.y;
            return found;
        }
    }
}
