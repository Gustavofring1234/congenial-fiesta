// Tacos do RPGolScene (modelos glf_club_WD/IR/SW/PT). Velocidade da bola, ângulo de saída e backspin
// calibrados com BallFlight (tests/csharp: carry do driver ≈ 206 m, ferro ≈ 144 m, wedge ≈ 88 m).
using UnityEngine;

namespace LinuxSports.Activities.Golf
{
    public enum GolfClubKind { Driver, Iron, Wedge, Putter }

    public struct GolfClub
    {
        public GolfClubKind kind;
        public string label, model;
        public float launchDeg, backspin, maxSpeedMS, sideSpinPerDeg, maxErrorDeg;

        public static readonly GolfClub[] All =
        {
            new GolfClub { kind = GolfClubKind.Driver, label = "Driver (1W)", model = "glf_club_WD", launchDeg = 12f, backspin = 280f, maxSpeedMS = 74f, sideSpinPerDeg = 9f, maxErrorDeg = 9f },
            new GolfClub { kind = GolfClubKind.Iron, label = "Ferro (7I)", model = "glf_club_IR", launchDeg = 20f, backspin = 420f, maxSpeedMS = 46f, sideSpinPerDeg = 7f, maxErrorDeg = 6f },
            new GolfClub { kind = GolfClubKind.Wedge, label = "Wedge (SW)", model = "glf_club_SW", launchDeg = 38f, backspin = 520f, maxSpeedMS = 33f, sideSpinPerDeg = 5f, maxErrorDeg = 4f },
            new GolfClub { kind = GolfClubKind.Putter, label = "Putter (PT)", model = "glf_club_PT", launchDeg = 0f, backspin = 0f, maxSpeedMS = 9f, sideSpinPerDeg = 0f, maxErrorDeg = 2f },
        };

        public static GolfClub Get(GolfClubKind k) { return All[(int)k]; }

        /// <summary>Escolha automática pela distância (m) e superfície, como o caddie do jogo.</summary>
        public static GolfClubKind Suggest(float distanceM, string surface, bool onTee)
        {
            if (surface == "green") return GolfClubKind.Putter;
            if (surface == "bunker") return distanceM > 110f ? GolfClubKind.Iron : GolfClubKind.Wedge;
            if (distanceM > 165f && (onTee || surface == "fairway")) return GolfClubKind.Driver;
            if (distanceM > 165f) return GolfClubKind.Iron;
            if (distanceM > 85f) return GolfClubKind.Iron;
            if (distanceM > 22f) return GolfClubKind.Wedge;
            return GolfClubKind.Putter;
        }

        /// <summary>Velocidade de saída: perde força na areia e no rough.</summary>
        public static float SurfacePowerFactor(string surface, GolfClubKind k)
        {
            if (k == GolfClubKind.Putter) return 1f;
            switch (surface)
            {
                case "rough": return 0.88f;
                case "deepRough": return 0.7f;
                case "bunker": return k == GolfClubKind.Wedge ? 0.75f : 0.55f;
                default: return 1f;
            }
        }

        /// <summary>Velocidade (m/s) para o putt rolar d metros com resistência r (fração de g).</summary>
        public static float PuttSpeed(float distanceM, float rolling)
        {
            return Mathf.Sqrt(2f * rolling * BallFlight.GravityMS2 * Mathf.Max(0.05f, distanceM));
        }
    }
}
