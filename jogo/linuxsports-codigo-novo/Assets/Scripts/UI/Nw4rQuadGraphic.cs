// Graphic de imagem/janela NW4R (ver LytMaterialState em Nw4rLayoutGraphics.cs).
using UnityEngine;
using UnityEngine.UI;

namespace LinuxSports.UI
{
    /// <summary>Quad de imagem/janela (conteúdo) com 4 cores de vértice e UVs do layout.</summary>
    public sealed class Nw4rQuadGraphic : MaskableGraphic
    {
        public LytMaterialState state;
        public Color32[] vertexColors = { new Color32(255, 255, 255, 255), new Color32(255, 255, 255, 255), new Color32(255, 255, 255, 255), new Color32(255, 255, 255, 255) };
        public Vector2[] texCoords = { new Vector2(0, 0), new Vector2(1, 0), new Vector2(0, 1), new Vector2(1, 1) };
        public float paneAlpha = 1f;
        public int flip;            // bit 0 = espelha U, bit 1 = espelha V (molduras)
        public Rect? subRect;       // região dentro do retângulo (molduras de janela)

        public override Texture mainTexture => state != null && state.Texture != null ? state.Texture : s_WhiteTexture;
        public override Material material { get { return state != null ? state.material : base.material; } set { base.material = value; } }

        protected override void OnPopulateMesh(VertexHelper vh)
        {
            vh.Clear();
            Rect r = subRect ?? GetPixelAdjustedRect();
            // ordem NW4R: 0 esq-topo, 1 dir-topo, 2 esq-base, 3 dir-base
            var pos = new[] { new Vector2(r.xMin, r.yMax), new Vector2(r.xMax, r.yMax), new Vector2(r.xMin, r.yMin), new Vector2(r.xMax, r.yMin) };
            var uv = new Vector2[4];
            for (int i = 0; i < 4; i++)
            {
                int src = i;
                if ((flip & 1) != 0) src ^= 1;
                if ((flip & 2) != 0) src ^= 2;
                uv[i] = state != null ? state.MapUV(texCoords[src]) : new Vector2(texCoords[src].x, 1f - texCoords[src].y);
            }
            for (int i = 0; i < 4; i++)
            {
                Color32 c = vertexColors[i];
                c.a = (byte)Mathf.Clamp(Mathf.RoundToInt(c.a * paneAlpha * color.a), 0, 255);
                vh.AddVert(pos[i], c, uv[i]);
            }
            vh.AddTriangle(0, 1, 3);
            vh.AddTriangle(0, 3, 2);
        }
    }
}
