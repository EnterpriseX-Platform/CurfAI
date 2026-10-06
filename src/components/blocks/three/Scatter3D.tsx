"use client";
/**
 * 3D scatter — three measures of the same rows at once: xField across,
 * yFields[0] up, cfg.zField into the page, each axis scaled to its own range
 * inside a cube the reader can turn. Points are coloured by cfg.colorField:
 * the eight largest categories in the palette, the rest receding. Hover a
 * point for its values.
 *
 * Print, the PDF capture and browsers without WebGL get `FlatScatter` — x
 * against y, same colours — so the block always says something on paper.
 */
import { Stage3D, type OrbitHome } from "./Stage3D";
import { DEEMPHASIS_FILL, GRID_STROKE, LABEL_FILL, seriesName, type ChartRenderCtx } from "../charts/shared";
import { formatMetricCompact } from "@/lib/reporting/format";

const HOME: OrbitHome = { theta: 0.62, phi: 1.05, r: 185, min: 60, max: 900, target: [0, 0, 0] };
const HALF = 50;
const MAX_POINTS = 1500;
const COLOURED = 8;

type Pt = { x: number; y: number; z: number; group: string; row: Record<string, unknown> };

/** The rows with all three measures, each axis's range, and the coloured groups. */
export function scatter3dPoints(data: unknown[], xField: string, yField: string, zField: string, colorField?: string) {
  const pts: Pt[] = [];
  for (const row of (data as Array<Record<string, unknown>>).slice(0, MAX_POINTS)) {
    const [x, y, z] = [row?.[xField], row?.[yField], row?.[zField]].map((v) => (v == null || v === "" ? NaN : Number(v)));
    if (![x, y, z].every(Number.isFinite)) continue;
    pts.push({ x: x!, y: y!, z: z!, group: colorField ? String(row?.[colorField] ?? "—") : "", row });
  }
  const range = (k: "x" | "y" | "z"): [number, number] => {
    const vs = pts.map((p) => p[k]);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    return lo === hi ? [lo - 1, hi + 1] : [lo, hi];
  };
  const counts = new Map<string, number>();
  for (const p of pts) counts.set(p.group, (counts.get(p.group) ?? 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1]).slice(0, COLOURED).map(([g]) => g);
  return { pts, rx: range("x"), ry: range("y"), rz: range("z"), groups };
}

type Range = [number | null, number | null] | undefined;
/** Inside a zone's range on one axis (an open end, or no range, lets anything through). */
const within = (v: number, r: Range) => !r || ((r[0] == null || v >= r[0]) && (r[1] == null || v <= r[1]));
/** A zone's box on one axis, clamped to the axis's own range. */
export function zoneSpan(r: Range, [lo, hi]: [number, number]): [number, number] {
  return [Math.max(lo, r?.[0] ?? lo), Math.min(hi, r?.[1] ?? hi)];
}

export function Scatter3D({ ctx, palette }: { ctx: ChartRenderCtx; palette: string[] }) {
  const { data, xField, yFields, cfg, fmt, currency } = ctx;
  const numOpts = { locale: ctx.dateStyle?.locale };
  const zField: string = cfg?.zField;
  const colorField: string | undefined = cfg?.colorField;
  const { pts, rx, ry, rz, groups } = scatter3dPoints(data, xField, yFields[0]!, zField, colorField);
  const colourOf = (g: string) => { const i = groups.indexOf(g); return i >= 0 ? palette[i % palette.length]! : null; };
  const short = (v: number) => formatMetricCompact(v, fmt, currency, numOpts.locale);
  const name = (f: string) => seriesName(f, cfg);
  const zone = cfg?.zone as { x?: Range; y?: Range; z?: Range; label?: string } | undefined;
  const inZone = (p: { x: number; y: number; z: number }) => !!zone && within(p.x, zone.x) && within(p.y, zone.y) && within(p.z, zone.z);

  if (pts.length === 0) {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">{ctx.emptyText ?? "No rows to show"}</div>;
  }
  const flat = <FlatScatter pts={pts} rx={rx} ry={ry} colourOf={colourOf} xLabel={name(xField)} yLabel={name(yFields[0]!)} short={short} />;
  if (ctx.print) return flat;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <Stage3D
          home={HOME}
          version={`${pts.length}|${rx}|${ry}|${rz}|${groups.join(",")}|${JSON.stringify(zone ?? null)}`}
          fallback={flat}
          build={({ THREE, scene, label, hoverable }) => {
            const at = (v: number, [lo, hi]: [number, number]) => -HALF + ((v - lo) / (hi - lo)) * 2 * HALF;
            // The cube's twelve edges.
            const c = [-HALF, HALF];
            const segs: number[] = [];
            for (const a of c) for (const b of c) {
              segs.push(-HALF, a, b, HALF, a, b, a, -HALF, b, a, HALF, b, a, b, -HALF, a, b, HALF);
            }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.Float32BufferAttribute(segs, 3));
            const css = getComputedStyle(document.documentElement).getPropertyValue("--border").trim();
            scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(css ? `hsl(${css.replace(/\s+/g, ", ")})` : "#d6d9e3") })));
            // Axis ends and names.
            const axis = "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] text-muted-foreground";
            const title = "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-semibold text-foreground";
            label(short(rx[0]), [-HALF, -HALF - 6, HALF + 6], axis);
            label(short(rx[1]), [HALF, -HALF - 6, HALF + 6], axis);
            label(`${name(xField)} →`, [0, -HALF - 14, HALF + 10], title);
            label(short(ry[0]), [-HALF - 8, -HALF, HALF], axis);
            label(short(ry[1]), [-HALF - 8, HALF, HALF], axis);
            label(`${name(yFields[0]!)} ↑`, [-HALF - 12, HALF + 10, HALF], title);
            label(short(rz[0]), [HALF + 8, -HALF - 6, -HALF], axis);
            label(short(rz[1]), [HALF + 8, -HALF - 6, HALF], axis);
            label(`${name(zField)} →`, [HALF + 16, -HALF - 14, 0], title);
            // Points: one sphere geometry, a material per colour.
            const sphere = new THREE.SphereGeometry(1.5, 12, 9);
            const mats = new Map<string, any>();
            const matFor = (col: string) => { if (!mats.has(col)) mats.set(col, new THREE.MeshLambertMaterial({ color: new THREE.Color(col) })); return mats.get(col); };
            const faint = new THREE.MeshLambertMaterial({ color: new THREE.Color("#a0a6b8"), transparent: true, opacity: 0.45 });
            for (const p of pts) {
              const col = colourOf(p.group);
              const mesh = new THREE.Mesh(sphere, col ? matFor(col) : faint);
              mesh.position.set(at(p.x, rx), at(p.y, ry), at(p.z, rz));
              scene.add(mesh);
              hoverable(mesh, () => `${inZone(p) && zone?.label ? zone.label + "\n" : ""}${p.group ? p.group + "\n" : ""}${name(xField)}: ${short(p.x)}\n${name(yFields[0]!)}: ${short(p.y)}\n${name(zField)}: ${short(p.z)}`);
            }
            // The zone: a translucent box in the accent, its label above it.
            if (zone) {
              const [x0, x1] = zoneSpan(zone.x, rx), [y0, y1] = zoneSpan(zone.y, ry), [z0, z1] = zoneSpan(zone.z, rz);
              if (x1 > x0 && y1 > y0 && z1 > z0) {
                const [ax0, ax1, ay0, ay1, az0, az1] = [at(x0, rx), at(x1, rx), at(y0, ry), at(y1, ry), at(z0, rz), at(z1, rz)];
                const accent = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
                const tone = new THREE.Color(accent ? `hsl(${accent.replace(/\s+/g, ", ")})` : "#4a43d4");
                const geom = new THREE.BoxGeometry(ax1 - ax0, ay1 - ay0, az1 - az0);
                const box = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ color: tone, transparent: true, opacity: 0.1, depthWrite: false }));
                const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom), new THREE.LineBasicMaterial({ color: tone }));
                for (const o of [box, edges]) { o.position.set((ax0 + ax1) / 2, (ay0 + ay1) / 2, (az0 + az1) / 2); scene.add(o); }
                if (zone.label) label(zone.label, [(ax0 + ax1) / 2, ay1 + 6, (az0 + az1) / 2], title);
              }
            }
          }}
        />
      </div>
      {groups.length > 1 && (
        <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 pt-1 text-[10px] text-muted-foreground">
          {groups.map((g) => (
            <span key={g} className="inline-flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: colourOf(g) ?? undefined }} />{g}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** x against y, same colours — what a 3D scatter is on paper. */
function FlatScatter({ pts, rx, ry, colourOf, xLabel, yLabel, short }: {
  pts: Pt[]; rx: [number, number]; ry: [number, number]; colourOf: (g: string) => string | null;
  xLabel: string; yLabel: string; short: (v: number) => string;
}) {
  const W = 440, H = 260, left = 48, right = W - 10, top = 12, bottom = H - 30;
  const sx = (v: number) => left + ((v - rx[0]) / (rx[1] - rx[0])) * (right - left);
  const sy = (v: number) => bottom - ((v - ry[0]) / (ry[1] - ry[0])) * (bottom - top);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full max-h-full w-full max-w-full">
      <line x1={left} x2={right} y1={bottom} y2={bottom} stroke={GRID_STROKE} />
      <line x1={left} x2={left} y1={top} y2={bottom} stroke={GRID_STROKE} />
      <text x={left} y={bottom + 12} fontSize={9} fill={LABEL_FILL}>{short(rx[0])}</text>
      <text x={right} y={bottom + 12} fontSize={9} fill={LABEL_FILL} textAnchor="end">{short(rx[1])}</text>
      <text x={(left + right) / 2} y={H - 4} fontSize={10} fill={LABEL_FILL} textAnchor="middle">{xLabel}</text>
      <text x={left - 6} y={bottom} fontSize={9} fill={LABEL_FILL} textAnchor="end">{short(ry[0])}</text>
      <text x={left - 6} y={top + 6} fontSize={9} fill={LABEL_FILL} textAnchor="end">{short(ry[1])}</text>
      <text x={12} y={(top + bottom) / 2} fontSize={10} fill={LABEL_FILL} textAnchor="middle" transform={`rotate(-90 12 ${(top + bottom) / 2})`}>{yLabel}</text>
      {pts.map((p, i) => (
        <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={2.2} fill={colourOf(p.group) ?? DEEMPHASIS_FILL} fillOpacity={0.75} />
      ))}
    </svg>
  );
}
