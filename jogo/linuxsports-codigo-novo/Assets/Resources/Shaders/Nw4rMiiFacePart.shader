// Peças 2D da textura do rosto Mii (RFLiCapture + RFLiSetTev4Eye/RFLiSetTev4Mouth). Valores crus do GX
// (sem conversão de espaço de cor): texturas importadas sem sRGB e cores passadas com SetVector.
//   _Mode 0: cor sólida _Color0, alfa = textura.a (sobrancelha, bigode, pinta; I4 com alfa = intensidade)
//   _Mode 1: olho  = _Color0·R + _Color1·B + G (contorno, íris, branco)
//   _Mode 2: boca  = _Color0·R + _Color1·G + B
// Mistura de frente para trás como o GX (src·(1−dstA) + dst·dstA); alfa = srcA·(1−dstA) + dstA.
Shader "Nw4r/MiiFacePart"
{
    Properties
    {
        _MainTex ("Texture", 2D) = "white" {}
        _Color0 ("Color 0", Vector) = (0,0,0,1)
        _Color1 ("Color 1", Vector) = (1,1,1,1)
        _Mode ("Mode", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType"="Transparent" "Queue"="Transparent" }
        Cull Off
        ZWrite Off
        ZTest Always
        Blend OneMinusDstAlpha DstAlpha, OneMinusDstAlpha One

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 2.0
            #include "UnityCG.cginc"

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

            sampler2D _MainTex;
            float4 _Color0, _Color1;
            float _Mode;

            v2f vert (appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = v.uv;
                return o;
            }

            float4 frag (v2f i) : SV_Target
            {
                float4 t = tex2D(_MainTex, i.uv);
                float3 c = _Color0.rgb;
                if (_Mode > 1.5) c = saturate(_Color0.rgb * t.r + _Color1.rgb * t.g + t.bbb);
                else if (_Mode > 0.5) c = saturate(_Color0.rgb * t.r + _Color1.rgb * t.b + t.ggg);
                clip(t.a - 0.5 / 255.0);   // GX: alpha compare GREATER 0
                return float4(c, t.a);
            }
            ENDCG
        }
    }
}
