// Golfe (RPGolScene): cada buraco é uma cena glf_course_* com o tee e os pinos do .pmp (tipo 0 e 1) e a
// colisão .glb separada por flag do KCL (superfície: tee/fairway/rough/banca/green/água/fora dos limites).
// Voo com arrasto, backspin e efeito lateral (BallFlight), vento por buraco, rolamento por superfície,
// buraco (copo) e penalidades. Ordem de jogo: quem está mais longe do pino joga.
// Controle: < > mira, ^ v troca de taco, gesto Swing: força = velocidade; inclinação do gesto = hook/slice.
using System.Collections;
using System.Collections.Generic;
using LinuxSports.Activities.Rules;
using LinuxSports.Core;
using LinuxSports.Engine;
using UnityEngine;

namespace LinuxSports.Activities.Golf
{
    public sealed class GolfActivity : SportActivity
    {
        private const float CupRadius = 0.6f;          // u: copo de 10,8 cm é 1,08 u; aceita bola com metade dentro
        private const float GreenRadiusM = 16f;
        private readonly List<GolfCourse> holes = new List<GolfCourse>();
        private GolfScorecard card;
        private Nw4rSceneLoader course;
        private BallBody ball;
        private Transform flag, cup;
        private LineRenderer aimLine;
        private readonly List<SportActor> actors = new List<SportActor>();
        private Vector3[] ballPos;
        private Vector3 pin;
        private Vector3 wind;
        private bool holed;
        private string lastSurface = "tee";

        protected override IEnumerator Run()
        {
            foreach (var id in Session.golfHoles)
            {
                var c = Data.golfCourses.Find(g => g.id == id);
                if (c != null) holes.Add(c);
            }
            if (holes.Count == 0 && Data.golfCourses.Count > 0) holes.Add(Data.golfCourses[0]);
            var pars = new List<int>();
            foreach (var h in holes) pars.Add(h.par);
            card = new GolfScorecard(pars, Session.players.Count, 10);
            Hud.ClearAll();
            Hud.SetTitle("Golfe");
            Hud.ShowLayout(Sport.Hud("golf_00"));
            BuildBall();
            for (int p = 0; p < Session.players.Count; p++)
                actors.Add(SpawnActor(Session.players[p], Vector3.zero, Vector3.forward, TeamColors[p % 4]));
            ballPos = new Vector3[Session.players.Count];
            Cue("SE_TR_Common_Sports_Game_Start");

            for (int h = 0; h < holes.Count; h++)
            {
                yield return PlayHole(h);
            }
            Cue("SE_TR_Common_Sports_Game_End");
            yield return ShowCard(holes.Count - 1, 3f);
            Finish(BuildResult());
        }

        private void BuildBall()
        {
            var go = Model("glf_ball1", transform, PrimitiveType.Sphere, Vector3.one, Color.white);
            ball = go.AddComponent<BallBody>();
            ball.parameters = BallParams.Golf;
            ball.unitsPerMeter = U;
            ball.visualRadius = 0.5f;
            ball.restSpeed = 0.8f;
            ball.SurfaceParams = SurfaceParams;
            ball.Bounced += OnBounce;
            ball.Interceptor = CupCheck;
            var lr = new GameObject("AimLine").AddComponent<LineRenderer>();
            lr.transform.SetParent(transform, false);
            lr.material = new Material(Shader.Find("Sprites/Default"));
            lr.widthMultiplier = 1.2f;
            lr.positionCount = 40;
            lr.startColor = new Color(1f, 1f, 1f, 0.8f);
            lr.endColor = new Color(1f, 0.9f, 0.2f, 0.4f);
            aimLine = lr;
        }

        private BallParams SurfaceParams(Collider c)
        {
            var p = BallParams.Golf;
            switch (Data.GolfSurface(c))
            {
                case "green": p.restitution = 0.25f; p.friction = 0.3f; p.rolling = 0.065f; break;
                case "fairway": case "tee": p.restitution = 0.35f; p.friction = 0.35f; p.rolling = 0.11f; break;
                case "rough": p.restitution = 0.22f; p.friction = 0.55f; p.rolling = 0.3f; break;
                case "deepRough": p.restitution = 0.12f; p.friction = 0.7f; p.rolling = 0.6f; break;
                case "bunker": p.restitution = 0.05f; p.friction = 0.9f; p.rolling = 1.5f; break;
                case "water": p.restitution = 0f; p.friction = 1f; p.rolling = 5f; break;
            }
            return p;
        }

        // ------------------------------------------------------------------ buraco
        private IEnumerator PlayHole(int h)
        {
            var hole = holes[h];
            if (course != null) { Destroy(course.gameObject); Scenes.Remove(course); }
            Hud.Fade(true);
            yield return Wait(0.4f);
            yield return LoadScene(hole.scene, true, true, l => course = l);
            pin = hole.pins.Count > 0 ? hole.pins[(h + Session.seed) % hole.pins.Count] : hole.tee + hole.teeForward * M(hole.distanceMeters);
            float gy;
            if (course != null && course.GroundHeight(pin, out gy)) pin.y = gy;
            PlaceFlag();
            float windMS = (float)Rng.NextDouble() * 6f;
            float windDir = (float)Rng.NextDouble() * 360f;
            wind = Quaternion.Euler(0f, windDir, 0f) * Vector3.forward * M(windMS);
            ball.wind = wind;
            for (int p = 0; p < ballPos.Length; p++) ballPos[p] = hole.tee + Vector3.up * 0.6f;
            Hud.Fade(false);
            Hud.SetPane(Sport.Hud("golf_00"), "T_holeNum_00", (h + 1).ToString());
            CameraSet(hole.tee + Vector3.up * M(30f) - hole.teeForward * M(15f), pin, 50f);
            yield return Banner("Buraco " + (h + 1) + "  •  Par " + hole.par + "  •  " + Mathf.RoundToInt(hole.distanceMeters) + " m\nVento " + windMS.ToString("0.0") + " m/s", 2.2f);

            while (!card.HoleComplete(h))
            {
                int p = NextPlayer(h);
                yield return PlayShot(h, p);
            }
            yield return ShowCard(h, 2.2f);
        }

        private void PlaceFlag()
        {
            if (flag == null) flag = Model("glf_pin1", transform, PrimitiveType.Cylinder, new Vector3(0.3f, 15f, 0.3f), new Color(1f, 0.2f, 0.2f)).transform;
            if (cup == null) cup = Model("glf_cup", transform, PrimitiveType.Cylinder, new Vector3(1.2f, 0.05f, 1.2f), Color.black).transform;
            flag.position = pin + (flag.GetComponent<Renderer>() != null && Sport.ModelPrefab("glf_pin1") == null ? Vector3.up * 15f : Vector3.zero);
            cup.position = pin;
        }

        /// <summary>Quem está mais longe do pino (e ainda não terminou) joga.</summary>
        private int NextPlayer(int h)
        {
            int best = -1;
            float far = -1f;
            for (int p = 0; p < ballPos.Length; p++)
            {
                if (card.Holed(p, h)) continue;
                float d = Flat(ballPos[p] - pin).magnitude;
                if (d > far) { far = d; best = p; }
            }
            return best;
        }

        private IEnumerator PlayShot(int h, int p)
        {
            var slot = Session.players[p];
            var actor = actors[p];
            Vector3 start = ballPos[p];
            string surface = SurfaceAt(start);
            ball.Hold(start);
            ball.gameObject.SetActive(true);
            float distM = Flat(pin - start).magnitude / U;
            bool onTee = card.Strokes(p, h) == 0;
            var club = GolfClub.Get(GolfClub.Suggest(distM, surface, onTee));
            Vector3 toPin = Flat(pin - start).normalized;
            float aimYaw = 0f;
            actor.transform.position = start - Quaternion.Euler(0f, 90f, 0f) * toPin * 3.5f;
            actor.Face(toPin);
            var clubGo = actor.Attach(Sport.ModelPrefab(club.model), "wrist_r", Vector3.zero, Vector3.zero, PrimitiveType.Cylinder, new Vector3(0.3f, 4f, 0.3f), Color.gray);
            actor.Play(club.kind == GolfClubKind.Putter ? "glf_p_wait_m_R" : "glf_w_wait_m_R");
            UpdateHud(h, p, club, distM, surface);

            GestureEvent g = default(GestureEvent);
            bool got = false;
            if (slot.human)
            {
                Hud.SetHint("< > mirar   ^ v taco   gesto de tacada (arrastar/soltar, Espaço, celular)");
                float clubTimer = 0f;
                yield return WaitGesture(GestureKind.Swing, e => { g = e; got = true; }, () =>
                {
                    aimYaw += Input.Move.x * 40f * Time.deltaTime;
                    clubTimer -= Time.deltaTime;
                    if (Mathf.Abs(Input.Move.y) > 0.6f && clubTimer <= 0f)
                    {
                        int k = Mathf.Clamp((int)club.kind + (Input.Move.y > 0 ? -1 : 1), 0, 3);
                        club = GolfClub.All[k];
                        clubTimer = 0.25f;
                        Destroy(clubGo);
                        clubGo = actor.Attach(Sport.ModelPrefab(club.model), "wrist_r", Vector3.zero, Vector3.zero, PrimitiveType.Cylinder, new Vector3(0.3f, 4f, 0.3f), Color.gray);
                        UpdateHud(h, p, club, distM, surface);
                    }
                    Vector3 dir = Quaternion.Euler(0f, aimYaw, 0f) * toPin;
                    DrawAim(start, dir, club, surface, 1f);
                    actor.Face(dir);
                    CameraFollow(start - dir * M(club.kind == GolfClubKind.Putter ? 5f : 9f) + Vector3.up * M(club.kind == GolfClubKind.Putter ? 2.5f : 4f),
                                 start + dir * M(Mathf.Min(distM, club.kind == GolfClubKind.Putter ? 10f : 60f)), 6f, 50f);
                    Hud.SetMeter(Input.Charge, Input.Charge > 0f);
                    return true;
                });
            }
            else
            {
                yield return Wait(0.8f);
                got = true;
                CpuShot(slot.ai, start, distM, surface, ref club, out aimYaw, out g);
                Destroy(clubGo);
                clubGo = actor.Attach(Sport.ModelPrefab(club.model), "wrist_r", Vector3.zero, Vector3.zero, PrimitiveType.Cylinder, new Vector3(0.3f, 4f, 0.3f), Color.gray);
                Vector3 dir = Quaternion.Euler(0f, aimYaw, 0f) * toPin;
                DrawAim(start, dir, club, surface, 1f);
                CameraSet(start - dir * M(9f) + Vector3.up * M(4f), start + dir * M(40f), 50f);
                yield return Wait(0.8f);
            }
            Hud.SetHint("");
            Hud.SetMeter(0f, false);
            aimLine.enabled = false;
            if (!got) yield break;

            // ---- tacada
            float power = Mathf.Clamp(g.speed, 0f, 1.3f);
            float over = Mathf.Max(0f, power - 1f);                 // força além de 100% = descontrole
            float dev = Mathf.Clamp(90f - g.angle, -45f, 45f);       // gesto inclinado = efeito lateral
            float errDeg = dev * 0.08f + (over > 0f ? ((float)Rng.NextDouble() * 2f - 1f) * club.maxErrorDeg * over * 3f : 0f);
            Vector3 aimDir = Quaternion.Euler(0f, aimYaw + errDeg, 0f) * toPin;
            actor.Play(club.kind == GolfClubKind.Putter ? (power < 0.4f ? "glf_p_swing_l" : power < 0.8f ? "glf_p_swing_m" : "glf_p_swing_h")
                                                         : (power < 0.4f ? "glf_w_swing_l_R" : power < 0.8f ? "glf_w_swing_m_R" : "glf_w_swing_h_R"));
            yield return Wait(0.35f);
            Sfx(SfxKind.Whoosh, 0.4f + 0.4f * power);
            Impact(Mathf.Clamp01(power), club.kind == GolfClubKind.Putter ? 0.3f : 0.8f, club.kind == GolfClubKind.Putter ? 500f : 900f);
            card.AddStroke(p, h);
            Fx(onTee ? "Gol_tee_shot" : surface == "bunker" ? "Gol_bunker_shot01" : surface == "rough" || surface == "deepRough" ? "Gol_rough_shot_leaf" : "Gol_fairway_shot", start);
            holed = false;
            float speedMS = Mathf.Min(power, 1.15f) * club.maxSpeedMS * GolfClub.SurfacePowerFactor(surface, club.kind);
            if (club.kind == GolfClubKind.Putter)
                ball.Roll(start, aimDir * M(speedMS));
            else
            {
                float launch = club.launchDeg * Mathf.Deg2Rad;
                Vector3 v = (aimDir * Mathf.Cos(launch) + Vector3.up * Mathf.Sin(launch)) * M(speedMS);
                Vector3 spin = BallFlight.BackspinAxis(aimDir) * club.backspin * (0.5f + 0.5f * power) + Vector3.up * dev * club.sideSpinPerDeg;   // gesto inclinado à direita: mira e curva à direita (slice)
                ball.Launch(start + Vector3.up * 0.2f, v, spin);
                Fx("Gol_balltail", start);
            }
            yield return FollowBall(start);
            Destroy(clubGo);
            yield return ResolveLie(h, p, start);
        }

        private IEnumerator FollowBall(Vector3 start)
        {
            float t = 0f;
            while (ball.Simulating && t < 25f && !holed)
            {
                if (!Paused)
                {
                    t += Time.deltaTime;
                    Vector3 bp = ball.transform.position;
                    Vector3 v = ball.Velocity;
                    Vector3 back = Flat(v).sqrMagnitude > 1f ? Flat(v).normalized : Flat(pin - bp).normalized;
                    CameraFollow(bp - back * M(ball.Rolling ? 6f : 14f) + Vector3.up * M(ball.Rolling ? 3f : 6f), bp, ball.Rolling ? 4f : 2.5f, 50f);
                    if (bp.y < -5000f) break;
                }
                yield return null;
            }
            ball.Stop();
        }

        private IEnumerator ResolveLie(int h, int p, Vector3 previous)
        {
            var actor = actors[p];
            Vector3 bp = ball.transform.position;
            string surface = holed ? "cup" : SurfaceAt(bp);
            if (holed)
            {
                card.Hole(p, h);
                int s = card.Strokes(p, h);
                string name = GolfScorecard.ResultName(s, card.par[h]);
                ballPos[p] = pin;
                ball.gameObject.SetActive(false);
                Cue(s <= card.par[h] ? "SE_TR_Common_Sports_Training_GoodLong" : "SE_TR_Common_Sports_Decide");
                if (s == 1) Fx("Gol_matohit_pinlight", pin);
                else if (s - card.par[h] <= -3) Fx("Gol_2d_albat", pin + Vector3.up * 10f);
                else if (s - card.par[h] == -2) Fx("Gol_2d_eagle", pin + Vector3.up * 10f);
                else if (s - card.par[h] == -1) Fx("Gol_2d_birdie", pin + Vector3.up * 10f);
                Fx("Gol_mapobj_hole_green", pin);
                actor.SetExpression(s <= card.par[h] ? Entities.MiiExpression.Smile : Entities.MiiExpression.Normal);
                yield return Banner(Name(Session.players[p]) + ": " + name, 2f);
                actor.SetExpression(Entities.MiiExpression.Normal);
                yield break;
            }
            if (surface == "water" || surface == "outOfBounds" || bp.y < pin.y - M(200f))
            {
                if (surface == "water") Fx("Gol_ikepocha", bp);
                bool capped = card.AddStroke(p, h, 0);   // penalidade de 1 tacada
                ballPos[p] = previous;
                yield return Banner(surface == "water" ? "Água! +1 tacada" : "Fora dos limites! +1 tacada", 1.6f);
                if (capped) yield return PickUp(h, p);
                yield break;
            }
            ballPos[p] = bp;
            lastSurface = surface;
            float left = Flat(pin - bp).magnitude / U;
            string where = surface == "green" ? "No green" : surface == "bunker" ? "Na banca" : surface == "fairway" ? "No fairway" : surface == "rough" || surface == "deepRough" ? "No rough" : "";
            if (card.Strokes(p, h) >= card.maxStrokesPerHole) { yield return PickUp(h, p); yield break; }
            yield return Banner(where + (where.Length > 0 ? " - " : "") + left.ToString(left < 10f ? "0.0" : "0") + " m do buraco", 1.2f);
        }

        private IEnumerator PickUp(int h, int p)
        {
            if (!card.Holed(p, h)) card.Hole(p, h);
            ballPos[p] = pin;
            yield return Banner(Name(Session.players[p]) + " recolhe a bola (limite de tacadas)", 1.5f);
        }

        // ------------------------------------------------------------------ física auxiliar
        private bool CupCheck(Vector3 pos, Vector3 vel)
        {
            Vector3 d = pos - pin;
            if (Flat(d).magnitude < CupRadius && d.y < 1.2f && d.y > -2f && Flat(vel).magnitude < M(1.8f))
            {
                holed = true;
                ball.Stop();
                ball.transform.position = pin + Vector3.down * 0.6f;
                Impact(0.3f, 0.9f, 1200f);
                return true;
            }
            // Bate na bandeira: devolve a bola para perto do copo.
            if (Flat(d).magnitude < 0.5f && d.y > 1.2f && d.y < 25f)
            {
                ball.Velocity = new Vector3(-vel.x * 0.2f, vel.y, -vel.z * 0.2f);
            }
            return false;
        }

        private void OnBounce(Vector3 point, Vector3 normal, float speed, Collider col)
        {
            string s = Data.GolfSurface(col);
            if (speed < M(1f)) return;
            if (s == "bunker") Fx("Gol_bunker_fall", point);
            else if (s == "rough" || s == "deepRough") Fx("Gol_rough_bound", point);
            else if (s == "water") Fx("Gol_ikepocha", point);
            else Fx("Gol_fairway_bound", point);
            Impact(Mathf.Clamp01(speed / M(20f)) * 0.5f, s == "bunker" ? 0.1f : 0.4f, 260f);
        }

        private string SurfaceAt(Vector3 p)
        {
            RaycastHit hit;
            if (Physics.Raycast(p + Vector3.up * 30f, Vector3.down, out hit, 400f, ~0, QueryTriggerInteraction.Ignore))
            {
                string s = Data.GolfSurface(hit.collider);
                if (s == "rough" && Flat(p - pin).magnitude < M(GreenRadiusM) * 0.6f) return "green";
                return s;
            }
            return "outOfBounds";
        }

        private void DrawAim(Vector3 start, Vector3 dir, GolfClub club, string surface, float power)
        {
            aimLine.enabled = true;
            float speed = M(club.maxSpeedMS * power * GolfClub.SurfacePowerFactor(surface, club.kind));
            if (club.kind == GolfClubKind.Putter)
            {
                float dist = M(Mathf.Min(Flat(pin - start).magnitude / U, 30f));
                for (int i = 0; i < aimLine.positionCount; i++)
                {
                    Vector3 q = start + dir * dist * i / (aimLine.positionCount - 1f);
                    float gy;
                    if (course != null && course.GroundHeight(q, out gy, 200f)) q.y = gy + 0.3f;
                    aimLine.SetPosition(i, q);
                }
                return;
            }
            float launch = club.launchDeg * Mathf.Deg2Rad;
            Vector3 pos = start, vel = (dir * Mathf.Cos(launch) + Vector3.up * Mathf.Sin(launch)) * speed;
            Vector3 spin = BallFlight.BackspinAxis(dir) * club.backspin;
            int n = aimLine.positionCount;
            float step = 0.12f;
            for (int i = 0; i < n; i++)
            {
                aimLine.SetPosition(i, pos);
                for (int k = 0; k < 6; k++) BallFlight.Step(ref pos, ref vel, ref spin, Vector3.zero, BallParams.Golf, U, step / 6f);
                if (pos.y < start.y - 5f && vel.y < 0f) { for (int j = i + 1; j < n; j++) aimLine.SetPosition(j, pos); break; }
            }
        }

        private void CpuShot(AiProfile ai, Vector3 start, float distM, string surface, ref GolfClub club, out float aimYaw, out GestureEvent g)
        {
            club = GolfClub.Get(GolfClub.Suggest(distM, surface, false));
            float power;
            if (club.kind == GolfClubKind.Putter)
            {
                float need = GolfClub.PuttSpeed(distM * 1.04f, 0.065f);
                power = need / club.maxSpeedMS;
            }
            else
            {
                // Carry desejado: até o pino, descontando o rolamento esperado (~12% fairway, menos com wedge).
                float carry = distM * (club.kind == GolfClubKind.Wedge ? 0.93f : 0.86f);
                float dh = (pin.y - start.y);
                float launchSpeed = BallFlight.SolveSpeed(M(carry), club.launchDeg, club.backspin * 0.9f, BallParams.Golf, U, dh) / U;
                power = launchSpeed / (club.maxSpeedMS * GolfClub.SurfacePowerFactor(surface, club.kind));
            }
            power = Mathf.Clamp(power * (1f + ai.Error(Rng, 0.12f)), 0.05f, 1f);
            aimYaw = ai.Error(Rng, club.kind == GolfClubKind.Putter ? 3f : 7f);
            // Corrige parte do vento conforme a habilidade.
            Vector3 toPin = Flat(pin - start).normalized;
            float cross = Vector3.Dot(Vector3.Cross(toPin, Vector3.up), wind / U);
            aimYaw += cross * 0.6f * ai.skill;
            g = new GestureEvent { kind = GestureKind.Swing, speed = power, angle = 90f + ai.Error(Rng, 8f), dirY = 1f };
        }

        // ------------------------------------------------------------------ HUD e resultado
        private void UpdateHud(int h, int p, GolfClub club, float distM, string surface)
        {
            var sb = new System.Text.StringBuilder();
            sb.Append("Buraco ").Append(h + 1).Append('/').Append(holes.Count).Append("  Par ").Append(card.par[h]).Append('\n');
            sb.Append("Vez de ").Append(Name(Session.players[p])).Append("  •  tacada ").Append(card.Strokes(p, h) + 1).Append('\n');
            sb.Append(club.label).Append("  •  ").Append(distM.ToString("0")).Append(" m  •  ").Append(SurfaceName(surface)).Append('\n');
            sb.Append("Vento ").Append((wind.magnitude / U).ToString("0.0")).Append(" m/s ").Append(WindArrow()).Append('\n');
            for (int i = 0; i < Session.players.Count; i++)
                sb.Append(Name(Session.players[i])).Append(": ").Append(GolfScorecard.ToParText(card.ToPar(i))).Append(" (").Append(card.Total(i)).Append(")\n");
            Hud.SetScore(sb.ToString());
            Hud.SetPane(Sport.Hud("golf_00"), "T_club_00", club.label);
            Hud.SetPane(Sport.Hud("golf_00"), "T_distance_00", distM.ToString("0"));
        }

        private string WindArrow()
        {
            if (Cam == null || wind.sqrMagnitude < 1e-4f) return "";
            Vector3 local = Cam.transform.InverseTransformDirection(wind);
            float a = Mathf.Atan2(local.x, local.z) * Mathf.Rad2Deg;
            string[] arrows = { "(a favor)", "(a favor, p/ direita)", "(p/ direita)", "(contra, p/ direita)", "(contra)", "(contra, p/ esquerda)", "(p/ esquerda)", "(a favor, p/ esquerda)" };
            return arrows[((Mathf.RoundToInt(a / 45f) % 8) + 8) % 8];
        }

        private static string SurfaceName(string s)
        {
            switch (s)
            {
                case "tee": return "Tee";
                case "fairway": return "Fairway";
                case "green": return "Green";
                case "bunker": return "Banca";
                case "deepRough": return "Rough alto";
                default: return "Rough";
            }
        }

        private IEnumerator ShowCard(int lastHole, float secs)
        {
            var sb = new System.Text.StringBuilder("Súmula\n");
            for (int p = 0; p < Session.players.Count; p++)
            {
                sb.Append(Name(Session.players[p])).Append(": ");
                for (int h = 0; h <= lastHole; h++) sb.Append(card.Strokes(p, h)).Append(' ');
                sb.Append(" = ").Append(card.Total(p)).Append(" (").Append(GolfScorecard.ToParText(card.ToPar(p))).Append(")\n");
            }
            Hud.ShowLayout(Sport.Hud("glfScorecard_00"));
            Hud.SetScore(sb.ToString());
            yield return Wait(secs);
            Hud.HideLayout(Sport.Hud("glfScorecard_00"));
        }

        private ActivityResult BuildResult()
        {
            var r = NewResult();
            int best = card.Leader();
            bool tie = false;
            for (int p = 0; p < Session.players.Count; p++)
            {
                AddPlayer(r, Session.players[p], card.Total(p), card.Total(p) + " tacadas (" + GolfScorecard.ToParText(card.ToPar(p)) + ")");
                if (p != best && card.Total(p) == card.Total(best)) tie = true;
            }
            r.winner = tie ? -1 : best;
            r.humanWon = !tie && Session.players[best].human;
            string key = string.Join("-", Session.golfHoles.ToArray());
            r.records.Add(new RecordSubmission { field = "GolStandardBest", variant = key, value = card.ToPar(0), mode = RecordMode.Lower });
            int aces = 0;
            for (int h = 0; h < card.Holes; h++) if (card.Strokes(0, h) == 1) aces++;
            if (aces > 0) r.records.Add(new RecordSubmission { field = "GolAceCount", value = aces, mode = RecordMode.Add });
            r.lines.Add("Par do percurso: " + Sum(card.par));
            return r;
        }

        private static int Sum(int[] a) { int s = 0; foreach (int v in a) s += v; return s; }
        private static Vector3 Flat(Vector3 v) { v.y = 0f; return v; }
    }
}
