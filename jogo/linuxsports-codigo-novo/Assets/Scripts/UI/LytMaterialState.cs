// Graphics de UnityEngine.UI para os painéis NW4R.
// Cor (aproximação do TEV padrão do NW4R com uma textura, igual ao player web validado):
//   cor = lerp(tevColor0, tevColor1, textura) × cor de vértice × cor do material
// O lerp é feito pelo shader Nw4r/UI (Assets/Resources/Shaders/Nw4rUI.shader); cor de vértice e alfa
// do painel vão na cor de vértice do Graphic. UV: Wii tem V para baixo -> v_unity = 1 - v.
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;

namespace LinuxSports.UI
{
    /// <summary>Estado animável de um material de layout (compartilhado pelos painéis que o usam).</summary>
    public sealed class LytMaterialState
    {
        public LytMaterial def;
        public Color32[] tev = new Color32[3];
        public Color32 color;
        public Vector2[] srtTranslate, srtScale;
        public float[] srtRotate;
        public Texture2D overrideTexture;
        public Texture2D baseTexture;
        public Material material;
        public readonly List<Graphic> graphics = new List<Graphic>();

        public LytMaterialState(LytMaterial d, Texture2D tex, Shader shader)
        {
            def = d;
            for (int i = 0; i < 3; i++) tev[i] = d.tev[i];
            color = d.color;
            srtTranslate = (Vector2[])d.srtTranslate.Clone();
            srtScale = (Vector2[])d.srtScale.Clone();
            srtRotate = (float[])d.srtRotate.Clone();
            baseTexture = tex;
            material = new Material(shader) { name = "lyt_" + d.name };
            Push();
        }

        public Texture2D Texture => overrideTexture != null ? overrideTexture : baseTexture;

        public void Push()
        {
            material.SetColor("_TevColor0", tev[0]);
            material.SetColor("_TevColor1", tev[1]);
            material.SetColor("_MatColor", color);
            material.SetFloat("_HasTex", Texture != null ? 1f : 0f);
            material.SetFloat("_DstBlend", def.additive ? (float)UnityEngine.Rendering.BlendMode.One : (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            foreach (var g in graphics) if (g != null) { g.SetMaterialDirty(); g.SetVerticesDirty(); }
        }

        /// <summary>UV do Wii -> UV do Unity, com a SRT da camada 0 (mesma regra do player web).</summary>
        public Vector2 MapUV(Vector2 uv)
        {
            float u = uv.x, v = uv.y;
            if (srtScale.Length > 0)
            {
                float r = srtRotate[0] * Mathf.Deg2Rad;
                if (Mathf.Abs(r) > 1e-6f)
                {
                    float cu = u - 0.5f, cv = v - 0.5f, c = Mathf.Cos(r), s = Mathf.Sin(r);
                    u = cu * c - cv * s + 0.5f;
                    v = cu * s + cv * c + 0.5f;
                }
                u = u * srtScale[0].x + srtTranslate[0].x;
                v = v * srtScale[0].y - srtTranslate[0].y;
            }
            return new Vector2(u, 1f - v);
        }
    }

}
