// Perfil de IA de um adversário, derivado do perfil Mii (.rcd) e da força pedida.
// O .rcd não guarda habilidade; o que ele dá é corpo (altura/peso 0..127, sexo) e identidade. Daqui saem:
//   alcance/velocidade (altura), potência/resistência (peso), e um "estilo" estável por perfil
//   (agressividade e preferência de lado) tirado do hash do createId/nome, para cada CPU jogar diferente.
// A força (skill 0..1) vem do nível de habilidade do jogador (como o RPSports faz ao escolher adversários).
using System;

namespace LinuxSports.Core
{
    public sealed partial class AiProfile
    {
        public float skill;          // 0..1: precisão geral
        public float reaction;       // s: atraso para reagir
        public float accuracy;       // 0..1: 1 = erro mínimo
        public float power;          // 0..1
        public float speed;          // 0..1: deslocamento
        public float reach;          // multiplicador de alcance (0.85..1.15)
        public float aggression;     // 0..1
        public float sideBias;       // -1..1 (preferência esquerda/direita)
        public float stamina;        // 0..1
        public int seed;

        public static AiProfile Create(float height01, float build01, bool female, int hash, float skill01)
        {
            float s = Clamp01(skill01);
            var p = new AiProfile { seed = hash, skill = s };
            float u1 = ((hash >> 0) & 0xFF) / 255f, u2 = ((hash >> 8) & 0xFF) / 255f, u3 = ((hash >> 16) & 0xFF) / 255f;
            p.reach = 0.85f + 0.3f * Clamp01(height01);
            p.speed = Clamp01(0.35f + 0.45f * s + 0.25f * (1f - Math.Abs(build01 - 0.4f)) - 0.1f * Clamp01(build01 - 0.6f));
            p.power = Clamp01(0.3f + 0.4f * s + 0.3f * Clamp01(build01) + (female ? -0.03f : 0.03f));
            p.stamina = Clamp01(0.5f + 0.3f * s + 0.2f * (1f - Math.Abs(build01 - 0.5f) * 2f));
            p.accuracy = Clamp01(0.25f + 0.7f * s + 0.05f * (u1 - 0.5f));
            p.reaction = 0.45f - 0.33f * s + 0.04f * u2;
            p.aggression = Clamp01(0.3f + 0.4f * u3 + 0.2f * s);
            p.sideBias = u1 * 2f - 1f;
            return p;
        }

        /// <summary>Força 0..1 a partir dos pontos de habilidade do jogador (0..2000), com variação por adversário.</summary>
        public static float SkillForOpponent(int playerSkillPoints, int opponentIndex)
        {
            float baseSkill = Clamp01(playerSkillPoints / 2000f);
            float spread = ((opponentIndex * 37) % 11 - 5) / 50f;   // ±0.1 entre adversários
            return Clamp01(0.15f + 0.8f * baseSkill + spread);
        }

        /// <summary>Hash FNV-1a 32 bits (estável entre plataformas, ao contrário de string.GetHashCode).</summary>
        public static int StableHash(string s)
        {
            unchecked
            {
                uint h = 2166136261;
                foreach (char c in s ?? "") { h ^= c; h *= 16777619; }
                return (int)(h & 0x7FFFFFFF);
            }
        }

        private static float Clamp01(float v) { return v < 0f ? 0f : v > 1f ? 1f : v; }

        /// <summary>Erro gaussiano (Box-Muller) escalado pela imprecisão do perfil.</summary>
        public float Error(Random rng, float scale)
        {
            double u1 = 1.0 - rng.NextDouble(), u2 = rng.NextDouble();
            double n = Math.Sqrt(-2.0 * Math.Log(u1)) * Math.Cos(2.0 * Math.PI * u2);
            return (float)(n * scale * (1f - accuracy * 0.9f));
        }
    }
}
