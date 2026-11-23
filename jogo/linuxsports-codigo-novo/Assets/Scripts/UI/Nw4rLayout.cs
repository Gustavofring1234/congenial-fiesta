// Player de layouts NW4R (138 telas/HUD) e das 647 animações 2D em UnityEngine.UI.
//
// Coordenadas: origem no centro da tela, Y para cima (igual ao RectTransform). Cada painel vira um
// RectTransform com tamanho = size e pivô = origem (0..8: coluna esq/centro/dir, linha topo/centro/base);
// os filhos se ancoram no pivô do pai, como no NW4R.
// Alfa: influencedAlpha -> CanvasGroup (afeta os filhos); senão só o Graphic do próprio painel.
// Animação: alvos sem painel/material correspondente (47 animações citam painéis inexistentes,
// index/anim-missing-targets.json) são ignorados em silêncio; ficam contados em MissingTargets.
using System;
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;
using UnityEngine.UI;

namespace LinuxSports.UI
{
    public sealed class Nw4rPaneState
    {
        public LytPane pane;
        public RectTransform rect;
        public CanvasGroup group;
        public Nw4rQuadGraphic quad;
        public Nw4rTextGraphic text;
        public readonly List<Nw4rQuadGraphic> frames = new List<Nw4rQuadGraphic>();
        public Vector3 t, r;
        public Vector2 s, size;
        public float alpha;
        public bool visible;
        public Color32[] vtx;
    }

    public sealed class Nw4rLayout : MonoBehaviour
    {
        public string LayoutName { get; private set; }
        /// <summary>assetId do ui_manifest (nomes de layout se repetem entre pastas, ex.: menuBg_00).</summary>
        public string SourceId { get; set; }
        public LytLayout Data { get; private set; }
        public readonly Dictionary<string, Nw4rPaneState> Panes = new Dictionary<string, Nw4rPaneState>();
        public readonly Dictionary<string, LytMaterialState> Materials = new Dictionary<string, LytMaterialState>();
        public readonly List<LytMaterialState> MaterialList = new List<LytMaterialState>();

        public float speed = 1f;
        public event Action<Nw4rLayout, string> AnimationFinished;

        private sealed class Binding { public LytAnimTarget target; public Nw4rPaneState pane; public LytMaterialState mat; }
        private sealed class Playing
        {
            public LytAnimation anim;
            public List<Binding> bound = new List<Binding>();
            public Texture2D[] textures = new Texture2D[0];
            public float frame;
            public bool loop;
            public int missing;
        }

        private readonly List<Playing> playing = new List<Playing>();
        public int MissingTargets { get; private set; }

        // ------------------------------------------------------------------ construção
        public void Build(string layoutName, LytLayout data, Texture2D[] textures, BitmapFont[] fonts, Shader shader)
        {
            LayoutName = layoutName;
            Data = data;
            var root = (RectTransform)transform;
            root.sizeDelta = data.screen;
            for (int i = 0; i < data.materials.Count; i++)
            {
                var md = data.materials[i];
                Texture2D tex = md.textureMaps.Length > 0 && md.textureMaps[0] >= 0 && md.textureMaps[0] < textures.Length ? textures[md.textureMaps[0]] : null;
                if (tex != null && md.wrapS.Length > 0)
                {
                    tex.wrapModeU = Wrap(md.wrapS[0]);
                    tex.wrapModeV = Wrap(md.wrapT[0]);
                }
                var st = new LytMaterialState(md, tex, shader);
                MaterialList.Add(st);
                if (!Materials.ContainsKey(md.name)) Materials[md.name] = st;
            }
            if (data.root != null) BuildPane(data.root, root, new Vector2(0.5f, 0.5f), fonts);
            foreach (var p in Panes.Values) ApplyPane(p);
        }

        private static TextureWrapMode Wrap(int gx) { return gx == 1 ? TextureWrapMode.Repeat : gx == 2 ? TextureWrapMode.Mirror : TextureWrapMode.Clamp; }

        private LytMaterialState Mat(int index) { return index >= 0 && index < MaterialList.Count ? MaterialList[index] : null; }

        private void BuildPane(LytPane p, RectTransform parent, Vector2 parentPivot, BitmapFont[] fonts)
        {
            var go = new GameObject(p.name, typeof(RectTransform));
            var rt = (RectTransform)go.transform;
            rt.SetParent(parent, false);
            rt.anchorMin = rt.anchorMax = parentPivot;
            int col = p.origin % 3, row = p.origin / 3;
            rt.pivot = new Vector2(col * 0.5f, 1f - row * 0.5f);
            var st = new Nw4rPaneState
            {
                pane = p, rect = rt, t = p.translate, r = p.rotate, s = p.scale, size = p.size,
                alpha = p.alpha / 255f, visible = p.visible,
            };
            if (p.influencedAlpha) st.group = go.AddComponent<CanvasGroup>();
            LytQuad quad = p.picture ?? p.windowContent;
            if (quad != null)
            {
                st.quad = go.AddComponent<Nw4rQuadGraphic>();
                st.quad.raycastTarget = false;
                st.quad.state = Mat(quad.material);
                st.quad.texCoords = quad.texCoords;
                st.vtx = (Color32[])quad.vertexColors.Clone();
                st.quad.vertexColors = st.vtx;
                if (st.quad.state != null) st.quad.state.graphics.Add(st.quad);
            }
            if (p.type == "window" && p.windowFrames.Count > 0)
            {
                bool one = p.windowFrames.Count == 1;
                for (int k = 0; k < 4; k++)
                {
                    var fr = p.windowFrames[one ? 0 : Mathf.Min(k, p.windowFrames.Count - 1)];
                    var fgo = new GameObject("frame" + k, typeof(RectTransform));
                    var frt = (RectTransform)fgo.transform;
                    frt.SetParent(rt, false);
                    frt.anchorMin = frt.anchorMax = new Vector2(k % 2, 1 - k / 2);
                    frt.pivot = frt.anchorMin;
                    var g = fgo.AddComponent<Nw4rQuadGraphic>();
                    g.raycastTarget = false;
                    g.state = Mat(fr.Key);
                    g.flip = (one ? k : 0) ^ fr.Value;
                    if (g.state != null) g.state.graphics.Add(g);
                    st.frames.Add(g);
                }
            }
            if (p.text != null)
            {
                st.text = go.AddComponent<Nw4rTextGraphic>();
                st.text.raycastTarget = false;
                st.text.state = Mat(p.text.material);
                st.text.def = p.text;
                st.text.font = p.text.font >= 0 && p.text.font < fonts.Length ? fonts[p.text.font] : null;
                st.text.text = p.text.text;
                if (st.text.state != null) st.text.state.graphics.Add(st.text);
            }
            if (!Panes.ContainsKey(p.name)) Panes[p.name] = st;
            foreach (var c in p.children) BuildPane(c, rt, rt.pivot, fonts);
        }

        private void ApplyPane(Nw4rPaneState s)
        {
            var rt = s.rect;
            rt.anchoredPosition3D = new Vector3(s.t.x, s.t.y, -s.t.z);
            rt.localRotation = Quaternion.Euler(s.r.x, s.r.y, s.r.z);
            rt.localScale = new Vector3(s.s.x, s.s.y, 1f);
            rt.sizeDelta = new Vector2(Mathf.Abs(s.size.x), Mathf.Abs(s.size.y));
            if (rt.gameObject.activeSelf != s.visible) rt.gameObject.SetActive(s.visible);
            if (s.group != null) s.group.alpha = s.alpha;
            float own = s.group != null ? 1f : s.alpha;
            if (s.quad != null) { s.quad.paneAlpha = own; s.quad.SetVerticesDirty(); }
            if (s.text != null) { s.text.paneAlpha = own; s.text.SetVerticesDirty(); }
            if (s.frames.Count > 0)
            {
                float w = rt.sizeDelta.x, h = rt.sizeDelta.y;
                foreach (var f in s.frames)
                {
                    var tex = f.state != null ? f.state.Texture : null;
                    float cw = tex != null ? Mathf.Min(tex.width, w / 2f) : 0f, ch = tex != null ? Mathf.Min(tex.height, h / 2f) : 0f;
                    ((RectTransform)f.transform).sizeDelta = new Vector2(cw, ch);
                    f.paneAlpha = own;
                    f.SetVerticesDirty();
                }
            }
        }

        // ------------------------------------------------------------------ texto
        /// <summary>Troca o texto de um painel de texto (ex.: com TextManager). Retorna false se o painel não existir.</summary>
        public bool SetText(string pane, string value)
        {
            Nw4rPaneState s;
            if (!Panes.TryGetValue(pane, out s) || s.text == null) return false;
            s.text.SetText(value);
            return true;
        }

        public bool SetVisible(string pane, bool visible)
        {
            Nw4rPaneState s;
            if (!Panes.TryGetValue(pane, out s)) return false;
            s.visible = visible;
            ApplyPane(s);
            return true;
        }

        /// <summary>Retângulo de tela de um painel "bounding" (para botões/toque).</summary>
        public RectTransform PaneRect(string pane)
        {
            Nw4rPaneState s;
            return Panes.TryGetValue(pane, out s) ? s.rect : null;
        }

        // ------------------------------------------------------------------ animação
        /// <summary>Liga uma animação já carregada. Alvos ausentes são ignorados em silêncio.</summary>
        public void Play(LytAnimation anim, Texture2D[] animTextures, bool? loop = null, bool additive = false)
        {
            if (!additive) StopAll();
            var pl = new Playing { anim = anim, textures = animTextures ?? new Texture2D[0], loop = loop ?? anim.loop };
            foreach (var tg in anim.targets)
            {
                if (tg.material)
                {
                    LytMaterialState ms;
                    if (Materials.TryGetValue(tg.name, out ms)) pl.bound.Add(new Binding { target = tg, mat = ms });
                    else pl.missing++;
                }
                else
                {
                    Nw4rPaneState ps;
                    if (Panes.TryGetValue(tg.name, out ps)) pl.bound.Add(new Binding { target = tg, pane = ps });
                    else pl.missing++;
                }
            }
            MissingTargets = pl.missing;
            playing.Add(pl);
            ApplyFrame(pl, 0f);
        }

        public void StopAll() { playing.Clear(); }

        public bool IsPlaying(string animName)
        {
            foreach (var p in playing) if (p.anim.name == animName) return true;
            return false;
        }

        /// <summary>Posiciona a animação em um quadro (sem avançar o tempo).</summary>
        public void Seek(string animName, float frame)
        {
            foreach (var p in playing) if (p.anim.name == animName) { p.frame = frame; ApplyFrame(p, frame); }
        }

        private void Update()
        {
            if (playing.Count == 0) return;
            float df = Time.unscaledDeltaTime * Nw4rCoordinates.FrameRate * speed;
            for (int i = playing.Count - 1; i >= 0; i--)
            {
                var p = playing[i];
                float len = Mathf.Max(1, p.anim.frameSize);
                p.frame += df;
                bool done = false;
                if (p.frame >= len)
                {
                    if (p.loop) p.frame %= len;
                    else { p.frame = len; done = true; }
                }
                ApplyFrame(p, p.frame);
                if (done)
                {
                    playing.RemoveAt(i);
                    if (AnimationFinished != null) AnimationFinished(this, p.anim.name);
                }
            }
        }

        private static int Channel(char c) { return c == 'r' ? 0 : c == 'g' ? 1 : c == 'b' ? 2 : 3; }

        private static void SetChannel(ref Color32 c, int ch, float v)
        {
            byte b = (byte)Mathf.Clamp(Mathf.RoundToInt(v), 0, 255);
            if (ch == 0) c.r = b; else if (ch == 1) c.g = b; else if (ch == 2) c.b = b; else c.a = b;
        }

        private void ApplyFrame(Playing pl, float frame)
        {
            var dirtyMats = new HashSet<LytMaterialState>();
            var movedPanes = new HashSet<Nw4rPaneState>();
            foreach (var b in pl.bound)
            {
                if (b.mat != null)
                {
                    var ms = b.mat;
                    foreach (var tr in b.target.tracks)
                    {
                        float v = tr.Sample(frame);
                        string prop = tr.property;
                        int dot = prop.IndexOf('.');
                        if (dot > 0 && dot == prop.Length - 2)
                        {
                            string head = prop.Substring(0, dot);
                            int ch = Channel(prop[prop.Length - 1]);
                            if (head.StartsWith("tevColor") && head.Length == 9)
                            {
                                int k = head[8] - '0';
                                if (k >= 0 && k < 3) SetChannel(ref ms.tev[k], ch, v);
                            }
                            else if (!head.StartsWith("konstColor")) SetChannel(ref ms.color, ch, v);
                        }
                        else if (prop == "textureIndex")
                        {
                            int ti = Mathf.RoundToInt(v);
                            ms.overrideTexture = ti >= 0 && ti < pl.textures.Length ? pl.textures[ti] : null;
                        }
                        else if (tr.index < ms.srtScale.Length)
                        {
                            switch (prop)
                            {
                                case "translateS": ms.srtTranslate[tr.index].x = v; break;
                                case "translateT": ms.srtTranslate[tr.index].y = v; break;
                                case "scaleS": ms.srtScale[tr.index].x = v; break;
                                case "scaleT": ms.srtScale[tr.index].y = v; break;
                                case "rotate": ms.srtRotate[tr.index] = v; break;
                            }
                        }
                    }
                    dirtyMats.Add(ms);
                }
                else
                {
                    var s = b.pane;
                    foreach (var tr in b.target.tracks)
                    {
                        float v = tr.Sample(frame);
                        string prop = tr.property;
                        char last = prop[prop.Length - 1];
                        int axis = last == 'X' ? 0 : last == 'Y' ? 1 : last == 'Z' ? 2 : -1;
                        if (prop.StartsWith("translate")) { if (axis >= 0) s.t[axis] = v; }
                        else if (prop.StartsWith("rotate")) { if (axis >= 0) s.r[axis] = v; }
                        else if (prop.StartsWith("scale")) { if (axis == 0) s.s.x = v; else if (axis == 1) s.s.y = v; }
                        else if (prop == "width") s.size.x = v;
                        else if (prop == "height") s.size.y = v;
                        else if (prop == "visible") s.visible = v >= 0.5f;
                        else if (prop == "alpha") s.alpha = Mathf.Clamp(v, 0f, 255f) / 255f;
                        else if (prop.StartsWith("vertexColor") && s.vtx != null && prop.Length >= 16)
                        {
                            string corner = prop.Substring(11, 2);
                            int ci = corner == "LT" ? 0 : corner == "RT" ? 1 : corner == "LB" ? 2 : corner == "RB" ? 3 : -1;
                            if (ci >= 0) SetChannel(ref s.vtx[ci], Channel(prop[prop.Length - 1]), v);
                        }
                    }
                    movedPanes.Add(s);
                }
            }
            foreach (var m in dirtyMats) m.Push();
            foreach (var p in movedPanes) ApplyPane(p);
        }

        private void OnDestroy()
        {
            foreach (var m in MaterialList) if (m.material != null) Destroy(m.material);
        }
    }
}
