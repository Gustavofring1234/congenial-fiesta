// Conversão do referencial do Wii (NW4R: destro, Y para cima, ângulos em graus) para o Unity (canhoto).
//
// Os .glb são importados pelo glTFast, que espelha o eixo X (posição (-x, y, z), rotação (x, -y, -z, w)).
// Tudo que vem dos .brres (ossos, CHR0, câmeras SCN0, emissores .breff) usa a MESMA troca, para casar
// com a geometria. As cenas (.scene.json em StreamingAssets/Scenes) já vêm convertidas pelo
// tools/stage_unity_assets.py.
//
// Rotação NW4R de um osso: R = Rz · Ry · Rx (aplica X primeiro), ângulos em graus.
using UnityEngine;

namespace LinuxSports.Core
{
    public static class Nw4rCoordinates
    {
        /// <summary>Quadros por segundo das animações NW4R e dos efeitos.</summary>
        public const float FrameRate = 60f;

        public static Vector3 Position(float x, float y, float z) { return new Vector3(-x, y, z); }

        public static Vector3 Position(Vector3 wii) { return new Vector3(-wii.x, wii.y, wii.z); }

        /// <summary>Euler XYZ do NW4R (graus) -> rotação local do Unity.</summary>
        public static Quaternion Rotation(float rxDeg, float ryDeg, float rzDeg)
        {
            // composição numérica no espaço do Wii (q = qz * qy * qx) e depois o espelho em X
            Quaternion qx = Quaternion.AngleAxis(rxDeg, Vector3.right);
            Quaternion qy = Quaternion.AngleAxis(ryDeg, Vector3.up);
            Quaternion qz = Quaternion.AngleAxis(rzDeg, Vector3.forward);
            return Mirror(qz * qy * qx);
        }

        public static Quaternion Mirror(Quaternion wii) { return new Quaternion(wii.x, -wii.y, -wii.z, wii.w); }

        /// <summary>Matriz 3x4 do Wii (linhas, translação na 4ª coluna) -> Matrix4x4 do Unity.</summary>
        public static Matrix4x4 Matrix(float[] rowMajor3x4)
        {
            var m = Matrix4x4.identity;
            for (int r = 0; r < 3; r++)
                for (int c = 0; c < 4; c++)
                    m[r, c] = rowMajor3x4[r * 4 + c];
            var s = Matrix4x4.Scale(new Vector3(-1, 1, 1));
            return s * m * s;
        }

        /// <summary>Direção "olhar para" de uma câmera de alvo (aim) do SCN0, já convertida.</summary>
        public static Quaternion LookAt(Vector3 eyeWii, Vector3 aimWii, float twistDeg)
        {
            Vector3 eye = Position(eyeWii), aim = Position(aimWii);
            Vector3 fwd = aim - eye;
            if (fwd.sqrMagnitude < 1e-10f) fwd = Vector3.forward;
            return Quaternion.LookRotation(fwd.normalized, Vector3.up) * Quaternion.AngleAxis(twistDeg, Vector3.forward);
        }

        /// <summary>Câmera de rotação do SCN0 (sem alvo). A câmera NW4R olha para -Z local.</summary>
        public static Quaternion CameraRotation(float rxDeg, float ryDeg, float rzDeg)
        {
            return Rotation(rxDeg, ryDeg, rzDeg) * Quaternion.AngleAxis(180f, Vector3.up);
        }

        public static Color32 Color(int[] rgba)
        {
            if (rgba == null || rgba.Length < 3) return new Color32(255, 255, 255, 255);
            byte a = rgba.Length > 3 ? (byte)rgba[3] : (byte)255;
            return new Color32((byte)rgba[0], (byte)rgba[1], (byte)rgba[2], a);
        }
    }
}
