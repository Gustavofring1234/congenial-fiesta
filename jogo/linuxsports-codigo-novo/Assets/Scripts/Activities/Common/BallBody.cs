// Bola com física própria (BallFlight) e colisão contra as MeshColliders da cena (as 21 malhas .glb de
// colisão) via SphereCast. Mais estável que Rigidbody para bolas rápidas/pequenas e igual em todo
// navegador (passos fixos). Rola quando a velocidade normal fica pequena, seguindo a inclinação.
using System;
using UnityEngine;

namespace LinuxSports.Activities
{
    public sealed class BallBody : MonoBehaviour
    {
        public BallParams parameters = BallParams.Tennis;
        public float unitsPerMeter = 10f;
        public float visualRadius = 1f;            // raio do modelo (u), usado na colisão
        public Vector3 wind;
        public LayerMask collisionMask = ~0;
        public bool useGroundPlane;                 // plano de segurança caso a malha falhe
        public float groundPlaneY;
        public float restSpeed = 0.6f;              // u/s
        public float maxSubstep = 1f / 240f;

        public Vector3 Velocity;
        public Vector3 Spin;                        // rad/s
        public bool Simulating { get; private set; }
        public bool Rolling { get; private set; }
        public bool AtRest { get; private set; }
        public int Bounces { get; private set; }
        public float AirTime { get; private set; }
        public Vector3 LastContactNormal { get; private set; } = Vector3.up;
        public Collider LastContact { get; private set; }

        /// <summary>Quique: ponto, normal, velocidade normal de impacto (u/s), collider.</summary>
        public event Action<Vector3, Vector3, float, Collider> Bounced;
        public event Action Rested;
        /// <summary>Chamado a cada subpasso antes da colisão (regras podem interceptar: rede, buraco, etc.).</summary>
        public Func<Vector3, Vector3, bool> Interceptor;
        /// <summary>Parâmetros de quique/rolamento por superfície (golfe: fairway, rough, banca, green).</summary>
        public Func<Collider, BallParams> SurfaceParams;
        private BallParams contactParams;

        /// <summary>Põe a bola rolando no chão (tacada de putter).</summary>
        public void Roll(Vector3 position, Vector3 velocity)
        {
            Launch(position, velocity, Vector3.zero);
            Rolling = true;
            LastContactNormal = Vector3.up;
            contactParams = parameters;
            RaycastHit hit;
            if (Physics.Raycast(position + Vector3.up * visualRadius * 2f, Vector3.down, out hit, visualRadius * 6f, collisionMask, QueryTriggerInteraction.Ignore))
            {
                LastContactNormal = hit.normal;
                LastContact = hit.collider;
                if (SurfaceParams != null) contactParams = SurfaceParams(hit.collider);
            }
        }

        public void Launch(Vector3 position, Vector3 velocity, Vector3 spin)
        {
            transform.position = position;
            Velocity = velocity;
            Spin = spin;
            Simulating = true;
            Rolling = false;
            AtRest = false;
            Bounces = 0;
            AirTime = 0f;
            contactParams = parameters;
        }

        public void Hold(Vector3 position)
        {
            transform.position = position;
            Velocity = Vector3.zero;
            Spin = Vector3.zero;
            Simulating = false;
            Rolling = false;
        }

        public void Stop() { Simulating = false; Velocity = Vector3.zero; }

        private void Update()
        {
            if (!Simulating) return;
            float dt = Mathf.Min(Time.deltaTime, 0.05f);
            int steps = Mathf.Max(1, Mathf.CeilToInt(dt / maxSubstep));
            float h = dt / steps;
            for (int i = 0; i < steps && Simulating; i++) Substep(h);
        }

        public void Substep(float h)
        {
            Vector3 pos = transform.position;
            Vector3 vel = Velocity;
            Vector3 spin = Spin;
            if (!Rolling)
            {
                AirTime += h;
                BallFlight.Step(ref pos, ref vel, ref spin, wind, parameters, unitsPerMeter, h);
            }
            else
            {
                // Rolamento: gravidade ao longo do plano + resistência ao rolamento.
                Vector3 n = LastContactNormal;
                Vector3 g = new Vector3(0f, -BallFlight.GravityMS2 * unitsPerMeter, 0f);
                Vector3 along = g - Vector3.Dot(g, n) * n;
                vel += along * h;
                vel -= Vector3.Dot(vel, n) * n;
                float sp = vel.magnitude;
                float decel = contactParams.rolling * BallFlight.GravityMS2 * unitsPerMeter * h;
                vel = sp > decel ? vel * ((sp - decel) / sp) : Vector3.zero;
                pos += vel * h;
                spin = Vector3.Cross(n, vel) / Mathf.Max(0.001f, visualRadius);
            }

            if (Interceptor != null && Interceptor(pos, vel)) { Velocity = vel; Spin = spin; return; }

            Vector3 from = transform.position;
            Vector3 delta = pos - from;
            float dist = delta.magnitude;
            RaycastHit hit;
            bool contact = false;
            if (dist > 1e-6f && Physics.SphereCast(from, visualRadius, delta / dist, out hit, dist, collisionMask, QueryTriggerInteraction.Ignore))
            {
                contact = true;
                pos = from + delta / dist * Mathf.Max(0f, hit.distance - 0.01f);
                Resolve(ref vel, ref spin, hit.normal, hit.point, hit.collider);
            }
            else if (Rolling)
            {
                // Mantém contato com o chão (descidas): sonda curta para baixo.
                if (Physics.SphereCast(pos + LastContactNormal * visualRadius, visualRadius, -LastContactNormal, out hit, visualRadius * 1.6f, collisionMask, QueryTriggerInteraction.Ignore))
                {
                    pos = pos + LastContactNormal * visualRadius - LastContactNormal * hit.distance;
                    LastContactNormal = hit.normal;
                    if (hit.collider != LastContact && SurfaceParams != null) contactParams = SurfaceParams(hit.collider);
                    LastContact = hit.collider;
                }
                else Rolling = false;   // saiu de uma borda: volta a voar
            }
            if (!contact && useGroundPlane && pos.y - visualRadius < groundPlaneY)
            {
                pos.y = groundPlaneY + visualRadius;
                Resolve(ref vel, ref spin, Vector3.up, new Vector3(pos.x, groundPlaneY, pos.z), null);
            }
            transform.position = pos;
            Velocity = vel;
            Spin = spin;
            if (Rolling && vel.magnitude < restSpeed && Vector3.Angle(LastContactNormal, Vector3.up) < 12f)
            {
                Velocity = Vector3.zero;
                Simulating = false;
                AtRest = true;
                if (Rested != null) Rested();
            }
        }

        private void Resolve(ref Vector3 vel, ref Vector3 spin, Vector3 normal, Vector3 point, Collider col)
        {
            float vn = -Vector3.Dot(vel, normal);
            LastContactNormal = normal;
            LastContact = col;
            contactParams = SurfaceParams != null && col != null ? SurfaceParams(col) : parameters;
            if (vn <= 0f) return;
            if (!Rolling && vn > restSpeed * 4f)
            {
                vel = BallFlight.Bounce(vel, normal, ref spin, contactParams, unitsPerMeter);
                Bounces++;
                if (Bounced != null) Bounced(point, normal, vn, col);
                // Quique muito fraco: passa a rolar.
                if (Vector3.Dot(vel, normal) < BallFlight.GravityMS2 * unitsPerMeter * 0.05f && normal.y > 0.5f) Rolling = true;
            }
            else
            {
                vel -= Vector3.Dot(vel, normal) * normal;
                if (normal.y > 0.5f) Rolling = true;
            }
        }
    }
}
