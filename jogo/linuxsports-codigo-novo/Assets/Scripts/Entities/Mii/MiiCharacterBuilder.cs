// Montador paramétrico da cabeça Mii (RFL "Kokeshi") em tempo de execução, compatível com WebGL.
//
// Peças e transformações (RFLiInitCharModelRes @ 0x8016dd80, desmontado do main.dol):
//   Faceline/Mask: tipo do rosto, sem transformação. O Faceline traz 3 âncoras: nariz, barba, cabelo.
//   Cap/Hair/Forehead: tipo do cabelo, em âncora "cabelo", escala 1, espelho X se o cabelo for invertido.
//   Beard: tipo da barba, âncora "barba", escala 1.
//   Nose/Noseline: tipo do nariz, escala 0,4 + 0,175·escala, em (nariz.x, nariz.y − 1,5·(y − 8), nariz.z).
//   Glass: forma 0, escala 0,4 + 0,15·escala, em (nariz.x, nariz.y + 5 − 1,5·(y − 11), nariz.z + 2).
// Texturas de forma (RFLiInitTexRes): rosto = maquiagem[faceline.texture], boné = cap[cabelo],
// linha do nariz = noseline[nariz], óculos = glass[glass.type]. Cores: tabelas de MiiParams.
// Ordem: opacos (barba, nariz, testa, cabelo, boné, rosto), depois translúcidos (máscara, linha do nariz, óculos).
//
// No jogo a cabeça é desenhada com a matriz do osso "head_set" do corpo (RFLSetCoordinate(+X para cima,
// +Y para a frente) em CreateNigaoeModel), então ela acompanha as animações CHR0 do corpo. Aqui a cabeça
// vira filha desse osso, com a rotação que alinha os eixos do RFL aos do corpo na pose de repouso.
//
// headScale: o tamanho final da cabeça vem de uma escala aplicada fora do RFL (RPGrpModel), que não foi
// localizada no código descompilado; 0,125 deixa o rosto (~54 unidades RFL) com ~2 larguras do corpo ava_body.
using System.Collections.Generic;
using LinuxSports.Engine;
using UnityEngine;

namespace LinuxSports.Entities
{
    [DisallowMultipleComponent]
    public sealed class MiiCharacterBuilder : MonoBehaviour
    {
        [Tooltip("Perfil de Resources/Mii/Profiles (ex.: cpu_mii_000). Ignorado se rawData estiver definido.")]
        public string profileId = "cpu_mii_000";
        [Tooltip("RFLCharData de 74 bytes (.rcd/.mii importado como bytes), opcional.")]
        public TextAsset rawData;
        [Tooltip("Corpo (prefab ava_body*) que recebe a cabeça no osso headJoint. Opcional.")]
        public Nw4rModelInfo body;
        public string headJoint = "head_set";
        public float headScale = 0.125f;
        [Tooltip("Lado da textura do rosto (o RFL usa 64, 128 ou 256).")]
        public int faceTextureResolution = 256;
        public MiiExpression expression = MiiExpression.Normal;
        public bool buildOnStart = true;

        public MiiCharInfo Info { get; private set; }
        public Transform Head { get; private set; }

        private readonly List<Object> owned = new List<Object>();
        private readonly Dictionary<MiiExpression, RenderTexture> faces = new Dictionary<MiiExpression, RenderTexture>();
        private Material maskMaterial;

        private static readonly int TexId = Shader.PropertyToID("_MainTex");
        private static readonly int KColorId = Shader.PropertyToID("_KColor");
        private static readonly int ModeId = Shader.PropertyToID("_Mode");

        private void Start()
        {
            if (buildOnStart) Build();
        }

        private void OnDestroy() { Clear(); }

        public void Build()
        {
            Build(rawData != null ? MiiCharInfo.FromRaw(rawData.bytes) : MiiResources.LoadProfile(profileId));
        }

        public void Build(MiiCharInfo info)
        {
            Clear();
            Info = info;
            var p = MiiResources.Params;

            Head = new GameObject("MiiHead").transform;
            AttachHead();

            var face = MiiResources.Shape(MiiShapePart.Faceline, info.faceline.type);
            if (face == null) { Debug.LogError("Faceline " + info.faceline.type + " ausente"); return; }
            Vector4 skin = MiiParams.Raw(p.facelineColor[Index(info.faceline.color, p.facelineColor.Length)]);
            Vector4 hairColor = MiiParams.Raw(p.hairColor[info.hair.color]);
            Vector3 noseAt = face.noseAnchor;
            float noseScale = 0.4f + 0.175f * info.nose.scale;
            var noseTrans = new Vector3(noseAt.x, noseAt.y - 1.5f * (info.nose.y - 8), noseAt.z);

            // opacos
            Part(MiiShapePart.Beard, info.beard.type, true, 1f, face.beardAnchor, false, 0, MiiParams.Raw(p.beardColor[info.beard.color]), null, 2000);
            Part(MiiShapePart.Nose, info.nose.type, true, noseScale, noseTrans, false, 0, skin, null, 2000);
            Part(MiiShapePart.Forehead, info.hair.type, true, 1f, face.hairAnchor, info.hair.flip, 0, skin, null, 2000);
            Part(MiiShapePart.Hair, info.hair.type, true, 1f, face.hairAnchor, info.hair.flip, 0, hairColor, null, 2000);
            Part(MiiShapePart.Cap, info.hair.type, true, 1f, face.hairAnchor, info.hair.flip, 1,
                 MiiParams.Raw(p.favoriteColor[info.favoriteColor]), MiiResources.Texture("cap_shape", info.hair.type), 2000);
            Part(MiiShapePart.Faceline, info.faceline.type, false, 1f, Vector3.zero, false, 2, skin,
                 MiiResources.Texture("faceline_shape", info.faceline.texture), 2000);
            // translúcidos, na ordem do RFLDrawXluCore
            var mask = Part(MiiShapePart.Mask, info.faceline.type, false, 1f, Vector3.zero, false, 3, Vector4.one, null, 3000);
            if (mask != null) maskMaterial = mask.sharedMaterial;
            Part(MiiShapePart.Noseline, info.nose.type, true, noseScale, noseTrans, false, 4, Vector4.zero,
                 MiiResources.Texture("noseline_shape", info.nose.type), 3001);
            if (info.glass.type != 0)
            {
                var glassTrans = new Vector3(noseAt.x, noseAt.y + 5f - 1.5f * (info.glass.y - 11), noseAt.z + 2f);
                var g = Part(MiiShapePart.Glass, 0, true, 0.4f + 0.15f * info.glass.scale, glassTrans, false, 5,
                             MiiParams.Raw(p.glassColor[info.glass.color]), MiiResources.Texture("glass_shape", info.glass.type), 3002);
                if (g != null) g.sharedMaterial.SetFloat("_Cull", 0f);
            }
            SetExpression(expression);
        }

        /// <summary>Troca a expressão (textura do rosto gerada uma vez por expressão e guardada).</summary>
        public void SetExpression(MiiExpression e)
        {
            expression = e;
            if (Info == null || maskMaterial == null) return;
            RenderTexture rt;
            if (!faces.TryGetValue(e, out rt) || rt == null || !rt.IsCreated())
            {
                rt = MiiFaceTexture.Render(Info.WithExpression(e, MiiResources.Params), faceTextureResolution, rt);
                faces[e] = rt;
            }
            maskMaterial.SetTexture(TexId, rt);
        }

        /// <summary>
        /// Cor favorita (tabela 0x80380fe8). No jogo ela vai para TEV0 do material mt_main do corpo e das mãos
        /// (RPSysKokeshiManager::SetMatColor), junto com a textura do corpo trocada por código de cada esporte.
        /// </summary>
        public Color32 FavoriteColor { get { return Info == null ? new Color32(255, 255, 255, 255) : MiiResources.Params.favoriteColor[Info.favoriteColor]; } }

        private MeshRenderer Part(MiiShapePart part, int index, bool transform, float scale, Vector3 trans, bool flip,
                                  int mode, Vector4 k, Texture2D tex, int queue)
        {
            var shape = MiiResources.Shape(part, index);
            if (shape == null) return null;
            var mesh = MiiResources.BuildMesh(shape, "Mii_" + part + "_" + index, transform, scale, trans, flip);
            owned.Add(mesh);
            var go = new GameObject(part.ToString());
            go.transform.SetParent(Head, false);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var r = go.AddComponent<MeshRenderer>();
            var shader = Shader.Find("Nw4r/Mii");
            if (shader == null) throw new MissingReferenceException("shader Nw4r/Mii ausente (Resources/Shaders)");
            var m = new Material(shader) { name = "Mii_" + part, renderQueue = queue };
            owned.Add(m);
            m.SetVector(KColorId, k);
            m.SetFloat(ModeId, mode);
            if (tex != null) m.SetTexture(TexId, tex);
            if (queue >= 3000)
            {
                m.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
                m.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
                m.SetFloat("_ZWrite", 0f);
                m.SetOverrideTag("RenderType", "Transparent");
                m.SetShaderPassEnabled("ShadowCaster", false);
            }
            r.sharedMaterial = m;
            return r;
        }

        private void AttachHead()
        {
            Transform joint = null;
            if (body != null)
            {
                int bi = body.BoneIndex(headJoint);
                if (bi >= 0) joint = body.bones[bi].transform;
                else Debug.LogWarning("osso " + headJoint + " não existe em " + body.modelName);
            }
            if (joint == null)
            {
                Head.SetParent(transform, false);
                Head.localScale = Vector3.one * headScale;
                return;
            }
            // Na pose de repouso o RFL fica alinhado aos eixos do corpo; guarda essa rotação relativa ao osso.
            body.ResetPose();
            Head.SetParent(joint, false);
            Head.localPosition = Vector3.zero;
            Head.rotation = body.transform.rotation;
            Head.localScale = Vector3.one * (headScale * body.transform.lossyScale.x / Safe(joint.lossyScale.x));
        }

        private void Clear()
        {
            foreach (var rt in faces.Values) if (rt != null) { rt.Release(); Destroy(rt); }
            faces.Clear();
            foreach (var o in owned) if (o != null) Destroy(o);
            owned.Clear();
            if (Head != null) Destroy(Head.gameObject);
            Head = null;
            maskMaterial = null;
        }

        private static int Index(int v, int n) { return v < n ? v : 0; }   // RFLiGetFacelineColor: fora da tabela -> 0
        private static float Safe(float v) { return Mathf.Abs(v) < 1e-6f ? 1f : v; }
    }
}
