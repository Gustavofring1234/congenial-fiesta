// Súmula de golfe por tacadas (stroke play) com limite de tacadas por buraco. Sem UnityEngine.
using System;
using System.Collections.Generic;

namespace LinuxSports.Activities.Rules
{
    public sealed class GolfScorecard
    {
        public readonly int[] par;
        public readonly int players;
        public readonly int maxStrokesPerHole;
        private readonly int[,] strokes;
        private readonly bool[,] holed;

        public GolfScorecard(IList<int> parPerHole, int players, int maxStrokesPerHole = 10)
        {
            if (parPerHole == null || parPerHole.Count == 0) throw new ArgumentException("sem buracos");
            par = new int[parPerHole.Count];
            for (int i = 0; i < par.Length; i++) par[i] = parPerHole[i];
            this.players = Math.Max(1, players);
            this.maxStrokesPerHole = maxStrokesPerHole;
            strokes = new int[this.players, par.Length];
            holed = new bool[this.players, par.Length];
        }

        public int Holes => par.Length;
        public int Strokes(int player, int hole) => strokes[player, hole];
        public bool Holed(int player, int hole) => holed[player, hole];

        /// <summary>Conta uma tacada (penalidade = tacada extra). Retorna true se atingiu o limite (buraco encerrado).</summary>
        public bool AddStroke(int player, int hole, int penalty = 0)
        {
            if (holed[player, hole]) throw new InvalidOperationException("buraco já concluído");
            strokes[player, hole] += 1 + penalty;
            if (strokes[player, hole] >= maxStrokesPerHole) { strokes[player, hole] = maxStrokesPerHole; holed[player, hole] = true; return true; }
            return false;
        }

        public void Hole(int player, int hole) { holed[player, hole] = true; }

        public bool HoleComplete(int hole)
        {
            for (int p = 0; p < players; p++) if (!holed[p, hole]) return false;
            return true;
        }

        public int Total(int player)
        {
            int t = 0;
            for (int h = 0; h < par.Length; h++) t += strokes[player, h];
            return t;
        }

        /// <summary>Relação ao par só dos buracos concluídos.</summary>
        public int ToPar(int player)
        {
            int t = 0;
            for (int h = 0; h < par.Length; h++) if (holed[player, h]) t += strokes[player, h] - par[h];
            return t;
        }

        public int Leader()
        {
            int best = 0;
            for (int p = 1; p < players; p++) if (Total(p) < Total(best)) best = p;
            return best;
        }

        public static string ToParText(int d) => d == 0 ? "E" : d > 0 ? "+" + d : d.ToString();

        /// <summary>Nome do resultado do buraco (como glf_hole_in_one_model / nice_in etc.).</summary>
        public static string ResultName(int strokesTaken, int holePar)
        {
            if (strokesTaken == 1) return "Hole in one!";
            switch (strokesTaken - holePar)
            {
                case -3: return "Albatroz";
                case -2: return "Eagle";
                case -1: return "Birdie";
                case 0: return "Par";
                case 1: return "Bogey";
                case 2: return "Double bogey";
                case 3: return "Triple bogey";
                default: return strokesTaken - holePar < -3 ? "Condor" : "+" + (strokesTaken - holePar);
            }
        }
    }
}
