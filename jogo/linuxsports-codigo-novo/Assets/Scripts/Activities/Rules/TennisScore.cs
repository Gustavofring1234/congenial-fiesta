// Contagem de tênis (0/15/30/40, iguais, vantagem; games; troca de saque a cada game; partida de N games
// com 2 de vantagem e decisão no game N+1, como no RPTnsScene: partidas curtas de 1, 3 ou 5 games).
// Sem UnityEngine.
using System;

namespace LinuxSports.Activities.Rules
{
    public sealed class TennisScore
    {
        public readonly int gamesToWin;
        public readonly int teamSize;
        private readonly int[] points = new int[2];
        private readonly int[] games = new int[2];

        public int ServingTeam { get; private set; }
        public int ServerIndex { get; private set; }       // jogador do time que saca (duplas alternam)
        public int Winner { get; private set; } = -1;
        public bool IsMatchOver => Winner >= 0;
        public int PointsPlayed { get; private set; }
        public int FaultCount { get; private set; }        // 0 ou 1 no ponto atual
        private readonly int[] serverRotation = new int[2];

        public TennisScore(int gamesToWin = 3, int teamSize = 1, int firstServer = 0)
        {
            if (gamesToWin < 1) throw new ArgumentOutOfRangeException(nameof(gamesToWin));
            this.gamesToWin = gamesToWin;
            this.teamSize = Math.Max(1, teamSize);
            ServingTeam = firstServer;
        }

        public int Games(int team) => games[team];
        public int Points(int team) => points[team];

        /// <summary>Lado do saque: 0 = direita (deuce), 1 = esquerda (vantagem), pela soma dos pontos do game.</summary>
        public int ServeSide => (points[0] + points[1]) % 2;

        /// <summary>Falta de saque. Retorna true se foi dupla falta (ponto para o recebedor).</summary>
        public bool Fault()
        {
            if (IsMatchOver) return false;
            if (FaultCount == 0) { FaultCount = 1; return false; }
            PointTo(1 - ServingTeam);
            return true;
        }

        public void Let() { }

        /// <summary>Ponto para um time. Retorna o evento resultante.</summary>
        public TennisEvent PointTo(int team)
        {
            if (IsMatchOver) return TennisEvent.MatchOver;
            PointsPlayed++;
            FaultCount = 0;
            points[team]++;
            int o = 1 - team;
            if (points[team] >= 4 && points[team] - points[o] >= 2) return WinGame(team);
            if (points[team] >= 3 && points[o] >= 3)
            {
                // Volta para iguais (40-40) para os números não crescerem.
                if (points[team] == points[o]) { points[0] = points[1] = 3; return TennisEvent.Deuce; }
                return TennisEvent.Advantage;
            }
            return TennisEvent.Point;
        }

        private TennisEvent WinGame(int team)
        {
            games[team]++;
            points[0] = points[1] = 0;
            int o = 1 - team;
            bool matchWon = games[team] >= gamesToWin && (games[team] - games[o] >= 2 || games[team] > gamesToWin || gamesToWin == 1);
            // Rotação do saque: troca o time; em duplas, cada time alterna seus jogadores.
            serverRotation[ServingTeam] = (serverRotation[ServingTeam] + 1) % teamSize;
            ServingTeam = 1 - ServingTeam;
            ServerIndex = serverRotation[ServingTeam];
            if (matchWon) { Winner = team; return TennisEvent.MatchOver; }
            return TennisEvent.Game;
        }

        /// <summary>Texto do placar do game ("15-30", "Iguais", "Vantagem").</summary>
        public string PointText(int perspectiveTeam = 0)
        {
            int a = points[perspectiveTeam], b = points[1 - perspectiveTeam];
            if (a >= 3 && b >= 3)
            {
                if (a == b) return "Iguais";
                return a > b ? "Vantagem" : "Vantagem adv.";
            }
            return Call(a) + "-" + Call(b);
        }

        public static string Call(int p)
        {
            switch (p) { case 0: return "0"; case 1: return "15"; case 2: return "30"; default: return "40"; }
        }

        /// <summary>Game point / break point / match point para o time.</summary>
        public bool IsGamePoint(int team)
        {
            int o = 1 - team;
            return points[team] >= 3 && points[team] > points[o];
        }

        public bool IsMatchPoint(int team)
        {
            if (!IsGamePoint(team)) return false;
            int g = games[team] + 1, o = games[1 - team];
            return g >= gamesToWin && (g - o >= 2 || g > gamesToWin || gamesToWin == 1);
        }
    }

    public enum TennisEvent { Point, Deuce, Advantage, Game, MatchOver }
}
