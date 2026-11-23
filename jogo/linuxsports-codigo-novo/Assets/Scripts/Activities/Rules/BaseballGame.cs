// Regras de beisebol (contagem bola/strike, eliminações, bases, entradas, walk-off) para a partida de
// N entradas do RPBsbScene (o jogador rebate numa metade e arremessa na outra). Sem UnityEngine.
using System;
using System.Collections.Generic;

namespace LinuxSports.Activities.Rules
{
    public enum PitchResult { Ball, CalledStrike, SwingingStrike, Foul, Single, Double, Triple, HomeRun, Out, DoublePlay }

    public sealed class BaseballGame
    {
        public readonly int innings;
        private readonly List<int>[] runsByInning = { new List<int>(), new List<int>() };

        public int Inning { get; private set; }           // 0-based
        public bool Bottom { get; private set; }          // false = alto (visitante, time 0 rebate)
        public int Balls { get; private set; }
        public int Strikes { get; private set; }
        public int Outs { get; private set; }
        public int Bases { get; private set; }            // bit 0 = 1ª, bit 1 = 2ª, bit 2 = 3ª
        public bool IsGameOver { get; private set; }
        public int Hits(int team) => hits[team];
        private readonly int[] hits = new int[2];
        private readonly int[] runs = new int[2];
        public int ConsecutiveHits { get; private set; }  // rebatidas seguidas do time que rebate
        public int BestConsecutiveHits(int team) => bestStreak[team];
        private readonly int[] bestStreak = new int[2];

        public BaseballGame(int innings = 3)
        {
            if (innings < 1) throw new ArgumentOutOfRangeException(nameof(innings));
            this.innings = innings;
            runsByInning[0].Add(0);
        }

        public int BattingTeam => Bottom ? 1 : 0;
        public int FieldingTeam => Bottom ? 0 : 1;
        public int Runs(int team) => runs[team];
        public IReadOnlyList<int> Linescore(int team) => runsByInning[team];
        public int Winner => !IsGameOver ? -1 : runs[0] > runs[1] ? 0 : runs[1] > runs[0] ? 1 : -1;

        /// <summary>Aplica o resultado de um arremesso. Retorna as corridas marcadas na jogada.</summary>
        public int Apply(PitchResult r)
        {
            if (IsGameOver) throw new InvalidOperationException("Partida encerrada");
            int scored = 0;
            switch (r)
            {
                case PitchResult.Ball:
                    if (++Balls >= 4) scored = Walk();
                    break;
                case PitchResult.CalledStrike:
                case PitchResult.SwingingStrike:
                    if (++Strikes >= 3) { ConsecutiveHits = 0; AddOut(); }
                    break;
                case PitchResult.Foul:
                    if (Strikes < 2) Strikes++;
                    break;
                case PitchResult.Single: scored = Hit(1); break;
                case PitchResult.Double: scored = Hit(2); break;
                case PitchResult.Triple: scored = Hit(3); break;
                case PitchResult.HomeRun: scored = Hit(4); break;
                case PitchResult.Out:
                    ConsecutiveHits = 0;
                    // Bola rebatida e apanhada: corredor da 3ª marca em sacrifício com menos de 2 eliminações.
                    if (Outs < 2 && (Bases & 4) != 0 && sacrificeNext) { Bases &= ~4; scored = 1; }
                    sacrificeNext = false;
                    AddOut();
                    break;
                case PitchResult.DoublePlay:
                    ConsecutiveHits = 0;
                    if ((Bases & 1) != 0 && Outs < 2) { Bases &= ~1; AddOut(); }
                    if (!halfJustEnded) AddOut();
                    break;
            }
            if (scored > 0) Score(scored);
            halfJustEnded = false;
            return scored;
        }

        private bool sacrificeNext;
        private bool halfJustEnded;

        /// <summary>Marca a próxima eliminação como voo de sacrifício (bola alta funda).</summary>
        public void MarkSacrificeFly() { sacrificeNext = true; }

        private int Walk()
        {
            int scored = 0;
            // Avanço forçado.
            if ((Bases & 1) != 0)
            {
                if ((Bases & 2) != 0)
                {
                    if ((Bases & 4) != 0) scored = 1;
                    Bases |= 4;
                }
                Bases |= 2;
            }
            Bases |= 1;
            ResetCount();
            return scored;
        }

        private int Hit(int bases)
        {
            int scored = 0;
            hits[BattingTeam]++;
            ConsecutiveHits++;
            if (ConsecutiveHits > bestStreak[BattingTeam]) bestStreak[BattingTeam] = ConsecutiveHits;
            int b = Bases << bases;          // todos avançam o número de bases da rebatida
            for (int k = 3; k < 7; k++) if ((b >> k & 1) != 0) scored++;
            Bases = b & 7;
            if (bases == 4) scored++;        // o rebatedor
            else Bases |= 1 << (bases - 1);
            ResetCount();
            return scored;
        }

        private void Score(int n)
        {
            runs[BattingTeam] += n;
            var list = runsByInning[BattingTeam];
            list[list.Count - 1] += n;
            // Walk-off: mandante passa à frente no fim da última entrada ou extra.
            if (Bottom && Inning >= innings - 1 && runs[1] > runs[0]) IsGameOver = true;
        }

        private void AddOut()
        {
            ResetCount();
            if (++Outs < 3) return;
            Outs = 0;
            Bases = 0;
            ConsecutiveHits = 0;
            halfJustEnded = true;
            if (!Bottom)
            {
                // Fim do alto: se for a última entrada e o mandante já vence, acabou.
                if (Inning >= innings - 1 && runs[1] > runs[0]) { IsGameOver = true; return; }
                Bottom = true;
                runsByInning[1].Add(0);
            }
            else
            {
                if (Inning >= innings - 1 && runs[0] != runs[1]) { IsGameOver = true; return; }
                // Entradas extras limitadas a innings + 3 (empate declarado depois disso, como partida curta).
                if (Inning >= innings + 2) { IsGameOver = true; return; }
                Bottom = false;
                Inning++;
                runsByInning[0].Add(0);
            }
        }

        private void ResetCount() { Balls = 0; Strikes = 0; }

        public string CountText => Balls + "-" + Strikes + ", " + Outs + (Outs == 1 ? " eliminação" : " eliminações");

        public string HalfText => (Bottom ? "Baixo da " : "Alto da ") + (Inning + 1) + "ª";
    }
}
