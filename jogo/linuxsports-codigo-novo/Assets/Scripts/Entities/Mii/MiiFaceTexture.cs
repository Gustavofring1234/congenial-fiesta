// Textura do rosto (olhos, sobrancelhas, boca, bigode, pinta), como RFLiMakeTexture/RFLiCapture:
//
// Posição (RFLiSetFaceParts, 0x80170728): espaço de 64 unidades × (res / 64), y para baixo.
//   olho       x = 32 ∓ 0,8896146·eyeX     y = 18,4515247 + 1,0760944·eyeY   l = 5,34375·k  a = 4,5·k
//   sobrancelha x = 32 ∓ 0,8896146·browX   y = 16,5498066 + 1,0760944·browY  l = 5,0625·k   a = 4,5·k
//   boca       x = 32                      y = 29,2588501 + 1,0760944·mouthY l = 6,1875·k   a = 4,5·k
//   bigode     x = 32 (2 metades)          y = 31,7635536 + 1,0760944·y      l = 4,5·k      a = 9·k
//   pinta      x = 17,7661648 + 1,7792293·x y = 17,9598598 + 1,0760944·y     l = a = k
//   com k = 1 + 0,4·escala; rotação = 11,25° · ((rot + base[tipo]) & 31) (lado direito: 360° − rotação).
// Quad (RFLiDrawQuad): T(x, y) · S(0,8896146; 0,9276675) · Rz(rot) · S(l, a) sobre o retângulo local
//   x ∈ [−0,5; 0,5] (alinhamento 0), [−1; 0] (2, lado esquerdo) ou [0; 1] com u espelhado (1, lado direito);
//   y ∈ [−0,5; 0,5], v = 0 em cima.
// Ordem e mistura (RFLiCapture): bigode, boca, sobrancelhas, olhos, pinta, de frente para trás
//   (GX blend INVDSTALPHA/DSTALPHA); a 2ª passada do original só recalcula o alfa, aqui feito junto.
using System.Collections.Generic;
using UnityEngine;

namespace LinuxSports.Entities
{
    public static class MiiFaceTexture
    {
        private const int ModeSolid = 0, ModeEye = 1, ModeMouth = 2;
        private const float AxisX = 0.8896146f, AxisY = 0.9276675f;
        private static Material material;
        private static readonly int TexId = Shader.PropertyToID("_MainTex");
        private static readonly int Color0Id = Shader.PropertyToID("_Color0");
        private static readonly int Color1Id = Shader.PropertyToID("_Color1");
        private static readonly int ModeId = Shader.PropertyToID("_Mode");

        private struct Quad
        {
            public Texture2D tex;
            public float x, y, w, h, rot;
            public int align, mode;
            public Vector4 c0, c1;
        }

        /// <summary>Desenha o rosto de <paramref name="info"/> (já com a expressão aplicada) em <paramref name="target"/>.</summary>
        public static RenderTexture Render(MiiCharInfo info, int resolution, RenderTexture target = null)
        {
            if (target == null)
            {
                target = new RenderTexture(resolution, resolution, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Linear)
                { name = "MiiFace", wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Bilinear, useMipMap = false };
                target.Create();
            }
            if (material == null)
            {
                var shader = Shader.Find("Nw4r/MiiFacePart");
                if (shader == null) throw new MissingReferenceException("shader Nw4r/MiiFacePart ausente (Resources/Shaders)");
                material = new Material(shader) { hideFlags = HideFlags.HideAndDontSave };
            }

            var prev = RenderTexture.active;
            RenderTexture.active = target;
            GL.PushMatrix();
            GL.LoadPixelMatrix(0, resolution, resolution, 0);   // y para baixo, como o ortho do RFL
            GL.Clear(true, true, new Color(0, 0, 0, 0));
            foreach (var q in Quads(info, resolution))
            {
                if (q.tex == null) continue;
                material.SetTexture(TexId, q.tex);
                material.SetVector(Color0Id, q.c0);
                material.SetVector(Color1Id, q.c1);
                material.SetFloat(ModeId, q.mode);
                material.SetPass(0);
                Draw(q);
            }
            GL.PopMatrix();
            RenderTexture.active = prev;
            return target;
        }

        private static IEnumerable<Quad> Quads(MiiCharInfo c, int res)
        {
            var p = MiiResources.Params;
            float u = res / 64f;
            if (c.beard.mustache != 0)
            {
                float k = 1f + 0.4f * c.beard.scale;
                var q = new Quad { tex = MiiResources.Texture("mustache", c.beard.mustache), x = 32f * u,
                    y = (31.7635536f + 1.0760944f * c.beard.y) * u, w = 4.5f * k * u, h = 9f * k * u,
                    mode = ModeSolid, c0 = MiiParams.Raw(p.mustacheColor2D[c.beard.color]) };
                q.align = 2; yield return q;
                q.align = 1; yield return q;
            }
            {
                float k = 1f + 0.4f * c.mouth.scale;
                yield return new Quad { tex = MiiResources.Texture("mouth", c.mouth.type), x = 32f * u,
                    y = (29.2588501f + 1.0760944f * c.mouth.y) * u, w = 6.1875f * k * u, h = 4.5f * k * u, align = 0,
                    mode = ModeMouth, c0 = MiiParams.Raw(p.mouthColorDark[c.mouth.color]), c1 = MiiParams.Raw(p.mouthColorLip[c.mouth.color]) };
            }
            {
                float k = 1f + 0.4f * c.eyebrow.scale;
                float rot = 11.25f * ((c.eyebrow.rotate + p.eyebrowRotateOffset[c.eyebrow.type]) & 31);
                var q = new Quad { tex = MiiResources.Texture("eyebrow", c.eyebrow.type),
                    y = (16.5498066f + 1.0760944f * c.eyebrow.y) * u, w = 5.0625f * k * u, h = 4.5f * k * u,
                    mode = ModeSolid, c0 = MiiParams.Raw(p.eyebrowColor2D[c.eyebrow.color]) };
                q.x = (32f - AxisX * c.eyebrow.x) * u; q.rot = rot; q.align = 2; yield return q;
                q.x = (32f + AxisX * c.eyebrow.x) * u; q.rot = 360f - rot; q.align = 1; yield return q;
            }
            {
                float k = 1f + 0.4f * c.eye.scale;
                float rot = 11.25f * ((c.eye.rotate + p.eyeRotateOffset[c.eye.type]) & 31);
                var q = new Quad { tex = MiiResources.Texture("eye", c.eye.type),
                    y = (18.4515247f + 1.0760944f * c.eye.y) * u, w = 5.34375f * k * u, h = 4.5f * k * u,
                    mode = ModeEye, c0 = MiiParams.Raw(p.EyeOutline(c.eye.type)), c1 = MiiParams.Raw(p.eyeColor[c.eye.color]) };
                q.x = (32f - AxisX * c.eye.x) * u; q.rot = rot; q.align = 2; yield return q;
                q.x = (32f + AxisX * c.eye.x) * u; q.rot = 360f - rot; q.align = 1; yield return q;
            }
            if (c.mole.enabled)
            {
                float k = 1f + 0.4f * c.mole.scale;
                yield return new Quad { tex = MiiResources.Texture("mole", 1), x = (17.7661648f + 1.7792293f * c.mole.x) * u,
                    y = (17.9598598f + 1.0760944f * c.mole.y) * u, w = k * u, h = k * u, align = 0,
                    mode = ModeSolid, c0 = MiiParams.Raw(p.moleColor) };
            }
        }

        private static void Draw(Quad q)
        {
            float x0 = q.align == 0 ? -0.5f : q.align == 2 ? -1f : 0f;
            float uL = q.align == 1 ? 1f : 0f, uR = 1f - uL;
            float r = q.rot * Mathf.Deg2Rad, cs = Mathf.Cos(r), sn = Mathf.Sin(r);
            GL.Begin(GL.QUADS);
            Vertex(q, x0, -0.5f, cs, sn, uL, 0f);
            Vertex(q, x0 + 1f, -0.5f, cs, sn, uR, 0f);
            Vertex(q, x0 + 1f, 0.5f, cs, sn, uR, 1f);
            Vertex(q, x0, 0.5f, cs, sn, uL, 1f);
            GL.End();
        }

        // t do GX (0 em cima) -> v do Unity (PNG importado com a linha 0 em cima): v = 1 - t
        private static void Vertex(Quad q, float lx, float ly, float cs, float sn, float s, float t)
        {
            float px = lx * q.w, py = ly * q.h;
            float rx = cs * px - sn * py, ry = sn * px + cs * py;
            GL.TexCoord2(s, 1f - t);
            GL.Vertex3(q.x + AxisX * rx, q.y + AxisY * ry, 0f);
        }
    }
}
