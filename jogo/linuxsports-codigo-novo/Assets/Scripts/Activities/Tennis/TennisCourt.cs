// Geometria e balística da quadra (ITF, em unidades da cena; a rede tns_net_a mede ~12,8 m = 136 u e confere
// a escala de 10 u/m). Rede em z = 0; time 0 do lado +Z. Sem MonoBehaviour: testável.
using UnityEngine;

namespace LinuxSports.Activities.Tennis
{
    public sealed class TennisCourt
    {
        public float halfLength = 118.85f, singlesHalfWidth = 41.15f, doublesHalfWidth = 54.85f;
        public float serviceLine = 64f, netCenter = 9.14f, netPost = 10.7f, netHalfWidth = 64f;
        public float unitsPerMeter = 10f;
        public bool doubles;

        public float HalfWidth => doubles ? doublesHalfWidth : singlesHalfWidth;

        /// <summary>Lado da quadra de um time: +1 (z > 0) para o time 0, −1 para o time 1.</summary>
        public static float Side(int team) => team == 0 ? 1f : -1f;

        public float NetHeight(float x)
        {
            float t = Mathf.Clamp01(Mathf.Abs(x) / netHalfWidth);
            return Mathf.Lerp(netCenter, netPost, t);
        }

        public bool InCourt(Vector3 p, int targetTeam, float margin = 0.5f)
        {
            float s = Side(targetTeam);
            return p.z * s >= -margin && p.z * s <= halfLength + margin && Mathf.Abs(p.x) <= HalfWidth + margin;
        }

        /// <summary>Caixa de saque (no lado do recebedor). side 0 = deuce (direita do sacador), 1 = vantagem.</summary>
        public bool InServiceBox(Vector3 p, int receiverTeam, int serveSide, float margin = 0.5f)
        {
            float s = Side(receiverTeam);
            if (p.z * s < -margin || p.z * s > serviceLine + margin) return false;
            // O sacador do time 0 (lado +Z, olhando para −Z) tem a direita em −X; o saque é cruzado.
            float serverSide = Side(1 - receiverTeam);
            float boxSign = (serveSide == 0 ? 1f : -1f) * serverSide;   // deuce: caixa em +X vista do time 0 sacando
            return p.x * boxSign >= -margin && p.x * boxSign <= singlesHalfWidth + margin;
        }

        public Vector3 ServiceBoxCenter(int receiverTeam, int serveSide)
        {
            float s = Side(receiverTeam);
            float serverSide = Side(1 - receiverTeam);
            float boxSign = (serveSide == 0 ? 1f : -1f) * serverSide;
            return new Vector3(boxSign * singlesHalfWidth * 0.5f, 0f, s * serviceLine * 0.6f);
        }

        public Vector3 ServePosition(int team, int serveSide)
        {
            float s = Side(team);
            // Time 0 olha para −Z: a direita dele é −X. Deuce = metade direita.
            float x = (serveSide == 0 ? -1f : 1f) * s * 12f;
            return new Vector3(x, 0f, s * (halfLength + 4f));
        }

        /// <summary>Velocidade inicial para a bola ir de `from` e cair em `target` com a rapidez dada (u/s),
        /// passando sobre a rede. Busca binária no ângulo de elevação; se não alcançar, aumenta a rapidez.</summary>
        public Vector3 SolveShot(Vector3 from, Vector3 target, float speed, float topspin, BallParams p, float radius)
        {
            Vector3 flat = target - from;
            flat.y = 0f;
            Vector3 dir = flat.normalized;
            float want = flat.magnitude;
            for (int attempt = 0; attempt < 6; attempt++)
            {
                float lo = -15f, hi = 50f;
                Vector3 best = Vector3.zero;
                bool ok = false;
                for (int it = 0; it < 22; it++)
                {
                    float mid = 0.5f * (lo + hi);
                    Vector3 v = Velocity(dir, mid, speed);
                    Vector3 spin = -BallFlight.BackspinAxis(dir) * topspin;
                    float t;
                    Vector3 land = BallFlight.PredictLanding(from, v, spin, Vector3.zero, p, unitsPerMeter, radius, out t, 6f, 1f / 120f);
                    float got = Vector3.Dot(land - from, dir);
                    if (got < want) lo = mid; else hi = mid;
                    best = v;
                    ok = Mathf.Abs(got - want) < 3f;
                }
                if (ok && ClearsNet(from, best, -BallFlight.BackspinAxis(dir) * topspin, p, radius)) return best;
                if (!ok) speed *= 1.15f;          // não alcança: mais força
                else speed *= 0.9f;               // bate na rede: menos força, ângulo maior
            }
            return Velocity(dir, 12f, speed);
        }

        public bool ClearsNet(Vector3 from, Vector3 v, Vector3 spin, BallParams p, float radius)
        {
            Vector3 at;
            float t;
            if (Mathf.Sign(from.z) == 0f) return true;
            if (!BallFlight.CrossPlaneZ(from, v, spin, Vector3.zero, p, unitsPerMeter, 0f, out at, out t, 4f)) return true;
            return at.y - radius > NetHeight(at.x);
        }

        private static Vector3 Velocity(Vector3 dir, float elevDeg, float speed)
        {
            float r = elevDeg * Mathf.Deg2Rad;
            return (dir * Mathf.Cos(r) + Vector3.up * Mathf.Sin(r)) * speed;
        }
    }
}
