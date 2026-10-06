"use client";
/**
 * One WebGL stage for the 3D blocks (3D map, 3D scatter): the renderer, an
 * orbit camera (drag to turn, right-drag or shift-drag to pan, Ctrl+wheel or pinch
 * to zoom), labels as HTML laid over the canvas and kept where their 3D point
 * projects, a hover tooltip by raycast, and a clean-up that frees the GL
 * context. three.js is imported only when one of these mounts, so a report
 * without a 3D block never downloads it.
 *
 * The caller's `build` adds its objects to the scene; `version` rebuilds it
 * (a new time-lapse frame, new rows). Anything that can't run WebGL — print,
 * the PDF capture, an old browser — gets `fallback` instead, which is why
 * every 3D block has a flat twin.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Home } from "lucide-react";
import { wheelZooms } from "../charts/wheelZoom";

export type OrbitHome = { theta: number; phi: number; r: number; min: number; max: number; target: [number, number, number] };

export type View3D = {
  THREE: any;
  scene: any;
  /** A label over the canvas at a 3D point; `className` styles it. */
  label: (text: string, at: [number, number, number], className?: string) => void;
  /** Objects the pointer can hover; `describe` returns the tooltip text for one, or null; `onClick` runs on a click (not a drag). */
  hoverable: (object: any, describe: () => string | null, onClick?: () => void) => void;
  /** Called every frame until it returns false (a growing column). */
  animate: (step: (now: number) => boolean) => void;
};

export function Stage3D({
  home, build, version, fallback, className, resetLabel, views,
}: {
  home: OrbitHome;
  build: (view: View3D) => void;
  /** Change it to rebuild the scene (keeping the camera where the reader left it). */
  version: unknown;
  fallback: ReactNode;
  className?: string;
  /** Shows a button that puts the camera back where it started, labelled with this. */
  resetLabel?: string;
  /** More cameras a reader can fly to (a cluster of points), as buttons beside reset. */
  views?: Array<{ label: string; home: OrbitHome }>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const engine = useRef<{ rebuild: (b: typeof build) => void; reset: () => void; goTo: (h: OrbitHome) => void } | null>(null);

  // Mount once: renderer, camera, orbit, render loop.
  useEffect(() => {
    let cancelled = false;
    let dispose = () => {};
    (async () => {
      let THREE: any;
      try { THREE = await import("three"); } catch { if (!cancelled) setFailed(true); return; }
      if (cancelled || !host.current) return;
      let renderer: any;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch { setFailed(true); return; }
      const el = host.current;
      const canvas: HTMLCanvasElement = renderer.domElement;
      canvas.style.display = "block";
      canvas.style.cursor = "grab";
      canvas.style.touchAction = "none";
      el.prepend(canvas);
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      const size = () => { const r = el.getBoundingClientRect(); return { w: Math.max(1, r.width), h: Math.max(1, r.height) }; };
      const camera = new THREE.PerspectiveCamera(38, 1, 1, 10000);
      let scene = new THREE.Scene();
      let labels: Array<{ el: HTMLDivElement; pos: any }> = [];
      let hover: Array<{ object: any; describe: () => string | null; onClick?: () => void }> = [];
      let downAt: { x: number; y: number } | null = null;
      let anims: Array<(now: number) => boolean> = [];
      let dirty = true;

      // Orbit camera.
      const st = { ...home, target: new THREE.Vector3(...home.target) };
      const apply = () => {
        const s = Math.sin(st.phi);
        camera.position.set(st.target.x + st.r * s * Math.sin(st.theta), st.target.y + st.r * Math.cos(st.phi), st.target.z + st.r * s * Math.cos(st.theta));
        camera.lookAt(st.target);
        dirty = true;
      };
      const pointers = new Map<number, { x: number; y: number; b: number; shift: boolean }>();
      let pinch = 0;
      const tip = (text: string | null, x = 0, y = 0) => {
        const t = tipRef.current; if (!t) return;
        if (!text) { t.hidden = true; return; }
        t.textContent = text; t.hidden = false;
        const { w, h } = size();
        t.style.left = Math.min(w - t.offsetWidth - 6, Math.max(6, x + 12)) + "px";
        t.style.top = Math.min(h - t.offsetHeight - 6, Math.max(6, y + 12)) + "px";
      };
      const onDown = (e: PointerEvent) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey }); downAt = { x: e.clientX, y: e.clientY }; tip(null); };
      const ray = new THREE.Raycaster();
      const mouse = new THREE.Vector2();
      const onMove = (e: PointerEvent) => {
        const p = pointers.get(e.pointerId);
        if (p) {
          const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
          if (pointers.size === 2) {
            const [a, b] = [...pointers.values()]; const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
            if (pinch) { st.r = Math.min(st.max, Math.max(st.min, (st.r * pinch) / d)); apply(); }
            pinch = d; return;
          }
          if (p.b === 2 || p.shift) {
            const k = st.r * 0.0016;
            const right = new THREE.Vector3(Math.cos(st.theta), 0, -Math.sin(st.theta));
            const fwd = new THREE.Vector3(-Math.sin(st.theta), 0, -Math.cos(st.theta));
            st.target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k);
          } else {
            st.theta -= dx * 0.006;
            st.phi = Math.min(1.45, Math.max(0.12, st.phi - dy * 0.006));
          }
          apply();
          return;
        }
        const rect = canvas.getBoundingClientRect();
        mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        ray.setFromCamera(mouse, camera);
        const hit = ray.intersectObjects(hover.map((h) => h.object), false)[0];
        const text = hit ? hover.find((h) => h.object === hit.object)?.describe() ?? null : null;
        canvas.style.cursor = text ? "pointer" : "grab";
        tip(text, e.clientX - rect.left, e.clientY - rect.top);
      };
      const onUp = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = 0;
        // A click is a press that barely moved; a drag turned the camera.
        if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4 && e.button === 0) {
          const rect = canvas.getBoundingClientRect();
          mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
          ray.setFromCamera(mouse, camera);
          const hit = ray.intersectObjects(hover.map((h) => h.object), false)[0];
          hover.find((h) => h.object === hit?.object)?.onClick?.();
        }
        downAt = null;
      };
      // The wheel zooms by the charts' shared rule (wheelZoom.ts): Ctrl/⌘ or a
      // pinch anywhere, a plain wheel when enlarged or once clicked into — a
      // map in the middle of a page must not swallow every scroll past it.
      let activated = false;
      const onWheel = (e: WheelEvent) => { if (!wheelZooms(e, canvas, activated)) return; e.preventDefault(); st.r = Math.min(st.max, Math.max(st.min, st.r * Math.exp(e.deltaY * 0.0012))); apply(); };
      const onActivate = () => { activated = true; };
      const onLeave = () => { activated = false; tip(null); };
      const noMenu = (e: Event) => e.preventDefault();
      canvas.addEventListener("pointerdown", onActivate);
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("pointercancel", onUp);
      canvas.addEventListener("pointerleave", onLeave);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("contextmenu", noMenu);

      const freeScene = () => {
        scene.traverse((o: any) => { o.geometry?.dispose?.(); (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m?.dispose?.()); });
        labelsRef.current?.replaceChildren();
        labels = []; hover = []; anims = [];
      };
      const rebuild = (b: typeof build) => {
        freeScene();
        scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a8, 0.9));
        const sun = new THREE.DirectionalLight(0xffffff, 0.7);
        sun.position.set(-300, 900, 500);
        scene.add(sun);
        b({
          THREE, scene,
          label: (text, at, cls) => {
            const d = document.createElement("div");
            d.className = cls ?? "pointer-events-none absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-card/90 px-1 text-[10px] text-foreground shadow-xs";
            d.textContent = text;
            labelsRef.current?.appendChild(d);
            labels.push({ el: d, pos: new THREE.Vector3(...at) });
          },
          hoverable: (object, describe, onClick) => { hover.push({ object, describe, onClick }); },
          animate: (step) => { anims.push(step); },
        });
        dirty = true;
      };

      let raf = 0;
      const v = new THREE.Vector3();
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        if (anims.length) { anims = anims.filter((a) => a(now)); dirty = true; }
        if (!dirty) return;
        dirty = false;
        renderer.render(scene, camera);
        const { w, h } = size();
        for (const l of labels) {
          v.copy(l.pos).project(camera);
          const off = v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
          l.el.hidden = off;
          if (!off) { l.el.style.left = ((v.x + 1) / 2) * w + "px"; l.el.style.top = ((1 - v.y) / 2) * h + "px"; }
        }
      };
      const resize = () => { const { w, h } = size(); renderer.setSize(w, h, false); canvas.style.width = "100%"; canvas.style.height = "100%"; camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true; };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();
      apply();
      raf = requestAnimationFrame(frame);
      // Glide, not jump, so the reader sees where the new view is.
      const goTo = (h: OrbitHome) => {
        const from = { theta: st.theta, phi: st.phi, r: st.r, target: st.target.clone() };
        const to = new THREE.Vector3(...h.target);
        Object.assign(st, { min: h.min, max: h.max });
        const t0 = performance.now();
        anims.push((now) => {
          const k = Math.min(1, (now - t0) / 600);
          const e = 1 - Math.pow(1 - k, 3);
          st.theta = from.theta + (h.theta - from.theta) * e;
          st.phi = from.phi + (h.phi - from.phi) * e;
          st.r = from.r + (h.r - from.r) * e;
          st.target.copy(from.target).lerp(to, e);
          apply();
          return k < 1;
        });
      };
      engine.current = { rebuild, reset: () => goTo(home), goTo };
      dispose = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("pointercancel", onUp);
        canvas.removeEventListener("pointerleave", onLeave);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("pointerdown", onActivate);
        canvas.removeEventListener("contextmenu", noMenu);
        freeScene();
        renderer.forceContextLoss?.();
        renderer.dispose();
        canvas.remove();
      };
      rebuild(build);
    })();
    return () => { cancelled = true; engine.current = null; dispose(); };
    // The stage mounts once; `version` rebuilds the scene below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild the scene when what it shows changes, keeping the camera.
  useEffect(() => {
    engine.current?.rebuild(build);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  if (failed) return <>{fallback}</>;
  return (
    <div ref={host} className={`relative h-full w-full overflow-hidden ${className ?? ""}`}>
      <div ref={labelsRef} className="pointer-events-none absolute inset-0" />
      <div className="absolute right-2 top-2 z-20 flex gap-1">
        {views?.map((v) => (
          <button key={v.label} type="button" onClick={() => engine.current?.goTo(v.home)}
            className="h-6 rounded-md border border-border bg-background px-2 text-[10px] font-semibold text-muted-foreground shadow-sm hover:text-foreground">
            {v.label}
          </button>
        ))}
        {resetLabel && (
          <button type="button" onClick={() => engine.current?.reset()} title={resetLabel} aria-label={resetLabel}
            className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground">
            <Home className="h-3 w-3" />
          </button>
        )}
      </div>
      <div ref={tipRef} hidden className="pointer-events-none absolute z-10 max-w-xs whitespace-pre-line rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md" />
    </div>
  );
}
