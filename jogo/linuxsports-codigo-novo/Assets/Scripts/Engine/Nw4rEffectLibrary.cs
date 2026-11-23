// Biblioteca de efeitos NW4R em tempo de execução (Resources/Effects), ver Nw4rParticleFactory.
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Engine
{
    /// <summary>Biblioteca de efeitos em tempo de execução: carrega pacotes de Resources/Effects e instancia
    /// emissores por nome (prefabs do Editor quando existem; senão monta na hora).</summary>
    public sealed class Nw4rEffectLibrary : MonoBehaviour
    {
        private static Nw4rEffectLibrary instance;
        private readonly Dictionary<string, object> emitters = new Dictionary<string, object>();
        private readonly Dictionary<string, string> emitterPack = new Dictionary<string, string>();
        private readonly Dictionary<string, Material> materials = new Dictionary<string, Material>();
        private bool indexed;

        public static Nw4rEffectLibrary Instance
        {
            get
            {
                if (instance == null)
                {
                    var go = new GameObject("[Nw4rEffectLibrary]");
                    DontDestroyOnLoad(go);
                    instance = go.AddComponent<Nw4rEffectLibrary>();
                }
                return instance;
            }
        }

        private void EnsureIndex()
        {
            if (indexed) return;
            indexed = true;
            var idx = Resources.Load<TextAsset>("Effects/effects_index");
            if (idx == null) { Debug.LogWarning("Nw4rEffectLibrary: Resources/Effects/effects_index.json ausente"); return; }
            foreach (var pack in J.Objs(Json.Parse(idx.text), "packs"))
            {
                var ta = Resources.Load<TextAsset>(J.Str(pack, "resource"));
                if (ta == null) continue;
                var doc = Json.Parse(ta.text);
                string pk = J.Str(pack, "pack");
                foreach (var em in J.Objs(doc, "emitters"))
                {
                    string name = J.Str(em, "name");
                    emitters[name] = em;
                    emitterPack[name] = pk;
                }
            }
        }

        public IEnumerable<string> EmitterNames { get { EnsureIndex(); return emitters.Keys; } }

        public bool Has(string emitter) { EnsureIndex(); return emitters.ContainsKey(emitter); }

        /// <summary>Cria e toca o emissor na posição. Destroi sozinho ao terminar se não for contínuo.</summary>
        public ParticleSystem Spawn(string emitter, Vector3 position, Quaternion rotation, Transform parent = null)
        {
            EnsureIndex();
            object em;
            if (!emitters.TryGetValue(emitter, out em)) { Debug.LogWarning("Nw4rEffectLibrary: emissor '" + emitter + "' não existe"); return null; }
            GameObject go;
            var prefab = Resources.Load<GameObject>("Effects/Prefabs/" + emitterPack[emitter] + "/" + emitter);
            if (prefab != null) go = Instantiate(prefab, position, rotation, parent);
            else
            {
                go = new GameObject(emitter);
                go.transform.SetParent(parent, false);
                go.transform.SetPositionAndRotation(position, rotation);
                var ps0 = go.AddComponent<ParticleSystem>();
                ps0.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
                Nw4rParticleFactory.Configure(ps0, em, MaterialFor(em));
            }
            var ps = go.GetComponent<ParticleSystem>();
            if (!ps.main.loop)
            {
                var main = ps.main;
                main.stopAction = ParticleSystemStopAction.Destroy;
            }
            ps.Play(true);
            return ps;
        }

        private Material MaterialFor(object em)
        {
            var res = J.Arr(J.Obj(em, "particle"), "textureResources");
            string texRes = res != null && res.Count > 0 ? res[0] as string : null;
            bool add = Nw4rParticleFactory.IsAdditive(J.Str(em, "category"));
            string key = (texRes ?? "none") + (add ? "+" : "-");
            Material m;
            if (!materials.TryGetValue(key, out m))
            {
                var tex = texRes != null ? Resources.Load<Texture2D>(texRes) : null;
                materials[key] = m = Nw4rParticleFactory.RuntimeMaterial(tex, add);
            }
            return m;
        }
    }
}
