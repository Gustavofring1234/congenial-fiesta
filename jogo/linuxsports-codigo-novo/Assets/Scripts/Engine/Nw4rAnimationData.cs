// Modelo em memória das animações 3D convertidas por tools/export_animations.py ('nw4r-anim3d').
// Usado em tempo de execução (Nw4rAnimationPlayer) e no Editor (Nw4rAnimationImporter), para que as
// duas leituras amostrem as trilhas exatamente igual (Hermite do NW4R, tangente por quadro).
using System;
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Engine
{
    public enum Nw4rAnimType { CHR0, SRT0, PAT0, CLR0, VIS0, SHP0, SCN0 }

    /// <summary>Trilha escalar: constante, Hermite (quadro, valor, tangente) ou linear (um valor por quadro).</summary>
    public sealed class Nw4rTrack
    {
        public enum Kind { Const, Hermite, Linear }
        public Kind kind;
        public float constant;
        public float[] frames, values, tangents; // Hermite
        public float[] perFrame;                 // Linear

        public static Nw4rTrack Constant(float v) { return new Nw4rTrack { kind = Kind.Const, constant = v }; }

        public static Nw4rTrack Parse(object o)
        {
            if (o == null) return null;
            string t = J.Str(o, "type", "const");
            var tr = new Nw4rTrack();
            if (t == "hermite")
            {
                var keys = J.Arr(o, "keys");
                tr.kind = Kind.Hermite;
                int n = keys == null ? 0 : keys.Count;
                tr.frames = new float[n]; tr.values = new float[n]; tr.tangents = new float[n];
                for (int i = 0; i < n; i++)
                {
                    var k = J.Floats(keys[i]);
                    tr.frames[i] = k[0]; tr.values[i] = k[1]; tr.tangents[i] = k.Length > 2 ? k[2] : 0f;
                }
                if (n == 0) { tr.kind = Kind.Const; tr.constant = 0f; }
            }
            else if (t == "linear")
            {
                tr.kind = Kind.Linear;
                tr.perFrame = J.Floats(o, "values");
                if (tr.perFrame.Length == 0) { tr.kind = Kind.Const; tr.constant = 0f; }
            }
            else
            {
                tr.kind = Kind.Const;
                tr.constant = J.F(o, "value");
            }
            return tr;
        }

        public bool IsConstant => kind == Kind.Const;

        public float Sample(float frame)
        {
            switch (kind)
            {
                case Kind.Const: return constant;
                case Kind.Linear:
                {
                    var v = perFrame;
                    if (frame <= 0) return v[0];
                    if (frame >= v.Length - 1) return v[v.Length - 1];
                    int i = (int)frame;
                    float f = frame - i;
                    return v[i] + (v[i + 1] - v[i]) * f;
                }
                default:
                {
                    var k = frames;
                    int n = k.Length;
                    if (frame <= k[0]) return values[0];
                    if (frame >= k[n - 1]) return values[n - 1];
                    int lo = 0, hi = n - 1;
                    while (hi - lo > 1) { int mid = (lo + hi) >> 1; if (k[mid] <= frame) lo = mid; else hi = mid; }
                    float f0 = k[lo], f1 = k[hi];
                    float dt = f1 - f0;
                    if (dt <= 0f) return values[hi];
                    float s = (frame - f0) / dt, s2 = s * s, s3 = s2 * s;
                    return (2 * s3 - 3 * s2 + 1) * values[lo] + (s3 - 2 * s2 + s) * dt * tangents[lo]
                         + (-2 * s3 + 3 * s2) * values[hi] + (s3 - s2) * dt * tangents[hi];
                }
            }
        }
    }

    public sealed class Nw4rBoneTrack
    {
        public string bone;
        public bool identity;
        public Nw4rTrack[] scale, rotate, translate; // null = canal ausente (usa a pose do modelo)
        public bool scaleOne, rotTransZero;
    }

    public sealed class Nw4rTexSrtTrack
    {
        public string material;
        public int slot;
        public Nw4rTrack scaleS, scaleT, rotate, translateS, translateT;
    }

    public sealed class Nw4rColorTrack
    {
        public string material, target;
        public uint mask;
        public Color32 constant;
        public Color32[] frames;
        public bool IsConstant => frames == null;

        public Color32 Sample(float frame)
        {
            if (frames == null) return constant;
            int n = frames.Length;
            if (frame <= 0) return frames[0];
            if (frame >= n - 1) return frames[n - 1];
            int i = (int)frame;
            return Color32.Lerp(frames[i], frames[i + 1], frame - i);
        }
    }

    public sealed class Nw4rPatternTrack
    {
        public string material;
        public int slot;
        public string constTexture;
        public float[] keyFrames;
        public string[] keyTextures;

        public string Sample(float frame)
        {
            if (keyFrames == null || keyFrames.Length == 0) return constTexture;
            string cur = keyTextures[0];
            for (int i = 0; i < keyFrames.Length; i++) { if (keyFrames[i] <= frame + 1e-4f) cur = keyTextures[i]; else break; }
            return cur;
        }
    }

    public sealed class Nw4rVisTrack
    {
        public string bone;
        public bool constant;
        public bool[] frames;
        public bool Sample(float frame)
        {
            if (frames == null) return constant;
            int i = Mathf.Clamp(Mathf.FloorToInt(frame), 0, frames.Length - 1);
            return frames[i];
        }
    }

    public sealed class Nw4rShapeTrack
    {
        public string shape, baseSet, target;
        public Nw4rTrack weight;
    }

    public sealed class Nw4rCameraTrack
    {
        public string name;
        public bool aim, ortho, placeholder;
        public Nw4rTrack posX, posY, posZ, rotX, rotY, rotZ, aimX, aimY, aimZ, twist, fovY, near, far, aspect, orthoHeight;

        public Vector3 Position(float f) { return new Vector3(posX.Sample(f), posY.Sample(f), posZ.Sample(f)); }
        public Vector3 Aim(float f) { return new Vector3(aimX.Sample(f), aimY.Sample(f), aimZ.Sample(f)); }

        public void Apply(Camera cam, float f)
        {
            cam.transform.localPosition = Nw4rCoordinates.Position(Position(f));
            cam.transform.localRotation = aim
                ? Nw4rCoordinates.LookAt(Position(f), Aim(f), twist.Sample(f))
                : Nw4rCoordinates.CameraRotation(rotX.Sample(f), rotY.Sample(f), rotZ.Sample(f));
            cam.orthographic = ortho;
            if (ortho) cam.orthographicSize = Mathf.Max(0.01f, orthoHeight.Sample(f) * 0.5f);
            else cam.fieldOfView = Mathf.Clamp(fovY.Sample(f), 1f, 179f);
            float n = near.Sample(f), fa = far.Sample(f);
            if (n > 0f && fa > n) { cam.nearClipPlane = n; cam.farClipPlane = fa; }
        }
    }

    public sealed class Nw4rLightTrack
    {
        public string name, kind;
        public Nw4rTrack startX, startY, startZ, endX, endY, endZ;
        public Color32 color;
        public Color32[] colorFrames;
        public float cutoffDeg, refBrightness, refDistance;

        public Color32 Color(float f)
        {
            if (colorFrames == null || colorFrames.Length == 0) return color;
            int i = Mathf.Clamp(Mathf.FloorToInt(f), 0, colorFrames.Length - 1);
            return colorFrames[i];
        }
    }

    public sealed class Nw4rAnimation
    {
        public Nw4rAnimType type;
        public string name, source;
        public int frames;
        public bool loop;
        public readonly List<Nw4rBoneTrack> bones = new List<Nw4rBoneTrack>();
        public readonly List<Nw4rTexSrtTrack> texSrt = new List<Nw4rTexSrtTrack>();
        public readonly List<Nw4rColorTrack> colors = new List<Nw4rColorTrack>();
        public readonly List<Nw4rPatternTrack> patterns = new List<Nw4rPatternTrack>();
        public readonly List<Nw4rVisTrack> visibility = new List<Nw4rVisTrack>();
        public readonly List<Nw4rShapeTrack> shapes = new List<Nw4rShapeTrack>();
        public readonly List<Nw4rCameraTrack> cameras = new List<Nw4rCameraTrack>();
        public readonly List<Nw4rLightTrack> lights = new List<Nw4rLightTrack>();
        public readonly List<KeyValuePair<string, Color32>> ambients = new List<KeyValuePair<string, Color32>>();

        public float DurationSeconds => Mathf.Max(1, frames) / Nw4rCoordinates.FrameRate;

        private static Nw4rTrack[] Channel(object o, string key)
        {
            var a = J.Arr(o, key);
            if (a == null) return null;
            var r = new Nw4rTrack[3];
            for (int i = 0; i < 3; i++) r[i] = Nw4rTrack.Parse(i < a.Count ? a[i] : null) ?? Nw4rTrack.Constant(0);
            return r;
        }

        private static Color32 Col(object list)
        {
            var c = J.Ints(list);
            return Nw4rCoordinates.Color(c);
        }

        public static Nw4rAnimation Parse(object root)
        {
            var a = new Nw4rAnimation();
            string t = J.Str(root, "type");
            if (!Enum.TryParse(t, out a.type)) throw new FormatException("tipo de animação desconhecido: " + t);
            a.name = J.Str(root, "name");
            a.source = J.Str(root, "source");
            a.frames = J.Int(root, "frames");
            a.loop = J.Bool(root, "loop");
            switch (a.type)
            {
                case Nw4rAnimType.CHR0:
                    foreach (var b in J.Objs(root, "bones"))
                    {
                        var flags = J.Obj(b, "flags");
                        a.bones.Add(new Nw4rBoneTrack
                        {
                            bone = J.Str(b, "bone"), identity = J.Bool(b, "identity"),
                            scale = Channel(b, "scale"), rotate = Channel(b, "rotate"), translate = Channel(b, "translate"),
                            scaleOne = J.Bool(flags, "scaleOne"), rotTransZero = J.Bool(flags, "rotTransZero"),
                        });
                    }
                    break;
                case Nw4rAnimType.SRT0:
                    foreach (var m in J.Objs(root, "materials"))
                        foreach (var tx in J.Objs(m, "textures"))
                        {
                            if (J.Get(tx, "slot") == null) continue; // matrizes indiretas não são usadas pelo shader
                            a.texSrt.Add(new Nw4rTexSrtTrack
                            {
                                material = J.Str(m, "material"), slot = J.Int(tx, "slot"),
                                scaleS = Nw4rTrack.Parse(J.Get(tx, "scaleS")), scaleT = Nw4rTrack.Parse(J.Get(tx, "scaleT")),
                                rotate = Nw4rTrack.Parse(J.Get(tx, "rotate")),
                                translateS = Nw4rTrack.Parse(J.Get(tx, "translateS")), translateT = Nw4rTrack.Parse(J.Get(tx, "translateT")),
                            });
                        }
                    break;
                case Nw4rAnimType.CLR0:
                    foreach (var m in J.Objs(root, "materials"))
                        foreach (var tg in J.Objs(m, "targets"))
                        {
                            var ct = new Nw4rColorTrack { material = J.Str(m, "material"), target = J.Str(tg, "target"), mask = (uint)J.Num(tg, "mask") };
                            if (J.Has(tg, "const")) ct.constant = Col(J.Get(tg, "const"));
                            else
                            {
                                var fr = J.Arr(tg, "frames");
                                ct.frames = new Color32[fr.Count];
                                for (int i = 0; i < fr.Count; i++) ct.frames[i] = Col(fr[i]);
                            }
                            a.colors.Add(ct);
                        }
                    break;
                case Nw4rAnimType.PAT0:
                    foreach (var m in J.Objs(root, "materials"))
                        foreach (var sl in J.Objs(m, "slots"))
                        {
                            var pt = new Nw4rPatternTrack { material = J.Str(m, "material"), slot = J.Int(sl, "slot") };
                            if (J.Has(sl, "const")) pt.constTexture = J.Str(J.Get(sl, "const"), "texture");
                            var keys = J.Arr(sl, "keys");
                            if (keys != null)
                            {
                                pt.keyFrames = new float[keys.Count];
                                pt.keyTextures = new string[keys.Count];
                                for (int i = 0; i < keys.Count; i++) { pt.keyFrames[i] = J.F(keys[i], "frame"); pt.keyTextures[i] = J.Str(keys[i], "texture"); }
                            }
                            a.patterns.Add(pt);
                        }
                    break;
                case Nw4rAnimType.VIS0:
                    foreach (var b in J.Objs(root, "bones"))
                    {
                        var vt = new Nw4rVisTrack { bone = J.Str(b, "bone"), constant = J.Bool(b, "const", true) };
                        var fr = J.Arr(b, "frames");
                        if (fr != null) { vt.frames = new bool[fr.Count]; for (int i = 0; i < fr.Count; i++) vt.frames[i] = fr[i] is bool && (bool)fr[i]; }
                        a.visibility.Add(vt);
                    }
                    break;
                case Nw4rAnimType.SHP0:
                    foreach (var s in J.Objs(root, "shapes"))
                        foreach (var tg in J.Objs(s, "targets"))
                            a.shapes.Add(new Nw4rShapeTrack
                            {
                                shape = J.Str(s, "shape"), baseSet = J.Str(s, "base"), target = J.Str(tg, "vertexSet"),
                                weight = Nw4rTrack.Parse(J.Get(tg, "weight")) ?? Nw4rTrack.Constant(0),
                            });
                    break;
                case Nw4rAnimType.SCN0:
                    foreach (var c in J.Objs(root, "cameras"))
                    {
                        Func<string, Nw4rTrack> tr = k => Nw4rTrack.Parse(J.Get(c, k)) ?? Nw4rTrack.Constant(0);
                        a.cameras.Add(new Nw4rCameraTrack
                        {
                            name = J.Str(c, "name"), aim = J.Str(c, "type") == "aim", ortho = J.Str(c, "projection") == "ortho",
                            placeholder = J.Bool(c, "placeholder"),
                            posX = tr("posX"), posY = tr("posY"), posZ = tr("posZ"), rotX = tr("rotX"), rotY = tr("rotY"), rotZ = tr("rotZ"),
                            aimX = tr("aimX"), aimY = tr("aimY"), aimZ = tr("aimZ"), twist = tr("twist"), fovY = tr("fovY"),
                            near = tr("near"), far = tr("far"), aspect = tr("aspect"), orthoHeight = tr("orthoHeight"),
                        });
                    }
                    foreach (var l in J.Objs(root, "lights"))
                    {
                        Func<string, Nw4rTrack> tr = k => Nw4rTrack.Parse(J.Get(l, k)) ?? Nw4rTrack.Constant(0);
                        var lt = new Nw4rLightTrack
                        {
                            name = J.Str(l, "name"), kind = J.Str(l, "kind", "point"),
                            startX = tr("startX"), startY = tr("startY"), startZ = tr("startZ"),
                            endX = tr("endX"), endY = tr("endY"), endZ = tr("endZ"),
                            color = J.Has(l, "color") ? Col(J.Get(l, "color")) : new Color32(255, 255, 255, 255),
                            cutoffDeg = J.F(l, "cutoffDeg", 90f), refBrightness = J.F(l, "refBrightness", 1f), refDistance = J.F(l, "refDistance", 1f),
                        };
                        var cf = J.Arr(l, "colorFrames");
                        if (cf != null) { lt.colorFrames = new Color32[cf.Count]; for (int i = 0; i < cf.Count; i++) lt.colorFrames[i] = Col(cf[i]); }
                        a.lights.Add(lt);
                    }
                    foreach (var am in J.Objs(root, "ambients"))
                    {
                        Color32 c = J.Has(am, "color") ? Col(J.Get(am, "color")) : (J.Arr(am, "frames") != null && J.Arr(am, "frames").Count > 0 ? Col(J.Arr(am, "frames")[0]) : new Color32(0, 0, 0, 255));
                        a.ambients.Add(new KeyValuePair<string, Color32>(J.Str(am, "name"), c));
                    }
                    break;
            }
            return a;
        }

        /// <summary>Pose local de um osso no quadro, já no referencial do Unity.</summary>
        public static void SampleBone(Nw4rBoneTrack t, float frame, Vector3 bindScaleWii, Vector3 bindRotWii, Vector3 bindPosWii,
                                      out Vector3 scale, out Quaternion rotation, out Vector3 position)
        {
            Vector3 s = bindScaleWii, r = bindRotWii, p = bindPosWii;
            if (t.identity) { s = Vector3.one; r = Vector3.zero; p = Vector3.zero; }
            else
            {
                if (t.scale != null) s = new Vector3(t.scale[0].Sample(frame), t.scale[1].Sample(frame), t.scale[2].Sample(frame));
                else if (t.scaleOne) s = Vector3.one;
                if (t.rotate != null) r = new Vector3(t.rotate[0].Sample(frame), t.rotate[1].Sample(frame), t.rotate[2].Sample(frame));
                else if (t.rotTransZero) r = Vector3.zero;
                if (t.translate != null) p = new Vector3(t.translate[0].Sample(frame), t.translate[1].Sample(frame), t.translate[2].Sample(frame));
                else if (t.rotTransZero) p = Vector3.zero;
            }
            scale = s;
            rotation = Nw4rCoordinates.Rotation(r.x, r.y, r.z);
            position = Nw4rCoordinates.Position(p);
        }

        /// <summary>_BaseMap_ST (escala, deslocamento) e rotação em graus para a SRT de textura no quadro.
        /// UV do Wii tem V para baixo; o glTFast inverte V (v' = 1 - v), daí o deslocamento em T.</summary>
        public static Vector4 SampleTexSrt(Nw4rTexSrtTrack t, float frame, out float rotationDeg)
        {
            float ss = t.scaleS != null ? t.scaleS.Sample(frame) : 1f;
            float st = t.scaleT != null ? t.scaleT.Sample(frame) : 1f;
            float ts = t.translateS != null ? t.translateS.Sample(frame) : 0f;
            float tt = t.translateT != null ? t.translateT.Sample(frame) : 0f;
            rotationDeg = t.rotate != null ? t.rotate.Sample(frame) : 0f;
            return new Vector4(ss, st, ts, 1f - st + tt);
        }
    }

    /// <summary>Entrada de StreamingAssets/animations_manifest.json.</summary>
    public sealed class Nw4rAnimationEntry
    {
        public string id, name, file, method, brres;
        public Nw4rAnimType type;
        public int frames;
        public bool loop;
        public readonly List<string> modelAssetIds = new List<string>();
        public readonly List<float> modelScores = new List<float>();
        public readonly List<string> sceneAssetIds = new List<string>();

        public static List<Nw4rAnimationEntry> ParseManifest(object root)
        {
            var list = new List<Nw4rAnimationEntry>();
            foreach (var e in J.Objs(root, "animations"))
            {
                var en = new Nw4rAnimationEntry
                {
                    id = J.Str(e, "id"), name = J.Str(e, "name"), file = J.Str(e, "file"), method = J.Str(e, "method"),
                    brres = J.Str(e, "brres"), frames = J.Int(e, "frames"), loop = J.Bool(e, "loop"),
                };
                Enum.TryParse(J.Str(e, "type"), out en.type);
                foreach (var m in J.Objs(e, "models")) { en.modelAssetIds.Add(J.Str(m, "assetId")); en.modelScores.Add(J.F(m, "score", 1f)); }
                foreach (var s in J.Objs(e, "scenes")) en.sceneAssetIds.Add(J.Str(s, "assetId"));
                list.Add(en);
            }
            return list;
        }
    }
}
