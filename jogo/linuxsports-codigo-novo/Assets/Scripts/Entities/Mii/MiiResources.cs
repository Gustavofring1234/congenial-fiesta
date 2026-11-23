// Dados do RFL exportados por tools/export_mii.py para Assets/Resources/Mii/ (Resources funciona no WebGL
// sem acesso a disco). Tudo é carregado sob demanda e guardado em cache.
//
// Conversão Wii -> Unity igual à do resto do projeto (Nw4rCoordinates): posição e normal (-x, y, z);
// por causa do espelho, cada triângulo tem a ordem invertida (o JSON vem anti-horário visto de fora).
// UV: o GX tem t = 0 no topo e o PNG é importado com a linha 0 em cima, então v = 1 - t.
using System;
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Entities
{
    public enum MiiShapePart { Nose, Forehead, Faceline, Hair, Cap, Beard, Noseline, Mask, Glass }

    public sealed class MiiShape
    {
        public float[] positions, normals, uvs;
        public int[] triangles;
        /// <summary>Só no Faceline: âncoras (Wii) do nariz, da barba e do cabelo.</summary>
        public Vector3 noseAnchor, beardAnchor, hairAnchor;
    }

    /// <summary>Tabelas do RFL lidas do main.dol (Resources/Mii/rfl_params.json).</summary>
    public sealed class MiiParams
    {
        public Color32[] facelineColor, hairColor, beardColor, glassColor, favoriteColor, eyeColor;
        public Color32[] eyebrowColor2D, mustacheColor2D, mouthColorDark, mouthColorLip;
        public Color32 eyeOutline, eyeOutline9, eyeOutline20, moleColor;
        public int[] eyeRotateOffset, eyebrowRotateOffset;

        public Color32 EyeOutline(int eyeType) { return eyeType == 9 ? eyeOutline9 : eyeType == 20 ? eyeOutline20 : eyeOutline; }

        /// <summary>Cor como os valores do GX (0..1, sem conversão de espaço de cor).</summary>
        public static Vector4 Raw(Color32 c) { return new Vector4(c.r / 255f, c.g / 255f, c.b / 255f, c.a / 255f); }
    }

    public static class MiiResources
    {
        public const string Root = "Mii/";
        private static readonly Dictionary<MiiShapePart, MiiShape[]> shapes = new Dictionary<MiiShapePart, MiiShape[]>();
        private static readonly Dictionary<string, Texture2D> textures = new Dictionary<string, Texture2D>();
        private static Dictionary<string, object> textureMeta;
        private static MiiParams parameters;

        public static MiiParams Params
        {
            get
            {
                if (parameters != null) return parameters;
                var j = Json.ParseObject(Text("rfl_params"));
                var colors = J.Obj(j, "colors");
                var outline = J.Obj(j, "eyeOutline");
                parameters = new MiiParams
                {
                    facelineColor = Colors(colors, "facelineColor"), hairColor = Colors(colors, "hairColor"),
                    beardColor = Colors(colors, "beardColor"), glassColor = Colors(colors, "glassColor"),
                    favoriteColor = Colors(colors, "favoriteColor"), eyeColor = Colors(colors, "eyeColor"),
                    eyebrowColor2D = Colors(colors, "eyebrowColor2D"), mustacheColor2D = Colors(colors, "mustacheColor2D"),
                    mouthColorDark = Colors(colors, "mouthColorDark"), mouthColorLip = Colors(colors, "mouthColorLip"),
                    eyeOutline = Rgba(J.Get(outline, "default")), eyeOutline9 = Rgba(J.Get(outline, "9")),
                    eyeOutline20 = Rgba(J.Get(outline, "20")), moleColor = Rgba(J.Get(j, "moleColor")),
                    eyeRotateOffset = J.Ints(j, "eyeRotateOffset"), eyebrowRotateOffset = J.Ints(j, "eyebrowRotateOffset"),
                };
                return parameters;
            }
        }

        /// <summary>Perfil de Resources/Mii/Profiles (ex.: "cpu_mii_000"), decodificado do RFLCharData original.</summary>
        public static MiiCharInfo LoadProfile(string id)
        {
            var j = Json.ParseObject(Text("Profiles/" + id));
            return MiiCharInfo.FromRaw(Convert.FromBase64String(J.Str(j, "raw")));
        }

        public static List<string> ProfileIds()
        {
            var ids = new List<string>();
            foreach (var p in J.Objs(Json.ParseObject(Text("profiles")), "profiles")) ids.Add(J.Str(p, "id"));
            return ids;
        }

        /// <summary>Forma <paramref name="index"/> da parte, ou null se a parte for vazia (ex.: barba 0).</summary>
        public static MiiShape Shape(MiiShapePart part, int index)
        {
            MiiShape[] list;
            if (!shapes.TryGetValue(part, out list))
            {
                var parts = J.Arr(Json.ParseObject(Text("Shapes/" + PartFile(part))), "parts");
                list = new MiiShape[parts.Count];
                for (int i = 0; i < parts.Count; i++)
                {
                    var p = parts[i] as Dictionary<string, object>;
                    if (p == null) continue;
                    var s = new MiiShape
                    {
                        positions = J.Floats(p, "positions"), normals = J.Floats(p, "normals"),
                        uvs = J.Has(p, "uvs") ? J.Floats(p, "uvs") : null, triangles = J.Ints(p, "triangles"),
                    };
                    if (J.Has(p, "anchors"))
                    {
                        var a = J.Obj(p, "anchors");
                        s.noseAnchor = V3(J.Floats(a, "nose"));
                        s.beardAnchor = V3(J.Floats(a, "beard"));
                        s.hairAnchor = V3(J.Floats(a, "hair"));
                    }
                    list[i] = s;
                }
                shapes[part] = list;
            }
            return index >= 0 && index < list.Length ? list[index] : null;
        }

        /// <summary>Textura de Resources/Mii/Textures/&lt;pasta&gt;/NN.png com o wrap do GX aplicado.</summary>
        public static Texture2D Texture(string folder, int index)
        {
            string key = folder + "/" + index.ToString("00");
            Texture2D tex;
            if (textures.TryGetValue(key, out tex)) return tex;
            tex = Resources.Load<Texture2D>(Root + "Textures/" + key);
            if (tex != null)
            {
                if (textureMeta == null) textureMeta = J.Obj(Json.ParseObject(Text("textures")), "textures");
                var list = J.Arr(textureMeta, folder);
                if (list != null && index < list.Count)
                {
                    tex.wrapModeU = Wrap(J.Int(list[index], "wrapS"));
                    tex.wrapModeV = Wrap(J.Int(list[index], "wrapT"));
                }
                tex.filterMode = FilterMode.Bilinear;
            }
            textures[key] = tex;
            return tex;
        }

        /// <summary>
        /// Malha no referencial do Unity. Com <paramref name="transform"/> a posição vira
        /// trans + pos·escala (RFLiInitShapeRes); <paramref name="flipX"/> espelha o cabelo (repartido ao contrário).
        /// </summary>
        public static Mesh BuildMesh(MiiShape s, string name, bool transform, float scale, Vector3 transWii, bool flipX)
        {
            int n = s.positions.Length / 3;
            var pos = new Vector3[n];
            var nrm = new Vector3[n];
            float fx = flipX ? -1f : 1f;
            for (int i = 0; i < n; i++)
            {
                var p = new Vector3(fx * s.positions[3 * i], s.positions[3 * i + 1], s.positions[3 * i + 2]);
                if (transform) p = transWii + p * scale;
                pos[i] = Nw4rCoordinates.Position(p);
                nrm[i] = Nw4rCoordinates.Position(fx * s.normals[3 * i], s.normals[3 * i + 1], s.normals[3 * i + 2]);
            }
            // Espelho Wii->Unity inverte o sentido; o flip do cabelo inverte de novo.
            bool reverse = !flipX;
            var tri = new int[s.triangles.Length];
            for (int i = 0; i < tri.Length; i += 3)
            {
                tri[i] = s.triangles[i];
                tri[i + 1] = reverse ? s.triangles[i + 2] : s.triangles[i + 1];
                tri[i + 2] = reverse ? s.triangles[i + 1] : s.triangles[i + 2];
            }
            var mesh = new Mesh { name = name };
            mesh.vertices = pos;
            mesh.normals = nrm;
            if (s.uvs != null)
            {
                var uv = new Vector2[n];
                for (int i = 0; i < n; i++) uv[i] = new Vector2(s.uvs[2 * i], 1f - s.uvs[2 * i + 1]);
                mesh.uv = uv;
            }
            mesh.triangles = tri;
            mesh.RecalculateBounds();
            return mesh;
        }

        public static string PartFile(MiiShapePart p)
        {
            switch (p)
            {
                case MiiShapePart.Nose: return "nose";
                case MiiShapePart.Forehead: return "forehead";
                case MiiShapePart.Faceline: return "faceline";
                case MiiShapePart.Hair: return "hair";
                case MiiShapePart.Cap: return "cap";
                case MiiShapePart.Beard: return "beard";
                case MiiShapePart.Noseline: return "noseline";
                case MiiShapePart.Mask: return "mask";
                default: return "glass";
            }
        }

        private static string Text(string path)
        {
            var t = Resources.Load<TextAsset>(Root + path);
            if (t == null) throw new InvalidOperationException("Resources/" + Root + path + ".json ausente (rode tools/export_mii.py)");
            return t.text;
        }

        private static TextureWrapMode Wrap(int gx) { return gx == 1 ? TextureWrapMode.Repeat : gx == 2 ? TextureWrapMode.Mirror : TextureWrapMode.Clamp; }
        private static Vector3 V3(float[] f) { return new Vector3(f[0], f[1], f[2]); }

        private static Color32 Rgba(object list)
        {
            var v = J.Ints(list);
            return new Color32((byte)v[0], (byte)v[1], (byte)v[2], (byte)v[3]);
        }

        private static Color32[] Colors(object o, string key)
        {
            var arr = J.Arr(o, key);
            var c = new Color32[arr.Count];
            for (int i = 0; i < c.Length; i++) c[i] = Rgba(arr[i]);
            return c;
        }
    }
}
