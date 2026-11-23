// Metadados de um modelo NW4R montado pelo Editor (Assets/Editor/Nw4rModelPostprocessor.cs).
// Guarda o que o player de animação precisa sem reler o .brres: ossos e pose de repouso (no
// referencial do Wii, igual às trilhas CHR0), material NW4R -> (renderer, índice), malha -> osso
// (para VIS0) e as texturas de troca do PAT0.
using System;
using System.Collections.Generic;
using UnityEngine;

namespace LinuxSports.Engine
{
    [Serializable]
    public sealed class Nw4rBoneInfo
    {
        public string name;
        public Transform transform;
        public int parent = -1;
        public Vector3 bindScale = Vector3.one;    // Wii
        public Vector3 bindRotation;               // Wii, graus XYZ
        public Vector3 bindTranslation;            // Wii
    }

    [Serializable]
    public sealed class Nw4rMaterialBinding
    {
        public string material;
        public Renderer renderer;
        public int index;
    }

    [Serializable]
    public sealed class Nw4rMeshBinding
    {
        public string mesh;
        public Renderer renderer;
        public int bone = -1;
        public string binding;   // static | rigid | skinned
    }

    [Serializable]
    public sealed class Nw4rNamedTexture
    {
        public string name;
        public Texture2D texture;
    }

    [DisallowMultipleComponent]
    public sealed class Nw4rModelInfo : MonoBehaviour
    {
        public string assetId;
        public string modelName;
        public string brres;
        public List<Nw4rBoneInfo> bones = new List<Nw4rBoneInfo>();
        public List<Nw4rMaterialBinding> materials = new List<Nw4rMaterialBinding>();
        public List<Nw4rMeshBinding> meshes = new List<Nw4rMeshBinding>();
        public List<Nw4rNamedTexture> patternTextures = new List<Nw4rNamedTexture>();

        private Dictionary<string, int> boneIndex;
        private Dictionary<string, List<Nw4rMaterialBinding>> matIndex;
        private Dictionary<string, Texture2D> texIndex;

        public int BoneIndex(string name)
        {
            if (boneIndex == null)
            {
                boneIndex = new Dictionary<string, int>();
                for (int i = 0; i < bones.Count; i++) if (!boneIndex.ContainsKey(bones[i].name)) boneIndex[bones[i].name] = i;
            }
            int k;
            return boneIndex.TryGetValue(name, out k) ? k : -1;
        }

        public List<Nw4rMaterialBinding> MaterialBindings(string material)
        {
            if (matIndex == null)
            {
                matIndex = new Dictionary<string, List<Nw4rMaterialBinding>>();
                foreach (var m in materials)
                {
                    List<Nw4rMaterialBinding> l;
                    if (!matIndex.TryGetValue(m.material, out l)) matIndex[m.material] = l = new List<Nw4rMaterialBinding>();
                    l.Add(m);
                }
            }
            List<Nw4rMaterialBinding> r;
            return matIndex.TryGetValue(material, out r) ? r : null;
        }

        public Texture2D PatternTexture(string name)
        {
            if (name == null) return null;
            if (texIndex == null)
            {
                texIndex = new Dictionary<string, Texture2D>();
                foreach (var t in patternTextures) if (t.texture != null) texIndex[t.name] = t.texture;
            }
            Texture2D tex;
            return texIndex.TryGetValue(name, out tex) ? tex : null;
        }

        /// <summary>Renderers cujas malhas seguem o osso (alvo do VIS0).</summary>
        public IEnumerable<Renderer> RenderersOfBone(int bone)
        {
            foreach (var m in meshes) if (m.bone == bone && m.renderer != null) yield return m.renderer;
        }

        /// <summary>Volta todos os ossos para a pose de repouso.</summary>
        public void ResetPose()
        {
            foreach (var b in bones)
            {
                if (b.transform == null) continue;
                b.transform.localScale = b.bindScale;
                b.transform.localRotation = Core.Nw4rCoordinates.Rotation(b.bindRotation.x, b.bindRotation.y, b.bindRotation.z);
                b.transform.localPosition = Core.Nw4rCoordinates.Position(b.bindTranslation);
            }
        }
    }
}
