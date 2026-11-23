// Importação das texturas do RFL (Assets/Resources/Mii/Textures, geradas por tools/export_mii.py).
// Os canais são máscaras do TEV (olho: R contorno, G branco, B íris; boca: R, G, B; maquiagem: G = alfa),
// por isso: sem sRGB (valores crus do GX), sem compressão (ASTC/DXT misturariam canais) e sem mipmaps
// (o RFL não usa). O wrap de cada textura é aplicado em tempo de execução a partir de textures.json.
using UnityEditor;

namespace LinuxSports.EditorTools
{
    public sealed class MiiTexturePostprocessor : AssetPostprocessor
    {
        public const string Folder = "Assets/Resources/Mii/Textures/";

        private void OnPreprocessTexture()
        {
            if (!assetPath.Replace('\\', '/').StartsWith(Folder)) return;
            var ti = (TextureImporter)assetImporter;
            ti.textureType = TextureImporterType.Default;
            ti.sRGBTexture = false;
            ti.alphaSource = TextureImporterAlphaSource.FromInput;
            ti.alphaIsTransparency = false;
            ti.mipmapEnabled = false;
            ti.npotScale = TextureImporterNPOTScale.None;
            ti.textureCompression = TextureImporterCompression.Uncompressed;
            ti.isReadable = false;
            var web = ti.GetPlatformTextureSettings("WebGL");
            web.overridden = true;
            web.format = TextureImporterFormat.RGBA32;
            ti.SetPlatformTextureSettings(web);
        }
    }
}
