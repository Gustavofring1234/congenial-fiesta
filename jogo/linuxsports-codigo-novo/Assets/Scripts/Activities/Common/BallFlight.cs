// Voo de bola em unidades da cena (10 u = 1 m): gravidade, arrasto quadrático e efeito Magnus.
// a = g + (−½·ρ·Cd·A·|v|·v + ½·ρ·Cl·A·r·(ω × v)/|ω|·|v|... simplificado para S·(ω × v)) / m
// Integração semi-implícita de Euler em subpassos fixos (determinística, sem threads: WebGL).
using UnityEngine;

namespace LinuxSports.Activities
{
    public struct BallParams
    {
        public float radiusM;       // raio em metros
        public float massKg;
        public float dragCd;        // coeficiente de arrasto
        public float magnus;        // coeficiente S (kg) do termo S·(ω × v)
        public float spinDecay;     // 1/s
        public float restitution;   // quique na grama/quadra
        public float friction;      // perda tangencial no quique (0..1)
        public float rolling;       // resistência ao rolamento (m/s² por m/s² de g)

        public static BallParams Golf => new BallParams { radiusM = 0.02135f, massKg = 0.04593f, dragCd = 0.25f, magnus = 0.000025f, spinDecay = 0.25f, restitution = 0.38f, friction = 0.35f, rolling = 0.11f };
        public static BallParams Tennis => new BallParams { radiusM = 0.0335f, massKg = 0.058f, dragCd = 0.55f, magnus = 0.000045f, spinDecay = 0.15f, restitution = 0.75f, friction = 0.25f, rolling = 0.25f };
        public static BallParams Baseball => new BallParams { radiusM = 0.0366f, massKg = 0.145f, dragCd = 0.33f, magnus = 0.00008f, spinDecay = 0.1f, restitution = 0.45f, friction = 0.4f, rolling = 0.3f };
        public static BallParams Bowling => new BallParams { radiusM = 0.109f, massKg = 6.8f, dragCd = 0.47f, magnus = 0f, spinDecay = 0.02f, restitution = 0.1f, friction = 0.04f, rolling = 0.012f };

        public float Area => Mathf.PI * radiusM * radiusM;
    }

    public static class BallFlight
    {
        public const float AirDensity = 1.2f;
        public const float GravityMS2 = 9.81f;

        /// <summary>Aceleração (u/s²) na posição/velocidade dadas. Vento e velocidade em u/s; spin em rad/s.</summary>
        public static Vector3 Acceleration(Vector3 vel, Vector3 spin, Vector3 wind, BallParams p, float unitsPerMeter)
        {
            Vector3 vRel = (vel - wind) / unitsPerMeter;                 // m/s
            float speed = vRel.magnitude;
            Vector3 drag = speed > 1e-5f ? -0.5f * AirDensity * p.dragCd * p.Area * speed * vRel / p.massKg : Vector3.zero;
            Vector3 lift = p.magnus > 0f ? p.magnus * Vector3.Cross(spin, vRel) / p.massKg : Vector3.zero;
            return (new Vector3(0f, -GravityMS2, 0f) + drag + lift) * unitsPerMeter;
        }

        public static void Step(ref Vector3 pos, ref Vector3 vel, ref Vector3 spin, Vector3 wind, BallParams p, float unitsPerMeter, float dt)
        {
            vel += Acceleration(vel, spin, wind, p, unitsPerMeter) * dt;
            pos += vel * dt;
            spin *= Mathf.Max(0f, 1f - p.spinDecay * dt);
        }

        /// <summary>Simula sem colisão até a bola descer abaixo de groundY. Retorna o ponto de queda e o tempo.</summary>
        public static Vector3 PredictLanding(Vector3 pos, Vector3 vel, Vector3 spin, Vector3 wind, BallParams p, float unitsPerMeter,
                                             float groundY, out float time, float maxTime = 15f, float dt = 1f / 120f)
        {
            time = 0f;
            Vector3 prev = pos;
            while (time < maxTime)
            {
                prev = pos;
                Step(ref pos, ref vel, ref spin, wind, p, unitsPerMeter, dt);
                time += dt;
                if (pos.y <= groundY && vel.y < 0f)
                {
                    float t = Mathf.InverseLerp(prev.y, pos.y, groundY);
                    return Vector3.Lerp(prev, pos, t);
                }
            }
            return pos;
        }

        /// <summary>Posição quando a bola cruza o plano z = planeZ (ou null se não cruzar no tempo).</summary>
        public static bool CrossPlaneZ(Vector3 pos, Vector3 vel, Vector3 spin, Vector3 wind, BallParams p, float unitsPerMeter,
                                       float planeZ, out Vector3 at, out float time, float maxTime = 5f, float dt = 1f / 240f)
        {
            time = 0f;
            float side = Mathf.Sign(pos.z - planeZ);
            while (time < maxTime)
            {
                Vector3 prev = pos;
                Step(ref pos, ref vel, ref spin, wind, p, unitsPerMeter, dt);
                time += dt;
                if (Mathf.Sign(pos.z - planeZ) != side)
                {
                    float t = Mathf.InverseLerp(prev.z, pos.z, planeZ);
                    at = Vector3.Lerp(prev, pos, t);
                    return true;
                }
            }
            at = pos;
            return false;
        }

        /// <summary>Velocidade de lançamento (u/s) para a bola cair a `distance` (u) no plano, com o ângulo dado.
        /// Busca binária sobre a simulação (o arrasto não tem solução fechada).</summary>
        public static float SolveSpeed(float distance, float launchDeg, float backspin, BallParams p, float unitsPerMeter,
                                       float heightDelta = 0f, float maxSpeedMS = 90f)
        {
            float lo = 0.5f, hi = maxSpeedMS;
            float rad = launchDeg * Mathf.Deg2Rad;
            for (int it = 0; it < 28; it++)
            {
                float mid = 0.5f * (lo + hi);
                Vector3 v = new Vector3(0f, Mathf.Sin(rad), Mathf.Cos(rad)) * mid * unitsPerMeter;
                Vector3 spin = BackspinAxis(Vector3.forward) * backspin;
                float t;
                Vector3 land = PredictLanding(Vector3.zero, v, spin, Vector3.zero, p, unitsPerMeter, heightDelta, out t);
                if (land.z < distance) lo = mid; else hi = mid;
            }
            return 0.5f * (lo + hi) * unitsPerMeter;
        }

        /// <summary>Eixo do backspin para uma direção de voo (ω × v aponta para cima). Topspin = eixo oposto.</summary>
        public static Vector3 BackspinAxis(Vector3 direction)
        {
            Vector3 h = new Vector3(direction.x, 0f, direction.z);
            if (h.sqrMagnitude < 1e-8f) h = Vector3.forward;
            return Vector3.Cross(h.normalized, Vector3.up);
        }

        /// <summary>Quique numa superfície de normal n: componente normal invertida com restituição, tangencial
        /// reduzida pelo atrito; parte do spin vira velocidade tangencial (efeito no quique).</summary>
        public static Vector3 Bounce(Vector3 vel, Vector3 normal, ref Vector3 spin, BallParams p, float unitsPerMeter)
        {
            float vn = Vector3.Dot(vel, normal);
            if (vn >= 0f) return vel;
            Vector3 vN = vn * normal;
            Vector3 vT = vel - vN;
            // velocidade da superfície da bola devida ao spin: ω × (−r·n)
            Vector3 contact = Vector3.Cross(spin, -normal * p.radiusM * unitsPerMeter);
            Vector3 slip = vT + contact;
            Vector3 newT = vT - slip * Mathf.Clamp01(p.friction);
            spin *= 1f - Mathf.Clamp01(p.friction);
            return newT - vN * p.restitution;
        }
    }
}
