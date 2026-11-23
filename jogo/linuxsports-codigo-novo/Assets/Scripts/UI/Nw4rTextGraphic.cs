// Graphic de texto NW4R com atlas BMFont (.brfnt convertido).
using UnityEngine;
using UnityEngine.UI;

namespace LinuxSports.UI
{
    /// <summary>Texto com o atlas BMFont do .brfnt (cores de topo/base como cor de vértice).</summary>
    public sealed class Nw4rTextGraphic : MaskableGraphic
    {
        public LytMaterialState state;
        public BitmapFont font;
        public LytText def;
        public string text;
        public float paneAlpha = 1f;

        public override Texture mainTexture => font != null && font.page != null ? font.page : s_WhiteTexture;
        public override Material material { get { return state != null ? state.material : base.material; } set { base.material = value; } }

        public void SetText(string value)
        {
            if (text == value) return;
            text = value;
            SetVerticesDirty();
        }

        private static int Col(int origin) { return origin % 3; }
        private static int Row(int origin) { return origin / 3; }

        protected override void OnPopulateMesh(VertexHelper vh)
        {
            vh.Clear();
            if (font == null || def == null || string.IsNullOrEmpty(text) || font.page == null) return;
            Rect r = GetPixelAdjustedRect();
            float sx = def.fontSize.x / font.size, sy = def.fontSize.y / font.size;
            float lineH = font.lineHeight * sy + def.lineSpace;
            var lines = text.Replace("\r", "").Split('\n');
            var widths = new float[lines.Length];
            float blockW = 0f;
            for (int li = 0; li < lines.Length; li++)
            {
                float w = 0f;
                foreach (char ch in lines[li]) if (ch >= 0x20) w += Advance(ch, sx);
                widths[li] = w;
                blockW = Mathf.Max(blockW, w);
            }
            float blockH = lines.Length * lineH;
            float W = r.width, H = r.height;
            float ox = new[] { 0f, (W - blockW) / 2f, W - blockW }[Col(def.textOrigin)];
            float oy = new[] { 0f, (H - blockH) / 2f, H - blockH }[Row(def.textOrigin)];
            int align = def.alignment == 0 ? Col(def.textOrigin) : Mathf.Clamp(def.alignment - 1, 0, 2);
            float invW = 1f / font.page.width, invH = 1f / font.page.height;
            int vi = 0;
            for (int li = 0; li < lines.Length; li++)
            {
                float x = ox + new[] { 0f, (blockW - widths[li]) / 2f, blockW - widths[li] }[align];
                float y = oy + li * lineH;
                foreach (char ch in lines[li])
                {
                    if (ch < 0x20) continue;
                    BitmapFont.Glyph g;
                    if (font.glyphs.TryGetValue(ch, out g) && g.w > 0)
                    {
                        float gx0 = x + g.xoff * sx, gy0 = y + g.yoff * sy;
                        float gx1 = gx0 + g.w * sx, gy1 = gy0 + g.h * sy;
                        // topo-esquerda do retângulo -> coordenadas locais (Y para cima)
                        var p0 = new Vector2(r.xMin + gx0, r.yMax - gy0);
                        var p1 = new Vector2(r.xMin + gx1, r.yMax - gy1);
                        float u0 = g.x * invW, u1 = (g.x + g.w) * invW;
                        float v0 = 1f - g.y * invH, v1 = 1f - (g.y + g.h) * invH;
                        float ft = H > 0 ? Mathf.Clamp01(gy0 / H) : 0f, fb = H > 0 ? Mathf.Clamp01(gy1 / H) : 1f;
                        Color32 ct = Grad(ft), cb = Grad(fb);
                        vh.AddVert(new Vector3(p0.x, p0.y), ct, new Vector2(u0, v0));
                        vh.AddVert(new Vector3(p1.x, p0.y), ct, new Vector2(u1, v0));
                        vh.AddVert(new Vector3(p0.x, p1.y), cb, new Vector2(u0, v1));
                        vh.AddVert(new Vector3(p1.x, p1.y), cb, new Vector2(u1, v1));
                        vh.AddTriangle(vi, vi + 1, vi + 3);
                        vh.AddTriangle(vi, vi + 3, vi + 2);
                        vi += 4;
                    }
                    x += Advance(ch, sx);
                }
            }
        }

        private Color32 Grad(float t)
        {
            Color32 c = Color32.Lerp(def.top, def.bottom, t);
            c.a = (byte)Mathf.Clamp(Mathf.RoundToInt(c.a * paneAlpha * color.a), 0, 255);
            return c;
        }

        private float Advance(char ch, float sx)
        {
            BitmapFont.Glyph g;
            return (font.glyphs.TryGetValue(ch, out g) ? g.adv : font.defaultWidth) * sx + def.charSpace;
        }
    }
}
