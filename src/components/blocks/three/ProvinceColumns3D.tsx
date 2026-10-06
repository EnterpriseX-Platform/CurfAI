"use client";
/**
 * The province map in 3D: Thailand's provinces as a low relief, a column on
 * each province with data, as tall as its value against the map's own scale
 * (the same maxAbs the flat map shades by — in a time-lapse, fixed across
 * frames, so the columns grow month by month). Clicking a column does what
 * clicking the province does on the flat map. The five tallest are labelled.
 * With `shade`, a column's colour is a second measure (the prototype's "dark
 * = much of it needs review") on its own fixed range; without, its height
 * again.
 */
import { Stage3D, type OrbitHome } from "./Stage3D";
import { THAILAND_MAP_H, THAILAND_MAP_W, THAILAND_PROVINCE_PATHS } from "@/lib/reporting/thailandProvincePaths";
import { useRef, type ReactNode } from "react";

const CX = THAILAND_MAP_W / 2;
const CY = THAILAND_MAP_H / 2;
const MAX_H = 230;
const MIN_H = 4;
// Turned a little off north and tilted, so the columns stand clear of each
// other and of the land — the prototype's framing.
const HOME: OrbitHome = { theta: 0.42, phi: 0.82, r: 1180, min: 60, max: 2600, target: [0, 0, 40] };

/** The rings of an "M x y L x y … Z" path, as [x, y] points. */
export function parseRings(d: string): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> | null = null;
  const re = /([MLZ])([^MLZ]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const n = m[2]!.trim() ? m[2]!.trim().split(/[\s,]+/).map(Number) : [];
    if (m[1] === "M") { cur = []; rings.push(cur); }
    if (m[1] !== "Z" && cur) for (let i = 0; i + 1 < n.length; i += 2) cur.push([n[i]!, n[i + 1]!]);
  }
  return rings.filter((r) => r.length > 2);
}

type Entry = {
  id: string; name: string; value: number | null; shade?: number | null;
  /** A point's own map position (projectLon/projectLat) — otherwise its province's centre. */
  at?: [number, number];
  /** A fixed colour (the point's group) instead of the shade or value. */
  color?: string;
};

/** Where an entry stands on the map, in THAILAND_MAP units — or null. */
function siteOf(e: Entry): [number, number] | null {
  if (e.at) return e.at;
  const p = THAILAND_PROVINCE_PATHS[e.id];
  return p ? [p.cx, p.cy] : null;
}

/**
 * A camera over the densest bunch of points (the Bangkok branches beside
 * one in Chiang Mai) — the prototype's "กรุงเทพฯ และปริมณฑล" view — or null
 * when the points don't bunch: fewer than two near each other, or all of them.
 */
export function clusterHome(sites: Array<[number, number]>, radius = 40): OrbitHome | null {
  if (sites.length < 3) return null;
  const near = (a: [number, number]) => sites.filter((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= radius);
  const best = sites.map(near).sort((a, b) => b.length - a.length)[0]!;
  if (best.length < 2 || best.length === sites.length) return null;
  const cx = best.reduce((s, q) => s + q[0], 0) / best.length;
  const cy = best.reduce((s, q) => s + q[1], 0) / best.length;
  const extent = Math.max(...best.map((q) => Math.hypot(q[0] - cx, q[1] - cy)), 4);
  return { theta: HOME.theta, phi: 0.9, r: Math.max(150, extent * 14), min: 30, max: HOME.max, target: [cx - CX, 0, cy - CY] };
}

export function ProvinceColumns3D({
  entries, maxAbs, color, label, version, onPick, fallback, caption, resetLabel, shade, clusterLabel,
}: {
  /** Names the button that flies to the densest bunch of points, when there is one. */
  clusterLabel?: string;
  /** Colour the columns by each entry's `shade` over `range`, named `label` in the tooltip. */
  shade?: { label: string; range: [number, number]; format: (v: number) => string };
  /** What the values are as of — a time-lapse's frame ("ม.ค. 69 · so far"); heads each tooltip. */
  caption?: string;
  resetLabel?: string;
  /** One per province (its id the THAILAND_PROVINCE_PATHS slug), or per point with `at`. */
  entries: Entry[];
  maxAbs: number;
  color: string;
  label: (v: number) => string;
  version: unknown;
  onPick: (id: string) => void;
  fallback: ReactNode;
}) {
  // Each column's height as last drawn, so a time-lapse frame grows the
  // columns from where they stood instead of raising them from the ground
  // every month.
  const drawn = useRef(new Map<string, number>());
  const pointsOnly = entries.length > 0 && entries.every((e) => e.at);
  const cluster = pointsOnly && clusterLabel
    ? clusterHome(entries.filter((e) => e.value != null && e.value > 0).map((e) => e.at!))
    : null;
  return (
    <Stage3D
      home={HOME}
      views={cluster ? [{ label: clusterLabel!, home: cluster }] : undefined}
      version={version}
      fallback={fallback}
      resetLabel={resetLabel}
      build={({ THREE, scene, label: addLabel, hoverable, animate }) => {
        const css = getComputedStyle(document.documentElement);
        const token = (name: string, alt: string) => {
          const v = css.getPropertyValue(name).trim();
          // The theme writes "225 30.8% 94.9%"; three.js parses the comma form.
          return v ? `hsl(${v.replace(/\s+/g, ", ")})` : alt;
        };
        const land = new THREE.MeshLambertMaterial({ color: new THREE.Color(token("--muted", "#eef0f6")) });
        const edge = new THREE.LineBasicMaterial({ color: new THREE.Color(token("--border", "#d6d9e3")) });
        for (const p of Object.values(THAILAND_PROVINCE_PATHS)) {
          const rings = parseRings(p.d);
          const shapes = rings.map((r) => new THREE.Shape(r.map(([x, y]) => new THREE.Vector2(x - CX, -(y - CY)))));
          const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shapes, { depth: 3, bevelEnabled: false }), land);
          mesh.rotation.x = -Math.PI / 2;
          scene.add(mesh);
          for (const r of rings) {
            const pts = r.map(([x, y]) => new THREE.Vector3(x - CX, 3.2, y - CY));
            pts.push(pts[0]);
            scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), edge));
          }
        }

        // One hue, light to dark: a tint of the accent, not the land's grey — a
        // low column read as part of the map.
        const base = new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.7);
        const full = new THREE.Color(color);
        // Points sit closer than provinces (Ari and Thong Lo are a few units apart).
        const box = pointsOnly ? new THREE.BoxGeometry(6, 1, 6) : new THREE.BoxGeometry(7, 1, 7);
        const hitBox = new THREE.BoxGeometry(16, 1, 16);
        const hidden = new THREE.MeshBasicMaterial({ visible: false });
        const cols: Array<{ id: string; mesh: any; from: number; h: number }> = [];
        const heightOf = (v: number) => MIN_H + Math.min(1, v / Math.max(1, maxAbs)) * MAX_H;
        const withData = entries.filter((e) => e.value != null && e.value > 0 && siteOf(e));
        for (const e of withData) {
          const [px, py] = siteOf(e)!;
          const share = Math.min(1, (e.value as number) / Math.max(1, maxAbs));
          const tone = shade && e.shade != null
            ? Math.max(0, Math.min(1, (e.shade - shade.range[0]) / ((shade.range[1] - shade.range[0]) || 1)))
            : share;
          const mesh = new THREE.Mesh(box, new THREE.MeshLambertMaterial({ color: e.color ? new THREE.Color(e.color) : base.clone().lerp(full, 0.15 + 0.85 * tone) }));
          const from = drawn.current.get(e.id) ?? 0;
          mesh.scale.y = Math.max(0.001, from);
          mesh.position.set(px - CX, 3 + from / 2, py - CY);
          scene.add(mesh);
          cols.push({ id: e.id, mesh, from, h: heightOf(e.value as number) });
          // A 7-unit column is a few pixels wide from across the map: the
          // pointer hovers a wider invisible box that grows with it.
          const hit = new THREE.Mesh(hitBox, hidden);
          mesh.add(hit);
          const shadeLine = shade && e.shade != null ? `\n${shade.label}: ${shade.format(e.shade)}` : "";
          hoverable(hit, () => `${caption ? caption + "\n" : ""}${e.name}\n${label(e.value as number)}${shadeLine}`, () => onPick(e.id));
        }
        // A province that drops out of this frame starts from the ground next time.
        const live = new Set(withData.map((e) => e.id));
        for (const id of [...drawn.current.keys()]) if (!live.has(id)) drawn.current.delete(id);
        // The five tallest provinces; every point, when there are only a few.
        const labelled = pointsOnly && withData.length <= 8 ? withData : [...withData].sort((a, b) => (b.value as number) - (a.value as number)).slice(0, 5);
        for (const e of labelled) {
          const [px, py] = siteOf(e)!;
          addLabel(`${e.name} ${label(e.value as number)}`, [px - CX, heightOf(e.value as number) + 12, py - CY]);
        }
        // Columns rise into place — each frame of a time-lapse from where they stood.
        const t0 = performance.now();
        animate((now) => {
          const k = Math.min(1, (now - t0) / 500);
          const ease = 1 - Math.pow(1 - k, 3);
          for (const c of cols) {
            const h = c.from + (c.h - c.from) * ease;
            c.mesh.scale.y = Math.max(0.001, h);
            c.mesh.position.y = 3 + h / 2;
            drawn.current.set(c.id, h);
          }
          return k < 1;
        });
      }}
    />
  );
}
