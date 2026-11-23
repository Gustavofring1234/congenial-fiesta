// Boxe (RPBoxScene) no ringue MainGame (box_ring, 7,4 m). Golpe pelo gesto Strike: lado do gesto = mão
// (direita/esquerda), gesto para cima = gancho de baixo (uppercut), gesto lateral = cruzado (hook), resto
// = direto (jab/straight); força = velocidade. v = guarda alta, < > = esquiva. Guarda bloqueia diretos e
// cruzados, uppercut passa a guarda, esquiva evita diretos e uppercuts, golpe no contra-ataque vale mais.
using System.Collections;
using LinuxSports.Activities.Rules;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Activities.Boxing
{
    public sealed class BoxingActivity : SportActivity
    {
        private enum PunchType { Jab, Straight, Hook, Upper }
        private enum Stance { Idle, Guard, WeaveLeft, WeaveRight, Windup, Recover, Down, Stunned }

        private sealed class Fighter
        {
            public int index;
            public SportActor actor;
            public PlayerSlot slot;
            public Stance stance = Stance.Idle;
            public float stanceUntil;
            public PunchType punch;
            public bool rightHand;
            public float punchPower;
            public float nextDecision;
            public GameObject gloveL, gloveR;
            public Vector3 home;
        }

        private BoxingBout bout;
        private readonly Fighter[] f = new Fighter[2];
        private float ringHalf;

        protected override IEnumerator Run()
        {
            bout = new BoxingBout(Mathf.Clamp(Session.boxingRounds, 1, 5), 60f, Session.seed);
            ringHalf = Sport.G("ringHalfSize", 36.9f);
            Hud.ClearAll();
            Hud.SetTitle("Boxe");
            yield return LoadScene(Sport.scenes.Count > 0 ? Sport.scenes[0] : null, false, true, null, n =>
                n.StartsWith("box_ring") || n.StartsWith("box_rope") || n.StartsWith("box_corner") || n == "box_hall" || n == "box_light" || n.StartsWith("box_avatar"));
            Hud.ShowLayout(Sport.Hud("boxGauge_00"));
            for (int i = 0; i < 2; i++)
            {
                var slot = i == 0 ? Session.players[0] : (Session.players.Count > 1 ? Session.players[1] : Session.players[0]);
                Vector3 pos = new Vector3(0f, 0f, i == 0 ? M(0.85f) : -M(0.85f));
                var a = SpawnActor(slot, pos, new Vector3(0f, 0f, i == 0 ? -1f : 1f), TeamColors[i]);
                var fi = new Fighter { index = i, actor = a, slot = slot, home = pos };
                fi.gloveL = a.Attach(Sport.ModelPrefab("box_glove_L"), "wrist_l", Vector3.zero, Vector3.zero, PrimitiveType.Sphere, Vector3.one * 2.2f, i == 0 ? Color.blue : Color.red);
                fi.gloveR = a.Attach(Sport.ModelPrefab("box_glove_R"), "wrist_r", Vector3.zero, Vector3.zero, PrimitiveType.Sphere, Vector3.one * 2.2f, i == 0 ? Color.blue : Color.red);
                a.Play("box_wait1R");
                f[i] = fi;
            }
            Audio.PlayAmbient(SfxKind.Crowd, 0.5f);
            Cue("SE_TR_Common_Sports_Game_Start");

            while (!bout.IsOver)
            {
                int round = bout.Round;
                ResetFighters();
                yield return Banner("Round " + round, 1.4f);
                yield return Banner("Lute!", 0.6f);
                while (!bout.IsOver && bout.Round == round)
                {
                    if (!Paused)
                    {
                        float dt = Time.deltaTime;
                        HumanControl();
                        CpuControl(f[1], f[0]);
                        UpdateFighter(f[0], f[1]);
                        UpdateFighter(f[1], f[0]);
                        UpdateCamera();
                        UpdateHud();
                        if (bout.DownFighter >= 0) yield return Knockdown();
                        else bout.Tick(dt);
                    }
                    yield return null;
                }
                if (!bout.IsOver) yield return Banner("Fim do round " + round, 1.6f);
            }
            Audio.StopAmbient();
            Cue("SE_TR_Common_Sports_Game_End");
            yield return Banner(EndText(), 2.8f);
            Finish(BuildResult());
        }

        private void ResetFighters()
        {
            foreach (var fi in f)
            {
                fi.actor.transform.position = fi.home;
                fi.stance = Stance.Idle;
                fi.actor.Play("box_wait1R");
                fi.nextDecision = Time.time + 1f;
            }
        }

        // ------------------------------------------------------------------ controle
        private void HumanControl()
        {
            var me = f[0];
            if (me.stance == Stance.Down || me.stance == Stance.Stunned) { ClearGesture(); return; }
            bool busy = me.stance == Stance.Windup || me.stance == Stance.Recover;
            GestureEvent g;
            if (!busy && TakeGesture(out g))
            {
                Input.gestureKind = GestureKind.Strike;
                PunchType type = Mathf.Abs(g.dirY) > 0.75f && g.dirY > 0f ? PunchType.Upper : Mathf.Abs(g.dirX) > 0.8f ? PunchType.Hook : g.speed < 0.6f ? PunchType.Jab : PunchType.Straight;
                StartPunch(me, type, g.dirX >= 0f, g.speed);
                return;
            }
            Input.gestureKind = GestureKind.Strike;
            if (busy) return;
            Vector2 m = Input.Move;
            Stance want = m.y < -0.5f ? Stance.Guard : m.x < -0.5f ? Stance.WeaveLeft : m.x > 0.5f ? Stance.WeaveRight : Stance.Idle;
            SetDefense(me, want);
        }

        private void SetDefense(Fighter fi, Stance s)
        {
            if (fi.stance == s) return;
            fi.stance = s;
            switch (s)
            {
                case Stance.Guard: fi.actor.PlayFirst("box_c_shadowR", "box_pose_waitR"); break;
                case Stance.WeaveLeft:
                case Stance.WeaveRight:
                    fi.actor.PlayFirst("box_c_weaveR");
                    Fx("Box_afterimage02", fi.actor.transform.position + Vector3.up * M(1.2f));
                    break;
                default: fi.actor.Play("box_wait1R"); break;
            }
        }

        private void CpuControl(Fighter me, Fighter foe)
        {
            if (me.stance == Stance.Down || me.stance == Stance.Stunned) return;
            if (me.stance == Stance.Windup || me.stance == Stance.Recover) return;
            if (Time.time < me.nextDecision) return;
            var ai = me.slot.ai;
            me.nextDecision = Time.time + Mathf.Max(0.12f, ai.reaction + (float)Rng.NextDouble() * 0.35f);
            float healthRatio = bout.Health(me.index) / BoxingBout.MaxHealth;
            // Lê o golpe do adversário com chance proporcional à habilidade.
            if (foe.stance == Stance.Windup && Rng.NextDouble() < 0.25 + 0.6 * ai.skill)
            {
                if (foe.punch == PunchType.Upper) SetDefense(me, Rng.NextDouble() < 0.5 ? Stance.WeaveLeft : Stance.WeaveRight);
                else if (foe.punch == PunchType.Hook) SetDefense(me, Stance.Guard);
                else SetDefense(me, Rng.NextDouble() < 0.5 ? Stance.Guard : (Rng.NextDouble() < 0.5 ? Stance.WeaveLeft : Stance.WeaveRight));
                return;
            }
            // Contra-ataque quando o adversário está se recuperando.
            bool opening = foe.stance == Stance.Recover || foe.stance == Stance.Stunned;
            double attack = (opening ? 0.75 : 0.3) * (0.5 + ai.aggression) * (healthRatio < 0.3f ? 0.7 : 1.0);
            if (Rng.NextDouble() < attack)
            {
                double r = Rng.NextDouble();
                PunchType t = foe.stance == Stance.Guard ? (r < 0.6 ? PunchType.Upper : PunchType.Hook)
                            : r < 0.35 ? PunchType.Jab : r < 0.65 ? PunchType.Straight : r < 0.85 ? PunchType.Hook : PunchType.Upper;
                StartPunch(me, t, Rng.NextDouble() < 0.5 + ai.sideBias * 0.2, 0.6f + 0.6f * ai.power);
                return;
            }
            double guard = 0.25 + (1f - healthRatio) * 0.4;
            SetDefense(me, Rng.NextDouble() < guard ? Stance.Guard : Stance.Idle);
        }

        // ------------------------------------------------------------------ golpes
        private static float Windup(PunchType t) { return t == PunchType.Jab ? 0.12f : t == PunchType.Straight ? 0.18f : t == PunchType.Hook ? 0.24f : 0.26f; }
        private static float Recovery(PunchType t) { return t == PunchType.Jab ? 0.18f : t == PunchType.Straight ? 0.28f : 0.36f; }
        private static float BaseDamage(PunchType t) { return t == PunchType.Jab ? 5f : t == PunchType.Straight ? 8f : t == PunchType.Hook ? 10f : 11f; }

        private static string PunchAnim(PunchType t, bool right)
        {
            switch (t)
            {
                case PunchType.Jab: return right ? "box_punch_jab_R" : "box_punch_jab_L";
                case PunchType.Straight: return right ? "box_punch_straight_r_R" : "box_punch_straight_l_R";
                case PunchType.Hook: return right ? "box_punch_hook_r_R" : "box_punch_hook_l_R";
                default: return right ? "box_punch_upper_r_R" : "box_punch_upper_l_R";
            }
        }

        private void StartPunch(Fighter me, PunchType t, bool right, float power)
        {
            me.stance = Stance.Windup;
            me.punch = t;
            me.rightHand = right;
            me.punchPower = Mathf.Clamp(power, 0.2f, 1.5f);
            me.stanceUntil = Time.time + Windup(t);
            me.actor.Play(PunchAnim(t, right));
            bout.Throw(me.index);
            Sfx(SfxKind.Whoosh, 0.35f + 0.3f * me.punchPower, 1.1f);
            string color = me.index == 0 ? "blue" : "red";
            Fx(t == PunchType.Jab ? "Box_glovetail01_" + color : "Box_glovetail02_" + color, (right ? me.gloveR : me.gloveL).transform.position);
        }

        private void UpdateFighter(Fighter me, Fighter foe)
        {
            // Leve balanço lateral na esquiva.
            Vector3 side = Vector3.right * (me.index == 0 ? 1f : -1f);
            Vector3 offset = me.stance == Stance.WeaveLeft ? -side * M(0.35f) : me.stance == Stance.WeaveRight ? side * M(0.35f) : Vector3.zero;
            if (me.stance != Stance.Down) me.actor.transform.position = Vector3.Lerp(me.actor.transform.position, me.home + offset, 1f - Mathf.Exp(-14f * Time.deltaTime));
            if (me.stance == Stance.Windup && Time.time >= me.stanceUntil)
            {
                Resolve(me, foe);
                if (me.stance == Stance.Windup) { me.stance = Stance.Recover; me.stanceUntil = Time.time + Recovery(me.punch); }
            }
            else if ((me.stance == Stance.Recover || me.stance == Stance.Stunned) && Time.time >= me.stanceUntil)
            {
                me.stance = Stance.Idle;
                me.actor.Play("box_wait1R");
            }
            if (bout.Health(me.index) < 30f && Rng.NextDouble() < Time.deltaTime * 0.5) Fx("Box_sweat_1time01", me.actor.transform.position + Vector3.up * M(1.6f));
        }

        private void Resolve(Fighter atk, Fighter def)
        {
            Vector3 head = def.actor.transform.position + Vector3.up * M(1.5f);
            string atkColor = atk.index == 0 ? "blue" : "red";
            bool weaving = def.stance == Stance.WeaveLeft || def.stance == Stance.WeaveRight;
            // Esquiva: evita diretos e uppercuts; o cruzado pega quem esquiva para o lado de onde ele vem.
            if (weaving)
            {
                bool hookSide = atk.punch == PunchType.Hook && ((def.stance == Stance.WeaveLeft) == atk.rightHand);
                if (!hookSide)
                {
                    Hud.ShowMessage(def.index == 0 ? "Esquivou!" : "Ele esquivou", 0.6f);
                    atk.stance = Stance.Recover;
                    atk.stanceUntil = Time.time + Recovery(atk.punch) + 0.15f;   // golpe no vazio desequilibra
                    return;
                }
            }
            float power = atk.punchPower * (atk.slot.ai != null ? 0.8f + 0.4f * atk.slot.ai.power : 1f);
            float dmg = BaseDamage(atk.punch) * (0.6f + 0.6f * power);
            if (def.stance == Stance.Guard && atk.punch != PunchType.Upper)
            {
                dmg *= 0.15f;
                Fx("Box_guard01_" + (def.index == 0 ? "blue" : "red"), head);
                Impact(0.35f, 0.2f, 140f);
                atk.stance = Stance.Recover;
                atk.stanceUntil = Time.time + Recovery(atk.punch) + 0.1f;
                bout.Land(atk.index, dmg);
                return;
            }
            bool counter = def.stance == Stance.Windup || def.stance == Stance.Recover;
            if (counter) dmg *= 1.4f;
            if (def.stance == Stance.Guard) dmg *= 0.8f;   // uppercut por dentro da guarda
            int level = dmg > 13f ? 4 : dmg > 10f ? 3 : dmg > 6f ? 2 : 1;
            Fx("Box_hit0" + level + "_" + (atk.index == 0 ? "blue" : "red"), head);
            Impact(Mathf.Clamp01(dmg / 16f), 0.3f, 110f);
            if (counter) Hud.ShowMessage("Contra-ataque!", 0.7f);
            bool down = bout.Land(atk.index, dmg);
            def.actor.SetExpression(Entities.MiiExpression.Anger);
            // Golpe forte atordoa e interrompe o golpe do defensor.
            if (down) { def.stance = Stance.Down; def.actor.PlayFirst("box_down1R", "box_down2R"); }
            else if (dmg > 9f || counter) { def.stance = Stance.Stunned; def.stanceUntil = Time.time + 0.35f + dmg * 0.02f; }
        }

        private IEnumerator Knockdown()
        {
            int who = bout.DownFighter;
            var fi = f[who];
            fi.stance = Stance.Down;
            fi.actor.PlayFirst("box_down1R", "box_down2R");
            fi.actor.SetExpression(Entities.MiiExpression.Sorrow);
            Fx("Box_indistinct01", fi.actor.transform.position + Vector3.up * M(1f));
            yield return Banner(who == 0 ? "Você caiu!" : "Derrubou!", 1f);
            int getUp = bout.ResolveCount();
            for (int c = 1; c <= Mathf.Min(getUp, 10); c++)
            {
                Hud.ShowMessage(c.ToString(), 0.7f);
                Sfx(SfxKind.Click, 0.8f);
                yield return Wait(0.65f);
            }
            if (bout.IsOver) { yield return Banner("K.O.!", 1.6f); yield break; }
            fi.stance = Stance.Idle;
            fi.actor.Play("box_wait1R");
            fi.actor.SetExpression(Entities.MiiExpression.Normal);
            if (bout.End == BoutEnd.TKO) yield return Banner("Nocaute técnico", 1.6f);
            else yield return Banner(who == 0 ? "Levantou! Continue" : "Ele levantou", 1f);
        }

        // ------------------------------------------------------------------ câmera e HUD
        private void UpdateCamera()
        {
            var me = f[0].actor.transform;
            var foe = f[1].actor.transform;
            Vector3 eye = me.position + Vector3.up * M(2.1f) + new Vector3(0f, 0f, M(2.6f));
            CameraFollow(eye, foe.position + Vector3.up * M(1.3f), 8f, 52f);
        }

        private void UpdateHud()
        {
            Hud.SetScore("Round " + bout.Round + "/" + bout.rounds + "   " + Mathf.CeilToInt(bout.TimeLeft) + " s\n" +
                         "Você  " + Bar(bout.Health(0)) + "\n" + "CPU   " + Bar(bout.Health(1)) + "\n" +
                         "Golpes: " + bout.Landed(0) + "/" + bout.Thrown(0));
            Hud.SetHint("Gesto = soco (lado = mão, para cima = uppercut, lateral = cruzado)   v guarda   < > esquiva");
            string lyt = Sport.Hud("boxGauge_00");
            Hud.SetPane(lyt, "T_round_00", bout.Round.ToString());
        }

        private static string Bar(float hp)
        {
            int n = Mathf.Clamp(Mathf.CeilToInt(hp / 10f), 0, 10);
            return new string('|', n) + new string('.', 10 - n) + " " + Mathf.CeilToInt(hp);
        }

        private string EndText()
        {
            switch (bout.End)
            {
                case BoutEnd.KO: return bout.Winner == 0 ? "Vitória por K.O.!" : "Derrota por K.O.";
                case BoutEnd.TKO: return bout.Winner == 0 ? "Vitória por nocaute técnico!" : "Derrota por nocaute técnico";
                case BoutEnd.Draw: return "Empate";
                default: return bout.Winner == 0 ? "Vitória por pontos!" : "Derrota por pontos";
            }
        }

        private ActivityResult BuildResult()
        {
            var r = NewResult();
            AddPlayer(r, f[0].slot, Mathf.RoundToInt(bout.DamageDealt(0)), bout.Landed(0) + " golpes, " + bout.Knockdowns(1) + " quedas causadas");
            AddPlayer(r, f[1].slot, Mathf.RoundToInt(bout.DamageDealt(1)), bout.Landed(1) + " golpes, " + bout.Knockdowns(0) + " quedas causadas");
            r.winner = bout.Winner;
            r.humanWon = bout.Winner == 0;
            r.lines.Add(EndText());
            return r;
        }
    }
}
