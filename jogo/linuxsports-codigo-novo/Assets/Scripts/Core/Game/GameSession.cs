// Sessão de jogo: modalidade escolhida, jogadores (perfil Mii .rcd, humano ou CPU, perfil de IA) e opções.
using System.Collections.Generic;
using LinuxSports.Entities;

namespace LinuxSports.Core
{
    public sealed class PlayerSlot
    {
        public string profileId;          // cpu_mii_NNN (Resources/Mii/Profiles)
        public string name;
        public bool human;
        public AiProfile ai;              // também usado no humano para corpo/altura (força de IA ignorada)
        public MiiCharInfo info;
    }

    public sealed class GameSession
    {
        public Sport sport;
        public readonly List<PlayerSlot> players = new List<PlayerSlot>();
        public int humanCount = 1;

        // Opções por modalidade (definidas na tela de opções)
        public int tennisGames = 3;
        public bool tennisDoubles = true;
        public int baseballInnings = 3;
        public int bowlingFrames = 10;
        public List<string> golfHoles = new List<string>();   // ids de GolfCourse em ordem
        public int boxingRounds = 3;
        public int seed = 1;

        public PlayerSlot Human => players.Count > 0 ? players[0] : null;
    }

    public sealed class PlayerResult
    {
        public string profileId, name;
        public bool human;
        public int score;               // pontos/tacadas/corridas/games conforme a modalidade
        public string scoreText;
    }

    public sealed class ActivityResult
    {
        public Sport sport;
        public readonly List<PlayerResult> players = new List<PlayerResult>();
        public int winner = -1;           // índice em players (-1 = empate ou sem vencedor)
        public bool humanWon;
        public bool aborted;
        public readonly List<string> lines = new List<string>();
        /// <summary>Recordes a enviar ao RecordStore: campo (RPSportsPlayerData) -> valor.</summary>
        public readonly List<RecordSubmission> records = new List<RecordSubmission>();
    }

    public struct RecordSubmission
    {
        public string field;              // ex.: BowStandardBest
        public string variant;            // sufixo opcional (ex.: id do curso de golfe)
        public int value;
        public RecordMode mode;
    }

    public enum RecordMode { Higher, Lower, Add }
}
