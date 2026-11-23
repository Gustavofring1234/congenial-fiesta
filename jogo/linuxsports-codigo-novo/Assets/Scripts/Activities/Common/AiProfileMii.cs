// AiProfile a partir do perfil Mii (.rcd decodificado por MiiCharInfo.FromRaw).
using LinuxSports.Entities;

namespace LinuxSports.Core
{
    public sealed partial class AiProfile
    {
        public static AiProfile FromMii(MiiCharInfo info, string profileId, float skill01)
        {
            float h = info != null ? info.height / 127f : 0.5f;
            float b = info != null ? info.build / 127f : 0.5f;
            int hash = StableHash((info != null ? info.name : "") + "|" + profileId);
            return Create(h, b, info != null && info.female, hash, skill01);
        }
    }
}
