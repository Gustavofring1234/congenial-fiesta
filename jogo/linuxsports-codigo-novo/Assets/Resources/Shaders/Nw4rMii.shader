// Peças 3D da cabeça Mii no URP, com os estágios TEV de RFLDrawOpaCore / RFLDrawXluCore (K = _KColor):
//   _Mode 0 sólido     cor = K                          (nariz, testa, rosto sem textura, cabelo, barba)
//   _Mode 1 boné       cor = (K + K·tex) / 2            (cor favorita)
//   _Mode 2 rosto      cor = lerp(K, tex.rab, tex.g)    (maquiagem/rugas; swap table base+1 = R,A,B,G)
//   _Mode 3 máscara    cor = tex.rgb, alfa = tex.a      (textura composta por MiiFaceTexture)
//   _Mode 4 linha nariz cor = 0, alfa = tex.a
//   _Mode 5 óculos     cor = K·tex.rgb, alfa = tex.a
// Depois o RFL multiplica pela cor da luz (canal 0 do GX: ambiente + difusa). Aqui: luz principal Lambert +
// SH. As contas TEV usam valores crus do GX (texturas sem sRGB, K por SetVector) e o resultado é levado
// ao espaço linear no fim quando o projeto não está em Gamma.
Shader "Nw4r/Mii"
{
    Properties
    {
        _MainTex ("Texture", 2D) = "white" {}
        _KColor ("Konst Color (GX)", Vector) = (1,1,1,1)
        _Mode ("Mode", Float) = 0
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src Blend", Float) = 1
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst Blend", Float) = 0
        [Enum(UnityEngine.Rendering.CullMode)] _Cull ("Cull", Float) = 2
        _ZWrite ("ZWrite", Float) = 1
    }
    SubShader
    {
        Tags { "RenderPipeline"="UniversalPipeline" "RenderType"="Opaque" "Queue"="Geometry" }

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
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float4 _KColor;
                float _Mode;
            CBUFFER_END

            struct Attributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; float2 uv : TEXCOORD0; };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; float3 normalWS : TEXCOORD1; float fog : TEXCOORD2; };

            Varyings vert (Attributes v)
            {
                Varyings o;
                VertexPositionInputs p = GetVertexPositionInputs(v.positionOS.xyz);
                o.positionCS = p.positionCS;
                o.normalWS = TransformObjectToWorldNormal(v.normalOS);
                o.uv = v.uv;
                o.fog = ComputeFogFactor(p.positionCS.z);
                return o;
            }

            half4 frag (Varyings i) : SV_Target
            {
                float4 t = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv);
                float3 k = _KColor.rgb;
                float4 c = float4(k, 1);
                if (_Mode > 4.5)      c = float4(k * t.rgb, t.a);
                else if (_Mode > 3.5) c = float4(0, 0, 0, t.a);
                else if (_Mode > 2.5) c = t;
                else if (_Mode > 1.5) c = float4(lerp(k, t.rab, t.g), 1);
                else if (_Mode > 0.5) c = float4((k + k * t.rgb) * 0.5, 1);
                clip(c.a - 0.5 / 255.0);   // GX: alpha compare GREATER 0
                #if !defined(UNITY_COLORSPACE_GAMMA)
                c.rgb = SRGBToLinear(c.rgb);
                #endif
                Light l = GetMainLight();
                half3 n = normalize(i.normalWS);
                c.rgb *= SampleSH(n) + l.color * saturate(dot(n, l.direction));
                c.rgb = MixFog(c.rgb, i.fog);
                return half4(c);
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
