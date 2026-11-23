// Estrutura dos layouts 2D (.layout.json, NW4R LYT) e das animações 2D (.anim.json, RLPA/RLVC/RLTP/RLVI/RLTS/RLMC),
// lidos de StreamingAssets/UI (cópia de linuxsports-web-wispt/assets feita por tools/stage_unity_assets.py).
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.UI
{
    public sealed class LytMaterial
    {
        public string name;
        public Color32[] tev = new Color32[3];
        public Color32 color = new Color32(255, 255, 255, 255);
        public bool hasColor;
        public int[] textureMaps = new int[0];
        public int[] wrapS = new int[0], wrapT = new int[0];
        public Vector2[] srtTranslate = new Vector2[0], srtScale = new Vector2[0];
        public float[] srtRotate = new float[0];
        public bool additive;
    }

    public sealed class LytQuad
    {
        public int material = -1;
        public Color32[] vertexColors = new Color32[4];
        public Vector2[] texCoords = { new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1), new Vector2(1, 1) };
    }

    public sealed class LytText
    {
        public int material = -1, font, textOrigin, alignment, maxChars;
        public string text;
        public Color32 top, bottom;
        public Vector2 fontSize;
        public float charSpace, lineSpace;
    }

    public sealed class LytPane
    {
        public string type, name, userData;
        public bool visible, influencedAlpha;
        public int origin, alpha;
        public Vector3 translate, rotate;
        public Vector2 scale, size;
        public LytQuad picture;
        public LytText text;
        public LytQuad windowContent;
        public readonly List<KeyValuePair<int, int>> windowFrames = new List<KeyValuePair<int, int>>(); // (material, flip)
        public readonly List<LytPane> children = new List<LytPane>();
    }

    public sealed class LytLayout
    {
        public string assetId;
        public Vector2 screen;
        public bool centered;
        public readonly List<string> textureNames = new List<string>();
        public readonly List<LytMaterial> materials = new List<LytMaterial>();
        public LytPane root;

        private static Color32 Col(object o) { return Nw4rCoordinates.Color(J.Ints(o)); }

        private static LytQuad Quad(object q)
        {
            if (q == null) return null;
            var r = new LytQuad { material = J.Int(q, "material", -1) };
            var vc = J.Arr(q, "vertexColors");
            for (int i = 0; i < 4; i++) r.vertexColors[i] = vc != null && i < vc.Count ? Col(vc[i]) : new Color32(255, 255, 255, 255);
            var tc = J.Arr(q, "texCoords");
            if (tc != null && tc.Count > 0)
            {
                var set = tc[0] as List<object>;
                if (set != null && set.Count >= 4)
                    for (int i = 0; i < 4; i++) { var uv = J.Floats(set[i]); r.texCoords[i] = new Vector2(uv[0], uv[1]); }
            }
            return r;
        }

        private static LytPane Pane(object p)
        {
            var t = J.Floats(p, "translate");
            var rt = J.Floats(p, "rotate");
            var sc = J.Floats(p, "scale");
            var sz = J.Floats(p, "size");
            var pane = new LytPane
            {
                type = J.Str(p, "type"), name = J.Str(p, "name"), userData = J.Str(p, "userData", ""),
                visible = J.Bool(p, "visible", true), influencedAlpha = J.Bool(p, "influencedAlpha"),
                origin = J.Int(p, "origin", 4), alpha = J.Int(p, "alpha", 255),
                translate = new Vector3(t[0], t[1], t.Length > 2 ? t[2] : 0),
                rotate = new Vector3(rt[0], rt[1], rt[2]),
                scale = new Vector2(sc[0], sc[1]), size = new Vector2(sz[0], sz[1]),
            };
            if (pane.type == "picture") pane.picture = Quad(J.Get(p, "picture"));
            else if (pane.type == "window")
            {
                var w = J.Get(p, "window");
                pane.windowContent = Quad(J.Get(w, "content"));
                foreach (var f in J.Objs(w, "frames")) pane.windowFrames.Add(new KeyValuePair<int, int>(J.Int(f, "material"), J.Int(f, "flip")));
            }
            else if (pane.type == "text")
            {
                var x = J.Get(p, "text");
                var cols = J.Arr(x, "colors");
                var fs = J.Floats(x, "fontSize");
                pane.text = new LytText
                {
                    material = J.Int(x, "material", -1), font = J.Int(x, "font"), text = J.Str(x, "text", ""),
                    maxChars = J.Int(x, "maxChars"), textOrigin = J.Int(x, "textOrigin", 4), alignment = J.Int(x, "alignment"),
                    top = cols != null && cols.Count > 0 ? Col(cols[0]) : new Color32(255, 255, 255, 255),
                    bottom = cols != null && cols.Count > 1 ? Col(cols[1]) : new Color32(255, 255, 255, 255),
                    fontSize = fs.Length >= 2 ? new Vector2(fs[0], fs[1]) : new Vector2(24, 24),
                    charSpace = J.F(x, "charSpace"), lineSpace = J.F(x, "lineSpace"),
                };
            }
            foreach (var c in J.Objs(p, "children")) pane.children.Add(Pane(c));
            return pane;
        }

        public static LytLayout Parse(object root)
        {
            var l = new LytLayout { assetId = J.Str(root, "assetId") };
            var scr = J.Obj(root, "screen");
            l.screen = new Vector2(J.F(scr, "width", 608), J.F(scr, "height", 456));
            l.centered = J.Bool(scr, "centered", true);
            foreach (var t in J.Objs(root, "textures")) l.textureNames.Add(J.Str(t, "name"));
            foreach (var m in J.Objs(root, "materialDefs"))
            {
                var mat = new LytMaterial { name = J.Str(m, "name") };
                var tev = J.Arr(m, "tevColors");
                for (int i = 0; i < 3; i++) mat.tev[i] = tev != null && i < tev.Count ? Col(tev[i]) : (i == 0 ? new Color32(0, 0, 0, 0) : new Color32(255, 255, 255, 255));
                if (J.Has(m, "color")) { mat.color = Col(J.Get(m, "color")); mat.hasColor = true; }
                var maps = new List<Dictionary<string, object>>(J.Objs(m, "textureMaps"));
                mat.textureMaps = new int[maps.Count]; mat.wrapS = new int[maps.Count]; mat.wrapT = new int[maps.Count];
                for (int i = 0; i < maps.Count; i++) { mat.textureMaps[i] = J.Int(maps[i], "texture", -1); mat.wrapS[i] = J.Int(maps[i], "wrapS"); mat.wrapT[i] = J.Int(maps[i], "wrapT"); }
                var srt = new List<Dictionary<string, object>>(J.Objs(m, "texSrt"));
                mat.srtTranslate = new Vector2[srt.Count]; mat.srtScale = new Vector2[srt.Count]; mat.srtRotate = new float[srt.Count];
                for (int i = 0; i < srt.Count; i++)
                {
                    var tr = J.Floats(srt[i], "translate"); var s = J.Floats(srt[i], "scale");
                    mat.srtTranslate[i] = new Vector2(tr[0], tr[1]); mat.srtScale[i] = new Vector2(s[0], s[1]); mat.srtRotate[i] = J.F(srt[i], "rotate");
                }
                var bm = J.Ints(m, "blendMode");
                mat.additive = bm.Length >= 3 && bm[0] == 1 && bm[2] == 1; // GX: (blend, SRCALPHA, ONE) = aditivo
                l.materials.Add(mat);
            }
            var r = J.Get(root, "root");
            if (r != null) l.root = Pane(r);
            return l;
        }
    }

    public sealed class LytKey { public float frame, value, slope; }

    public sealed class LytTrack
    {
        public string property;
        public int index;
        public bool step;
        public LytKey[] keys;

        public float Sample(float frame)
        {
            var k = keys;
            if (k.Length == 0) return 0f;
            if (frame <= k[0].frame) return k[0].value;
            var last = k[k.Length - 1];
            if (frame >= last.frame) return last.value;
            int i = 0;
            while (i + 1 < k.Length && k[i + 1].frame <= frame) i++;
            var a = k[i]; var b = k[i + 1];
            if (step) return a.value;
            float dt = b.frame - a.frame;
            if (dt <= 0) return b.value;
            float t = (frame - a.frame) / dt, t2 = t * t, t3 = t2 * t;
            return (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * dt * a.slope + (-2 * t3 + 3 * t2) * b.value + (t3 - t2) * dt * b.slope;
        }
    }

    public sealed class LytAnimTarget
    {
        public string name;
        public bool material;
        public readonly List<LytTrack> tracks = new List<LytTrack>();
    }

    public sealed class LytAnimation
    {
        public string assetId, name;
        public int frameSize;
        public bool loop;
        public readonly List<LytAnimTarget> targets = new List<LytAnimTarget>();

        public static LytAnimation Parse(object root, string name)
        {
            var a = new LytAnimation { assetId = J.Str(root, "assetId"), name = name, frameSize = J.Int(root, "frameSize"), loop = J.Bool(root, "loop") };
            foreach (var t in J.Objs(root, "targets"))
            {
                var tg = new LytAnimTarget { name = J.Str(t, "name"), material = J.Str(t, "kind") == "material" };
                foreach (var tr in J.Objs(t, "tracks"))
                {
                    var keys = new List<LytKey>();
                    foreach (var k in J.Objs(tr, "keys")) keys.Add(new LytKey { frame = J.F(k, "frame"), value = J.F(k, "value"), slope = J.F(k, "slope") });
                    tg.tracks.Add(new LytTrack { property = J.Str(tr, "property"), index = J.Int(tr, "index"), step = J.Str(tr, "interpolation") == "step", keys = keys.ToArray() });
                }
                a.targets.Add(tg);
            }
            return a;
        }
    }

    /// <summary>Fonte BMFont convertida de .brfnt (font.json + atlas PNG).</summary>
    public sealed class BitmapFont
    {
        public struct Glyph { public int x, y, w, h, xoff, yoff, adv; }
        public readonly Dictionary<int, Glyph> glyphs = new Dictionary<int, Glyph>();
        public float size, lineHeight, defaultWidth;
        public int scaleW, scaleH;
        public string pagePath;
        public Texture2D page;

        public static BitmapFont Parse(object root)
        {
            var f = new BitmapFont();
            var info = J.Obj(root, "info");
            var common = J.Obj(root, "common");
            f.lineHeight = J.F(common, "lineHeight", 32);
            f.size = J.F(info, "size", f.lineHeight);
            if (f.size <= 0) f.size = f.lineHeight;
            f.scaleW = J.Int(common, "scaleW", 256);
            f.scaleH = J.Int(common, "scaleH", 256);
            f.defaultWidth = J.F(J.Obj(J.Obj(root, "nw4r"), "defaultWidth"), "charWidth", f.size / 2);
            var pages = J.Strings(root, "pages");
            f.pagePath = pages.Count > 0 ? pages[0] : null;
            foreach (var c in J.Objs(root, "chars"))
                f.glyphs[J.Int(c, "id")] = new Glyph
                {
                    x = J.Int(c, "x"), y = J.Int(c, "y"), w = J.Int(c, "width"), h = J.Int(c, "height"),
                    xoff = J.Int(c, "xoffset"), yoff = J.Int(c, "yoffset"), adv = J.Int(c, "xadvance"),
                };
            return f;
        }
    }
}
