// Reconstrução da EGG::LightTexture (eggLightTexture.cpp) na CPU, para o shader Nw4r/Lit (avatares Mii).
//
// No Wii, a cada quadro LightTexture::draw (@ 800921dc) pinta uma esfera de normais (fillNormalMapSphere)
// numa textura "lm_N": limpa com a cor global do LightManager (FUN_80092280) e, para cada luz com os
// bits 0x01|0x20 e com o bit do seu índice na máscara do LTEX (addLight @ 80092580), soma
//     cor_final(luz) × peso × rampa_modo(N · L)
// onde L é o vetor "para a luz" no espaço de câmera (addLight nega a direção calculada em
// CalcFinalDirColor @ 8009dc58), cor_final = min(255, cor × intensidade), o peso < 1 escala a cor e
// rampa_modo é uma das 10 tabelas de 64 texels de LightTexture::initialize (@ 80091920), indexada por
// j = 32 + 32·(N·L) (a tabela é gravada deslocada de meia volta e lida com coordenada s = N·L/2).
// Os modelos leem a textura por mapeamento esférico da normal em espaço de câmera.
//
// Espaço de câmera aqui = Camera.worldToCameraMatrix do Unity (x direita, y cima, z para o observador),
// que coincide com o espaço de câmera do GX depois do espelho em X do glTFast. A textura é gravada com a
// linha 0 embaixo (Texture2D) e lida com uv = n.xy·0,5 + 0,5.
using UnityEngine;

namespace LinuxSports.Engine
{
    public static class Nw4rLightTextureGenerator
    {
        public const int RampSize = 64;

        /// <summary>Vetor unitário "para a luz" em espaço de câmera. false se a luz não tem direção definida.</summary>
        /// <summary>Linhas 0..2 da rotação de uma matriz mundo -> câmera (ex.: Camera.worldToCameraMatrix).</summary>
        public struct ViewBasis
        {
            public Vector3 row0, row1, row2;
            public static ViewBasis From(Matrix4x4 m)
            {
                return new ViewBasis { row0 = new Vector3(m.m00, m.m01, m.m02), row1 = new Vector3(m.m10, m.m11, m.m12),
                                       row2 = new Vector3(m.m20, m.m21, m.m22) };
            }
            public Vector3 MultiplyVector(Vector3 v) { return new Vector3(Vector3.Dot(row0, v), Vector3.Dot(row1, v), Vector3.Dot(row2, v)); }
        }

        public static bool ToLightView(Nw4rEnvLight l, Matrix4x4 worldToView, out Vector3 dir)
        {
            return ToLightView(l, ViewBasis.From(worldToView), out dir);
        }

        public static bool ToLightView(Nw4rEnvLight l, ViewBasis worldToView, out Vector3 dir)
        {
            Vector3 toLightWii = -l.DirectionWii; // posição - alvo
            switch (l.space)
            {
                case Nw4rLightSpace.CameraFront: dir = new Vector3(0f, 0f, 1f); return true;
                case Nw4rLightSpace.CameraBack: dir = new Vector3(0f, 0f, -1f); return true;
                case Nw4rLightSpace.View:
                    dir = toLightWii;
                    break;
                default:
                    dir = worldToView.MultiplyVector(Core.Nw4rCoordinates.Position(toLightWii));
                    break;
            }
            if (dir.sqrMagnitude < 1e-12f) return false;
            dir.Normalize();
            if (l.space == Nw4rLightSpace.WorldSpecular)
            {
                // CalcView modo 1: meio-vetor entre a luz e o observador (+z no espaço de câmera).
                dir = (dir + new Vector3(0f, 0f, 1f));
                if (dir.sqrMagnitude < 1e-12f) return false;
                dir.Normalize();
            }
            return true;
        }

        /// <summary>Luz entra nesta textura? (flags 0x01 e 0x20, bit na máscara, cor habilitada).</summary>
        public static bool Contributes(Nw4rEnvLight l, Nw4rLightTextureDef def)
        {
            return l != null && l.enabled && l.lightTexture && def.UsesLight(l.index);
        }

        /// <summary>Cor somada pela luz (rgb 0..255, antes da rampa).</summary>
        public static Vector3 LightColor(Nw4rEnvLight l, Nw4rLightTextureDef def)
        {
            Color32 c = l.FinalColor;
            float w = 1f;
            if (def.entries != null && l.index < def.entries.Length) w = def.entries[l.index].weight;
            if (w < 1f) c = Nw4rEnvLight.Scale(c, w); // CalcFinalDirColor: só escala quando peso < 1
            return new Vector3(c.r, c.g, c.b);
        }

        public static int Mode(Nw4rEnvLight l, Nw4rLightTextureDef def)
        {
            return def.entries != null && l.index < def.entries.Length ? def.entries[l.index].mode : 0;
        }

        /// <summary>Preenche pixels (size × size, linha 0 embaixo). Devolve quantas luzes entraram.</summary>
        public static int Fill(Color32[] pixels, int size, Nw4rEnvironmentData env, Nw4rLightTextureDef def,
                               float[][] ramps, Matrix4x4 worldToView)
        {
            return Fill(pixels, size, env, def, ramps, ViewBasis.From(worldToView));
        }

        public static int Fill(Color32[] pixels, int size, Nw4rEnvironmentData env, Nw4rLightTextureDef def,
                               float[][] ramps, ViewBasis worldToView)
        {
            int n = 0;
            var dirs = new Vector3[env.lights.Count];
            var cols = new Vector3[env.lights.Count];
            var rampOf = new float[env.lights.Count][];
            foreach (var l in env.lights)
            {
                if (!Contributes(l, def)) continue;
                Vector3 d;
                if (!ToLightView(l, worldToView, out d)) continue;
                int mode = Mode(l, def);
                if (ramps == null || mode < 0 || mode >= ramps.Length || ramps[mode] == null) continue;
                dirs[n] = d;
                cols[n] = LightColor(l, def);
                rampOf[n] = ramps[mode];
                n++;
            }
            Color32 g = env.globalColor;
            float inv = 2f / size;
            for (int y = 0; y < size; y++)
            {
                float ny = (y + 0.5f) * inv - 1f;
                for (int x = 0; x < size; x++)
                {
                    float nx = (x + 0.5f) * inv - 1f;
                    float r2 = nx * nx + ny * ny, nz;
                    float sx = nx, sy = ny;
                    if (r2 >= 1f) { float s = 1f / Mathf.Sqrt(r2); sx *= s; sy *= s; nz = 0f; }
                    else nz = Mathf.Sqrt(1f - r2);
                    float r = g.r, gg = g.g, b = g.b;
                    for (int k = 0; k < n; k++)
                    {
                        float ndl = sx * dirs[k].x + sy * dirs[k].y + nz * dirs[k].z;
                        int j = Mathf.Clamp(Mathf.RoundToInt(32f + 32f * ndl), 0, RampSize - 1);
                        float v = rampOf[k][j];
                        r += cols[k].x * v; gg += cols[k].y * v; b += cols[k].z * v;
                    }
                    pixels[y * size + x] = new Color32((byte)Mathf.Min(255f, r), (byte)Mathf.Min(255f, gg),
                                                       (byte)Mathf.Min(255f, b), 255);
                }
            }
            return n;
        }
    }
}
