// Instancia prefabs de modelos NW4R (Resources/Prefabs/Models/<assetId>, gerados pelo menu Nw4r) e, se o
// import do Editor ainda não rodou, um primitivo substituto do mesmo tamanho para a partida continuar jogável.
using UnityEngine;

namespace LinuxSports.Activities
{
    public static class ModelSpawner
    {
        public static GameObject Spawn(string prefabResource, Transform parent, PrimitiveType fallback, Vector3 fallbackScale, Color fallbackColor, string name = null)
        {
            GameObject go = null;
            var prefab = !string.IsNullOrEmpty(prefabResource) ? Resources.Load<GameObject>(prefabResource) : null;
            if (prefab != null) go = Object.Instantiate(prefab, parent, false);
            else
            {
                go = GameObject.CreatePrimitive(fallback);
                go.transform.SetParent(parent, false);
                go.transform.localScale = fallbackScale;
                var col = go.GetComponent<Collider>();
                if (col != null) Object.Destroy(col);
                var r = go.GetComponent<Renderer>();
                if (r != null) Tint(r, fallbackColor);
            }
            if (name != null) go.name = name;
            return go;
        }

        public static void Tint(Renderer r, Color c)
        {
            var block = new MaterialPropertyBlock();
            r.GetPropertyBlock(block);
            block.SetColor("_BaseColor", c);
            block.SetColor("_Color", c);
            r.SetPropertyBlock(block);
        }

        public static Transform FindDeep(Transform root, string name)
        {
            if (root == null) return null;
            if (root.name == name) return root;
            for (int i = 0; i < root.childCount; i++)
            {
                var t = FindDeep(root.GetChild(i), name);
                if (t != null) return t;
            }
            return null;
        }

        /// <summary>Remove colliders de um modelo visual (a física usa colliders próprios).</summary>
        public static void StripColliders(GameObject go)
        {
            foreach (var c in go.GetComponentsInChildren<Collider>()) Object.Destroy(c);
        }
    }
}
