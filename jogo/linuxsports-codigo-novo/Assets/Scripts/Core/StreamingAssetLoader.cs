// Carregamento assíncrono de StreamingAssets compatível com WebGL.
// No WebGL, Application.streamingAssetsPath é uma URL e System.IO não funciona: tudo passa por
// UnityWebRequest. Em outras plataformas o mesmo código funciona (file:// ou jar:// no Android).
// Respostas de texto ficam em cache (os manifestos são lidos por vários componentes).
using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;

namespace LinuxSports.Core
{
    public sealed class StreamingAssetLoader : MonoBehaviour
    {
        private static StreamingAssetLoader instance;
        private readonly Dictionary<string, string> textCache = new Dictionary<string, string>();
        private readonly Dictionary<string, Texture2D> textureCache = new Dictionary<string, Texture2D>();
        private readonly Dictionary<string, List<Action<string, string>>> pendingText = new Dictionary<string, List<Action<string, string>>>();
        private readonly Dictionary<string, List<Action<Texture2D, string>>> pendingTex = new Dictionary<string, List<Action<Texture2D, string>>>();

        /// <summary>Instância única, criada sob demanda e mantida entre cenas.</summary>
        public static StreamingAssetLoader Instance
        {
            get
            {
                if (instance == null)
                {
                    var go = new GameObject("[StreamingAssetLoader]");
                    DontDestroyOnLoad(go);
                    instance = go.AddComponent<StreamingAssetLoader>();
                }
                return instance;
            }
        }

        /// <summary>URL/caminho completo de um arquivo relativo a StreamingAssets (barras POSIX).</summary>
        public static string Url(string relative)
        {
            string root = Application.streamingAssetsPath;
            string rel = relative.Replace('\\', '/').TrimStart('/');
            string path = root.EndsWith("/") ? root + rel : root + "/" + rel;
            if (path.Contains("://") || path.StartsWith("jar:")) return EscapeSpaces(path);
            return "file://" + EscapeSpaces(path);
        }

        private static string EscapeSpaces(string url) { return url.Replace(" ", "%20").Replace("#", "%23"); }

        public void LoadText(string relative, Action<string> onDone, Action<string> onError = null)
        {
            string cached;
            if (textCache.TryGetValue(relative, out cached)) { onDone(cached); return; }
            List<Action<string, string>> waiters;
            Action<string, string> cb = (text, err) =>
            {
                if (err != null) { if (onError != null) onError(err); else Debug.LogWarning(err); }
                else onDone(text);
            };
            if (pendingText.TryGetValue(relative, out waiters)) { waiters.Add(cb); return; }
            pendingText[relative] = new List<Action<string, string>> { cb };
            StartCoroutine(TextRoutine(relative));
        }

        private IEnumerator TextRoutine(string relative)
        {
            using (var req = UnityWebRequest.Get(Url(relative)))
            {
                yield return req.SendWebRequest();
                string err = null, text = null;
                if (req.result != UnityWebRequest.Result.Success) err = "StreamingAssets: falha ao ler '" + relative + "': " + req.error;
                else { text = req.downloadHandler.text; textCache[relative] = text; }
                var waiters = pendingText[relative];
                pendingText.Remove(relative);
                foreach (var w in waiters) w(text, err);
            }
        }

        public void LoadJson(string relative, Action<object> onDone, Action<string> onError = null)
        {
            LoadText(relative, text =>
            {
                object parsed;
                try { parsed = Json.Parse(text); }
                catch (FormatException e)
                {
                    string msg = "JSON inválido em '" + relative + "': " + e.Message;
                    if (onError != null) onError(msg); else Debug.LogWarning(msg);
                    return;
                }
                onDone(parsed);
            }, onError);
        }

        public void LoadBytes(string relative, Action<byte[]> onDone, Action<string> onError = null)
        {
            StartCoroutine(BytesRoutine(relative, onDone, onError));
        }

        private IEnumerator BytesRoutine(string relative, Action<byte[]> onDone, Action<string> onError)
        {
            using (var req = UnityWebRequest.Get(Url(relative)))
            {
                yield return req.SendWebRequest();
                if (req.result != UnityWebRequest.Result.Success)
                {
                    string msg = "StreamingAssets: falha ao ler '" + relative + "': " + req.error;
                    if (onError != null) onError(msg); else Debug.LogWarning(msg);
                }
                else onDone(req.downloadHandler.data);
            }
        }

        /// <summary>Textura PNG de StreamingAssets (filtro bilinear, sem mipmaps, clamp).</summary>
        public void LoadTexture(string relative, Action<Texture2D> onDone, Action<string> onError = null)
        {
            Texture2D cached;
            if (textureCache.TryGetValue(relative, out cached) && cached != null) { onDone(cached); return; }
            List<Action<Texture2D, string>> waiters;
            Action<Texture2D, string> cb = (tex, err) =>
            {
                if (err != null) { if (onError != null) onError(err); else Debug.LogWarning(err); }
                else onDone(tex);
            };
            if (pendingTex.TryGetValue(relative, out waiters)) { waiters.Add(cb); return; }
            pendingTex[relative] = new List<Action<Texture2D, string>> { cb };
            StartCoroutine(TextureRoutine(relative));
        }

        private IEnumerator TextureRoutine(string relative)
        {
            using (var req = UnityWebRequestTexture.GetTexture(Url(relative), true))
            {
                yield return req.SendWebRequest();
                Texture2D tex = null;
                string err = null;
                if (req.result != UnityWebRequest.Result.Success) err = "StreamingAssets: falha ao ler textura '" + relative + "': " + req.error;
                else
                {
                    tex = DownloadHandlerTexture.GetContent(req);
                    tex.name = relative;
                    tex.wrapMode = TextureWrapMode.Clamp;
                    tex.filterMode = FilterMode.Bilinear;
                    textureCache[relative] = tex;
                }
                var waiters = pendingTex[relative];
                pendingTex.Remove(relative);
                foreach (var w in waiters) w(tex, err);
            }
        }

        /// <summary>Carrega vários textos e chama onDone quando todos terminarem (com erro ou não).</summary>
        public void LoadAllJson(IList<string> paths, Action<Dictionary<string, object>> onDone)
        {
            var result = new Dictionary<string, object>();
            if (paths.Count == 0) { onDone(result); return; }
            int left = paths.Count;
            foreach (var p in paths)
            {
                string path = p;
                LoadJson(path, o => { result[path] = o; if (--left == 0) onDone(result); },
                         e => { Debug.LogWarning(e); if (--left == 0) onDone(result); });
            }
        }

        public void ClearCache()
        {
            textCache.Clear();
            foreach (var t in textureCache.Values) if (t != null) Destroy(t);
            textureCache.Clear();
        }
    }
}
