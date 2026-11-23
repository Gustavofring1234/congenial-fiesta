// Configura um ParticleSystem nativo a partir de um emissor NW4R (.breff convertido por
// tools/export_effects.py para Resources/Effects/<pacote>/<pacote>.effect.json).
//
// Unidades: o NW4R trabalha em quadros (60 Hz) e unidades de mundo do jogo (as mesmas dos .glb).
//   vida (quadros) / 60 -> segundos;  velocidade (unidade/quadro) × 60 -> unidade/s;
//   gravidade de campo (unidade/quadro²) × 3600 -> unidade/s², convertida em gravityModifier.
// Velocidade inicial: radial -> startSpeed (para fora da forma); eixo Y e direção especificada ->
// velocityOverLifetime com decaimento pela resistência do ar do campo (v·k^quadros), que reproduz o
// impulso inicial seguido de frenagem do NW4R.
// Curvas de partícula: cor/alfa -> colorOverLifetime (até 8 chaves cada), escala -> sizeOverLifetime,
// rotação -> rotationOverLifetime. Mistura aditiva para brilhos/faíscas/rastros (categoria do emissor).
using System;
using System.Collections.Generic;
using LinuxSports.Core;
using UnityEngine;

namespace LinuxSports.Engine
{
    public static class Nw4rParticleFactory
    {
        public const float Fps = 60f;

        public static bool IsAdditive(string category)
        {
            return category == "spark" || category == "glow" || category == "trail";
        }

        /// <summary>Material padrão de execução (shader Nw4r/Particle em Resources/Shaders).</summary>
        public static Material RuntimeMaterial(Texture2D tex, bool additive)
        {
            var shader = Shader.Find("Nw4r/Particle");
            if (shader == null) shader = Shader.Find("Universal Render Pipeline/Particles/Unlit");
            var m = new Material(shader) { name = (tex != null ? tex.name : "nw4r_particle") + (additive ? "_add" : "_alpha") };
            SetupMaterial(m, tex, additive);
            return m;
        }

        public static void SetupMaterial(Material m, Texture2D tex, bool additive)
        {
            if (m.HasProperty("_MainTex")) m.SetTexture("_MainTex", tex);
            if (m.HasProperty("_BaseMap")) m.SetTexture("_BaseMap", tex);
            if (m.HasProperty("_SrcBlend")) m.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
            if (m.HasProperty("_DstBlend")) m.SetFloat("_DstBlend", additive ? (float)UnityEngine.Rendering.BlendMode.One : (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            m.renderQueue = 3000;
        }

        private static Color ToColor(int[] c) { return (Color)Nw4rCoordinates.Color(c); }

        /// <summary>Aplica o emissor `em` ao ParticleSystem. `material` é o material já com a textura.</summary>
        public static void Configure(ParticleSystem ps, object em, Material material)
        {
            var e = J.Obj(em, "emitter");
            var p = J.Obj(em, "particle");
            var curves = J.Arr(em, "curves") ?? new List<object>();
            string category = J.Str(em, "category", "other");

            int emitLife = J.Int(e, "emitLife");
            int ptclLife = Mathf.Max(1, J.Int(e, "particleLife", 30));
            int interval = Mathf.Max(0, J.Int(e, "emitInterval"));
            float emitCount = Mathf.Max(0f, J.F(e, "emitCount", 1f));
            bool infinite = emitLife >= 0xFFFF || emitLife == 0;
            float duration = infinite ? 5f : Mathf.Max(1, emitLife) / Fps;
            float lifeSec = ptclLife / Fps;
            float lifeRnd = Mathf.Clamp01(Mathf.Abs(J.F(e, "particleLifeRandomPct")) / 100f);

            float air = 1f, gravity = 0f;
            var colorKeys = new List<KeyValuePair<float, Color>>();
            var alphaKeys = new List<KeyValuePair<float, float>>();
            var scaleX = new List<Keyframe>();
            var scaleY = new List<Keyframe>();
            var rotZ = new List<Keyframe>();
            foreach (var co in curves)
            {
                string target = J.Str(co, "target");
                var keys = J.Arr(co, "keys");
                if (keys == null || keys.Count == 0) continue;
                float len = Mathf.Max(1f, J.Bool(co, "relativeToLife") ? Mathf.Max(J.F(co, "length"), 1f) : ptclLife);
                foreach (var k in keys)
                {
                    float t = Mathf.Clamp01(J.F(k, "frame") / len);
                    var v = J.Floats(k, "values");
                    if (v.Length == 0) continue;
                    switch (target)
                    {
                        case "color0": if (v.Length >= 3) colorKeys.Add(new KeyValuePair<float, Color>(t, new Color(v[0] / 255f, v[1] / 255f, v[2] / 255f))); break;
                        case "alpha0": alphaKeys.Add(new KeyValuePair<float, float>(t, v[0] / 255f)); break;
                        case "scale": scaleX.Add(new Keyframe(t, v[0])); scaleY.Add(new Keyframe(t, v.Length > 1 ? v[1] : v[0])); break;
                        case "rotate": rotZ.Add(new Keyframe(t, v[v.Length - 1])); break;
                        case "fieldAirResistance": air = Mathf.Clamp(v[0], 0f, 1.5f); break;
                        case "fieldGravity": gravity = v[0]; break;
                    }
                }
            }

            var main = ps.main;
            main.duration = duration;
            main.loop = infinite;
            main.playOnAwake = false;
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            main.scalingMode = ParticleSystemScalingMode.Hierarchy;
            main.startLifetime = lifeRnd > 0 ? new ParticleSystem.MinMaxCurve(lifeSec * (1 - lifeRnd), lifeSec) : new ParticleSystem.MinMaxCurve(lifeSec);
            var vel = J.Obj(e, "velocity");
            float radial = J.F(vel, "radial") + J.F(vel, "normal");
            float rnd = Mathf.Abs(J.F(vel, "random"));
            float velRnd = Mathf.Clamp01(Mathf.Abs(J.F(e, "velocityInitRandomPct")) / 100f);
            float speed = Mathf.Abs(radial) * Fps;
            main.startSpeed = velRnd > 0 ? new ParticleSystem.MinMaxCurve(speed * (1 - velRnd), speed) : new ParticleSystem.MinMaxCurve(speed);
            var size = J.Floats(p, "size");
            var pscale = J.Floats(p, "scale");
            float sx = (size.Length > 0 ? size[0] : 1f) * (pscale.Length > 0 ? pscale[0] : 1f);
            float sy = (size.Length > 1 ? size[1] : sx) * (pscale.Length > 1 ? pscale[1] : 1f);
            main.startSize3D = true;
            main.startSizeX = sx;
            main.startSizeY = sy;
            main.startSizeZ = 1f;
            Color c0 = ToColor(J.Ints(p, "color0Primary")), c1 = ToColor(J.Ints(p, "color0Secondary"));
            if (c1.a <= 0.001f && c1.r + c1.g + c1.b <= 0.001f) c1 = c0;
            main.startColor = c0 == c1 ? new ParticleSystem.MinMaxGradient(c0) : new ParticleSystem.MinMaxGradient(c0, new Color(c1.r, c1.g, c1.b, c0.a));
            var prot = J.Floats(p, "rotate");
            if (prot.Length >= 3) main.startRotation = prot[2] * Mathf.Deg2Rad;
            main.gravityModifier = Mathf.Abs(Physics.gravity.y) > 1e-4f ? gravity * Fps * Fps / Mathf.Abs(Physics.gravity.y) : 0f;
            main.maxParticles = Mathf.Clamp(Mathf.CeilToInt(emitCount * (infinite ? 1f : Mathf.Max(1f, emitLife / (float)(interval + 1))) * Mathf.Max(1f, ptclLife / (float)(interval + 1))) + 8, 8, 4000);

            var emission = ps.emission;
            emission.enabled = true;
            if (!infinite && emitLife <= interval + 1)
            {
                emission.rateOverTime = 0f;
                emission.SetBursts(new[] { new ParticleSystem.Burst(0f, (short)Mathf.Clamp(Mathf.RoundToInt(emitCount), 1, short.MaxValue)) });
            }
            else
            {
                emission.SetBursts(new ParticleSystem.Burst[0]);
                emission.rateOverTime = emitCount * Fps / (interval + 1);
            }

            var shape = ps.shape;
            shape.enabled = true;
            var escale = J.Floats(e, "scale");
            var erot = J.Floats(e, "rotate");
            var etr = J.Floats(e, "translate");
            float r = Mathf.Max(0.0001f, escale.Length > 0 ? Mathf.Max(Mathf.Abs(escale[0]), Mathf.Abs(escale.Length > 2 ? escale[2] : escale[0])) : 1f);
            switch (J.Str(e, "form", "point"))
            {
                case "disc": shape.shapeType = ParticleSystemShapeType.Circle; shape.radius = r; shape.rotation = new Vector3(90, 0, 0); break;
                case "line": shape.shapeType = ParticleSystemShapeType.SingleSidedEdge; shape.radius = r; break;
                case "cube": shape.shapeType = ParticleSystemShapeType.Box; shape.scale = escale.Length >= 3 ? new Vector3(escale[0], escale[1], escale[2]) : Vector3.one; break;
                case "cylinder": shape.shapeType = ParticleSystemShapeType.Cone; shape.angle = 0f; shape.radius = r; break;
                case "sphere": shape.shapeType = ParticleSystemShapeType.Sphere; shape.radius = r; break;
                case "torus": shape.shapeType = ParticleSystemShapeType.Donut; shape.radius = r; shape.donutRadius = r * 0.25f; break;
                default: shape.shapeType = ParticleSystemShapeType.Sphere; shape.radius = 0.0001f; break;
            }
            shape.randomDirectionAmount = (rnd + Mathf.Abs(radial)) > 1e-5f ? Mathf.Clamp01(rnd / (rnd + Mathf.Abs(radial))) : 0f;
            if (etr.Length >= 3) shape.position = Nw4rCoordinates.Position(etr[0], etr[1], etr[2]);
            if (erot.Length >= 3) shape.rotation += Nw4rCoordinates.Rotation(erot[0] * Mathf.Rad2Deg, erot[1] * Mathf.Rad2Deg, erot[2] * Mathf.Rad2Deg).eulerAngles;

            // impulso direcional inicial com frenagem (resistência do ar)
            Vector3 dirWii = new Vector3(0f, J.F(vel, "yAxis"), 0f);
            float spec = J.F(vel, "specified");
            var specDir = J.Floats(vel, "specifiedDirection");
            if (Mathf.Abs(spec) > 1e-6f && specDir.Length >= 3)
            {
                // a direção especificada vem como ângulos (rad) de um vetor +Y
                Quaternion q = Quaternion.Euler(specDir[0] * Mathf.Rad2Deg, specDir[1] * Mathf.Rad2Deg, specDir[2] * Mathf.Rad2Deg);
                dirWii += q * Vector3.up * spec;
            }
            var vol = ps.velocityOverLifetime;
            if (dirWii.sqrMagnitude > 1e-10f)
            {
                Vector3 v0 = Nw4rCoordinates.Position(dirWii) * Fps;
                var decay = new AnimationCurve();
                for (int k = 0; k <= 8; k++)
                {
                    float t = k / 8f;
                    decay.AddKey(t, Mathf.Pow(Mathf.Max(air, 1e-4f), t * ptclLife));
                }
                vol.enabled = true;
                vol.space = ParticleSystemSimulationSpace.Local;
                vol.x = new ParticleSystem.MinMaxCurve(v0.x, decay);
                vol.y = new ParticleSystem.MinMaxCurve(v0.y, decay);
                vol.z = new ParticleSystem.MinMaxCurve(v0.z, decay);
            }
            else vol.enabled = false;
            var limit = ps.limitVelocityOverLifetime;
            limit.enabled = air < 0.999f && speed > 0f;
            if (limit.enabled)
            {
                limit.limit = new ParticleSystem.MinMaxCurve(speed * 4f);
                limit.drag = new ParticleSystem.MinMaxCurve((1f - air) * Fps);
                limit.multiplyDragByParticleSize = false;
            }

            var col = ps.colorOverLifetime;
            if (colorKeys.Count > 0 || alphaKeys.Count > 0)
            {
                col.enabled = true;
                var g = new Gradient();
                g.SetKeys(BuildColorKeys(colorKeys), BuildAlphaKeys(alphaKeys));
                col.color = new ParticleSystem.MinMaxGradient(g);
            }
            else col.enabled = false;

            var sol = ps.sizeOverLifetime;
            if (scaleX.Count > 0)
            {
                sol.enabled = true;
                sol.separateAxes = true;
                float mx = 1e-4f;
                foreach (var k in scaleX) mx = Mathf.Max(mx, Mathf.Abs(k.value));
                foreach (var k in scaleY) mx = Mathf.Max(mx, Mathf.Abs(k.value));
                sol.x = new ParticleSystem.MinMaxCurve(mx, Normalize(scaleX, mx));
                sol.y = new ParticleSystem.MinMaxCurve(mx, Normalize(scaleY, mx));
                sol.z = new ParticleSystem.MinMaxCurve(1f);
            }
            else sol.enabled = false;

            var rol = ps.rotationOverLifetime;
            if (rotZ.Count >= 2)
            {
                rotZ.Sort((a, b) => a.time.CompareTo(b.time));
                float dv = rotZ[rotZ.Count - 1].value - rotZ[0].value;
                float dt = Mathf.Max(1e-3f, (rotZ[rotZ.Count - 1].time - rotZ[0].time) * lifeSec);
                rol.enabled = true;
                rol.z = new ParticleSystem.MinMaxCurve(dv * Mathf.Deg2Rad / dt);
            }
            else rol.enabled = false;

            var ren = ps.GetComponent<ParticleSystemRenderer>();
            if (ren != null)
            {
                ren.sharedMaterial = material;
                ren.renderMode = category == "trail" ? ParticleSystemRenderMode.Stretch : ParticleSystemRenderMode.Billboard;
                if (category == "trail") { ren.lengthScale = 2f; ren.velocityScale = 0.02f; }
                ren.alignment = ParticleSystemRenderSpace.View;
            }
        }

        private static AnimationCurve Normalize(List<Keyframe> keys, float max)
        {
            var c = new AnimationCurve();
            keys.Sort((a, b) => a.time.CompareTo(b.time));
            foreach (var k in keys) c.AddKey(k.time, k.value / max);
            if (c.length == 1) c.AddKey(1f, c.keys[0].value);
            return c;
        }

        private static GradientColorKey[] BuildColorKeys(List<KeyValuePair<float, Color>> keys)
        {
            if (keys.Count == 0) return new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) };
            keys.Sort((a, b) => a.Key.CompareTo(b.Key));
            var r = new List<GradientColorKey>();
            int step = Mathf.Max(1, Mathf.CeilToInt(keys.Count / 8f));
            for (int i = 0; i < keys.Count && r.Count < 8; i += step) r.Add(new GradientColorKey(keys[i].Value, keys[i].Key));
            return r.ToArray();
        }

        private static GradientAlphaKey[] BuildAlphaKeys(List<KeyValuePair<float, float>> keys)
        {
            if (keys.Count == 0) return new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, 1f) };
            keys.Sort((a, b) => a.Key.CompareTo(b.Key));
            var r = new List<GradientAlphaKey>();
            int step = Mathf.Max(1, Mathf.CeilToInt(keys.Count / 8f));
            for (int i = 0; i < keys.Count && r.Count < 8; i += step) r.Add(new GradientAlphaKey(keys[i].Value, keys[i].Key));
            return r.ToArray();
        }
    }

}
