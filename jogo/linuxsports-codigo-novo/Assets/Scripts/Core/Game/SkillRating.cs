// Pontos de habilidade (SkillLevel do RPSportsPlayerData) ajustados como Elo contra a força da CPU.
using System;

namespace LinuxSports.Core
{
    public static class SkillRating
    {
        public const int Max = 2000;
        public const float K = 60f;

        /// <summary>Variação: força do adversário 0..1 vira 0..2000 pontos; resultado 1 = vitória, 0,5 = empate.</summary>
        public static int Delta(int current, float opponentStrength01, float outcome01)
        {
            float opp = Clamp01(opponentStrength01) * Max;
            double expected = 1.0 / (1.0 + Math.Pow(10.0, (opp - current) / 400.0));
            return (int)Math.Round(K * (Clamp01(outcome01) - expected), MidpointRounding.AwayFromZero);
        }

        private static float Clamp01(float v) { return v < 0f ? 0f : v > 1f ? 1f : v; }
    }
}
