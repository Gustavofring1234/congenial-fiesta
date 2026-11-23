// Material dos modelos NW4R no URP: textura (camada 0) × cor de vértice × _BaseColor, luz principal
// Lambert + ambiente (SH/RenderSettings) + _AmbientColor (CLR0 amb0). Com _UseTevLerp = 1 a base vira
// lerp(_TevColor0, _TevColor1, textura) (animações CLR0 de tev0/tev1). _BaseMapRotation gira o UV
// (SRT0) em torno do centro. Modos: opaco, recorte (_AlphaClip) e translúcido (_Surface = 1).
// _UseLightTexture = 1 (materiais com camadas lm_0/lm_1, os avatares): em vez da luz do URP usa as
// EGG::LightTexture globais _Nw4rLightTex0/1 (Nw4rEnvironment) por mapeamento esférico da normal em
// espaço de câmera: cor = base × lm_0 + lm_1 (difusa × base + especular/contraluz). Sem Nw4rEnvironment
// na cena (_Nw4rLightTexReady = 0) cai na luz normal.
Shader "Nw4r/Lit"
{
    Properties
    {
        _BaseMap ("Base Map", 2D) = "white" {}
        _BaseColor ("Base Color", Color) = (1,1,1,1)
        _BaseMapRotation ("UV Rotation (deg)", Float) = 0
        _AmbientColor ("Ambient (CLR0)", Color) = (0,0,0,0)
        _TevColor0 ("TEV Color 0", Color) = (0,0,0,1)
        _TevColor1 ("TEV Color 1", Color) = (1,1,1,1)
        _TevColor2 ("TEV Color 2", Color) = (1,1,1,1)
        _KonstColor0 ("Konst Color 0", Color) = (1,1,1,1)
        _UseTevLerp ("Use TEV lerp", Float) = 0
        _UseVertexColor ("Use Vertex Color", Float) = 1
        _Unlit ("Unlit", Float) = 0
        _UseLightTexture ("Use EGG LightTexture (lm_0/lm_1)", Float) = 0
        _Cutoff ("Alpha Cutoff", Range(0,1)) = 0.5
        [Toggle(_ALPHATEST_ON)] _AlphaClip ("Alpha Clip", Float) = 0
        _Surface ("Surface (0 opaque, 1 transparent)", Float) = 0
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src Blend", Float) = 1
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst Blend", Float) = 0
        [Enum(UnityEngine.Rendering.CullMode)] _Cull ("Cull", Float) = 2
        _ZWrite ("ZWrite", Float) = 1
    }
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "RenderType"="Opaque" "Queue"="Geometry" }
        LOD 100

        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode"="UniversalForward" }
            Blend [_SrcBlend] [_DstBlend]
            ZWrite [_ZWrite]
            Cull [_Cull]

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma shader_feature_local _ALPHATEST_ON
            #pragma multi_compile_fog
            #pragma multi_compile_instancing
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);
            TEXTURE2D(_Nw4rLightTex0); SAMPLER(sampler_Nw4rLightTex0);
            TEXTURE2D(_Nw4rLightTex1);
            float _Nw4rLightTexReady;
            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                half4 _BaseColor;
                float _BaseMapRotation;
                half4 _AmbientColor;
                half4 _TevColor0, _TevColor1, _TevColor2, _KonstColor0;
                float _UseTevLerp, _UseVertexColor, _Unlit, _Cutoff, _Surface, _UseLightTexture;
            CBUFFER_END

            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; float4 color : COLOR; float2 uv : TEXCOORD0; UNITY_VERTEX_INPUT_INSTANCE_ID };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; half4 color : COLOR; float3 normalWS : TEXCOORD1; float fog : TEXCOORD2; UNITY_VERTEX_INPUT_INSTANCE_ID };

            Varyings vert (Attributes v)
            {
                Varyings o;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_TRANSFER_INSTANCE_ID(v, o);
                VertexPositionInputs p = GetVertexPositionInputs(v.positionOS.xyz);
                o.positionCS = p.positionCS;
                o.normalWS = TransformObjectToWorldNormal(v.normalOS);
                float r = radians(_BaseMapRotation);
                float2 c = v.uv - 0.5;
                float2 uv = float2(c.x * cos(r) - c.y * sin(r), c.x * sin(r) + c.y * cos(r)) + 0.5;
                o.uv = uv * _BaseMap_ST.xy + _BaseMap_ST.zw;
                o.color = _UseVertexColor > 0.5 ? v.color : half4(1,1,1,1);
                o.fog = ComputeFogFactor(p.positionCS.z);
                return o;
            }

            half4 frag (Varyings i) : SV_Target
            {
                half4 tex = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, i.uv);
                half4 baseCol = _UseTevLerp > 0.5 ? lerp(_TevColor0, _TevColor1, tex) : tex * _BaseColor;
                half4 col = baseCol * i.color;
                #ifdef _ALPHATEST_ON
                clip(col.a - _Cutoff);
                #endif
                if (_Unlit < 0.5 && _UseLightTexture * _Nw4rLightTexReady > 0.5)
                {
                    float3 nV = normalize(mul((float3x3)UNITY_MATRIX_V, normalize(i.normalWS)));
                    float2 luv = nV.xy * 0.5 + 0.5;
                    half3 lm0 = SAMPLE_TEXTURE2D(_Nw4rLightTex0, sampler_Nw4rLightTex0, luv).rgb;
                    half3 lm1 = SAMPLE_TEXTURE2D(_Nw4rLightTex1, sampler_Nw4rLightTex0, luv).rgb;
                    col.rgb = col.rgb * (lm0 + _AmbientColor.rgb) + lm1;
                }
                else if (_Unlit < 0.5)
                {
                    Light l = GetMainLight();
                    half3 n = normalize(i.normalWS);
                    half ndl = saturate(dot(n, l.direction));
                    half3 ambient = SampleSH(n) + _AmbientColor.rgb;
                    col.rgb *= ambient + l.color * ndl;
                }
                col.rgb = MixFog(col.rgb, i.fog);
                if (_Surface < 0.5) col.a = 1;
                return col;
            }
            ENDHLSL
        }

        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode"="ShadowCaster" }
            ZWrite On
            ColorMask 0
            Cull [_Cull]
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            struct Attributes { float4 positionOS : POSITION; };
            struct Varyings { float4 positionCS : SV_POSITION; };
            Varyings vert (Attributes v) { Varyings o; o.positionCS = TransformObjectToHClip(v.positionOS.xyz); return o; }
            half4 frag (Varyings i) : SV_Target { return 0; }
            ENDHLSL
        }

        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode"="DepthOnly" }
            ZWrite On
            ColorMask 0
            Cull [_Cull]
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            struct Attributes { float4 positionOS : POSITION; };
            struct Varyings { float4 positionCS : SV_POSITION; };
            Varyings vert (Attributes v) { Varyings o; o.positionCS = TransformObjectToHClip(v.positionOS.xyz); return o; }
            half4 frag (Varyings i) : SV_Target { return 0; }
            ENDHLSL
        }
    }
    FallBack "Hidden/Universal Render Pipeline/FallbackError"
}
