// Dados de um Mii no formato interno do RFL (RFLiCharInfo), lidos de um RFLCharData de 74 bytes
// (.rcd do jogo ou .mii do Wii). A conversão reproduz bit a bit convertRaw2InfoCore_ (0x80172dac);
// o mesmo algoritmo, em Python, gera os campos legíveis de Resources/Mii/Profiles/*.json (tools/nw4r/rfl.py).
//
// As expressões repetem RFLiMakeTexture (0x8016efd0): cada uma troca tipo/rotação de olho, sobrancelha
// e boca antes de compor a textura do rosto.
using System;

namespace LinuxSports.Entities
{
    public enum MiiExpression { Normal = 0, Smile = 1, Anger = 2, Sorrow = 3, Surprise = 4, Blink = 5, OpenMouth = 6 }

    [Serializable] public struct MiiFaceline { public int type, color, texture; }
    [Serializable] public struct MiiHair { public int type, color; public bool flip; }
    [Serializable] public struct MiiEye { public int type, color, scale, rotate, x, y; }
    [Serializable] public struct MiiEyebrow { public int type, color, scale, rotate, x, y; }
    [Serializable] public struct MiiNose { public int type, scale, y; }
    [Serializable] public struct MiiMouth { public int type, color, scale, y; }
    [Serializable] public struct MiiBeard { public int mustache, type, color, scale, y; }
    [Serializable] public struct MiiGlass { public int type, color, scale, y; }
    [Serializable] public struct MiiMole { public bool enabled; public int scale, x, y; }

    [Serializable]
    public sealed class MiiCharInfo
    {
        public const int RawSize = 74;

        public string name, creator;
        public bool female;
        public int birthMonth, birthDay, favoriteColor, height, build;
        public MiiFaceline faceline;
        public MiiHair hair;
        public MiiEye eye;
        public MiiEyebrow eyebrow;
        public MiiNose nose;
        public MiiMouth mouth;
        public MiiBeard beard;
        public MiiGlass glass;
        public MiiMole mole;

        public MiiCharInfo Clone() { return (MiiCharInfo)MemberwiseClone(); }

        public static MiiCharInfo FromRaw(byte[] raw)
        {
            if (raw == null || raw.Length < RawSize)
                throw new ArgumentException("RFLCharData precisa de " + RawSize + " bytes");
            Func<int, int> h = off => (raw[off] << 8) | raw[off + 1];
            int personal = h(0x00), face = h(0x20), hairW = h(0x22);
            int b24 = h(0x24), b26 = h(0x26), e28 = h(0x28), e2a = h(0x2A);
            int noseW = h(0x2C), mouthW = h(0x2E), glassW = h(0x30), beardW = h(0x32), moleW = h(0x34);

            uint eyeW = (uint)((e28 & 0x1F) << 5 | (e2a & 0x1E0) << 5 | (e28 & 0x3E0) << 9 | (e2a & 0x1E00) << 10
                             | (e2a & 0xE000) << 10) | (uint)(e28 & 0xFC00) << 16;
            uint browW = (uint)((b26 & 0x1F0) << 2 | (b26 & 0xF) << 11 | (b24 & 0x7C0) << 9 | (b26 & 0x1E00) << 11
                              | (b26 & 0xE000) << 11) | (uint)(b24 & 0xF800) << 16;
            int moleI = (moleW >> 5) & 0x3E | (moleW & 0x3E) << 5 | moleW & 0x7800 | moleW & 0x8000;
            int pers = ((face >> 2) & 1) | (personal << 1);

            var c = new MiiCharInfo
            {
                name = Utf16(raw, 0x02), creator = Utf16(raw, 0x36),
                female = F(personal, 14, 1) == 1, birthMonth = F(personal, 10, 4), birthDay = F(personal, 5, 5),
                favoriteColor = F(pers, 2, 4), height = raw[0x16], build = raw[0x17],
            };
            c.faceline = new MiiFaceline { type = F(face, 13, 3), color = F(face, 10, 3), texture = F(face, 6, 4) };
            c.hair = new MiiHair { type = F(hairW, 9, 7), color = F(hairW, 6, 3), flip = F(hairW, 5, 1) == 1 };
            c.eye = new MiiEye { type = U(eyeW, 26, 6), color = U(eyeW, 23, 3), scale = U(eyeW, 19, 4),
                                 rotate = U(eyeW, 14, 5), x = U(eyeW, 10, 4), y = U(eyeW, 5, 5) };
            c.eyebrow = new MiiEyebrow { type = U(browW, 27, 5), color = U(browW, 24, 3), scale = U(browW, 20, 4),
                                         rotate = U(browW, 15, 5), x = U(browW, 11, 4), y = U(browW, 6, 5) };
            c.nose = new MiiNose { type = F(noseW, 12, 4), scale = F(noseW, 8, 4), y = F(noseW, 3, 5) };
            c.mouth = new MiiMouth { type = F(mouthW, 11, 5), color = F(mouthW, 9, 2), scale = F(mouthW, 5, 4), y = F(mouthW, 0, 5) };
            c.beard = new MiiBeard { mustache = F(beardW, 14, 2), type = F(beardW, 12, 2), color = F(beardW, 9, 3),
                                     scale = F(beardW, 5, 4), y = F(beardW, 0, 5) };
            c.glass = new MiiGlass { type = F(glassW, 12, 4), color = F(glassW, 9, 3), scale = F(glassW, 5, 4), y = F(glassW, 0, 5) };
            c.mole = new MiiMole { enabled = F(moleI, 15, 1) == 1, scale = F(moleI, 11, 4), x = F(moleI, 6, 5), y = F(moleI, 1, 5) };
            return c;
        }

        /// <summary>Cópia com olhos/sobrancelhas/boca trocados como em RFLiMakeTexture.</summary>
        public MiiCharInfo WithExpression(MiiExpression e, MiiParams p)
        {
            var c = Clone();
            switch (e)
            {
                case MiiExpression.Smile: c.SwapEyeType(48, p); break;
                case MiiExpression.Anger:
                    c.eyebrow.rotate = Math.Min(c.eyebrow.rotate + 2, 11);
                    c.eye.rotate = Math.Min(c.eye.rotate + 2, 7);
                    c.mouth.type = 10;
                    break;
                case MiiExpression.Sorrow:
                    c.eyebrow.rotate = Clamp(c.eyebrow.rotate - 2, 0, 11);
                    c.eye.rotate = Clamp(c.eye.rotate - 2, 0, 7);
                    c.mouth.type = 12;
                    break;
                case MiiExpression.Surprise:
                    c.eyebrow.y = (c.eyebrow.y - 2) & 0x1F;   // campo de 5 bits, como no original
                    c.SwapEyeType(49, p);
                    break;
                case MiiExpression.Blink: c.SwapEyeType(26, p); break;
                case MiiExpression.OpenMouth: c.mouth.type = 24; break;
            }
            return c;
        }

        // Troca o tipo do olho mantendo a inclinação final: rot += base[antigo] - base[novo], limitado a 0..7.
        private void SwapEyeType(int newType, MiiParams p)
        {
            eye.rotate = Clamp(p.eyeRotateOffset[eye.type] - p.eyeRotateOffset[newType] + eye.rotate, 0, 7);
            eye.type = newType;
        }

        private static int F(int v, int shift, int width) { return (v >> shift) & ((1 << width) - 1); }
        private static int U(uint v, int shift, int width) { return (int)((v >> shift) & (uint)((1 << width) - 1)); }
        private static int Clamp(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

        private static string Utf16(byte[] raw, int off)
        {
            var chars = new char[10];
            int n = 0;
            for (; n < 10; n++)
            {
                char ch = (char)((raw[off + 2 * n] << 8) | raw[off + 2 * n + 1]);
                if (ch == '\0') break;
                chars[n] = ch;
            }
            return new string(chars, 0, n);
        }
    }
}
