// Regras da luta de boxe (RPBoxScene: 3 rounds, barra de vida, quedas com contagem até 10, KO, nocaute
// técnico com 3 quedas no round e decisão por pontos). Sem UnityEngine; a sorte vem de um System.Random
// injetado para a contagem ser reproduzível em teste.
using System;

namespace LinuxSports.Activities.Rules
{
    public enum BoutEnd { None, KO, TKO, Decision, Draw }

    public sealed class BoxingBout
    {
        public const float MaxHealth = 100f;
        public readonly int rounds;
        public readonly float roundSeconds;
        private readonly Random rng;

        private readonly float[] health = { MaxHealth, MaxHealth };
        private readonly float[] recoverableHealth = { MaxHealth, MaxHealth };
        private readonly int[] knockdownsRound = new int[2];
        private readonly int[] knockdownsTotal = new int[2];
        private readonly float[] damageDealt = new float[2];
        private readonly int[] landed = new int[2];
        private readonly int[] thrown = new int[2];

        public int Round { get; private set; } = 1;
        public float RoundTime { get; private set; }
        public BoutEnd End { get; private set; }
        public int Winner { get; private set; } = -1;
        public int DownFighter { get; private set; } = -1;     // quem está na lona (-1 = ninguém)
        public bool IsOver => End != BoutEnd.None;

        public BoxingBout(int rounds = 3, float roundSeconds = 60f, int seed = 1)
        {
            this.rounds = Math.Max(1, rounds);
            this.roundSeconds = Math.Max(5f, roundSeconds);
            rng = new Random(seed);
        }

        public float Health(int f) => health[f];
        public float Recoverable(int f) => recoverableHealth[f];
        public int Knockdowns(int f) => knockdownsTotal[f];
        public int Landed(int f) => landed[f];
        public int Thrown(int f) => thrown[f];
        public float DamageDealt(int f) => damageDealt[f];

        public void Throw(int attacker) { thrown[attacker]++; }

        /// <summary>Golpe conectado. Retorna true se derrubou o adversário.</summary>
        public bool Land(int attacker, float damage)
        {
            if (IsOver || DownFighter >= 0) return false;
            int d = 1 - attacker;
            damage = Math.Max(0f, damage);
            landed[attacker]++;
            damageDealt[attacker] += damage;
            health[d] = Math.Max(0f, health[d] - damage);
            // Parte do dano é recuperável (barra vermelha do boxGauge): volta devagar se não apanhar.
            recoverableHealth[d] = Math.Max(health[d], recoverableHealth[d] - damage * 0.4f);
            if (health[d] <= 0f)
            {
                DownFighter = d;
                knockdownsRound[d]++;
                knockdownsTotal[d]++;
                if (knockdownsRound[d] >= 3) Finish(BoutEnd.TKO, attacker);
                return true;
            }
            return false;
        }

        /// <summary>Contagem da queda: retorna em que número o lutador levanta (11 = não levanta, KO).
        /// Chance de levantar cai a cada queda; quem tem mais vida "recuperável" levanta antes.</summary>
        public int ResolveCount()
        {
            if (DownFighter < 0) return 0;
            int f = DownFighter;
            float stamina = recoverableHealth[f] / MaxHealth;
            double getUp = Math.Max(0.05, 0.95 - 0.28 * (knockdownsTotal[f] - 1) - 0.25 * (1 - stamina));
            int count = 11;
            if (rng.NextDouble() < getUp) count = 3 + (int)(rng.NextDouble() * 6) + (knockdownsTotal[f] - 1);
            if (count >= 10) count = 11;
            if (count == 11) { Finish(BoutEnd.KO, 1 - f); return count; }
            // Levanta com parte da vida recuperável.
            health[f] = Math.Max(15f, recoverableHealth[f] * 0.6f);
            recoverableHealth[f] = health[f];
            DownFighter = -1;
            return count;
        }

        /// <summary>Avança o relógio (só corre com os dois em pé). Retorna true quando o round termina.</summary>
        public bool Tick(float dt)
        {
            if (IsOver || DownFighter >= 0) return false;
            RoundTime += dt;
            for (int f = 0; f < 2; f++)
                if (health[f] < recoverableHealth[f]) health[f] = Math.Min(recoverableHealth[f], health[f] + dt * 2.5f);
            if (RoundTime < roundSeconds) return false;
            EndRound();
            return true;
        }

        public void EndRound()
        {
            if (IsOver) return;
            if (Round >= rounds) { Decide(); return; }
            Round++;
            RoundTime = 0f;
            knockdownsRound[0] = knockdownsRound[1] = 0;
            // Intervalo: recupera metade do que é recuperável.
            for (int f = 0; f < 2; f++)
            {
                health[f] = Math.Min(MaxHealth, health[f] + (MaxHealth - health[f]) * 0.35f);
                recoverableHealth[f] = Math.Max(recoverableHealth[f], health[f]);
            }
        }

        private void Decide()
        {
            // Pontos: dano causado, menos 10 por queda sofrida.
            float a = damageDealt[0] - 10f * knockdownsTotal[0] + 5f * knockdownsTotal[1];
            float b = damageDealt[1] - 10f * knockdownsTotal[1] + 5f * knockdownsTotal[0];
            if (Math.Abs(a - b) < 1f) Finish(BoutEnd.Draw, -1);
            else Finish(BoutEnd.Decision, a > b ? 0 : 1);
        }

        private void Finish(BoutEnd e, int winner) { End = e; Winner = winner; }

        public float TimeLeft => Math.Max(0f, roundSeconds - RoundTime);
    }
}
