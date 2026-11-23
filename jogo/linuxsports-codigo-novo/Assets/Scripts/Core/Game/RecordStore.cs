// Recordes por perfil, com os campos do RPSportsPlayerData (getters/setters do DOL listados em
// gameplay_data.json -> records). Persistência via PlayerPrefs (no WebGL vira IndexedDB do navegador).
using System.Collections.Generic;
using UnityEngine;

namespace LinuxSports.Core
{
    public static class RecordStore
    {
        private const string Prefix = "ls.rec.";
        private static HashSet<string> validFields;

        /// <summary>Restringe os campos aos do RPSportsPlayerData (chamado com GameplayData.recordFields).</summary>
        public static void SetValidFields(IEnumerable<string> fields)
        {
            validFields = new HashSet<string>(fields);
        }

        public static bool IsValid(string field) { return validFields == null || validFields.Contains(field); }

        public static string Key(string profile, string field, string variant = null)
        {
            return Prefix + profile + "." + field + (string.IsNullOrEmpty(variant) ? "" : "." + variant);
        }

        public static bool Has(string profile, string field, string variant = null)
        {
            return PlayerPrefs.HasKey(Key(profile, field, variant));
        }

        public static int Get(string profile, string field, string variant = null, int def = 0)
        {
            return PlayerPrefs.GetInt(Key(profile, field, variant), def);
        }

        /// <summary>Envia um valor. Retorna true se virou recorde novo (ou, em Add, sempre que somou).</summary>
        public static bool Submit(string profile, RecordSubmission s)
        {
            if (string.IsNullOrEmpty(profile) || !IsValid(s.field))
            {
                Debug.LogWarning("RecordStore: campo fora do RPSportsPlayerData: " + s.field);
                return false;
            }
            string key = Key(profile, s.field, s.variant);
            bool has = PlayerPrefs.HasKey(key);
            int old = PlayerPrefs.GetInt(key, 0);
            bool improved;
            int value;
            switch (s.mode)
            {
                case RecordMode.Add: value = old + s.value; improved = s.value != 0; break;
                case RecordMode.Lower: improved = !has || s.value < old; value = improved ? s.value : old; break;
                default: improved = !has || s.value > old; value = improved ? s.value : old; break;
            }
            if (improved) PlayerPrefs.SetInt(key, value);
            return improved && s.mode != RecordMode.Add;
        }

        public static void Save() { PlayerPrefs.Save(); }

        // -------------------------------------------------- nível de habilidade (SkillLevel do RPSportsPlayerData)
        // Pontos de habilidade por modalidade, 0..2000, ajustados como Elo contra a força da CPU.
        public const int SkillStart = 0;

        public static int Skill(string profile, Sport sport)
        {
            return Get(profile, "SkillLevel", GameplayData.Key(sport), SkillStart);
        }

        /// <summary>Atualiza os pontos de habilidade e devolve a variação.</summary>
        public static int UpdateSkill(string profile, Sport sport, float opponentStrength01, float outcome01)
        {
            int cur = Skill(profile, sport);
            int delta = SkillDelta(cur, opponentStrength01, outcome01);
            int next = Mathf.Clamp(cur + delta, 0, 2000);
            PlayerPrefs.SetInt(Key(profile, "SkillLevel", GameplayData.Key(sport)), next);
            return next - cur;
        }

        public static int SkillDelta(int current, float opponentStrength01, float outcome01)
        {
            return SkillRating.Delta(current, opponentStrength01, outcome01);
        }

        public static void Clear(string profile, IEnumerable<string> fields)
        {
            foreach (var f in fields) PlayerPrefs.DeleteKey(Key(profile, f));
        }
    }
}
