// Placar de boliche de 10 quadros (regras oficiais; o RPBowScene usa a mesma contagem: strike = 10 + 2 próximas
// bolas, spare = 10 + 1 próxima, 10º quadro com bolas extras). Sem UnityEngine: testável fora do Editor.
using System;
using System.Collections.Generic;

namespace LinuxSports.Activities.Rules
{
    public sealed class BowlingScore
    {
        public const int Frames = 10;
        public const int AllPins = 0x3FF;   // bit i = pino i+1 em pé

        private readonly List<int> rolls = new List<int>();
        private readonly List<int> frameStart = new List<int>();   // índice da 1ª bola de cada quadro

        public IReadOnlyList<int> Rolls => rolls;
        public int CurrentFrame { get; private set; }               // 0..9 (10 = fim)
        public int RollInFrame { get; private set; }                // 0, 1 ou 2 (2 só no 10º quadro)
        public int StandingMask { get; private set; } = AllPins;    // pinos em pé para a próxima bola
        public bool IsGameOver => CurrentFrame >= Frames;
        public int Strikes { get; private set; }
        public int Spares { get; private set; }

        public BowlingScore() { frameStart.Add(0); }

        /// <summary>Registra a bola pela máscara de pinos que continuam em pé. Retorna o resultado da bola.</summary>
        public RollOutcome Roll(int standingAfter)
        {
            if (IsGameOver) throw new InvalidOperationException("Partida encerrada");
            standingAfter &= StandingMask;                           // pino derrubado não volta a ficar em pé
            int knocked = PopCount(StandingMask) - PopCount(standingAfter);
            bool fullRack = StandingMask == AllPins;
            rolls.Add(knocked);
            var outcome = new RollOutcome { pins = knocked, frame = CurrentFrame, roll = RollInFrame };
            outcome.split = fullRack && IsSplit(standingAfter);
            if (standingAfter == 0 && fullRack) { outcome.strike = true; Strikes++; }
            else if (standingAfter == 0) { outcome.spare = true; Spares++; }
            outcome.gutter = knocked == 0;

            if (CurrentFrame < Frames - 1)
            {
                if (standingAfter == 0 || RollInFrame == 1) NextFrame();
                else { RollInFrame = 1; StandingMask = standingAfter; }
            }
            else
            {
                // 10º quadro: strike ou spare dá bolas extras com novo jogo de pinos.
                if (RollInFrame == 0)
                {
                    RollInFrame = 1;
                    StandingMask = standingAfter == 0 ? AllPins : standingAfter;
                }
                else if (RollInFrame == 1)
                {
                    int first = rolls[rolls.Count - 2];
                    if (first == 10 || first + knocked == 10) { RollInFrame = 2; StandingMask = standingAfter == 0 ? AllPins : standingAfter; }
                    else NextFrame();
                }
                else NextFrame();
            }
            outcome.frameComplete = outcome.frame != CurrentFrame;
            return outcome;
        }

        private void NextFrame()
        {
            CurrentFrame++;
            RollInFrame = 0;
            StandingMask = AllPins;
            if (CurrentFrame < Frames) frameStart.Add(rolls.Count);
        }

        /// <summary>Pontos acumulados até o quadro f (null se ainda não dá para contar: strike/spare pendente).</summary>
        public int? CumulativeScore(int f)
        {
            int total = 0;
            for (int i = 0; i <= f; i++)
            {
                int? s = FrameScore(i);
                if (s == null) return null;
                total += s.Value;
            }
            return total;
        }

        public int? FrameScore(int f)
        {
            if (f >= frameStart.Count) return null;
            int r = frameStart[f];
            if (r >= rolls.Count) return null;
            if (f == Frames - 1)
            {
                int n = rolls.Count - r;
                if (n < 2) return null;
                int a = rolls[r], b = rolls[r + 1];
                if (a == 10 || a + b == 10) return n >= 3 ? a + b + rolls[r + 2] : (int?)null;
                return a + b;
            }
            if (rolls[r] == 10) return r + 2 < rolls.Count ? 10 + rolls[r + 1] + rolls[r + 2] : (int?)null;
            if (r + 1 >= rolls.Count) return null;
            if (rolls[r] + rolls[r + 1] == 10) return r + 2 < rolls.Count ? 10 + rolls[r + 2] : (int?)null;
            return rolls[r] + rolls[r + 1];
        }

        /// <summary>Total contado até agora (só quadros fechados).</summary>
        public int Total
        {
            get
            {
                int t = 0;
                for (int f = 0; f < Frames; f++) { int? s = FrameScore(f); if (s == null) break; t += s.Value; }
                return t;
            }
        }

        /// <summary>Símbolos de um quadro para a súmula ("X", "/", "-", dígitos).</summary>
        public string FrameMarks(int f)
        {
            if (f >= frameStart.Count) return "";
            int r = frameStart[f];
            int end = f + 1 < frameStart.Count ? frameStart[f + 1] : rolls.Count;
            var s = new System.Text.StringBuilder();
            int standing = 10;
            for (int i = r; i < end; i++)
            {
                int k = rolls[i];
                if (k == 10 && standing == 10) { s.Append('X'); standing = 10; continue; }
                if (k == standing && standing < 10) { s.Append('/'); standing = 10; continue; }
                s.Append(k == 0 ? '-' : (char)('0' + k));
                standing -= k;
                if (f < Frames - 1 && i == r + 1) break;
            }
            return s.ToString();
        }

        public static int PopCount(int m) { int c = 0; while (m != 0) { m &= m - 1; c++; } return c; }

        // Posição dos pinos no triângulo (coluna em meias distâncias, fileira): 1 na frente, 7..10 atrás.
        private static readonly int[] Col = { 0, -1, 1, -2, 0, 2, -3, -1, 1, 3 };
        private static readonly int[] Row = { 0, 1, 1, 2, 2, 2, 3, 3, 3, 3 };
        public static int PinColumn(int i) => Col[i];
        public static int PinRow(int i) => Row[i];

        /// <summary>Split: pino 1 caído e restam dois ou mais grupos de pinos sem pino entre eles (regra da USBC).</summary>
        public static bool IsSplit(int standing)
        {
            if ((standing & 1) != 0 || PopCount(standing) < 2) return false;
            // Agrupa por adjacência: dois pinos são vizinhos se estão na mesma fileira a 2 meias-distâncias
            // ou em fileiras vizinhas a 1 meia-distância.
            var seen = 0;
            int groups = 0;
            for (int i = 0; i < 10; i++)
            {
                if ((standing >> i & 1) == 0 || (seen >> i & 1) != 0) continue;
                groups++;
                var stack = new Stack<int>();
                stack.Push(i); seen |= 1 << i;
                while (stack.Count > 0)
                {
                    int a = stack.Pop();
                    for (int b = 0; b < 10; b++)
                    {
                        if ((standing >> b & 1) == 0 || (seen >> b & 1) != 0) continue;
                        int dr = Math.Abs(Row[a] - Row[b]), dc = Math.Abs(Col[a] - Col[b]);
                        bool adj = (dr == 0 && dc == 2) || (dr == 1 && dc == 1);
                        // Pino exatamente atrás (mesma coluna, 2 fileiras) também conta como "sem vão".
                        if (dr == 2 && dc == 0) adj = true;
                        if (adj) { seen |= 1 << b; stack.Push(b); }
                    }
                }
            }
            return groups >= 2;
        }
    }

    public struct RollOutcome
    {
        public int pins, frame, roll;
        public bool strike, spare, split, gutter, frameComplete;
    }
}
