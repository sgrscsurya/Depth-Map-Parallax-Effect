import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * Edge-safe depth parallax.
 *
 * Why edges used to look "glued" / show a double glass rim:
 * the near layer and the far layer move at different speeds, so a gap opens
 * along every cliff in the depth map. A plain shader fills that gap with the
 * rim pixels of the near object, which looks like a smear or a ghost rim.
 *
 * Fix: before rendering, the depth map is "slope limited" once. Cliffs
 * between near and far layers become gentle ramps that run out into the
 * smooth sky. The sky then stretches slowly over a wide area (invisible),
 * and the glass / moss rims are never repeated. Slopes that are already
 * gentle, like the inside of the moss, are not touched.
 *
 * Living-scene extras (all additive, nothing repainted):
 *  - intro reveal, pollen motes (occluded by the real depth), drifting mist,
 *    warm light rays, moss sway, glass shimmer + inner reflection shift,
 *    click-to-dolly + light pulse, phone tilt, slow day-light colour drift.
 */

const BAKE_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Separable grayscale dilation with a cone: d'(x) = max_y ( d(y) - slope * |x - y| )
const BAKE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tDepth;
  uniform vec2  uTexel;
  uniform vec2  uDir;
  uniform float uInvert;
  uniform float uSlope;   // depth lost per pixel
  uniform float uStepPx;  // spacing of taps in pixels
  varying vec2 vUv;

  float rd(vec2 uv) {
    float d = texture2D(tDepth, uv).r;
    return mix(d, 1.0 - d, uInvert);
  }

  void main() {
    float best = rd(vUv);
    for (int i = -64; i <= 64; i++) {
      float o = float(i) * uStepPx;
      float d = rd(vUv + uDir * uTexel * o);
      best = max(best, d - uSlope * abs(o));
    }
    gl_FragColor = vec4(vec3(best), 1.0);
  }
`;

function DepthParallax({
  imageSrc = "/images/portrait.jpg",
  depthSrc = "/images/portrait-depth.png",
  strength = 0.065, // how far the layers travel (more = deeper)
  speed = 7.5, // how quickly the scene follows the cursor
  autoMotion = true, // slow self-turning when the mouse is idle / away
  autoSpeed = 2.5, // speed of the self-turning
  idleDelay = 1.0, // seconds without mouse movement before it starts turning
  light = 1.0, // cursor light strength (0 = off)
  focus = 0.5, // depth that stays still (the glass ball)
  invertDepth = false, // flip if black = near in your depth map
  edgeSoftness = 3.0, // width of the edge ramps (0 = off). Higher = cleaner edges
  zoom = 1.08, // slight overscan so edges never show

  // ---- New living-scene effects (0 = off) ----
  pollen = 1.0, // floating glowing motes at 3 depths
  mist = 1.0, // slow warm haze behind the ball
  rays = 1.0, // faint light shafts from the bright sky
  sway = 1.0, // tiny wind movement in the moss
  glass = 1.0, // shimmer sweep + inner reflection shift on the ball
  grade = 1.0, // slow warm <-> cool light drift
  clickEffects = true, // press = dolly in + light ripple
  tilt = true, // phone gyroscope controls the camera
  // Where the glass ball sits in the photo (0..1 image space, y up)
  ballX = 0.423,
  ballY = 0.427,
  ballRadius = 0.239, // measured in image-height units
}) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;

    const scene = new THREE.Scene();
    const aspect = container.clientWidth / container.clientHeight;
    const camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 100);
    camera.position.z = 5;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    container.appendChild(renderer.domElement);

    const targetMouse = new THREE.Vector2(0, 0);
    const currentMouse = new THREE.Vector2(0, 0);

    // Cursor light
    const pointerLight = new THREE.Vector2(0.5, 0.5); // uv space (0..1)
    const currentLight = new THREE.Vector2(0.5, 0.5);
    let lightAmt = 0;
    let pointerInside = false;
    let lastPointerTime = -Infinity;
    const startTime = performance.now();
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    // Intro, click dolly, click ripple
    let reveal = reducedMotion ? 1 : 0;
    let dolly = 0;
    let dollyTarget = 0;
    const pulsePos = new THREE.Vector2(0.5, 0.5);
    let pulseStart = -999; // seconds since start
    let tiltAsked = false;

    const loader = new THREE.TextureLoader();

    let imageTexture, depthTexture, geometry, material, mesh;
    let bakeGeometry, bakeMaterial, bakeScene, bakeMesh, rtA, rtB;
    let animationId;
    let disposed = false;
    let lastTime = performance.now();

    const fitMesh = (width, height) => {
      if (!mesh || !imageTexture) return;
      const imageAspect = imageTexture.image.width / imageTexture.image.height;
      mesh.scale.setScalar(Math.min(2, (2 * width / height) / imageAspect));
    };

    Promise.all([loader.loadAsync(imageSrc), loader.loadAsync(depthSrc)])
      .then(([image, depth]) => {
        if (disposed) {
          image.dispose();
          depth.dispose();
          return;
        }

        imageTexture = image;
        depthTexture = depth;

        imageTexture.colorSpace = THREE.SRGBColorSpace;
        imageTexture.generateMipmaps = false;
        imageTexture.minFilter = THREE.LinearFilter;

        depthTexture.colorSpace = THREE.NoColorSpace;
        depthTexture.generateMipmaps = false;
        depthTexture.minFilter = THREE.LinearFilter;
        depthTexture.magFilter = THREE.LinearFilter;

        const dw = depthTexture.image.width;
        const dh = depthTexture.image.height;
        const texel = new THREE.Vector2(1 / dw, 1 / dh);

        // ---------- One-time depth slope limiting ----------
        const makeRT = () =>
          new THREE.WebGLRenderTarget(dw, dh, {
            type: THREE.HalfFloatType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
            generateMipmaps: false,
          });
        rtA = makeRT();
        rtB = makeRT();

        // How far (in depth-map pixels) a full near/far difference travels
        const shiftPx = strength * dw;
        const rampPx = Math.max(edgeSoftness * shiftPx, 1);
        const slope = edgeSoftness > 0 ? 1 / rampPx : 1e6;
        const rangePx = Math.min(rampPx, 220);

        bakeGeometry = new THREE.PlaneGeometry(2, 2);
        bakeMaterial = new THREE.ShaderMaterial({
          uniforms: {
            tDepth: { value: depthTexture },
            uTexel: { value: texel },
            uDir: { value: new THREE.Vector2(1, 0) },
            uInvert: { value: invertDepth ? 1 : 0 },
            uSlope: { value: slope },
            uStepPx: { value: edgeSoftness > 0 ? rangePx / 64 : 0 },
          },
          vertexShader: BAKE_VERTEX,
          fragmentShader: BAKE_FRAGMENT,
          depthTest: false,
          depthWrite: false,
        });
        bakeScene = new THREE.Scene();
        bakeMesh = new THREE.Mesh(bakeGeometry, bakeMaterial);
        bakeMesh.frustumCulled = false;
        bakeScene.add(bakeMesh);

        // Horizontal pass
        renderer.setRenderTarget(rtA);
        renderer.render(bakeScene, camera);
        // Vertical pass
        bakeMaterial.uniforms.tDepth.value = rtA.texture;
        bakeMaterial.uniforms.uInvert.value = 0;
        bakeMaterial.uniforms.uDir.value.set(0, 1);
        renderer.setRenderTarget(rtB);
        renderer.render(bakeScene, camera);
        renderer.setRenderTarget(null);

        // ---------- Main render ----------
        const imageAspect = imageTexture.image.width / imageTexture.image.height;
        geometry = new THREE.PlaneGeometry(imageAspect, 1);

        material = new THREE.ShaderMaterial({
          uniforms: {
            uImage: { value: imageTexture },
            uDepth: { value: rtB.texture },
            uMouse: { value: currentMouse },
            uStrength: { value: strength },
            uFocus: { value: focus },
            uZoom: { value: zoom },
            uLightPos: { value: currentLight },
            uLightAmt: { value: 0 },
            uAspect: { value: container.clientWidth / container.clientHeight },

            uImgAspect: { value: imageAspect },
            uTime: { value: 0 },
            uReveal: { value: reveal },
            uPollen: { value: pollen },
            uMist: { value: mist },
            uRays: { value: rays },
            uSway: { value: sway },
            uGlass: { value: glass },
            uGrade: { value: grade },
            uDolly: { value: 0 },
            uPulsePos: { value: pulsePos },
            uPulseT: { value: 999 },
            uBall: { value: new THREE.Vector3(ballX, ballY, ballRadius) },
          },

          vertexShader: `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,

          fragmentShader: `
            uniform sampler2D uImage;
            uniform sampler2D uDepth;
            uniform vec2 uMouse;
            uniform float uStrength;
            uniform float uFocus;
            uniform float uZoom;
            uniform vec2 uLightPos;
            uniform float uLightAmt;
            uniform float uAspect;

            uniform float uImgAspect;
            uniform float uTime;
            uniform float uReveal;
            uniform float uPollen;
            uniform float uMist;
            uniform float uRays;
            uniform float uSway;
            uniform float uGlass;
            uniform float uGrade;
            uniform float uDolly;
            uniform vec2  uPulsePos;
            uniform float uPulseT;
            uniform vec3  uBall; // center xy (image uv), radius (image-height units)

            varying vec2 vUv;

            float readDepth(vec2 uv) {
              return texture2D(uDepth, clamp(uv, vec2(0.001), vec2(0.999))).r;
            }

            vec3 readImage(vec2 uv) {
              return texture2D(uImage, clamp(uv, vec2(0.001), vec2(0.999))).rgb;
            }

            float hash21(vec2 p) {
              p = fract(p * vec2(123.34, 456.21));
              p += dot(p, p + 45.32);
              return fract(p.x * p.y);
            }

            float vnoise(vec2 p) {
              vec2 i = floor(p);
              vec2 f = fract(p);
              f = f * f * (3.0 - 2.0 * f);
              float a = hash21(i);
              float b = hash21(i + vec2(1.0, 0.0));
              float c = hash21(i + vec2(0.0, 1.0));
              float d = hash21(i + vec2(1.0, 1.0));
              return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
            }

            float fbm(vec2 p) {
              return 0.5 * vnoise(p) + 0.25 * vnoise(p * 2.03 + 7.1) + 0.125 * vnoise(p * 4.1 + 3.7);
            }

            // One layer of drifting pollen. z = how near the layer is (1 = nearest).
            // World position follows the same parallax rule as the photo, and the
            // mote is hidden wherever the real scene is nearer than the mote.
            vec3 pollenLayer(float z, float cells, float size, float density,
                             float drift, float seed, float dd, float t) {
              vec2 world = vUv + uMouse * (z - uFocus) * uStrength * uReveal;
              vec2 sp = world * vec2(uAspect, 1.0) * cells + vec2(-0.3, -0.45) * t * drift;
              vec2 id = floor(sp);
              vec2 f = fract(sp);

              float h = hash21(id + seed);
              if (h > density) return vec3(0.0);

              vec2 pos = vec2(hash21(id + seed + 3.7), hash21(id + seed + 9.1)) * 0.4 + 0.3;
              pos += 0.1 * vec2(sin(t * 0.7 + h * 40.0), cos(t * 0.6 + h * 31.0));

              float s = size * (0.6 + 0.8 * hash21(id + seed + 5.3));
              float dist = length(f - pos);
              float a = smoothstep(s, s * 0.15, dist);
              a *= a;
              a *= 0.55 + 0.45 * sin(t * (0.8 + h * 1.6) + h * 50.0);

              float vis = smoothstep(-0.08, 0.04, z - dd);
              vec3 tint = mix(vec3(1.0, 0.78, 0.45), vec3(1.0, 0.95, 0.82), hash21(id + seed + 1.1));
              return tint * a * vis;
            }

            void main() {
              float t = uTime;
              vec2 par = uMouse * uStrength * uReveal;

              // ---- Depth parallax (+ depth-aware click dolly) ----
              // Read depth where the pixel really comes from. Because the
              // depth ramps are gentle now, this settles in a few passes.
              vec2 uv = (vUv - 0.5) / uZoom + 0.5;
              for (int i = 0; i < 6; i++) {
                float d = readDepth(uv);
                float z = uZoom * (1.0 + uDolly * 0.10 * (d + 0.3)); // near grows faster
                uv = (vUv - 0.5) / z + 0.5 + par * (d - uFocus);
              }

              float dd = readDepth(uv);

              // ---- Glass ball mask (image space) ----
              vec2 rel = (uv - uBall.xy) * vec2(uImgAspect, 1.0);
              float dB = length(rel) / uBall.z;
              float ballMask = 1.0 - smoothstep(0.95, 1.0, dB);

              // ---- Moss sway: only green, non-ball pixels move ----
              vec3 col0 = readImage(uv);
              float mossy = smoothstep(0.0, 0.25, (col0.g - col0.r * 0.9) / (col0.g + 0.02));
              mossy *= 1.0 - ballMask;

              vec2 wind = vec2(
                sin(t * 1.25 + uv.x * 13.0 + uv.y * 7.0) + 0.5 * sin(t * 2.1 + uv.y * 23.0 - uv.x * 11.0),
                0.45 * sin(t * 1.6 + uv.x * 17.0 + 2.0)
              );
              float gust = 0.65 + 0.35 * sin(t * 0.4 + uv.x * 3.0);

              vec2 uvF = uv + wind * gust * 0.002 * uSway * uReveal * mossy * (0.55 + 0.45 * dd);

              // ---- Inner reflection shift: the world inside the ball moves
              //      slightly against its rim, like real glass ----
              uvF += uMouse * 0.007 * uGlass * uReveal * ballMask * (1.0 - smoothstep(0.55, 0.98, dB));

              vec3 col = readImage(uvF);

              // ---- Soft light that follows the cursor ----
              vec2 q = (vUv - uLightPos) * vec2(uAspect, 1.0);
              float r2 = dot(q, q);
              float glow = exp(-r2 / (2.0 * 0.2 * 0.2));
              float wide = exp(-r2 / (2.0 * 0.5 * 0.5));
              float depthW = mix(0.55, 1.0, dd);

              col *= 1.0 + uLightAmt * (glow * 0.55 * depthW + wide * 0.12);
              col += vec3(1.0, 0.85, 0.6) * uLightAmt * glow * glow * 0.06 * depthW;
              col *= 1.0 - uLightAmt * 0.08 * (1.0 - wide);

              // ---- Drifting warm mist, deep behind the ball ----
              vec2 mw = (vUv + uMouse * (0.1 - uFocus) * uStrength * uReveal) * vec2(uAspect, 1.0);
              float m = smoothstep(0.35, 0.85, fbm(mw * 2.2 + vec2(t * 0.02, -t * 0.012)));
              float mistMask = 1.0 - smoothstep(0.15, 0.55, dd);
              col += vec3(1.0, 0.78, 0.52) * m * mistMask * 0.14 * uMist * uReveal;

              // ---- Light rays from the bright sky ----
              vec2 src = vec2(0.6, 0.56) + uMouse * (0.1 - uFocus) * uStrength * uReveal;
              vec2 rq = (vUv - src) * vec2(uAspect, 1.0);
              float rl = length(rq);
              float ang = atan(rq.y, rq.x);
              vec2 circ = vec2(cos(ang), sin(ang));
              float n1 = vnoise(circ * 3.0 + t * 0.05);
              float n2 = vnoise(circ * 5.0 + 3.0 - t * 0.04);
              float shaft = pow(clamp(sin(ang * 17.0 + n1 * 6.0 + t * 0.08) * 0.5 + 0.5, 0.0, 1.0), 3.0) * (0.5 + 0.5 * n2);
              float rayMask = mix(0.3, 1.0, 1.0 - smoothstep(0.3, 0.55, dd));
              float breathe = 0.8 + 0.2 * sin(t * 0.4);
              col += vec3(1.0, 0.82, 0.55) * shaft * exp(-rl * 1.6) * rayMask * breathe * 0.16 * uRays * uReveal;

              // ---- Glass shimmer sweep ----
              // float cycle = 6.5;
              // float ph = fract(t / cycle);
              // float p = clamp(ph / 0.3, 0.0, 1.0);
              // p = p * p * (3.0 - 2.0 * p);
              // float sweep = mix(-1.5, 1.5, p);
              // float along = dot(rel / uBall.z, normalize(vec2(0.8, 0.6)));
              // float bx = (along - sweep) / 0.12;
              // float band = exp(-bx * bx);
              // float rim = 0.35 + 0.65 * smoothstep(0.5, 1.0, dB);
              // col += vec3(1.0, 0.96, 0.88) * band * ballMask * rim * 0.38 * uGlass * uReveal;

              // ---- Pollen motes (3 depths, real occlusion) ----
              vec3 pol = pollenLayer(0.12, 34.0, 0.09, 0.14, 0.6, 1.3, dd, t) * 0.55
                       + pollenLayer(0.62, 20.0, 0.13, 0.11, 0.9, 7.7, dd, t) * 0.85
                       + pollenLayer(1.05, 11.0, 0.19, 0.07, 1.3, 15.2, dd, t);
              col += pol * 0.8 * uPollen * uReveal * (1.0 + glow * uLightAmt);

              // ---- Click ripple of light ----
              vec2 pq = (vUv - uPulsePos) * vec2(uAspect, 1.0);
              float rx = (length(pq) - uPulseT * 0.55) / 0.035;
              float ring = exp(-rx * rx) * exp(-uPulseT * 1.8) * step(uPulseT, 3.0);
              col += vec3(1.0, 0.88, 0.65) * ring * 0.22 * (0.5 + 0.5 * dd) * clamp(uLightAmt, 0.0, 1.0);

              // ---- Slow warm <-> cool light drift (starts neutral) ----
              float g = sin(t * 0.06) * uGrade;
              col *= vec3(1.0 - 0.04 * g, 1.0, 1.0 + 0.05 * g);

              gl_FragColor = vec4(col, 1.0);

              #include <colorspace_fragment>
            }
          `,
        });

        mesh = new THREE.Mesh(geometry, material);
        fitMesh(container.clientWidth, container.clientHeight);
        scene.add(mesh);

        lastTime = performance.now();

        const animate = (now) => {
          animationId = requestAnimationFrame(animate);
          const dt = Math.min((now - lastTime) / 1000, 0.05);
          lastTime = now;
          const t = (now - startTime) / 1000;

          // Intro: depth eases in over ~2s
          if (!reducedMotion) {
            const rp = THREE.MathUtils.clamp((t - 0.2) / 2.0, 0, 1);
            reveal = 1 - Math.pow(1 - rp, 3);
          }
          material.uniforms.uReveal.value = reveal;
          material.uniforms.uTime.value = t;

          // Click dolly + ripple clock
          dolly += (dollyTarget - dolly) * (1 - Math.exp(-5 * dt));
          material.uniforms.uDolly.value = dolly;
          material.uniforms.uPulseT.value = t - pulseStart;

          // Self-turning: slow orbit that blends in when the mouse is idle
          const idleFor = (now - lastPointerTime) / 1000;
          const idleBlend =
            autoMotion && !reducedMotion
              ? THREE.MathUtils.smoothstep(idleFor, idleDelay, idleDelay + 1.5)
              : 0;
          const a = t * autoSpeed;
          const autoX = Math.sin(a * 0.38) * 1.5 + Math.sin(a * 0.91) * 0.1;
          const autoY = Math.sin(a * 0.29 + 1.3) * 2 + Math.cos(a * 0.67) * 0.08;

          const tx = THREE.MathUtils.lerp(targetMouse.x, autoX, idleBlend);
          const ty = THREE.MathUtils.lerp(targetMouse.y, autoY, idleBlend);
          const k = 1 - Math.exp(-speed * dt);
          currentMouse.x += (tx - currentMouse.x) * k;
          currentMouse.y += (ty - currentMouse.y) * k;

          // Light: on the cursor while it is over the scene, else it rides along
          // with the self-turning
          const lx = pointerInside ? pointerLight.x : 0.5 + autoX * 0.32;
          const ly = pointerInside ? pointerLight.y : 0.5 - autoY * 0.4;
          const kl = 1 - Math.exp(-12 * dt);
          currentLight.x += (lx - currentLight.x) * kl;
          currentLight.y += (ly - currentLight.y) * kl;

          const fadeIn = THREE.MathUtils.clamp((t - 0.4) / 1.5, 0, 1);
          const lightTarget = (pointerInside ? 1 : 0.6) * light * fadeIn;
          lightAmt += (lightTarget - lightAmt) * (1 - Math.exp(-5 * dt));
          material.uniforms.uLightAmt.value = lightAmt;

          renderer.render(scene, camera);
        };
        animationId = requestAnimationFrame(animate);
      })
      .catch((error) => {
        console.error("Image loading failed:", error);
      });

    const handleMouseMove = (event) => {
      const rect = container.getBoundingClientRect();
      targetMouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      targetMouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      pointerLight.set(
        (event.clientX - rect.left) / rect.width,
        1 - (event.clientY - rect.top) / rect.height
      );
      pointerInside = true;
      lastPointerTime = performance.now();
    };
    const handleMouseLeave = () => {
      pointerInside = false;
      targetMouse.set(0, 0);
      lastPointerTime = performance.now();
    };

    // Press: dolly in + light ripple from the cursor
    const handlePointerDown = (event) => {
      handleMouseMove(event);
      if (clickEffects) {
        dollyTarget = 1;
        pulsePos.copy(pointerLight);
        pulseStart = (performance.now() - startTime) / 1000;
      }
      // iOS asks permission for the gyroscope from a tap
      if (
        tilt &&
        !tiltAsked &&
        typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function"
      ) {
        tiltAsked = true;
        DeviceOrientationEvent.requestPermission()
          .then((state) => {
            if (state === "granted") {
              window.addEventListener("deviceorientation", handleOrientation);
            }
          })
          .catch(() => {});
      }
    };
    const handlePointerUp = () => {
      dollyTarget = 0;
    };

    // Phone tilt (ignored on desktop, where gamma is null)
    const handleOrientation = (event) => {
      if (event.gamma == null || event.beta == null) return;
      targetMouse.set(
        THREE.MathUtils.clamp(event.gamma / 25, -1, 1),
        THREE.MathUtils.clamp(-(event.beta - 45) / 30, -1, 1)
      );
      lastPointerTime = performance.now();
    };

    container.addEventListener("pointermove", handleMouseMove);
    container.addEventListener("pointerleave", handleMouseLeave);
    container.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    if (tilt) window.addEventListener("deviceorientation", handleOrientation);

    const handleResize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (!width || !height) return;

      const newAspect = width / height;
      camera.left = -newAspect;
      camera.right = newAspect;
      camera.top = 1;
      camera.bottom = -1;
      camera.updateProjectionMatrix();

      renderer.setSize(width, height, false);
      fitMesh(width, height);
      if (material) material.uniforms.uAspect.value = newAspect;
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();

      container.removeEventListener("pointermove", handleMouseMove);
      container.removeEventListener("pointerleave", handleMouseLeave);
      container.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("deviceorientation", handleOrientation);

      geometry?.dispose();
      material?.dispose();
      bakeGeometry?.dispose();
      bakeMaterial?.dispose();
      rtA?.dispose();
      rtB?.dispose();
      imageTexture?.dispose();
      depthTexture?.dispose();

      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [
    imageSrc, depthSrc, strength, speed, autoMotion, autoSpeed, idleDelay,
    light, focus, invertDepth, edgeSoftness, zoom,
    pollen, mist, rays, sway, glass, grade, clickEffects, tilt,
    ballX, ballY, ballRadius,
  ]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        maxWidth: "none",
        margin: 0,
        background: "#222",
        overflow: "hidden",
        cursor: "crosshair",
        touchAction: "pan-y",
      }}
    />
  );
}

export default DepthParallax;
