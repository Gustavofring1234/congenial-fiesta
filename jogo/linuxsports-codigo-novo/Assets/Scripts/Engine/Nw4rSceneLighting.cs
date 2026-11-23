// Luzes do SCN0 (NW4R) -> Light do Unity. Usado pelo Nw4rAnimationPlayer ao tocar um SCN0.
// Direcional: direção = fim - início. Spot: posição no início, mirando o fim, ângulo = 2 × corte.
// Ponto: posição no início. A cor ambiente do conjunto de luzes vai para RenderSettings.ambientLight.
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Engine
{
    public static class Nw4rSceneLighting
    {
        public static void ApplyLight(Light light, string kind, Vector3 startWii, Vector3 endWii, Color32 color, float cutoffDeg)
        {
            Vector3 start = Nw4rCoordinates.Position(startWii), end = Nw4rCoordinates.Position(endWii);
            Vector3 dir = end - start;
            if (dir.sqrMagnitude < 1e-8f) dir = Vector3.down;
            light.color = new Color(color.r / 255f, color.g / 255f, color.b / 255f, 1f);
            switch (kind)
            {
                case "directional":
                    light.type = LightType.Directional;
                    light.transform.rotation = Quaternion.LookRotation(dir.normalized);
                    break;
                case "spot":
                    light.type = LightType.Spot;
                    light.transform.position = start;
                    light.transform.rotation = Quaternion.LookRotation(dir.normalized);
                    light.spotAngle = Mathf.Clamp(cutoffDeg * 2f, 1f, 179f);
                    break;
                default:
                    light.type = LightType.Point;
                    light.transform.position = start;
                    break;
            }
        }

        public static void ApplyAmbient(Color32 c)
        {
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(c.r / 255f, c.g / 255f, c.b / 255f, 1f);
        }
    }
}
