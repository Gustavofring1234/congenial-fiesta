// Catálogo dos 138 layouts (StreamingAssets/UI/ui_manifest.json) e fábrica de Nw4rLayout.
// Carrega layout, texturas (PNG) e fontes (font.json + atlas) por UnityWebRequest (WebGL) e monta a
// hierarquia sob um RectTransform. Animações 2D são carregadas sob demanda (PlayAnimation).
using System;
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.UI
{
    public sealed class Nw4rLayoutLibrary : MonoBehaviour
    {
        public const string ManifestPath = "UI/ui_manifest.json";
        private const string Root = "UI/";

        private static Nw4rLayoutLibrary instance;
        private object manifest;
        private readonly Dictionary<string, object> byName = new Dictionary<string, object>();
        private readonly Dictionary<string, object> byId = new Dictionary<string, object>();
        private readonly Dictionary<string, BitmapFont> fonts = new Dictionary<string, BitmapFont>();
        private readonly Dictionary<string, LytAnimation> anims = new Dictionary<string, LytAnimation>();
        private readonly List<Action> waiters = new List<Action>();
        private bool loading;
        private Shader shader;

        public static Nw4rLayoutLibrary Instance
        {
            get
            {
                if (instance == null)
                {
                    var go = new GameObject("[Nw4rLayoutLibrary]");
                    DontDestroyOnLoad(go);
                    instance = go.AddComponent<Nw4rLayoutLibrary>();
                }
                return instance;
            }
        }

        public bool Ready => manifest != null;
        public IEnumerable<string> LayoutNames => byName.Keys;

        public void EnsureLoaded(Action onReady)
        {
            if (manifest != null) { onReady(); return; }
            waiters.Add(onReady);
            if (loading) return;
            loading = true;
            StreamingAssetLoader.Instance.LoadJson(ManifestPath, m =>
            {
                manifest = m;
                foreach (var l in J.Objs(m, "layouts"))
                {
                    byName[J.Str(l, "name")] = l;
                    byId[J.Str(l, "assetId")] = l;
                }
                loading = false;
                var w = waiters.ToArray();
                waiters.Clear();
                foreach (var a in w) a();
            }, e => { loading = false; Debug.LogError(e); });
        }

        private object Entry(string nameOrId)
        {
            object e;
            if (byName.TryGetValue(nameOrId, out e) || byId.TryGetValue(nameOrId, out e)) return e;
            return null;
        }

        /// <summary>Nomes das animações 2D de um layout.</summary>
        public List<string> AnimationsOf(string layout)
        {
            var r = new List<string>();
            foreach (var a in J.Objs(Entry(layout), "animations")) r.Add(J.Str(a, "name"));
            return r;
        }

        /// <summary>Cria o layout sob `parent`. onDone recebe null se o layout não existir.</summary>
        public void Create(string layout, RectTransform parent, Action<Nw4rLayout> onDone)
        {
            EnsureLoaded(() =>
            {
                var entry = Entry(layout);
                if (entry == null) { Debug.LogWarning("Nw4rLayoutLibrary: layout '" + layout + "' não existe"); onDone(null); return; }
                if (shader == null) shader = Shader.Find("Nw4r/UI") ?? Shader.Find("UI/Default");
                var loader = StreamingAssetLoader.Instance;
                loader.LoadJson(Root + J.Str(entry, "file"), raw =>
                {
                    var data = LytLayout.Parse(raw);
                    var texEntries = new List<Dictionary<string, object>>(J.Objs(entry, "textures"));
                    var fontEntries = new List<Dictionary<string, object>>(J.Objs(entry, "fonts"));
                    var textures = new Texture2D[texEntries.Count];
                    var fontArr = new BitmapFont[fontEntries.Count];
                    int left = texEntries.Count + fontEntries.Count + 1;
                    Action step = () =>
                    {
                        if (--left > 0) return;
                        var go = new GameObject(J.Str(entry, "name"), typeof(RectTransform));
                        var rt = (RectTransform)go.transform;
                        rt.SetParent(parent, false);
                        rt.anchorMin = rt.anchorMax = rt.pivot = new Vector2(0.5f, 0.5f);
                        var lay = go.AddComponent<Nw4rLayout>();
                        lay.SourceId = J.Str(entry, "assetId");
                        lay.Build(J.Str(entry, "name"), data, textures, fontArr, shader);
                        onDone(lay);
                    };
                    for (int i = 0; i < texEntries.Count; i++)
                    {
                        int k = i;
                        string png = J.Str(texEntries[i], "png");
                        if (png == null) { step(); continue; }
                        loader.LoadTexture(Root + png, t => { textures[k] = t; step(); }, e => { Debug.LogWarning(e); step(); });
                    }
                    for (int i = 0; i < fontEntries.Count; i++)
                    {
                        int k = i;
                        string f = J.Str(fontEntries[i], "font");
                        if (f == null) { step(); continue; }
                        LoadFont(f, bf => { fontArr[k] = bf; step(); });
                    }
                    step();
                }, e => { Debug.LogError(e); onDone(null); });
            });
        }

        private void LoadFont(string path, Action<BitmapFont> onDone)
        {
            BitmapFont cached;
            if (fonts.TryGetValue(path, out cached)) { onDone(cached); return; }
            var loader = StreamingAssetLoader.Instance;
            loader.LoadJson(Root + path, raw =>
            {
                var f = BitmapFont.Parse(raw);
                if (f.pagePath == null) { fonts[path] = f; onDone(f); return; }
                loader.LoadTexture(Root + f.pagePath, t => { f.page = t; fonts[path] = f; onDone(f); },
                                   e => { Debug.LogWarning(e); onDone(f); });
            }, e => { Debug.LogWarning(e); onDone(null); });
        }

        /// <summary>Carrega (uma vez) e toca uma animação 2D do layout. Alvos ausentes são ignorados.</summary>
        public void PlayAnimation(Nw4rLayout layout, string animName, bool? loop = null, bool additive = false, Action onStarted = null)
        {
            EnsureLoaded(() =>
            {
                object animEntry = null;
                foreach (var a in J.Objs(Entry(layout.SourceId ?? layout.LayoutName), "animations"))
                    if (J.Str(a, "name") == animName || J.Str(a, "assetId") == animName) { animEntry = a; break; }
                if (animEntry == null) { Debug.LogWarning("Nw4rLayoutLibrary: '" + layout.LayoutName + "' não tem a animação '" + animName + "'"); return; }
                string file = J.Str(animEntry, "file");
                var texPaths = J.Strings(animEntry, "textures");
                Action<LytAnimation> play = anim =>
                {
                    var tex = new Texture2D[texPaths.Count];
                    int left = texPaths.Count + 1;
                    Action step = () =>
                    {
                        if (--left > 0) return;
                        if (layout == null) return;
                        layout.Play(anim, tex, loop, additive);
                        onStarted?.Invoke();
                    };
                    for (int i = 0; i < texPaths.Count; i++)
                    {
                        int k = i;
                        if (texPaths[i] == null) { step(); continue; }
                        StreamingAssetLoader.Instance.LoadTexture(Root + texPaths[i], t => { tex[k] = t; step(); }, e => { Debug.LogWarning(e); step(); });
                    }
                    step();
                };
                LytAnimation cachedAnim;
                if (anims.TryGetValue(file, out cachedAnim)) { play(cachedAnim); return; }
                StreamingAssetLoader.Instance.LoadJson(Root + file, raw =>
                {
                    var anim = LytAnimation.Parse(raw, J.Str(animEntry, "name"));
                    anims[file] = anim;
                    play(anim);
                }, e => Debug.LogWarning(e));
            });
        }
    }
}
