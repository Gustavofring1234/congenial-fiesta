// Beisebol (RPBsbScene) no estádio ballpark00: home na origem, linhas de falta em −X (1ª base) e +Z (3ª),
// muro com a distância por ângulo tirada da malha de colisão bbl_Field_a (gameplay_data.json).
// O jogador rebate no alto da entrada e arremessa no baixo, como no original.
// Rebater: gesto Swing; o momento em relação à passagem da bola pela base decide contato e direção
// (adiantado = puxa para o campo esquerdo). Arremessar: direcional escolhe o tipo (^ rápida, < curva,
// > slider, v troca de velocidade), gesto: força = velocidade, inclinação = lado.
using System.Collections;
using System.Collections.Generic;
using LinuxSports.Activities.Rules;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Activities.Baseball
{
    public sealed class BaseballActivity : SportActivity
    {
        private enum PitchType { Fastball, Curve, Slider, Changeup, Splitter }

        private BaseballGame game;
        private BallBody ball;
        private Vector3 home, cf, pitcherSpot;
        private float pitcherDist, baseDist;
        private float[] fence;
        private float fenceStep;
        private readonly List<SportActor> fielders = new List<SportActor>();
        private readonly Vector3[] fielderHome = new Vector3[8];
        private SportActor batter, pitcher, catcher;
        private readonly SportActor[] runners = new SportActor[3];
        private GameObject bat;
        private const float BallRadius = 0.37f;
        private const float WindowS = 0.13f;

        // Posições defensivas (ângulo a partir da linha da 1ª base em graus, distância em m).
        private static readonly Vector2[] FieldPos =
        {
            new Vector2(8f, 26f), new Vector2(30f, 40f), new Vector2(60f, 40f), new Vector2(82f, 26f),
            new Vector2(18f, 78f), new Vector2(45f, 88f), new Vector2(72f, 78f),
        };

        protected override IEnumerator Run()
        {
            game = new BaseballGame(Mathf.Clamp(Session.baseballInnings, 1, 9));
            home = Vector3.zero;
            cf = new Vector3(-1f, 0f, 1f).normalized;
            pitcherDist = Sport.G("pitcherDistance", 184.4f);
            baseDist = Sport.G("baseDistance", 274.3f);
            fence = Sport.GA("fence");
            fenceStep = Sport.G("fenceAngleStepDeg", 5f);
            pitcherSpot = home + cf * pitcherDist;

            Hud.ClearAll();
            Hud.SetTitle("Beisebol");
            yield return LoadScene(Sport.scenes.Count > 0 ? Sport.scenes[0] : null, true, true);
            Hud.ShowLayout(Sport.Hud("bblVsGame_00"));
            BuildBall();
            Audio.PlayAmbient(SfxKind.Crowd, 0.4f);
            Cue("SE_TR_Common_Sports_Game_Start");
            yield return Banner("Play ball! " + game.innings + (game.innings == 1 ? " entrada" : " entradas"), 1.6f);

            while (!game.IsGameOver)
            {
                bool humanBatting = game.BattingTeam == 0;
                SetupHalf(humanBatting);
                int half = game.Inning * 2 + (game.Bottom ? 1 : 0);
                yield return Banner(game.HalfText + (humanBatting ? " - você rebate" : " - você arremessa"), 1.4f);
                while (!game.IsGameOver && game.Inning * 2 + (game.Bottom ? 1 : 0) == half)
                    yield return PlayPitch(humanBatting);
            }
            Audio.StopAmbient();
            Cue("SE_TR_Common_Sports_Game_End");
            int w = game.Winner;
            yield return Banner((w == 0 ? "Vitória " : w == 1 ? "Derrota " : "Empate ") + game.Runs(0) + " x " + game.Runs(1), 2.5f);
            Finish(BuildResult());
        }

        private void BuildBall()
        {
            var go = Model("bbl_Ball", transform, PrimitiveType.Sphere, Vector3.one * BallRadius * 2.5f, Color.white);
            if (Resources.Load<GameObject>(Sport.ModelPrefab("bbl_Ball") ?? "") != null) go.transform.localScale = Vector3.one * (BallRadius * 1.4f / 1.2f);
            ball = go.AddComponent<BallBody>();
            ball.parameters = BallParams.Baseball;
            ball.unitsPerMeter = U;
            ball.visualRadius = BallRadius;
            ball.useGroundPlane = true;
            ball.groundPlaneY = 0f;
            ball.restSpeed = 3f;
            ball.Bounced += (p, n, s, c) => { if (s > M(3f)) { Fx("Bsb_bound_grass01", p); Impact(Mathf.Clamp01(s / M(30f)) * 0.4f, 0.4f, 200f); } };
        }

        private void SetupHalf(bool humanBatting)
        {
            foreach (var f in fielders) if (f != null) Destroy(f.gameObject);
            fielders.Clear();
            foreach (var r in runners) if (r != null) Destroy(r.gameObject);
            if (batter != null) Destroy(batter.gameObject);
            if (pitcher != null) Destroy(pitcher.gameObject);
            if (catcher != null) Destroy(catcher.gameObject);
            var battingSlot = humanBatting ? Session.players[0] : Opponent();
            var fieldingSlot = humanBatting ? Opponent() : Session.players[0];
            Color bc = TeamColors[humanBatting ? 0 : 1], fc = TeamColors[humanBatting ? 1 : 0];
            Vector3 right = Vector3.Cross(Vector3.up, cf);
            batter = SpawnActor(battingSlot, home - right * M(0.9f), right, bc);
            bat = batter.Attach(Sport.ModelPrefab("bbl_Bat"), "wrist_l", Vector3.zero, Vector3.zero, PrimitiveType.Cylinder, new Vector3(0.6f, 5f, 0.6f), new Color(0.7f, 0.5f, 0.3f));
            batter.Play("bbl_b_waitR");
            pitcher = SpawnActor(fieldingSlot, pitcherSpot, -cf, fc);
            pitcher.Attach(Sport.ModelPrefab("bbl_Glove_l"), "wrist_l", Vector3.zero, Vector3.zero, PrimitiveType.Sphere, Vector3.one * 1.5f, new Color(0.5f, 0.3f, 0.1f));
            pitcher.Play("bbl_p_waitR");
            catcher = SpawnActor(fieldingSlot, home - cf * M(1.2f), cf, fc);
            catcher.Play("bbl_c_waitR");
            for (int i = 0; i < FieldPos.Length; i++)
            {
                Vector3 pos = FieldPoint(FieldPos[i].x, M(FieldPos[i].y));
                fielderHome[i] = pos;
                var f = SpawnActor(fieldingSlot, pos, home - pos, fc);
                f.moveSpeed = M(6.5f + 2f * (fieldingSlot.ai != null ? fieldingSlot.ai.speed : 0.5f));
                f.Play("bbl_A0_waitR");
                fielders.Add(f);
            }
            for (int i = 0; i < 3; i++) runners[i] = null;
            CameraBatting();
            UpdateHud();
        }

        private PlayerSlot Opponent() { return Session.players.Count > 1 ? Session.players[1] : Session.players[0]; }

        /// <summary>Ponto do campo pelo ângulo a partir da linha da 1ª base (Wii +X = Unity −X) e distância.</summary>
        private Vector3 FieldPoint(float angleDeg, float dist)
        {
            float a = angleDeg * Mathf.Deg2Rad;
            return new Vector3(-Mathf.Cos(a) * dist, 0f, Mathf.Sin(a) * dist);
        }

        private static float FieldAngle(Vector3 p) { return Mathf.Atan2(p.z, -p.x) * Mathf.Rad2Deg; }

        private float FenceAt(float angleDeg)
        {
            if (fence == null || fence.Length == 0) return M(100f);
            float k = Mathf.Clamp(angleDeg / fenceStep, 0f, fence.Length - 1.001f);
            int i = (int)k;
            return Mathf.Lerp(fence[i], fence[Mathf.Min(i + 1, fence.Length - 1)], k - i);
        }

        private Vector3 BasePos(int b)   // 0 = 1ª, 1 = 2ª, 2 = 3ª, 3 = home
        {
            switch (b)
            {
                case 0: return new Vector3(-baseDist, 0f, 0f);
                case 1: return new Vector3(-baseDist, 0f, baseDist);
                case 2: return new Vector3(0f, 0f, baseDist);
                default: return home;
            }
        }

        private void CameraBatting()
        {
            CameraSet(home - cf * M(7f) + Vector3.up * M(2.4f), pitcherSpot + Vector3.up * M(1f), 42f);
        }

        // ------------------------------------------------------------------ arremesso
        private IEnumerator PlayPitch(bool humanBatting)
        {
            CameraBatting();
            ball.gameObject.SetActive(true);
            Vector3 release = pitcherSpot + Vector3.up * M(1.9f) + Vector3.Cross(Vector3.up, cf) * M(0.4f);
            ball.Hold(release);
            pitcher.Play("bbl_p_waitR");
            batter.Play("bbl_b_swing_wait1R");
            PitchType type;
            float speedMS, lateral, height;
            if (humanBatting)
            {
                Hud.SetHint("Gesto de rebatida quando a bola chegar (arrastar/soltar, Espaço, celular)");
                yield return Wait(0.9f + (float)Rng.NextDouble() * 0.6f);
                CpuPitch(Opponent().ai, out type, out speedMS, out lateral, out height);
            }
            else
            {
                Hud.SetHint("Direcional: ^ rápida  < curva  > slider  v troca  •  gesto para arremessar");
                type = PitchType.Fastball;
                GestureEvent g = default(GestureEvent);
                bool got = false;
                yield return WaitGesture(GestureKind.Throw, e => { g = e; got = true; }, () =>
                {
                    Vector2 m = Input.Move;
                    if (m.y > 0.6f) type = PitchType.Fastball;
                    else if (m.x < -0.6f) type = PitchType.Curve;
                    else if (m.x > 0.6f) type = PitchType.Slider;
                    else if (m.y < -0.6f) type = PitchType.Changeup;
                    Hud.SetHint("Arremesso: " + PitchName(type) + "   (^ rápida  < curva  > slider  v troca)  •  gesto para arremessar");
                    return true;
                });
                if (!got) yield break;
                float baseSpeed = type == PitchType.Changeup ? 30f : type == PitchType.Curve ? 33f : 37f;
                speedMS = Mathf.Clamp(baseSpeed * (0.75f + 0.3f * Mathf.Clamp(g.speed, 0f, 1.4f)), 22f, 46f);
                lateral = Mathf.Clamp((90f - g.angle) / 45f, -1f, 1f) * 0.35f;
                height = 0.8f + Mathf.Clamp(g.dirY, -1f, 1f) * 0.1f;
            }
            Hud.SetHint("");
            pitcher.Play(type == PitchType.Fastball ? "bbl_p_pitch1R" : "bbl_p_pitch2R");
            yield return Wait(0.45f);
            Vector3 spin;
            Vector3 v = SolvePitch(release, type, speedMS, lateral, height, out spin);
            ball.Launch(release, v, spin);
            Fx("Bsb_ball_tail01", release);
            Sfx(SfxKind.Whoosh, 0.3f);
            Hud.SetPane(Sport.Hud("bblCommon_00"), "T_ballSpeed_00", Mathf.RoundToInt(speedMS * 3.6f).ToString());
            Hud.SetPane(Sport.Hud("bblCommon_00"), "T_ballName_00", PitchName(type));

            // Tempo previsto de passagem pela base (plano perpendicular a cf na origem).
            float tCross = PredictPlateTime(release, v, spin);
            float t0 = Time.time;
            bool swung = false;
            float swingDt = 0f, swingPower = 0f;
            var batSlot = humanBatting ? Session.players[0] : Opponent();
            bool cpuWillSwing = false;
            float cpuDt = 0f;
            if (!humanBatting)
            {
                Vector3 at = PlateCrossing(release, v, spin);
                bool inZone = InZone(at);
                var ai = batSlot.ai;
                float discipline = 0.45f + 0.5f * ai.skill;
                cpuWillSwing = inZone ? Rng.NextDouble() < 0.55f + 0.4f * discipline : Rng.NextDouble() < 0.45f * (1f - discipline);
                cpuDt = ai.Error(Rng, 0.16f) + (type == PitchType.Changeup ? 0.05f * (1f - ai.skill) : 0f);
            }
            ClearGesture();
            while (true)
            {
                if (!Paused)
                {
                    float since = Time.time - t0;
                    GestureEvent g;
                    if (!swung && humanBatting && TakeGesture(out g)) { swung = true; swingDt = since - tCross; swingPower = g.speed; }
                    if (!swung && !humanBatting && cpuWillSwing && since >= tCross + cpuDt - 0.02f) { swung = true; swingDt = cpuDt; swingPower = 0.7f + 0.5f * batSlot.ai.power; }
                    if (swung && batter.CurrentAnimation != "bbl_b_swing1R") { batter.Play("bbl_b_swing1R"); Sfx(SfxKind.Whoosh, 0.6f); Fx("Bsb_batblur01", batter.transform.position + Vector3.up * M(1f)); }
                    // Contato: gesto adiantado espera a bola chegar à base; atrasado acontece na hora do gesto.
                    if (swung && Mathf.Abs(swingDt) <= WindowS && since >= Mathf.Max(tCross, tCross + swingDt) - 0.01f)
                    {
                        yield return Contact(swingDt, swingPower, batSlot);
                        yield break;
                    }
                    if (since > tCross + 0.35f) break;
                }
                yield return null;
            }
            // Sem contato: bola na luva do apanhador.
            Vector3 cross = ball.transform.position;
            ball.Hold(home - cf * M(1f) + Vector3.up * M(0.8f));
            catcher.Play("bbl_c_recerveR");
            Impact(0.3f, 0.2f, 120f);
            PitchResult res = swung ? PitchResult.SwingingStrike : InZone(PlateCrossing(release, v, spin)) ? PitchResult.CalledStrike : PitchResult.Ball;
            ApplyResult(res);
            yield return Banner(res == PitchResult.Ball ? "Ball" : res == PitchResult.SwingingStrike ? "Strike (girou)" : "Strike", 1f);
            yield return AfterPlay();
        }

        private static string PitchName(PitchType t)
        {
            switch (t)
            {
                case PitchType.Curve: return "Curva";
                case PitchType.Slider: return "Slider";
                case PitchType.Changeup: return "Troca de velocidade";
                case PitchType.Splitter: return "Splitter";
                default: return "Rápida";
            }
        }

        private void CpuPitch(AiProfile ai, out PitchType type, out float speedMS, out float lateral, out float height)
        {
            int n = ai.skill > 0.6f ? 5 : ai.skill > 0.3f ? 4 : 2;
            type = (PitchType)Rng.Next(n);
            float baseSpeed = type == PitchType.Changeup ? 30f : type == PitchType.Curve ? 32f : type == PitchType.Splitter ? 35f : 36f;
            speedMS = baseSpeed + 8f * ai.power + ai.Error(Rng, 1.5f);
            // A CPU mira as bordas da zona quanto mais habilidosa (às vezes erra para fora).
            lateral = Mathf.Clamp(ai.Error(Rng, 0.28f) + (Rng.NextDouble() < 0.5 ? -1f : 1f) * 0.12f * ai.skill, -0.45f, 0.45f);
            height = 0.8f + ai.Error(Rng, 0.25f);
        }

        private Vector3 PitchSpin(PitchType type, Vector3 dir)
        {
            Vector3 back = BallFlight.BackspinAxis(dir);
            switch (type)
            {
                case PitchType.Curve: return -back * 180f + Vector3.up * 60f;      // topspin: cai bastante
                case PitchType.Slider: return Vector3.up * -170f;                  // desvia para o lado
                case PitchType.Changeup: return back * 90f;
                case PitchType.Splitter: return -back * 60f;
                default: return back * 210f;                                        // rápida "sobe"
            }
        }

        /// <summary>Velocidade para a bola cruzar a base em (lateral, altura) metros.</summary>
        private Vector3 SolvePitch(Vector3 release, PitchType type, float speedMS, float lateralM, float heightM, out Vector3 spin)
        {
            Vector3 right = Vector3.Cross(Vector3.up, cf);
            Vector3 target = home + right * M(lateralM) + Vector3.up * M(heightM);
            spin = PitchSpin(type, (target - release).normalized);
            return PitchMath.Solve(release, target, M(speedMS), spin, home, cf, ball.parameters, U);
        }

        private Vector3 PlateCrossing(Vector3 from, Vector3 v, Vector3 spin)
        {
            float t;
            return PitchMath.PlateCrossing(from, v, spin, home, cf, ball.parameters, U, out t);
        }

        private float PredictPlateTime(Vector3 from, Vector3 v, Vector3 spin)
        {
            float t;
            PitchMath.PlateCrossing(from, v, spin, home, cf, ball.parameters, U, out t);
            return t;
        }

        private bool InZone(Vector3 at)
        {
            Vector3 right = Vector3.Cross(Vector3.up, cf);
            float lat = Vector3.Dot(at - home, right) / U, h = at.y / U;
            return Mathf.Abs(lat) <= 0.216f + 0.037f && h >= 0.45f && h <= 1.07f;
        }

        // ------------------------------------------------------------------ contato e jogada
        private IEnumerator Contact(float dt, float power, PlayerSlot batSlot)
        {
            float quality = 1f - Mathf.Abs(dt) / WindowS;                 // 1 = no ponto
            float spray = Mathf.Clamp(-dt / WindowS, -1f, 1f) * 48f;       // adiantado puxa (campo esquerdo)
            float exit = Mathf.Lerp(18f, 50f, quality * Mathf.Clamp01(power / 1.3f) * 0.85f + 0.15f * quality);
            float launch;
            if (quality > 0.75f) launch = Mathf.Lerp(18f, 32f, (float)Rng.NextDouble());
            else if (Rng.NextDouble() < 0.5) launch = Mathf.Lerp(-6f, 10f, (float)Rng.NextDouble());   // rasteira
            else launch = Mathf.Lerp(40f, 70f, (float)Rng.NextDouble());                               // bola alta
            spray += (float)(Rng.NextDouble() - 0.5) * 20f * (1f - quality);
            Vector3 dir = Quaternion.AngleAxis(spray, Vector3.up) * cf;
            Vector3 v = (dir * Mathf.Cos(launch * Mathf.Deg2Rad) + Vector3.up * Mathf.Sin(launch * Mathf.Deg2Rad)) * M(exit);
            Vector3 spin = BallFlight.BackspinAxis(dir) * (launch > 10f ? 220f : -120f);
            Vector3 from = home + Vector3.up * M(0.9f);
            ball.Launch(from, v, spin);
            Impact(Mathf.Clamp01(quality * 1.2f), 0.85f, 600f);
            if (quality > 0.85f) { Fx("Bsb_justmeet02", from); Cue("SE_TR_Common_Sports_Training_GoodLong"); }
            batter.Play("bbl_r_runR");

            // Simulação do voo para classificar a jogada.
            float hang;
            PitchResult res = Classify(from, v, spin, launch, exit, out hang);
            // Câmera e defensor correndo até a bola enquanto ela voa.
            float t = 0f, total = Mathf.Clamp(hang, 1f, 5f);
            Vector3 landing = BallFlight.PredictLanding(from, v, spin, Vector3.zero, ball.parameters, U, 0f, out hang);
            var chaser = NearestFielder(landing);
            Fx("Bsb_ballpoint01", landing);
            while (t < total)
            {
                if (!Paused)
                {
                    t += Time.deltaTime;
                    Vector3 bp = ball.transform.position;
                    CameraFollow(home - cf * M(12f) + Vector3.up * M(8f) + (bp - home) * 0.35f, bp, 2.5f, 50f);
                    if (chaser != null) chaser.MoveTowards(landing, Time.deltaTime, 1f, "bbl_A0_runR", "bbl_A0_waitR");
                    AdvanceRunnerVisuals(Time.deltaTime);
                }
                yield return null;
            }
            ball.Stop();
            string msg;
            switch (res)
            {
                case PitchResult.HomeRun: msg = "HOME RUN!"; Fx("Bsb_ballglow01", landing); break;
                case PitchResult.Foul: msg = "Foul"; break;
                case PitchResult.Out: msg = launch > 15f ? "Eliminado (bola alta)" : "Eliminado"; if (chaser != null) chaser.Play("bbl_c_recerveR"); break;
                case PitchResult.DoublePlay: msg = "Queimada dupla!"; break;
                case PitchResult.Single: msg = "Rebatida simples"; break;
                case PitchResult.Double: msg = "Rebatida dupla"; break;
                default: msg = "Rebatida tripla!"; break;
            }
            int runs = ApplyResult(res);
            if (runs > 0) msg += "\n+" + runs + (runs == 1 ? " corrida" : " corridas");
            if (res == PitchResult.HomeRun || res == PitchResult.Triple || res == PitchResult.Double) batter.SetExpression(Entities.MiiExpression.Smile);
            yield return Banner(msg, res == PitchResult.HomeRun ? 2.2f : 1.4f);
            batter.SetExpression(Entities.MiiExpression.Normal);
            yield return AfterPlay();
        }

        private PitchResult Classify(Vector3 from, Vector3 v, Vector3 spin, float launch, float exitMS, out float hang)
        {
            // Voo até cair ou passar o muro.
            Vector3 pos = from, vel = v, s = spin;
            float dt = 1f / 120f;
            hang = 0f;
            while (hang < 12f)
            {
                BallFlight.Step(ref pos, ref vel, ref s, Vector3.zero, ball.parameters, U, dt);
                hang += dt;
                Vector3 flat = new Vector3(pos.x, 0f, pos.z);
                float ang = FieldAngle(flat);
                if (ang >= -1f && ang <= 91f && flat.magnitude >= FenceAt(Mathf.Clamp(ang, 0f, 90f)))
                    return pos.y > M(3f) ? PitchResult.HomeRun : PitchResult.Double;   // bateu no muro
                if (pos.y <= 0f) break;
            }
            Vector3 land = new Vector3(pos.x, 0f, pos.z);
            float a = FieldAngle(land);
            if (a < 0f || a > 90f || land.magnitude < M(2f)) return PitchResult.Foul;
            float distM = land.magnitude / U;
            float fielderSpeed = 7f * U, reach = M(2.5f);
            float bestMargin = float.MaxValue;
            int nearest = -1;
            for (int i = 0; i < FieldPos.Length; i++)
            {
                Vector3 fp = FieldPoint(FieldPos[i].x, M(FieldPos[i].y));
                float need = (land - fp).magnitude - reach;
                float margin = need - fielderSpeed * Mathf.Max(0f, hang - 0.35f);
                if (margin < bestMargin) { bestMargin = margin; nearest = i; }
            }
            var def = Session.players[game.FieldingTeam == 0 ? 0 : Mathf.Min(1, Session.players.Count - 1)].ai;
            float defSkill = def != null ? def.skill : 0.5f;
            if (launch > 12f)
            {
                // Bola alta/linha: apanhada se algum defensor chega a tempo.
                if (bestMargin < M(1f) * defSkill)
                {
                    if (distM > 70f && game.Outs < 2) game.MarkSacrificeFly();
                    return PitchResult.Out;
                }
            }
            else
            {
                // Rasteira: infielders cortam bolas fracas ou na direção deles.
                for (int i = 0; i < 4; i++)
                {
                    float da = Mathf.Abs(a - FieldPos[i].x);
                    if (da < 6f + 6f * defSkill && exitMS < 44f)
                        return (game.Bases & 1) != 0 && game.Outs < 2 && exitMS < 36f && Rng.NextDouble() < 0.4 + 0.3 * defSkill ? PitchResult.DoublePlay : PitchResult.Out;
                }
                if (exitMS < 24f) return PitchResult.Out;
            }
            if (distM < 62f) return PitchResult.Single;
            if (distM < 88f || bestMargin < M(10f)) return PitchResult.Double;
            return PitchResult.Triple;
        }

        private SportActor NearestFielder(Vector3 p)
        {
            SportActor best = null;
            float d = float.MaxValue;
            foreach (var f in fielders)
            {
                float k = (f.transform.position - p).sqrMagnitude;
                if (k < d) { d = k; best = f; }
            }
            return best;
        }

        private int ApplyResult(PitchResult r)
        {
            int runs = game.Apply(r);
            UpdateRunnerVisuals();
            UpdateHud();
            return runs;
        }

        private IEnumerator AfterPlay()
        {
            ball.Stop();
            ball.gameObject.SetActive(false);
            for (int i = 0; i < fielders.Count; i++) fielders[i].transform.position = fielderHome[i];
            batter.Play("bbl_b_waitR");
            yield return Wait(0.4f);
        }

        private void UpdateRunnerVisuals()
        {
            var slot = game.BattingTeam == 0 ? Session.players[0] : Opponent();
            for (int b = 0; b < 3; b++)
            {
                bool occupied = (game.Bases >> b & 1) != 0;
                if (occupied && runners[b] == null)
                {
                    runners[b] = SpawnActor(slot, BasePos(b), BasePos((b + 1) % 4) - BasePos(b), TeamColors[game.BattingTeam]);
                    runners[b].Play("bbl_A0_waitR");
                }
                else if (!occupied && runners[b] != null) { Destroy(runners[b].gameObject); runners[b] = null; }
                else if (occupied) runners[b].transform.position = BasePos(b);
            }
        }

        private void AdvanceRunnerVisuals(float dt)
        {
            for (int b = 0; b < 3; b++)
                if (runners[b] != null) runners[b].MoveTowards(BasePos(b + 1 > 3 ? 3 : b + 1), dt, 0.8f, "bbl_r_runR", "bbl_A0_waitR");
        }

        private void UpdateHud()
        {
            string bases = ((game.Bases & 2) != 0 ? "#" : "o") + "\n" + ((game.Bases & 4) != 0 ? "#" : "o") + "   " + ((game.Bases & 1) != 0 ? "#" : "o");
            Hud.SetScore("Você " + game.Runs(0) + "  x  " + game.Runs(1) + " CPU\n" + game.HalfText + "\nB " + game.Balls + "  S " + game.Strikes + "  O " + game.Outs + "\n" + bases);
            string lyt = Sport.Hud("bblVsGame_00");
            Hud.SetPane(lyt, "T_scoreL_00", game.Runs(0).ToString());
            Hud.SetPane(lyt, "T_scoreR_00", game.Runs(1).ToString());
            Hud.SetPane(lyt, "T_game_00", (game.Inning + 1).ToString());
            var l = Hud.Layout(lyt);
            if (l != null)
            {
                for (int i = 0; i < 3; i++) l.SetVisible("P_ballOn_0" + i, game.Balls > i);
                for (int i = 0; i < 2; i++) l.SetVisible("P_strikeOn_0" + i, game.Strikes > i);
                for (int i = 0; i < 2; i++) l.SetVisible("P_outOn_0" + i, game.Outs > i);
                for (int i = 0; i < 3; i++) l.SetVisible("P_runnerOn_0" + (i + 1), (game.Bases >> i & 1) != 0);
            }
        }

        private ActivityResult BuildResult()
        {
            var r = NewResult();
            AddPlayer(r, Session.players[0], game.Runs(0), game.Runs(0) + " corridas, " + game.Hits(0) + " rebatidas");
            AddPlayer(r, Opponent(), game.Runs(1), game.Runs(1) + " corridas, " + game.Hits(1) + " rebatidas");
            r.winner = game.Winner;
            r.humanWon = game.Winner == 0;
            r.records.Add(new RecordSubmission { field = "BsbRenzokuBest", value = game.BestConsecutiveHits(0), mode = RecordMode.Higher });
            return r;
        }
    }
}
