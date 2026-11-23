// Boliche (RPBowScene). Geometria de gameplay_data.json: linha de falta em z = 0, pino 1 em z ≈ -182,8
// (18,29 m), pista correndo para -Z, 10 u = 1 m; as 7 pistas de fundo usam a tabela do DOL lida por
// Bowling::CheckBallLaneIntersection. Pinos e bola são Rigidbody (PhysX funciona no WebGL); o efeito
// (gancho) só "pega" no último terço seco da pista, como no padrão de óleo real.
// Controle: Move esquerda/direita = posição; mirar (Aim x) = ângulo; gesto Throw: força = velocidade da
// bola, componente lateral do gesto = efeito.
using System.Collections;
using System.Collections.Generic;
using LinuxSports.Activities.Rules;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Activities.Bowling
{
    public sealed class BowlingActivity : SportActivity
    {
        private float headPinZ, laneHalf, pinSpacing, pinHeight, pinRadius, ballRadius, laneEnd;
        private float[] npcLaneX;
        private readonly Rigidbody[] pins = new Rigidbody[10];
        private readonly Vector3[] pinHome = new Vector3[10];
        private Transform[] pinVisuals = new Transform[10];
        private Rigidbody ball;
        private Transform ballVisual;
        private BowlingBallSpin ballSpin;
        private readonly List<BowlingScore> scores = new List<BowlingScore>();
        private readonly List<SportActor> actors = new List<SportActor>();
        private const float ReleaseZ = 4f;
        private const float DryZ = -115f;      // último terço da pista (sem óleo)
        private bool pinHitSoundCooldown;

        protected override IEnumerator Run()
        {
            headPinZ = Sport.G("headPinZ", -182.8f);
            laneHalf = Sport.G("laneHalfWidth", 10.54f);
            pinSpacing = Sport.G("pinSpacing", 3.048f);
            pinHeight = Sport.G("pinHeight", 3.82f);
            pinRadius = Sport.G("pinRadius", 0.64f);
            ballRadius = Sport.G("ballRadius", 1.09f);
            laneEnd = Sport.G("laneEndZ", -260f);
            npcLaneX = Sport.GA("npcLaneX");

            Hud.ClearAll();
            Hud.SetTitle("Boliche");
            yield return LoadScene(Sport.commonScene, false, true, null, n =>
                n == "bwg_field" || n == "bwg_field_front" || n == "bwg_lane" || n == "bwg_throwline" || n == "bwg_gate" ||
                n == "bwg_gate_frame_L" || n == "bwg_gate_frame_R" || n == "bwg_wall_L" || n == "bwg_wall_R" || n == "lane_alpha");
            BuildLane();
            BuildPins();
            BuildBall();
            BuildBackgroundLanes();
            Hud.ShowLayout(Sport.Hud("score_00"));

            for (int i = 0; i < Session.players.Count; i++)
            {
                scores.Add(new BowlingScore());
                var a = SpawnActor(Session.players[i], new Vector3(-20f - 8f * i, 0f, 18f), Vector3.back, TeamColors[i % 4]);
                actors.Add(a);
                a.Play("bwg_waitR");
            }
            Cue("SE_TR_Common_Sports_Game_Start");
            yield return Banner("Boliche - " + Session.bowlingFrames + " quadros", 1.5f);

            int frames = Mathf.Clamp(Session.bowlingFrames, 1, BowlingScore.Frames);
            for (int f = 0; f < frames; f++)
            {
                for (int p = 0; p < Session.players.Count; p++)
                {
                    var sc = scores[p];
                    ResetPins(BowlingScore.AllPins);
                    while (!sc.IsGameOver && sc.CurrentFrame == f)
                    {
                        yield return PlayRoll(p);
                    }
                    actors[p].transform.position = new Vector3(-20f - 8f * p, 0f, 18f);
                }
            }
            yield return Wait(0.5f);
            Cue("SE_TR_Common_Sports_Game_End");
            yield return Banner("Fim de jogo", 2f);
            Finish(BuildResult(frames));
        }

        // ------------------------------------------------------------------ montagem
        private void BuildLane()
        {
            var root = new GameObject("LanePhysics").transform;
            root.SetParent(transform, false);
            var lanePm = new PhysicMaterial("lane") { dynamicFriction = 0.04f, staticFriction = 0.05f, bounciness = 0.05f, frictionCombine = PhysicMaterialCombine.Minimum };
            var woodPm = new PhysicMaterial("wood") { dynamicFriction = 0.3f, staticFriction = 0.35f, bounciness = 0.3f };
            float pitZ = headPinZ - 12f;
            // Abordagem + pista + plataforma dos pinos (topo em y = 0).
            Box(root, "Lane", new Vector3(0f, -1f, (40f + pitZ) * 0.5f), new Vector3(laneHalf * 2f, 2f, 40f - pitZ), lanePm);
            // Canaletas (2,35 u de largura, 0,6 u abaixo).
            float g = 2.35f;
            Box(root, "GutterL", new Vector3(laneHalf + g * 0.5f, -1.6f, (pitZ) * 0.5f), new Vector3(g, 2f, -pitZ), woodPm);
            Box(root, "GutterR", new Vector3(-laneHalf - g * 0.5f, -1.6f, (pitZ) * 0.5f), new Vector3(g, 2f, -pitZ), woodPm);
            // Laterais (kickbacks) na área dos pinos e divisórias ao longo da pista.
            float wallX = laneHalf + g + 0.4f;
            Box(root, "WallL", new Vector3(wallX, 3f, pitZ * 0.5f), new Vector3(0.8f, 8f, -pitZ), woodPm);
            Box(root, "WallR", new Vector3(-wallX, 3f, pitZ * 0.5f), new Vector3(0.8f, 8f, -pitZ), woodPm);
            // Fosso: piso baixo e almofada no fundo.
            Box(root, "Pit", new Vector3(0f, -6f, pitZ - 10f), new Vector3(wallX * 2f, 2f, 20f), woodPm);
            Box(root, "Cushion", new Vector3(0f, 2f, pitZ - 18f), new Vector3(wallX * 2f, 14f, 1f), woodPm);
        }

        private static void Box(Transform parent, string n, Vector3 center, Vector3 size, PhysicMaterial pm)
        {
            var go = new GameObject(n);
            go.transform.SetParent(parent, false);
            go.transform.position = center;
            var c = go.AddComponent<BoxCollider>();
            c.size = size;
            c.sharedMaterial = pm;
        }

        private void BuildPins()
        {
            var visualRoot = Model("bwg_pin_166_10", transform, PrimitiveType.Cylinder, Vector3.zero, Color.white);
            var pinPm = new PhysicMaterial("pin") { dynamicFriction = 0.35f, staticFriction = 0.4f, bounciness = 0.45f };
            float rowStep = pinSpacing * 0.8660254f;
            for (int i = 0; i < 10; i++)
            {
                var pos = new Vector3(-BowlingScore.PinColumn(i) * pinSpacing * 0.5f, 0f, headPinZ - BowlingScore.PinRow(i) * rowStep);
                pinHome[i] = pos;
                var go = new GameObject("Pin" + (i + 1));
                go.transform.SetParent(transform, false);
                go.transform.position = pos;
                var col = go.AddComponent<CapsuleCollider>();
                col.radius = pinRadius;
                col.height = pinHeight;
                col.center = new Vector3(0f, pinHeight * 0.5f, 0f);
                col.sharedMaterial = pinPm;
                var rb = go.AddComponent<Rigidbody>();
                rb.mass = 1.55f;
                rb.centerOfMass = new Vector3(0f, pinHeight * 0.38f, 0f);   // pino pesa embaixo
                rb.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;
                rb.interpolation = RigidbodyInterpolation.Interpolate;
                pins[i] = rb;
                go.AddComponent<BowlingPinSound>().owner = this;
                // Visual: osso pin_166_mdl<i> do modelo NW4R (10 pinos no mesmo modelo), ou primitivo.
                Transform vis = ModelSpawner.FindDeep(visualRoot.transform, "pin_166_mdl" + i);
                if (vis == null)
                {
                    var prim = GameObject.CreatePrimitive(PrimitiveType.Capsule);
                    Destroy(prim.GetComponent<Collider>());
                    prim.transform.SetParent(go.transform, false);
                    prim.transform.localPosition = new Vector3(0f, pinHeight * 0.5f, 0f);
                    prim.transform.localScale = new Vector3(pinRadius * 2f, pinHeight * 0.5f, pinRadius * 2f);
                }
                pinVisuals[i] = vis;
            }
            if (pinVisuals[0] == null && visualRoot.GetComponent<Renderer>() != null) visualRoot.SetActive(false);
        }

        private void LateUpdate()
        {
            // Copia a pose física de cada pino para o osso correspondente do modelo NW4R.
            for (int i = 0; i < 10; i++)
                if (pinVisuals[i] != null && pins[i] != null)
                    pinVisuals[i].SetPositionAndRotation(pins[i].transform.position, pins[i].transform.rotation);
            if (ballVisual != null && ball != null) ballVisual.SetPositionAndRotation(ball.transform.position, ball.transform.rotation);
        }

        private void BuildBall()
        {
            var go = new GameObject("BowlingBall");
            go.transform.SetParent(transform, false);
            var col = go.AddComponent<SphereCollider>();
            col.radius = ballRadius;
            col.sharedMaterial = new PhysicMaterial("ball") { dynamicFriction = 0.06f, staticFriction = 0.08f, bounciness = 0.05f };
            ball = go.AddComponent<Rigidbody>();
            ball.mass = 6.8f;
            ball.maxAngularVelocity = 60f;
            ball.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;
            ball.interpolation = RigidbodyInterpolation.Interpolate;
            ball.isKinematic = true;
            ballSpin = go.AddComponent<BowlingBallSpin>();
            string[] colors = { "bwg_ball_blue", "bwg_ball_pink", "bwg_ball_green", "bwg_ball_yellow" };
            var vis = Model(colors[0], transform, PrimitiveType.Sphere, Vector3.one * ballRadius * 2f, new Color(0.2f, 0.3f, 0.9f));
            ballVisual = vis.transform;
        }

        private void BuildBackgroundLanes()
        {
            if (npcLaneX == null) return;
            float rowStep = pinSpacing * 0.8660254f;
            foreach (float lx in npcLaneX)
            {
                if (Mathf.Abs(lx) < 1f) continue;
                // A tabela do DOL está no referencial do Wii; no Unity o X é espelhado.
                float x0 = -lx;
                var lane = Model("bwg_pin_74_10", transform, PrimitiveType.Capsule, Vector3.zero, Color.white);
                bool bones = ModelSpawner.FindDeep(lane.transform, "pin_74_mdl0") != null;
                for (int i = 0; i < 10; i++)
                {
                    var pos = new Vector3(x0 - BowlingScore.PinColumn(i) * pinSpacing * 0.5f, 0f, headPinZ - BowlingScore.PinRow(i) * rowStep);
                    Transform t = bones ? ModelSpawner.FindDeep(lane.transform, "pin_74_mdl" + i) : null;
                    if (t != null) { t.position = pos; continue; }
                    var prim = GameObject.CreatePrimitive(PrimitiveType.Capsule);
                    Destroy(prim.GetComponent<Collider>());
                    prim.transform.SetParent(transform, false);
                    prim.transform.position = pos + Vector3.up * pinHeight * 0.5f;
                    prim.transform.localScale = new Vector3(pinRadius * 2f, pinHeight * 0.5f, pinRadius * 2f);
                }
                if (!bones && lane.GetComponent<Renderer>() != null) Destroy(lane);
            }
        }

        // ------------------------------------------------------------------ jogada
        private void ResetPins(int standingMask)
        {
            for (int i = 0; i < 10; i++)
            {
                var rb = pins[i];
                bool up = (standingMask >> i & 1) != 0;
                rb.gameObject.SetActive(up);
                if (pinVisuals[i] != null) pinVisuals[i].gameObject.SetActive(up);
                if (!up) continue;
                rb.isKinematic = true;
                rb.transform.SetPositionAndRotation(pinHome[i], Quaternion.identity);
                rb.isKinematic = false;
                rb.velocity = Vector3.zero;
                rb.angularVelocity = Vector3.zero;
                rb.Sleep();
            }
        }

        private int StandingMask()
        {
            int m = 0;
            for (int i = 0; i < 10; i++)
            {
                var t = pins[i].transform;
                if (!pins[i].gameObject.activeSelf) continue;
                Vector3 p = t.position;
                bool onDeck = p.y > -0.5f && Mathf.Abs(p.x) < laneHalf + 0.5f && p.z < headPinZ + 4f && p.z > headPinZ - 14f;
                if (onDeck && Vector3.Dot(t.up, Vector3.up) > 0.85f) m |= 1 << i;
            }
            return m;
        }

        private IEnumerator PlayRoll(int p)
        {
            var slot = Session.players[p];
            var sc = scores[p];
            var actor = actors[p];
            UpdateScoreHud(p);
            float x = 0f, angle = 0f, speed = 0f, spin = 0f;
            Hud.SetHint(slot.human ? "< > posição   •   ponteiro/analógico direito: mira   •   gesto (arrastar/soltar, Espaço, celular) para arremessar" : "Vez de " + Name(slot));
            CameraSet(new Vector3(0f, 14f, 42f), new Vector3(0f, 2f, headPinZ * 0.35f), 40f);
            actor.transform.position = new Vector3(0f, 0f, 14f);
            actor.Face(Vector3.back);
            actor.Play("bwg_waitR");

            if (slot.human)
            {
                GestureEvent g = default(GestureEvent);
                bool got = false;
                yield return WaitGesture(GestureKind.Throw, e => { g = e; got = true; }, () =>
                {
                    x = Mathf.Clamp(x - Input.Move.x * 9f * Time.deltaTime, -laneHalf + 2f, laneHalf - 2f);
                    angle = Mathf.Clamp(-Input.Aim.x * 4f, -4f, 4f);
                    actor.transform.position = new Vector3(x, 0f, 14f);
                    DrawAimGuide(x, angle);
                    return true;
                });
                if (!got) yield break;
                speed = Mathf.Lerp(5.5f, 9.8f, Mathf.Clamp01(g.speed / 1.3f));
                spin = Mathf.Clamp(g.dirX * 1.8f, -1f, 1f);   // gesto para a direita = curva para a direita (-X)
                angle += Mathf.Clamp((g.angle - 90f) * 0.03f, -2f, 2f);
            }
            else
            {
                yield return Wait(0.6f);
                ComputeCpuThrow(slot.ai, sc.StandingMask, out x, out angle, out speed, out spin);
                actor.transform.position = new Vector3(x, 0f, 14f);
                yield return Wait(0.4f);
            }
            HideAimGuide();
            Hud.SetHint("");
            actor.Play("bwg_throwR");
            // Passos de aproximação até a linha de falta.
            float t = 0f;
            Vector3 start = actor.transform.position, end = new Vector3(x, 0f, ReleaseZ + 2f);
            while (t < 0.7f) { t += Dt; actor.transform.position = Vector3.Lerp(start, end, t / 0.7f); yield return null; }
            Sfx(SfxKind.Whoosh, 0.5f);
            ReleaseBall(new Vector3(x - 1.5f, ballRadius + 0.05f, ReleaseZ), angle, speed, spin);
            yield return FollowRoll();
            int standing = StandingMask();
            var outcome = sc.Roll(standing);
            yield return Announce(p, outcome);
            if (outcome.frameComplete || sc.IsGameOver) yield break;
            // 10º quadro com pinos novos após strike/spare, ou sobra para a 2ª bola.
            ResetPins(sc.StandingMask);
        }

        private void ReleaseBall(Vector3 pos, float angleDeg, float speedMS, float spin)
        {
            ball.isKinematic = true;
            ball.transform.position = pos;
            ball.isKinematic = false;
            Vector3 dir = Quaternion.Euler(0f, -angleDeg, 0f) * Vector3.back;
            ball.velocity = dir * M(speedMS);
            ball.angularVelocity = Vector3.Cross(Vector3.up, dir) * (M(speedMS) / ballRadius) * 0.3f + Vector3.up * spin * 6f;
            ballSpin.Configure(this, spin, DryZ, laneHalf, ballRadius);
        }

        private IEnumerator FollowRoll()
        {
            float t = 0f;
            bool reachedPins = false;
            float settle = 0f;
            while (t < 9f)
            {
                if (!Paused)
                {
                    t += Time.deltaTime;
                    Vector3 bp = ball.position;
                    if (bp.z < headPinZ + 6f) reachedPins = true;
                    Vector3 camPos = reachedPins ? new Vector3(0f, 12f, headPinZ + 34f) : new Vector3(bp.x * 0.5f, 9f, bp.z + 30f);
                    Vector3 look = reachedPins ? new Vector3(0f, 1f, headPinZ - 3f) : new Vector3(bp.x * 0.5f, 1f, bp.z - 30f);
                    CameraFollow(camPos, look, reachedPins ? 2.5f : 6f, 38f);
                    if (reachedPins || bp.z < headPinZ - 10f || bp.y < -3f)
                    {
                        bool moving = false;
                        for (int i = 0; i < 10; i++)
                            if (pins[i].gameObject.activeSelf && !pins[i].IsSleeping() && pins[i].velocity.sqrMagnitude > 4f) moving = true;
                        settle = moving ? 0f : settle + Time.deltaTime;
                        if (settle > 1.2f) break;
                    }
                }
                yield return null;
            }
            ball.isKinematic = true;
            ball.transform.position = new Vector3(0f, -20f, 30f);
        }

        private IEnumerator Announce(int p, RollOutcome o)
        {
            var actor = actors[p];
            string msg = null;
            if (o.strike) { msg = "STRIKE!"; Fx("Bow_perfect_kira", pinHome[0] + Vector3.up * 3f); actor.PlayFirst("bwg_A0_happyR"); actor.SetExpression(Entities.MiiExpression.Smile); }
            else if (o.spare) { msg = "SPARE!"; actor.PlayFirst("bwg_A0_happyR"); actor.SetExpression(Entities.MiiExpression.Smile); }
            else if (o.gutter) { msg = "Canaleta"; actor.SetExpression(Entities.MiiExpression.Sorrow); }
            else if (o.split) msg = "Split! " + o.pins;
            else msg = o.pins + (o.pins == 1 ? " pino" : " pinos");
            UpdateScoreHud(p);
            if (o.strike || o.spare) Cue("SE_TR_Common_Sports_Training_GoodLong");
            yield return Banner(msg, o.strike || o.spare ? 1.6f : 1.1f);
            actor.SetExpression(Entities.MiiExpression.Normal);
            if (scores[p].IsGameOver && scores[p].Total == 300)
            {
                Fx("Bow_perfect_hubuki", pinHome[0] + Vector3.up * 6f);
                yield return Banner("Jogo perfeito: 300!", 2.5f);
            }
        }

        private void UpdateScoreHud(int current)
        {
            var sb = new System.Text.StringBuilder();
            for (int p = 0; p < scores.Count; p++)
            {
                var s = scores[p];
                sb.Append(p == current ? "> " : "   ").Append(Name(Session.players[p])).Append("  ");
                for (int f = 0; f < BowlingScore.Frames; f++)
                {
                    string m = s.FrameMarks(f);
                    sb.Append('[').Append(m.PadRight(f == 9 ? 3 : 2)).Append(']');
                }
                sb.Append("  ").Append(s.Total).Append('\n');
            }
            var cur = scores[current];
            sb.Append("Quadro ").Append(Mathf.Min(cur.CurrentFrame + 1, 10)).Append(", bola ").Append(cur.RollInFrame + 1);
            Hud.SetScore(sb.ToString());
            Hud.SetPane(Sport.Hud("score_00"), "T_score_00", cur.Total.ToString());
        }

        // ------------------------------------------------------------------ CPU
        private void ComputeCpuThrow(AiProfile ai, int standing, out float x, out float angle, out float speed, out float spin)
        {
            // Alvo: bolso 1-3 com o pino 1 em pé; senão o centro dos pinos restantes.
            float targetX = -0.75f;
            if ((standing & 1) == 0 || standing != BowlingScore.AllPins)
            {
                float sum = 0f; int n = 0;
                for (int i = 0; i < 10; i++) if ((standing >> i & 1) != 0) { sum += -BowlingScore.PinColumn(i) * pinSpacing * 0.5f; n++; }
                if (n > 0) targetX = sum / n;
            }
            x = Mathf.Clamp(ai.sideBias * 4f, -laneHalf + 2f, laneHalf - 2f);
            spin = Mathf.Clamp(ai.sideBias * 0.25f * ai.skill, -0.3f, 0.3f);
            // O gancho desloca a bola ~ spin * k no último terço: compensa mirando para o outro lado.
            float hookShift = spin * 6.5f;                 // efeito > 0 leva a bola para -X
            float aimX = targetX + hookShift + ai.Error(Rng, 3.2f);
            float dz = headPinZ - ReleaseZ;
            angle = Mathf.Atan2(aimX - (x - 1.5f), -dz) * Mathf.Rad2Deg;   // ângulo > 0 desvia para +X
            speed = Mathf.Clamp(7f + 2.2f * ai.power + ai.Error(Rng, 1f), 5.5f, 9.8f);
        }

        // ------------------------------------------------------------------ guia de mira (RPBowTrajectoryGuide)
        private LineRenderer guide;

        private void DrawAimGuide(float x, float angle)
        {
            if (guide == null)
            {
                var go = new GameObject("AimGuide");
                go.transform.SetParent(transform, false);
                guide = go.AddComponent<LineRenderer>();
                guide.widthMultiplier = 0.25f;
                guide.positionCount = 2;
                guide.material = new Material(Shader.Find("Sprites/Default"));
                guide.startColor = new Color(1f, 1f, 0.3f, 0.9f);
                guide.endColor = new Color(1f, 1f, 0.3f, 0f);
            }
            guide.enabled = true;
            Vector3 a = new Vector3(x - 1.5f, 0.1f, ReleaseZ);
            Vector3 dir = Quaternion.Euler(0f, -angle, 0f) * Vector3.back;
            guide.SetPosition(0, a);
            guide.SetPosition(1, a + dir * 80f);
        }

        private void HideAimGuide() { if (guide != null) guide.enabled = false; }

        internal void PinHit(float impulse)
        {
            if (pinHitSoundCooldown || impulse < 2f) return;
            pinHitSoundCooldown = true;
            Impact(Mathf.Clamp01(impulse / 40f), 0.35f, 320f);
            Fx("Bow_pin_hit", pinHome[0] + Vector3.up * 2f);
            StartCoroutine(Cooldown());
        }

        private IEnumerator Cooldown() { yield return new WaitForSeconds(0.06f); pinHitSoundCooldown = false; }

        // ------------------------------------------------------------------ resultado
        private ActivityResult BuildResult(int frames)
        {
            var r = NewResult();
            int best = -1, bestScore = -1;
            for (int p = 0; p < scores.Count; p++)
            {
                int total = scores[p].Total;
                AddPlayer(r, Session.players[p], total, total + " pontos (" + scores[p].Strikes + " strikes, " + scores[p].Spares + " spares)");
                if (total > bestScore) { bestScore = total; best = p; }
                else if (total == bestScore) best = -1;
            }
            r.winner = best;
            r.humanWon = best >= 0 && Session.players[best].human;
            r.lines.Add("Melhor: " + bestScore);
            if (frames == BowlingScore.Frames)
            {
                int human = scores[0].Total;
                r.records.Add(new RecordSubmission { field = "BowStandardBest", value = human, mode = RecordMode.Higher });
                if (human == 300) r.records.Add(new RecordSubmission { field = "BowPerfectCount", value = 1, mode = RecordMode.Add });
            }
            return r;
        }
    }

    /// <summary>Gancho da bola: aceleração lateral proporcional ao efeito, só no trecho seco e fora da canaleta.</summary>
    public sealed class BowlingBallSpin : MonoBehaviour
    {
        private BowlingActivity owner;
        private float spin, dryZ, laneHalf, radius;
        private Rigidbody rb;

        public void Configure(BowlingActivity o, float spin01, float dry, float half, float r)
        {
            owner = o; spin = spin01; dryZ = dry; laneHalf = half; radius = r;
            rb = GetComponent<Rigidbody>();
        }

        private void FixedUpdate()
        {
            if (rb == null || rb.isKinematic || owner == null || owner.Paused) return;
            Vector3 p = rb.position;
            bool onLane = Mathf.Abs(p.x) < laneHalf - radius * 0.3f && p.y < radius + 0.3f && p.y > -0.2f;
            if (!onLane) return;
            Vector3 v = rb.velocity;
            float forward = -v.z;
            if (forward <= 0.5f) return;
            // Trecho oleoso: derrapa; seco: o efeito morde, mais forte quanto mais lenta a bola.
            float grip = p.z < dryZ ? 1f : Mathf.InverseLerp(0f, dryZ, p.z) * 0.15f;
            float hookAccel = spin * grip * 34f * Mathf.Clamp(80f / forward, 0.6f, 1.6f);
            rb.AddForce(new Vector3(-hookAccel, 0f, 0f), ForceMode.Acceleration);
        }
    }

    /// <summary>Som/efeito ao bater no pino.</summary>
    public sealed class BowlingPinSound : MonoBehaviour
    {
        public BowlingActivity owner;

        private void OnCollisionEnter(Collision c)
        {
            if (owner != null) owner.PinHit(c.impulse.magnitude);
        }
    }
}
