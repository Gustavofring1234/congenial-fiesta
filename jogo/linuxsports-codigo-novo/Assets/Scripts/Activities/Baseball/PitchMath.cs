// Balística do arremesso (testável sem cena): cruzamento com o plano da base e mira por correção iterativa.
using UnityEngine;

namespace LinuxSports.Activities.Baseball
{
    public static class PitchMath
    {
        /// <summary>Ponto em que a bola cruza o plano da base (perpendicular a cf, passando por home).</summary>
        public static Vector3 PlateCrossing(Vector3 from, Vector3 v, Vector3 spin, Vector3 home, Vector3 cf, BallParams p, float upm, out float time)
        {
            Vector3 pos = from, vel = v, s = spin;
            const float dt = 1f / 480f;
            time = 0f;
            for (float t = 0f; t < 2f; t += dt)
            {
                Vector3 prev = pos;
                BallFlight.Step(ref pos, ref vel, ref s, Vector3.zero, p, upm, dt);
                if (Vector3.Dot(pos - home, cf) <= 0f)
                {
                    float a = Vector3.Dot(prev - home, cf), b = Vector3.Dot(pos - home, cf);
                    float k = a / (a - b);
                    time = t + dt * k;
                    return Vector3.Lerp(prev, pos, k);
                }
            }
            time = 2f;
            return pos;
        }

        /// <summary>Velocidade (u/s) para cruzar a base no alvo, com o spin dado.</summary>
        public static Vector3 Solve(Vector3 release, Vector3 target, float speed, Vector3 spin, Vector3 home, Vector3 cf, BallParams p, float upm)
        {
            Vector3 right = Vector3.Cross(Vector3.up, cf);
            Vector3 dir = (target - release).normalized;
            float dist = Vector3.Distance(release, target);
            float yaw = 0f, pitch = 0f;
            for (int it = 0; it < 6; it++)
            {
                Vector3 d = Rotate(Rotate(dir, right, pitch), Vector3.up, yaw);
                float t;
                Vector3 at = PlateCrossing(release, d * speed, spin, home, cf, p, upm, out t);
                Vector3 err = target - at;
                // d ≈ −cf: ângulo positivo em torno de `right` levanta a bola; yaw positivo a leva para −right.
                pitch += Vector3.Dot(err, Vector3.up) / dist * Mathf.Rad2Deg;
                yaw -= Vector3.Dot(err, right) / dist * Mathf.Rad2Deg;
            }
            return Rotate(Rotate(dir, right, pitch), Vector3.up, yaw) * speed;
        }

        /// <summary>Rotação de Rodrigues com o mesmo resultado de Quaternion.AngleAxis(deg, axis) * v
        /// (ex.: 90° em torno de up leva forward para right), escrita à mão para rodar fora do motor (testes).</summary>
        public static Vector3 Rotate(Vector3 v, Vector3 axis, float deg)
        {
            Vector3 k = axis.normalized;
            float a = deg * Mathf.Deg2Rad;
            float c = Mathf.Cos(a), s = Mathf.Sin(a);
            return v * c + Vector3.Cross(k, v) * s + k * Vector3.Dot(k, v) * (1f - c);
        }
    }
}
