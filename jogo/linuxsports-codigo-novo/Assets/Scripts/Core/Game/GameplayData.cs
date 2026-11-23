// Dados de jogabilidade exportados por tools/export_gameplay.py (StreamingAssets/Gameplay/gameplay_data.json):
// nomes de animações/efeitos/modelos que cada modalidade cita em strings.tsv e que existem nos dados
// convertidos, layouts por estado, campos de recorde do RPSportsPlayerData e geometria de jogo
// (pista de boliche com as 7 pistas do DOL, tees/pinos dos cursos, muro do estádio, quadra, ringue).
using System;
using System.Collections.Generic;
using UnityEngine;

namespace LinuxSports.Core
{
    public enum Sport { Tennis, Baseball, Bowling, Golf, Boxing }

    public sealed class SportData
    {
        public Sport sport;
        public string key;
        public string commonScene;
        public readonly List<string> scenes = new List<string>();
        public readonly HashSet<string> animations = new HashSet<string>();
        public readonly HashSet<string> effects = new HashSet<string>();
        public readonly Dictionary<string, string> models = new Dictionary<string, string>();
        public readonly Dictionary<string, string> hud = new Dictionary<string, string>();
        public Dictionary<string, object> geometry;

        public bool HasAnimation(string n) { return n != null && animations.Contains(n); }
        public bool HasEffect(string n) { return n != null && effects.Contains(n); }
        public string ModelPrefab(string n) { string p; return n != null && models.TryGetValue(n, out p) ? p : null; }
        public string Hud(string n) { string p; return n != null && hud.TryGetValue(n, out p) ? p : null; }
        public float G(string field, float def) { return geometry != null ? J.F(geometry, field, def) : def; }
        public float[] GA(string field) { return geometry != null ? J.Floats(geometry, field) : new float[0]; }
    }

    public sealed class GolfCourse
    {
        public string id, scene;
        public Vector3 tee, teeForward;
        public readonly List<Vector3> pins = new List<Vector3>();
        public float distanceMeters;
        public int par;
    }

    public sealed class GameplayData
    {
        public const string Path = "Gameplay/gameplay_data.json";
        private static GameplayData current;
        public static GameplayData Current => current;

        public float unitsPerMeter = 10f;
        public readonly Dictionary<string, List<string>> stateLayouts = new Dictionary<string, List<string>>();
        public readonly List<string> recordFields = new List<string>();
        public readonly Dictionary<Sport, SportData> sports = new Dictionary<Sport, SportData>();
        public readonly List<GolfCourse> golfCourses = new List<GolfCourse>();
        public readonly Dictionary<string, string> avatarBodies = new Dictionary<string, string>();
        /// <summary>Flag do KCL dos cursos de golfe -> superfície (tee, fairway, rough, deepRough, bunker, green, water, outOfBounds).</summary>
        public readonly Dictionary<int, string> golfSurfaces = new Dictionary<int, string>();

        /// <summary>Flag do KCL de um collider (nó collision_0xNNNN gravado pela Etapa 1); -1 se não for de colisão.</summary>
        public static int CollisionFlag(Collider c)
        {
            if (c == null) return -1;
            string n = c.gameObject.name;
            int i = n.IndexOf("0x", StringComparison.Ordinal);
            if (i < 0) return -1;
            int v;
            return int.TryParse(n.Substring(i + 2, Math.Min(4, n.Length - i - 2)), System.Globalization.NumberStyles.HexNumber, null, out v) ? v : -1;
        }

        public string GolfSurface(Collider c)
        {
            string s;
            return golfSurfaces.TryGetValue(CollisionFlag(c), out s) ? s : "rough";
        }

        public SportData this[Sport s] { get { SportData d; return sports.TryGetValue(s, out d) ? d : null; } }

        /// <summary>Metros -> unidades da cena (10 u = 1 m).</summary>
        public float M(float meters) { return meters * unitsPerMeter; }

        public static string Key(Sport s)
        {
            switch (s)
            {
                case Sport.Tennis: return "tennis";
                case Sport.Baseball: return "baseball";
                case Sport.Bowling: return "bowling";
                case Sport.Golf: return "golf";
                default: return "boxing";
            }
        }

        public static void Load(Action<GameplayData> onDone, Action<string> onError = null)
        {
            if (current != null) { onDone(current); return; }
            StreamingAssetLoader.Instance.LoadJson(Path, root =>
            {
                current = Parse(root);
                onDone(current);
            }, e => { if (onError != null) onError(e); else Debug.LogError(e); });
        }

        public static GameplayData Parse(object root)
        {
            var d = new GameplayData();
            d.unitsPerMeter = J.F(root, "unitsPerMeter", 10f);
            var sl = J.Obj(root, "stateLayouts");
            if (sl != null) foreach (var kv in sl) d.stateLayouts[kv.Key] = J.Strings(sl, kv.Key);
            foreach (var r in J.Objs(root, "records")) d.recordFields.Add(J.Str(r, "field"));
            var bodies = J.Obj(root, "avatarBodies");
            if (bodies != null) foreach (var kv in bodies) d.avatarBodies[kv.Key] = kv.Value as string;
            var sports = J.Obj(root, "sports");
            foreach (Sport s in Enum.GetValues(typeof(Sport)))
            {
                var o = sports != null ? J.Obj(sports, Key(s)) : null;
                var sd = new SportData { sport = s, key = Key(s) };
                if (o != null)
                {
                    sd.commonScene = J.Str(o, "commonScene");
                    sd.scenes.AddRange(J.Strings(o, "scenes"));
                    foreach (var a in J.Strings(o, "animations")) sd.animations.Add(a);
                    foreach (var e in J.Strings(o, "effects")) sd.effects.Add(e);
                    var m = J.Obj(o, "models");
                    if (m != null) foreach (var kv in m) sd.models[kv.Key] = kv.Value as string;
                    var h = J.Obj(o, "hud");
                    if (h != null) foreach (var kv in h) sd.hud[kv.Key] = kv.Value as string;
                    sd.geometry = J.Obj(o, "geometry");
                    var surf = s == Sport.Golf ? J.Obj(o, "surfaces") : null;
                    if (surf != null)
                        foreach (var kv in surf)
                        {
                            int flag;
                            if (int.TryParse(kv.Key, out flag)) d.golfSurfaces[flag] = kv.Value as string;
                        }
                    if (s == Sport.Golf)
                        foreach (var c in J.Objs(o, "courses"))
                        {
                            var gc = new GolfCourse
                            {
                                id = J.Str(c, "id"), scene = J.Str(c, "scene"),
                                tee = V(J.Floats(c, "tee")), teeForward = V(J.Floats(c, "teeForward")),
                                distanceMeters = J.F(c, "distanceMeters"), par = J.Int(c, "par", 4),
                            };
                            foreach (var p in J.Arr(c, "pins") ?? new List<object>()) gc.pins.Add(V(J.Floats(p)));
                            d.golfCourses.Add(gc);
                        }
                }
                d.sports[s] = sd;
            }
            return d;
        }

        private static Vector3 V(float[] f) { return f != null && f.Length >= 3 ? new Vector3(f[0], f[1], f[2]) : Vector3.zero; }
    }
}
