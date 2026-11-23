// Personagem de uma modalidade: corpo Mii (ava_body*, com as animações CHR0 do esporte via
// Nw4rAnimationPlayer), cabeça montada pelo MiiCharacterBuilder a partir do .rcd, e objetos presos às mãos
// (raquete, taco, luvas). Sem os prefabs importados, usa uma cápsula do tamanho do corpo.
using LinuxSports.Core;
using LinuxSports.Engine;
using LinuxSports.Entities;
using UnityEngine;

namespace LinuxSports.Activities
{
    public sealed class SportActor : MonoBehaviour
    {
        public PlayerSlot slot;
        public SportData sport;
        public Nw4rAnimationPlayer Animator { get; private set; }
        public MiiCharacterBuilder Mii { get; private set; }
        public Nw4rModelInfo Body { get; private set; }
        public string CurrentAnimation { get; private set; }
        public Color TeamColor = Color.white;

        public float moveSpeed = 40f;      // u/s (4 m/s)
        public float turnSpeed = 720f;     // graus/s

        public static SportActor Create(PlayerSlot slot, SportData sport, GameplayData data, Transform parent, Vector3 position, Vector3 forward)
        {
            var root = new GameObject("Actor_" + (slot != null ? slot.name : "cpu"));
            root.transform.SetParent(parent, false);
            root.transform.position = position;
            root.transform.rotation = Quaternion.LookRotation(Flat(forward), Vector3.up);
            var a = root.AddComponent<SportActor>();
            a.slot = slot;
            a.sport = sport;
            a.Build(data);
            return a;
        }

        private void Build(GameplayData data)
        {
            string bodyName = BodyFor(slot != null ? slot.info : null);
            string prefab = null;
            if (data != null) data.avatarBodies.TryGetValue(bodyName, out prefab);
            var body = ModelSpawner.Spawn(prefab, transform, PrimitiveType.Capsule, new Vector3(9f, 7f, 5f), TeamColor, "Body");
            ModelSpawner.StripColliders(body);
            if (prefab == null || body.GetComponent<Nw4rModelInfo>() == null) body.transform.localPosition = new Vector3(0f, 7f, 0f);
            Body = body.GetComponent<Nw4rModelInfo>();
            if (Body != null)
            {
                Animator = body.GetComponent<Nw4rAnimationPlayer>();
                if (Animator == null) Animator = body.AddComponent<Nw4rAnimationPlayer>();
                Animator.model = Body;
            }
            if (slot != null && slot.info != null)
            {
                Mii = gameObject.AddComponent<MiiCharacterBuilder>();
                Mii.buildOnStart = false;
                Mii.body = Body;
                Mii.profileId = slot.profileId;
                Mii.Build(slot.info);
                if (Body == null && Mii.Head != null) Mii.Head.localPosition = new Vector3(0f, 15f, 0f);
            }
            float h = slot != null && slot.ai != null ? slot.ai.reach : 1f;
            transform.localScale = new Vector3(1f, 0.92f + 0.16f * (h - 0.85f) / 0.3f, 1f);
        }

        /// <summary>Corpo pelo sexo e peso do Mii (A = masculino, B = feminino; 0..3 = magro..forte).</summary>
        public static string BodyFor(MiiCharInfo info)
        {
            if (info == null) return "ava_bodyA1";
            int k = Mathf.Clamp(info.build * 4 / 128, 0, 3);
            return (info.female ? "ava_bodyB" : "ava_bodyA") + k;
        }

        /// <summary>Toca uma animação CHR0 do esporte se ela existir nos dados exportados.</summary>
        public bool Play(string anim)
        {
            if (Animator == null || sport == null || !sport.HasAnimation(anim)) return false;
            if (CurrentAnimation == anim && Animator.IsPlaying) return true;
            CurrentAnimation = anim;
            return Animator.Play(anim);
        }

        public bool PlayFirst(params string[] anims)
        {
            foreach (var a in anims) if (Play(a)) return true;
            return false;
        }

        public bool AnimationDone => Animator == null || !Animator.IsPlaying;

        /// <summary>Prende um modelo ao osso (wrist_r, wrist_l, chest...) ou à raiz se o osso não existir.</summary>
        public GameObject Attach(string prefab, string bone, Vector3 localPos, Vector3 localEuler, PrimitiveType fallback, Vector3 fallbackScale, Color color)
        {
            Transform parent = transform;
            if (Body != null)
            {
                int bi = Body.BoneIndex(bone);
                if (bi >= 0) parent = Body.bones[bi].transform;
            }
            var go = ModelSpawner.Spawn(prefab, parent, fallback, fallbackScale, color, bone + "_prop");
            ModelSpawner.StripColliders(go);
            go.transform.localPosition = parent == transform ? localPos + new Vector3(4f, 7f, 0f) : localPos;
            go.transform.localRotation = Quaternion.Euler(localEuler);
            return go;
        }

        public Transform Bone(string bone)
        {
            if (Body == null) return null;
            int bi = Body.BoneIndex(bone);
            return bi >= 0 ? Body.bones[bi].transform : null;
        }

        /// <summary>Anda em direção ao alvo (no plano). Retorna true ao chegar.</summary>
        public bool MoveTowards(Vector3 target, float dt, float speedScale = 1f, string walkAnim = null, string idleAnim = null)
        {
            Vector3 p = transform.position;
            Vector3 d = target - p;
            d.y = 0f;
            float dist = d.magnitude;
            float step = moveSpeed * speedScale * dt;
            if (dist <= Mathf.Max(0.05f, step))
            {
                transform.position = new Vector3(target.x, p.y, target.z);
                if (idleAnim != null) Play(idleAnim);
                return true;
            }
            transform.position = p + d / dist * step;
            if (walkAnim != null) Play(walkAnim);
            return false;
        }

        public void Face(Vector3 direction, float dt = -1f)
        {
            var f = Flat(direction);
            var q = Quaternion.LookRotation(f, Vector3.up);
            transform.rotation = dt < 0f ? q : Quaternion.RotateTowards(transform.rotation, q, turnSpeed * dt);
        }

        public void SetExpression(MiiExpression e) { if (Mii != null) Mii.SetExpression(e); }

        private static Vector3 Flat(Vector3 v)
        {
            v.y = 0f;
            return v.sqrMagnitude < 1e-6f ? Vector3.forward : v.normalized;
        }
    }
}
