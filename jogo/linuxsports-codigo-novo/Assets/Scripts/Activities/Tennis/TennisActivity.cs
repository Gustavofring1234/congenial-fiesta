// Tênis (RPTnsScene): duplas ou simples na quadra tns_Field_a. Como no original, os jogadores correm
// sozinhos até a bola; o jogador só bate. O momento do gesto define a direção (adiantado = cruzado,
// atrasado = paralela), a força define a velocidade e o gesto para cima dá topspin, para baixo slice/lob.
// Saque: primeiro gesto (ou Confirm) joga a bola para cima, o segundo bate; no topo = saque-foguete.
using System.Collections;
using System.Collections.Generic;
using LinuxSports.Activities.Rules;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Activities.Tennis
{
    public sealed class TennisActivity : SportActivity
    {
        private sealed class Player
        {
            public SportActor actor;
            public PlayerSlot slot;
            public int team;
            public Vector3 home;
            public GameObject racket;
        }

        private readonly TennisCourt court = new TennisCourt();
        private TennisScore score;
        private readonly List<Player> players = new List<Player>();
        private BallBody ball;
        private const float BallRadius = 0.35f;
        private const float HitRadius = 22f;       // alcance da raquete (u) a partir do centro do jogador
        private const float HitHeight = 26f;

        // estado do ponto
        private int lastHitTeam = -1;
        private int bouncesOnSide;
        private int bounceSideTeam = -1;
        private bool serving;
        private int pointWinner = -1;
        private string pointReason;
        private Player intercepter;
        private Vector3 interceptPoint;
        private float lastHitTime;
        private bool reServe;

        protected override IEnumerator Run()
        {
            court.unitsPerMeter = U;
            court.doubles = Session.tennisDoubles;
            court.halfLength = Sport.G("halfLength", court.halfLength);
            court.singlesHalfWidth = Sport.G("singlesHalfWidth", court.singlesHalfWidth);
            court.doublesHalfWidth = Sport.G("doublesHalfWidth", court.doublesHalfWidth);
            court.serviceLine = Sport.G("serviceLine", court.serviceLine);
            court.netCenter = Sport.G("netHeightCenter", court.netCenter);
            court.netPost = Sport.G("netHeightPost", court.netPost);
            court.netHalfWidth = Sport.G("netHalfWidth", court.netHalfWidth);
            int teamSize = Session.tennisDoubles ? 2 : 1;
            score = new TennisScore(Session.tennisGames, teamSize, 0);

            Hud.ClearAll();
            Hud.SetTitle("Tênis");
            yield return LoadScene(Sport.scenes.Count > 0 ? Sport.scenes[0] : null, true, true);
            Hud.ShowLayout(Sport.Hud("vsScoreServer_00"));
            BuildBall();
            BuildPlayers(teamSize);
            CameraSet(new Vector3(0f, M(7f), court.halfLength + M(11f)), new Vector3(0f, 0f, -M(3f)), 50f);
            Cue("SE_TR_Common_Sports_Game_Start");
            Audio.PlayAmbient(SfxKind.Crowd, 0.35f);
            yield return Banner(Session.tennisGames + (Session.tennisGames == 1 ? " game" : " games") + (Session.tennisDoubles ? " - duplas" : " - simples"), 1.5f);

            while (!score.IsMatchOver)
            {
                yield return PlayPoint();
                if (pointWinner < 0) continue;
                var ev = score.PointTo(pointWinner);
                yield return AnnouncePoint(ev);
            }
            Audio.StopAmbient();
            Cue("SE_TR_Common_Sports_Game_End");
            yield return Banner((score.Winner == 0 ? "Você venceu!" : "Você perdeu") + "  " + score.Games(0) + "-" + score.Games(1), 2.5f);
            Finish(BuildResult());
        }

        private void BuildBall()
        {
            var go = Model("tns_ball_a", transform, PrimitiveType.Sphere, Vector3.one * BallRadius * 2.4f, new Color(0.85f, 1f, 0.2f));
            if (Sport.ModelPrefab("tns_ball_a") != null && Resources.Load<GameObject>(Sport.ModelPrefab("tns_ball_a")) != null)
                go.transform.localScale = Vector3.one * (BallRadius * 1.3f / 5f);   // modelo tem raio 5 u
            ball = go.AddComponent<BallBody>();
            ball.parameters = BallParams.Tennis;
            ball.unitsPerMeter = U;
            ball.visualRadius = BallRadius;
            ball.useGroundPlane = true;
            ball.groundPlaneY = 0f;
            ball.restSpeed = 2f;
            ball.Bounced += OnBounce;
            ball.Interceptor = NetCheck;
        }

        private void BuildPlayers(int teamSize)
        {
            for (int team = 0; team < 2; team++)
            {
                for (int k = 0; k < teamSize; k++)
                {
                    int slotIndex = team * teamSize + k;
                    var slot = slotIndex < Session.players.Count ? Session.players[slotIndex] : Session.players[Session.players.Count - 1];
                    float s = TennisCourt.Side(team);
                    Vector3 home = teamSize == 1 ? new Vector3(0f, 0f, s * (court.halfLength + 6f))
                                                 : new Vector3((k == 0 ? -1f : 1f) * s * court.singlesHalfWidth * 0.55f, 0f, s * (court.halfLength * (k == 0 ? 0.95f : 0.45f)));
                    var actor = SpawnActor(slot, home, new Vector3(0f, 0f, -s), TeamColors[team]);
                    actor.moveSpeed = M(4.2f + 2.2f * (slot.ai != null ? slot.ai.speed : 0.5f));
                    var pl = new Player { actor = actor, slot = slot, team = team, home = home };
                    pl.racket = actor.Attach(Sport.ModelPrefab("tns_racket"), "wrist_r", Vector3.zero, Vector3.zero, PrimitiveType.Cube, new Vector3(2.4f, 6f, 0.4f), Color.white);
                    actor.Play("tns_waitR");
                    players.Add(pl);
                }
            }
        }

        // ------------------------------------------------------------------ ponto
        private IEnumerator PlayPoint()
        {
            pointWinner = -1;
            pointReason = null;
            lastHitTeam = -1;
            bouncesOnSide = 0;
            bounceSideTeam = -1;
            intercepter = null;
            UpdateHud();
            int servingTeam = score.ServingTeam;
            var server = TeamPlayer(servingTeam, score.ServerIndex);
            ResetPositions(server);
            yield return Wait(0.6f);

            // Saque (até 2 tentativas)
            while (pointWinner < 0)
            {
                if (reServe) { ResetPositions(server); yield return Wait(0.5f); }
                reServe = false;
                yield return Serve(server);
                if (pointWinner >= 0) yield break;
                // Bola em jogo: troca de bola até alguém fazer o ponto.
                yield return Rally();
                if (pointWinner >= 0 || score.IsMatchOver) yield break;
            }
        }

        private void ResetPositions(Player server)
        {
            int side = score.ServeSide;
            foreach (var p in players)
            {
                float s = TennisCourt.Side(p.team);
                Vector3 pos = p.home;
                if (p == server) pos = court.ServePosition(p.team, side);
                else if (p.team != server.team && (players.Count == 2 || IsReceiver(p, server, side)))
                {
                    // Recebedor na diagonal do sacador.
                    Vector3 sp = court.ServePosition(server.team, side);
                    pos = new Vector3(-sp.x * 1.6f, 0f, s * (court.halfLength + 2f));
                }
                p.actor.transform.position = pos;
                p.actor.Face(new Vector3(0f, 0f, -s));
                p.actor.Play("tns_waitR");
            }
        }

        private bool IsReceiver(Player p, Player server, int side)
        {
            var mates = players.FindAll(q => q.team == p.team);
            int idx = mates.IndexOf(p);
            return idx == side % mates.Count;
        }

        private Player TeamPlayer(int team, int index)
        {
            var mates = players.FindAll(q => q.team == team);
            return mates[Mathf.Clamp(index, 0, mates.Count - 1)];
        }

        private IEnumerator Serve(Player server)
        {
            serving = true;
            int side = score.ServeSide;
            int receiver = 1 - server.team;
            float s = TennisCourt.Side(server.team);
            Vector3 hand = server.actor.transform.position + new Vector3(0f, M(1f), 0f) + server.actor.transform.right * 2f;
            ball.Hold(hand);
            server.actor.Play("tns_toss_waitR");
            Hud.SetHint(server.slot.human ? "Gesto (ou Confirmar) para lançar a bola; gesto de novo para sacar" : "");

            bool tossed = false;
            float tossTime = 0f;
            GestureEvent g = default(GestureEvent);
            bool hit = false;
            if (server.slot.human)
            {
                while (!tossed)
                {
                    if (!Paused && (Input.ConfirmThisFrame || TakeGesture(out g))) tossed = true;
                    yield return null;
                }
            }
            else { yield return Wait(0.8f); tossed = true; }
            // Lançamento: bola sobe ~1,5 m acima da mão (ápice em ~0,55 s).
            server.actor.Play("tns_tossR");
            ball.Launch(hand, Vector3.up * M(5.4f), Vector3.zero);
            ball.useGroundPlane = true;
            ClearGesture();
            float apexTime = 5.4f / BallFlight.GravityMS2;
            float cpuHitAt = apexTime + (server.slot.ai != null ? server.slot.ai.Error(Rng, 0.12f) : 0f);
            while (!hit)
            {
                if (!Paused)
                {
                    tossTime += Time.deltaTime;
                    if (server.slot.human ? TakeGesture(out g) : tossTime >= cpuHitAt)
                    {
                        if (!server.slot.human)
                            g = new GestureEvent { speed = 0.75f + 0.45f * server.slot.ai.power, angle = 90f + server.slot.ai.Error(Rng, 15f), dirY = 1f };
                        hit = true;
                    }
                    if (ball.transform.position.y < hand.y - M(0.3f) && tossTime > apexTime) break;   // deixou cair: refaz
                }
                yield return null;
            }
            Hud.SetHint("");
            if (!hit) { ball.Hold(hand); serving = false; yield return Serve(server); yield break; }

            float timing = Mathf.Abs(tossTime - apexTime);
            bool rocket = timing < 0.06f && g.speed > 1f;
            float speed = M(Mathf.Lerp(28f, 48f, Mathf.Clamp01(g.speed / 1.4f)) * (rocket ? 1.18f : 1f) * Mathf.Lerp(1f, 0.75f, Mathf.Clamp01(timing / 0.3f)));
            Vector3 target = court.ServiceBoxCenter(receiver, side);
            float aimErr = (90f - g.angle) * 0.35f + (timing > 0.15f ? ((float)Rng.NextDouble() - 0.5f) * 18f : 0f);
            target.x += aimErr;
            target.z += -s * ((float)Rng.NextDouble() - 0.4f) * 14f * Mathf.Clamp01(timing / 0.2f);
            Vector3 from = ball.transform.position;
            Vector3 v = court.SolveShot(from, target, speed, 80f, ball.parameters, BallRadius);
            server.actor.Play("tns_serveR");
            ball.Launch(from, v, -BallFlight.BackspinAxis(v) * 80f);
            HitFeedback(server, g.speed, rocket);
            if (rocket) { Fx("Tns_ball_rocketserve", from); Fx("Tns_rocketserve_slow", from); }
            lastHitTeam = server.team;
            lastHitTime = Time.time;
            bouncesOnSide = 0;
            bounceSideTeam = -1;
            yield return null;
        }

        private IEnumerator Rally()
        {
            float stall = 0f;
            while (pointWinner < 0 && !reServe)
            {
                if (!Paused)
                {
                    StepPlayers(Time.deltaTime);
                    TryHits();
                    Vector3 bp = ball.transform.position;
                    // Bola parada, muito longe ou fora do mapa: encerra o ponto.
                    if (!ball.Simulating || bp.y < -M(5f) || Mathf.Abs(bp.z) > court.halfLength + M(25f) || Mathf.Abs(bp.x) > M(25f))
                    {
                        stall += Time.deltaTime;
                        if (stall > 0.2f) DecideDeadBall();
                    }
                    CameraFollow(new Vector3(bp.x * 0.3f, M(7f), court.halfLength + M(11f)), new Vector3(bp.x * 0.3f, 0f, Mathf.Clamp(bp.z, -court.halfLength, court.halfLength * 0.3f) - M(3f)), 2f, 50f);
                }
                yield return null;
            }
            ball.Stop();
        }

        private void DecideDeadBall()
        {
            if (pointWinner >= 0) return;
            // Quem bateu por último perde se a bola não quicou dentro do outro lado.
            if (bouncesOnSide >= 1 && bounceSideTeam >= 0) End(1 - bounceSideTeam, "dois quiques");
            else End(lastHitTeam >= 0 ? 1 - lastHitTeam : 1 - score.ServingTeam, "fora");
        }

        private void End(int winner, string reason)
        {
            if (pointWinner >= 0) return;
            pointWinner = winner;
            pointReason = reason;
            serving = false;
        }

        private void OnBounce(Vector3 point, Vector3 normal, float speed, Collider col)
        {
            if (pointWinner >= 0 || normal.y < 0.6f) return;
            Fx("Tns_ball_mark", point);
            Impact(Mathf.Clamp01(speed / M(20f)) * 0.5f, 0.5f, 240f);
            int sideTeam = point.z >= 0f ? 0 : 1;
            if (serving)
            {
                serving = false;
                if (sideTeam == lastHitTeam || !court.InServiceBox(point, 1 - lastHitTeam, score.ServeSide))
                {
                    bool dbl = score.FaultCount == 1;
                    Hud.ShowMessage(dbl ? "Dupla falta" : "Falta", 1.2f);
                    if (dbl) End(1 - lastHitTeam, "dupla falta");   // o ponto é dado em Run (PointTo zera as faltas)
                    else { score.Fault(); reServe = true; }        // 2º saque
                    return;
                }
                bounceSideTeam = sideTeam;
                bouncesOnSide = 1;
                return;
            }
            if (sideTeam == lastHitTeam && bounceSideTeam != sideTeam)
            {
                End(1 - lastHitTeam, "bola não passou a rede");
                return;
            }
            if (bounceSideTeam != sideTeam)
            {
                if (!court.InCourt(point, sideTeam)) { End(sideTeam, "fora"); Fx("Tns_ply_miss01", point); return; }
                bounceSideTeam = sideTeam;
                bouncesOnSide = 1;
            }
            else
            {
                bouncesOnSide++;
                if (bouncesOnSide >= 2) End(1 - sideTeam, "dois quiques");
            }
        }

        private bool NetCheck(Vector3 pos, Vector3 vel)
        {
            Vector3 prev = ball.transform.position;
            if (Mathf.Sign(prev.z) != Mathf.Sign(pos.z) && Mathf.Abs(pos.x) < court.netHalfWidth + 2f)
            {
                float t = Mathf.InverseLerp(prev.z, pos.z, 0f);
                Vector3 at = Vector3.Lerp(prev, pos, t);
                if (at.y - BallRadius < court.NetHeight(at.x))
                {
                    ball.transform.position = new Vector3(at.x, at.y, Mathf.Sign(prev.z) * (BallRadius + 0.2f));
                    ball.Velocity = new Vector3(vel.x * 0.3f, Mathf.Min(vel.y, 0f) * 0.3f, -vel.z * 0.1f);
                    Impact(0.25f, 0.1f, 140f);
                    if (serving) { /* bola na rede no saque: decide no quique (cai do lado do sacador = falta) */ }
                    return true;
                }
            }
            return false;
        }

        // ------------------------------------------------------------------ movimento e rebatidas
        private void StepPlayers(float dt)
        {
            Vector3 bp = ball.transform.position;
            Vector3 bv = ball.Velocity;
            int incomingTeam = bv.z > 0f ? 0 : 1;           // a bola vai para o lado deste time
            if (lastHitTeam >= 0 && incomingTeam == lastHitTeam) incomingTeam = 1 - lastHitTeam;
            // Escolhe quem vai na bola: o mais perto do ponto de interceptação previsto.
            if (intercepter == null || intercepter.team != incomingTeam)
            {
                interceptPoint = PredictIntercept(incomingTeam);
                float best = float.MaxValue;
                intercepter = null;
                foreach (var p in players)
                {
                    if (p.team != incomingTeam) continue;
                    float d = Flat(p.actor.transform.position - interceptPoint).magnitude;
                    if (d < best) { best = d; intercepter = p; }
                }
            }
            foreach (var p in players)
            {
                float s = TennisCourt.Side(p.team);
                Vector3 target = p == intercepter ? interceptPoint - p.actor.transform.right * M(0.9f) : p.home;
                float speedScale = p == intercepter ? 1f : 0.6f;
                // Reação da CPU: só começa a correr depois do tempo de reação.
                if (!p.slot.human && p.slot.ai != null && Time.time - lastHitTime < p.slot.ai.reaction) speedScale = 0f;
                bool arrived = p.actor.MoveTowards(target, dt, speedScale, "tns_walkR", "tns_waitR");
                p.actor.Face(new Vector3(bp.x - p.actor.transform.position.x, 0f, -s * M(10f)), dt);
                if (arrived && p == intercepter) p.actor.Play("tns_wait2R");
            }
        }

        /// <summary>Simula a bola adiante (com quique no chão) e devolve o primeiro ponto rebatível no lado do time.</summary>
        private Vector3 PredictIntercept(int team)
        {
            Vector3 pos = ball.transform.position, vel = ball.Velocity, spin = ball.Spin;
            float s = TennisCourt.Side(team);
            var prm = ball.parameters;
            bool bounced = bounceSideTeam == team;
            float dt = 1f / 60f;
            Vector3 candidate = new Vector3(pos.x, 0f, s * court.halfLength * 0.8f);
            for (float t = 0f; t < 3f; t += dt)
            {
                BallFlight.Step(ref pos, ref vel, ref spin, Vector3.zero, prm, U, dt);
                if (pos.y < BallRadius && vel.y < 0f)
                {
                    pos.y = BallRadius;
                    vel = BallFlight.Bounce(vel, Vector3.up, ref spin, prm, U);
                    if (pos.z * s > 0f) bounced = true;
                }
                if (pos.z * s > 0f && bounced && pos.y > M(0.5f) && pos.y < M(1.4f) && vel.y < 0f)
                    return new Vector3(Mathf.Clamp(pos.x, -court.doublesHalfWidth - M(3f), court.doublesHalfWidth + M(3f)), 0f, pos.z);
                if (pos.z * s > court.halfLength + M(6f)) return new Vector3(pos.x, 0f, s * (court.halfLength + M(5f)));
                if (pos.z * s > 0f) candidate = new Vector3(pos.x, 0f, pos.z);
            }
            return candidate;
        }

        private void TryHits()
        {
            if (serving || pointWinner >= 0 || intercepter == null) return;
            var p = intercepter;
            if (p.team == lastHitTeam) return;
            if (bounceSideTeam == p.team && bouncesOnSide >= 2) return;
            Vector3 bp = ball.transform.position;
            Vector3 rel = bp - (p.actor.transform.position + Vector3.up * M(1f));
            float radius = p.slot.human ? HitRadius * 1.4f : HitRadius * (p.slot.ai != null ? p.slot.ai.reach : 1f);
            bool inReach = Flat(rel).magnitude < radius && bp.y < HitHeight && bp.y > 0.4f;
            // Voleio só perto da rede; no fundo espera o quique.
            bool allowed = bounceSideTeam == p.team || Mathf.Abs(p.actor.transform.position.z) < court.serviceLine;
            if (!inReach || !allowed) { if (p.slot.human) { GestureEvent whiff; if (TakeGesture(out whiff)) Swing(p, false); } return; }
            float s = TennisCourt.Side(p.team);
            // Timing: posição da bola ao longo do eixo da quadra em relação ao jogador (+ = ainda na frente = adiantado).
            float timing = Mathf.Clamp(-rel.z * s / radius, -1f, 1f);
            if (p.slot.human)
            {
                GestureEvent g;
                if (!TakeGesture(out g)) return;
                Hit(p, g.speed, timing, g.dirY);
            }
            else
            {
                var ai = p.slot.ai;
                // A CPU espera o melhor momento com erro proporcional à imprecisão.
                float want = ai.Error(Rng, 0.6f);
                if (timing > want + 0.1f) return;
                Hit(p, 0.6f + 0.5f * ai.power + ai.Error(Rng, 0.15f), timing, ai.aggression > 0.6f ? 0.6f : 0.2f);
            }
        }

        private void Swing(Player p, bool connected)
        {
            bool forehand = Vector3.Dot(ball.transform.position - p.actor.transform.position, p.actor.transform.right) >= 0f;
            p.actor.Play(forehand ? "tns_forehandR" : "tns_backhandL");
            Sfx(SfxKind.Whoosh, 0.5f);
        }

        private void Hit(Player p, float power01, float timing, float dirY)
        {
            float s = TennisCourt.Side(p.team);
            int target = 1 - p.team;
            Swing(p, true);
            // Direção: adiantado (timing > 0) puxa para o lado do braço; atrasado empurra para o outro.
            bool forehand = Vector3.Dot(ball.transform.position - p.actor.transform.position, p.actor.transform.right) >= 0f;
            float pull = timing * (forehand ? 1f : -1f);
            float hw = court.HalfWidth * 0.85f;
            var ai = p.slot.human ? null : p.slot.ai;
            float x = Mathf.Clamp(-pull * hw * s + (ai != null ? ai.Error(Rng, hw * 0.5f) + ai.sideBias * 6f : 0f), -court.HalfWidth - M(1.5f), court.HalfWidth + M(1.5f));
            float power = Mathf.Clamp(power01, 0.1f, 1.6f);
            bool lob = dirY < -0.4f && power < 0.7f;
            float depth = Mathf.Lerp(0.55f, 0.92f, Mathf.Clamp01(power)) * court.halfLength;
            if (ai != null) depth += ai.Error(Rng, M(4f));
            // Força excessiva arrisca a bola sair.
            if (power > 1.2f) depth += (power - 1.2f) * M(12f) * (float)Rng.NextDouble();
            Vector3 aim = new Vector3(x, 0f, -s * depth);
            float speed = M(lob ? 14f : Mathf.Lerp(16f, 38f, Mathf.Clamp01(power / 1.3f)));
            float topspin = lob ? 20f : dirY > 0.3f ? 260f : dirY < -0.2f ? -120f : 120f;
            Vector3 from = ball.transform.position;
            Vector3 v = court.SolveShot(from, aim, speed, topspin, ball.parameters, BallRadius);
            if (lob) v.y = Mathf.Max(v.y, M(9f));
            ball.Launch(from, v, -BallFlight.BackspinAxis(v) * topspin);
            HitFeedback(p, power, false);
            lastHitTeam = p.team;
            lastHitTime = Time.time;
            bounceSideTeam = -1;
            bouncesOnSide = 0;
            intercepter = null;
        }

        private void HitFeedback(Player p, float power, bool rocket)
        {
            Impact(Mathf.Clamp01(power), 0.55f, rocket ? 320f : 260f);
            Fx("Tns_ball_spark", ball.transform.position);
            if (power > 1.1f) Fx(p.team == 0 ? "Tns_ply_good_blue" : "Tns_ply_good_red", p.actor.transform.position + Vector3.up * M(2.2f));
        }

        // ------------------------------------------------------------------ placar
        private IEnumerator AnnouncePoint(TennisEvent ev)
        {
            UpdateHud();
            int w = pointWinner;
            foreach (var p in players)
            {
                if (p.team == w) { p.actor.Play("tns_A0_jumpR"); p.actor.SetExpression(Entities.MiiExpression.Smile); }
                else p.actor.SetExpression(Entities.MiiExpression.Sorrow);
            }
            if (w == 0) Fx("Tns_jumpsmoke", players[0].actor.transform.position);
            string who = w == 0 ? "Ponto seu" : "Ponto do adversário";
            string msg;
            switch (ev)
            {
                case TennisEvent.Game: msg = "Game! " + score.Games(0) + "-" + score.Games(1); break;
                case TennisEvent.MatchOver: msg = "Game, set e partida!"; break;
                case TennisEvent.Deuce: msg = "Iguais"; break;
                case TennisEvent.Advantage: msg = "Vantagem " + (w == 0 ? "sua" : "do adversário"); break;
                default: msg = who + "  " + score.PointText(0); break;
            }
            if (!string.IsNullOrEmpty(pointReason) && ev == TennisEvent.Point) msg += "\n(" + pointReason + ")";
            if (ev == TennisEvent.Game || ev == TennisEvent.MatchOver) Cue("SE_TR_Common_Sports_Training_GoodLong");
            yield return Banner(msg, ev == TennisEvent.Point ? 1.4f : 2f);
            foreach (var p in players) p.actor.SetExpression(Entities.MiiExpression.Normal);
        }

        private void UpdateHud()
        {
            string server = score.ServingTeam == 0 ? "*" : " ";
            string server2 = score.ServingTeam == 1 ? "*" : " ";
            Hud.SetScore(server + " Você  games " + score.Games(0) + "   " + TennisScore.Call(Mathf.Min(score.Points(0), 3)) + "\n" +
                         server2 + " CPU   games " + score.Games(1) + "   " + TennisScore.Call(Mathf.Min(score.Points(1), 3)) + "\n" +
                         score.PointText(0) + (score.FaultCount > 0 ? "  (2º saque)" : ""));
            string lyt = Sport.Hud("vsScoreServer_00");
            Hud.SetPane(lyt, "T_scoreL_00", score.Games(0).ToString());
            Hud.SetPane(lyt, "T_scoreR_00", score.Games(1).ToString());
            Hud.SetPane(lyt, "T_scoreVsBar_00", score.PointText(0));
        }

        private ActivityResult BuildResult()
        {
            var r = NewResult();
            var human = Session.players[0];
            int teamSize = Session.tennisDoubles ? 2 : 1;
            int oppIndex = Mathf.Min(teamSize, Session.players.Count - 1);
            AddPlayer(r, human, score.Games(0), score.Games(0) + " games");
            AddPlayer(r, Session.players[oppIndex], score.Games(1), score.Games(1) + " games");
            r.winner = score.Winner;
            r.humanWon = score.Winner == 0;
            r.lines.Add("Pontos jogados: " + score.PointsPlayed);
            if (r.humanWon) r.records.Add(new RecordSubmission { field = "TnsSuccess", value = 1, mode = RecordMode.Add });
            return r;
        }

        private static Vector3 Flat(Vector3 v) { v.y = 0f; return v; }
    }
}
