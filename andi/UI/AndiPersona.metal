#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

// andi's "body": a living orb drawn entirely on the GPU. One shader, several materials, so the
// persona lab can swap looks without rebuilding pipelines. Driven from AndiPersona.swift.
//
// Space: `uv` is centered, y-up, and spans -1...1 across the view's short side.

namespace persona {

float hash(float3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

/// Smooth value noise in 0...1.
float noise(float3 p) {
    float3 i = floor(p);
    float3 f = fract(p);
    float3 u = f * f * (3.0 - 2.0 * f);
    float n000 = hash(i);
    float n100 = hash(i + float3(1, 0, 0));
    float n010 = hash(i + float3(0, 1, 0));
    float n110 = hash(i + float3(1, 1, 0));
    float n001 = hash(i + float3(0, 0, 1));
    float n101 = hash(i + float3(1, 0, 1));
    float n011 = hash(i + float3(0, 1, 1));
    float n111 = hash(i + float3(1, 1, 1));
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

float fbm(float3 p, int octaves) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < octaves; i++) {
        v += a * noise(p);
        p = p * 2.03 + float3(1.7, 9.2, 4.1);
        a *= 0.5;
    }
    return v;
}

/// depth -> body -> glow as t goes 0 -> 1.
float3 ramp(float3 glow, float3 body, float3 depth, float t) {
    t = saturate(t);
    return t < 0.5 ? mix(depth, body, t * 2.0) : mix(body, glow, t * 2.0 - 1.0);
}

float2 rotate(float2 p, float a) {
    float c = cos(a), s = sin(a);
    return float2(c * p.x - s * p.y, s * p.x + c * p.y);
}

} // namespace persona

/// - material: 0 pearl, 1 liquid metal, 2 plasma, 3 glass, 4 nebula
/// - energy: how "awake" andi is (mood + voice); bigger wobble and brighter
/// - touch / touchStrength: finger position (view points) and how pressed it is (0...1)
[[ stitchable ]] half4 andiPersona(float2 position, half4 color,
                                   float2 size, float time, float material,
                                   half4 glowColor, half4 bodyColor, half4 depthColor,
                                   float turbulence, float glow, float energy,
                                   float2 touch, float touchStrength, float scale) {
    float m = min(size.x, size.y) * 0.5;
    float2 uv = float2(position.x - size.x * 0.5, size.y * 0.5 - position.y) / m;
    float2 tp = float2(touch.x - size.x * 0.5, size.y * 0.5 - touch.y) / m;

    float3 A = float3(glowColor.rgb);
    float3 B = float3(bodyColor.rgb);
    float3 C = float3(depthColor.rgb);

    // --- Touch: lean toward the finger and send ripples through the surface.
    float2 lean = tp * 0.10 * touchStrength;
    float2 q = uv - lean;
    float2 toT = uv - tp;
    float td = length(toT);
    float ripple = touchStrength * sin(td * 20.0 - time * 9.0) * exp(-td * 3.5) * 0.03;
    q += (toT / max(td, 1e-4)) * ripple;

    // --- Shape: a circle whose edge breathes with noise.
    float d = length(q);
    float2 dir = q / max(d, 1e-4);
    float wobble = (persona::noise(float3(dir * 1.6, time * 0.6)) - 0.5) * (0.10 * turbulence + 0.16 * energy);
    wobble += sin(atan2(dir.y, dir.x) * 3.0 + time * 1.3) * 0.012 * energy;
    float toward = length(tp) > 1e-3 ? saturate(dot(dir, normalize(tp))) : 0.0;
    float bulge = pow(toward, 6.0) * 0.07 * touchStrength;
    float R = 0.62 * scale * (1.0 + wobble + bulge);
    float sdf = d - R;
    float aa = 1.5 / m;
    float inside = 1.0 - smoothstep(-aa, aa, sdf);

    // --- Fake sphere for lighting.
    float2 p = q / R;
    float nz = sqrt(max(0.0, 1.0 - dot(p, p)));
    float3 n = normalize(float3(p, nz));
    float fresnel = pow(1.0 - nz, 3.0);
    float3 L = normalize(float3(-0.45, 0.6, 1.0));

    float3 col = float3(0);
    float alphaIn = 1.0;
    int mat = int(material + 0.5);

    if (mat == 1) {
        // Liquid metal: a warped mirror reflecting a simple studio.
        float3 np = float3(p * 1.4, time * 0.25);
        float w = persona::fbm(np + persona::fbm(np * 1.3, 3) * 1.2 * turbulence, 4);
        float3 nn = normalize(n + float3(cos(w * 6.283), sin(w * 6.283), 0) * 0.35 * (0.3 + turbulence));
        float3 refl = reflect(float3(0, 0, -1), nn);
        float h = refl.y;
        float3 sky = mix(B, A, smoothstep(-0.1, 0.8, h));
        float3 ground = mix(C * 0.25, C, smoothstep(-1.0, -0.05, h));
        float3 env = mix(ground, sky, smoothstep(-0.04, 0.04, h));
        env += smoothstep(0.07, 0.0, abs(h)) * 0.8;
        env += pow(saturate(sin(refl.x * 5.0 + w * 3.0) * 0.5 + 0.5), 24.0) * 0.5;
        col = env * (0.8 + 0.5 * fresnel);
        col += pow(saturate(dot(reflect(-L, nn), float3(0, 0, 1))), 80.0) * 1.2;
    } else if (mat == 2) {
        // Plasma: domain-warped noise, glowing from the core out.
        float3 pp = float3(p * 1.8, time * 0.4);
        float2 warp = float2(persona::fbm(pp, 4), persona::fbm(pp + 5.2, 4));
        float f = persona::fbm(float3(p * 1.8 + warp * 2.5 * (0.2 + turbulence), time * 0.5), 5);
        col = persona::ramp(A, B, C, f * 1.25 + nz * 0.35 - 0.25);
        col *= mix(0.55, 1.35, nz);
        col += A * fresnel * 0.5;
    } else if (mat == 3) {
        // Glass: mostly clear, with aurora ribbons floating inside and a bright rim.
        float f = persona::fbm(float3(p * 1.5, time * 0.3), 4);
        float bands = sin(p.y * 5.0 + f * 7.0 * (0.3 + turbulence) + time * 0.8);
        float aurora = smoothstep(0.3, 1.0, bands) * smoothstep(1.0, 0.2, length(p));
        float3 inner = mix(B, A, f);
        col = inner * aurora * 1.4 + C * fresnel * 1.6;
        col += pow(saturate(dot(reflect(-L, n), float3(0, 0, 1))), 40.0) * 0.9;
        alphaIn = saturate(0.18 + aurora * 0.7 + fresnel * 0.9);
    } else if (mat == 4) {
        // Nebula: swirling clouds and twinkling stars in a dark sphere.
        float2 sp = persona::rotate(p, length(p) * 2.5 * (0.3 + turbulence) - time * 0.15);
        float f = persona::fbm(float3(sp * 2.0, time * 0.2), 5);
        float f2 = persona::fbm(float3(sp * 3.5 + f, time * 0.25 + 3.0), 4);
        col = mix(C * 0.15, B, smoothstep(0.3, 0.75, f));
        col += A * pow(saturate(f2), 3.0) * 2.2;
        float2 cell = floor(p * 16.0);
        float2 fr = fract(p * 16.0) - 0.5;
        float hs = persona::hash(float3(cell, 7.0));
        float star = step(0.9, hs) * smoothstep(0.14, 0.0, length(fr)) * (0.5 + 0.5 * sin(time * 3.0 + hs * 50.0));
        col += star * float3(1.0) * nz;
        col += A * fresnel * 0.6;
    } else {
        // Pearl: soft body color with a thin-film rainbow sheen.
        float w = persona::fbm(float3(p * 2.0, time * 0.3), 5);
        float film = nz * 1.2 + w * 1.5 * (0.3 + turbulence) + time * 0.05;
        float3 irid = 0.5 + 0.5 * cos(6.2831 * (film + float3(0.0, 0.33, 0.67)));
        float3 base = mix(B, A, w);
        col = mix(base, irid, 0.4) * (0.55 + 0.45 * nz);
        col += C * fresnel * 0.8;
        col += pow(saturate(dot(reflect(-L, n), float3(0, 0, 1))), 30.0) * 0.6;
    }

    col *= 1.0 + energy * 0.25;
    col = saturate(col);

    // --- Halo outside the orb (premultiplied).
    // Fades out before the frame's edge so the halo never shows a hard box.
    float edgeFade = smoothstep(1.0, 0.72, length(uv));
    float glowAmt = glow * 0.55 * exp(-max(sdf, 0.0) * 6.0) * (1.0 + energy * 0.5) * edgeFade;
    float aIn = inside * alphaIn;
    float g = (1.0 - aIn) * saturate(glowAmt);
    float3 rgb = col * aIn + A * g;
    return half4(half3(rgb), half(saturate(aIn + g)));
}
