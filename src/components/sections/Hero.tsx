"use client";

import { createRoot, type Root } from "react-dom/client";
import { useEffect } from "react";
import { KineticBrandmark } from "./hero/KineticBrandmark";

declare global {
  interface Window {
    __bigMamaLoaderComplete?: boolean;
  }
}

const LOADER_COMPLETE_EVENT = "bigmama:loader-complete";
const HERO_ENTRANCE_ANIMATION = "heroLoaderItem";
/** Bounded wait for the hero entrance animation to settle after loader completion. */
const ENTRANCE_FALLBACK_MS = 1200;
/** Bounded wait for app.js to report loader completion (CDN failure, loader-less builds). */
const LOADER_FALLBACK_MS = 6000;
/** Ceiling on the backing-store ratio. It must cover the common phone ratios
 *  (2 and 3) exactly: below the device's own ratio the browser upscales the
 *  bitmap to fit the aperture and the ink goes soft, which is the one thing
 *  this mechanism cannot afford. */
const MAX_DPR = 3;
/** Ceiling on projection bands per lane. The band mapping is linear inside each
 *  band while the true mapping is not, but across this aperture the deviation
 *  stays under a hundredth of a pixel, so the surface still reads as continuous
 *  and the saved draw calls go straight into frame budget on weaker hardware. */
const MAX_BANDS = 64;
/** Stops used to bake the static cylindrical shading gradient. */
const SHADE_STOPS = 32;
/** Bounded retries when a layout pass measures an aperture mid-reflow. */
const MAX_LAYOUT_RETRIES = 12;
/** Shortest resting hold the cadence may leave, so a mis-tuned cycle can never
 *  chain turns back to back and the phrase always stays readable. */
const MIN_HOLD_MS = 1500;

type Tunables = {
  turnMs: number;
  laneOffsetMs: number;
  /** Start-to-start period of the whole three-lane sequence. */
  cycleMs: number;
  bias: number;
  slots: number;
  slotRatio: number;
  depth: number;
  waist: number;
  surface: string;
  /** Drum material: a bone wash laid over the page, carried by the texture so
   *  it rotates with the surface. */
  body: string;
  bodyAlpha: number;
  grain: number;
  tooth: number;
  sheen: number;
  sheenSpread: number;
  shade: number;
  shadeStart: number;
  shadeGamma: number;
  shadeTop: number;
  lip: number;
  lipStart: number;
  lipLine: number;
  lipCatch: number;
  seam: number;
  seamSoft: number;
  seamLand: number;
};

/** Mirrors the .odometer block in styles.css, which owns every one of these.
 *  Used only when a custom property cannot be read. */
const DEFAULTS: Tunables = {
  turnMs: 940,
  laneOffsetMs: 104,
  cycleMs: 4500,
  bias: 0.58,
  slots: 6,
  slotRatio: 0.86,
  depth: 7,
  waist: 0.16,
  surface: "26, 18, 12",
  body: "34, 26, 18",
  bodyAlpha: 0,
  grain: 0,
  tooth: 0,
  sheen: 0.05,
  sheenSpread: 1,
  shade: 0.12,
  shadeStart: 0,
  shadeGamma: 1.8,
  shadeTop: 0.72,
  lip: 0,
  lipStart: 0.72,
  lipLine: 0,
  lipCatch: 0,
  seam: 0,
  seamSoft: 0.022,
  seamLand: 0,
};

type Geometry = {
  dpr: number;
  /** Aperture size in device pixels. */
  width: number;
  height: number;
  /** Drum radius and eye distance, device pixels. */
  radius: number;
  eye: number;
  /** Arc length of one drum slot, an even number of device pixels. */
  slotArc: number;
  halfSlot: number;
  /** Two slots: the surface repeats A,B around the drum. */
  period: number;
  textureHeight: number;
  /** Destination band edges down the aperture; length bands + 1. */
  bandTop: Int32Array;
  /** Surface arc offset at each band edge, relative to the aperture centre. */
  bandArc: Int32Array;
  /** Perspective-narrowed destination box per band. */
  bandLeft: Float64Array;
  bandWidth: Float64Array;
};

type Lane = {
  laneEl: HTMLElement;
  windowEl: HTMLElement;
  phraseEl: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  phrases: readonly [string, string];
  /** Reused across rebuilds: allocating a fresh canvas per layout pass piles up
   *  backing stores that the browser only reclaims at GC. */
  strip?: HTMLCanvasElement;
  texture?: HTMLCanvasElement;
  /** Everything the texture is derived from. A layout pass that changes none of
   *  it reuses the drum instead of repainting it. */
  textureKey?: string;
  geometry?: Geometry;
  shading?: CanvasGradient;
};

type OdometerController = { destroy: () => void };

type OdometerElement = HTMLHeadingElement & {
  __odometerController?: OdometerController;
};

function readMs(styles: CSSStyleDeclaration, property: string, fallback: number) {
  const raw = styles.getPropertyValue(property).trim();
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  if (raw.endsWith("ms")) return value;
  if (raw.endsWith("s")) return value * 1000;
  return value;
}

function readNumber(styles: CSSStyleDeclaration, property: string, fallback: number) {
  const value = Number.parseFloat(styles.getPropertyValue(property));
  return Number.isFinite(value) ? value : fallback;
}

/** "26 18 12" or "26, 18, 12" to a canvas-safe "r, g, b" triple. */
function readRgb(styles: CSSStyleDeclaration, property: string, fallback: string) {
  const parts = styles
    .getPropertyValue(property)
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part))
    .filter((part) => Number.isFinite(part));
  return parts.length === 3 ? parts.join(", ") : fallback;
}

function readTunables(headline: HTMLElement): Tunables {
  const s = window.getComputedStyle(headline);
  return {
    turnMs: Math.max(1, readMs(s, "--odo-turn", DEFAULTS.turnMs)),
    laneOffsetMs: Math.max(0, readMs(s, "--odo-lane-offset", DEFAULTS.laneOffsetMs)),
    cycleMs: Math.max(1, readMs(s, "--odo-cycle", DEFAULTS.cycleMs)),
    // Keeping the warp below 1 keeps angular velocity strictly positive: the
    // drum can never stall or creep backwards mid-turn.
    bias: Math.min(0.95, Math.max(0, readNumber(s, "--odo-bias", DEFAULTS.bias))),
    slots: Math.max(2, readNumber(s, "--odo-slots", DEFAULTS.slots)),
    slotRatio: Math.min(1, Math.max(0.3, readNumber(s, "--odo-slot-ratio", DEFAULTS.slotRatio))),
    depth: Math.max(1.5, readNumber(s, "--odo-depth", DEFAULTS.depth)),
    waist: Math.min(1, Math.max(0, readNumber(s, "--odo-waist", DEFAULTS.waist))),
    surface: readRgb(s, "--odo-surface-rgb", DEFAULTS.surface),
    body: readRgb(s, "--odo-body-rgb", DEFAULTS.body),
    bodyAlpha: Math.max(0, readNumber(s, "--odo-body", DEFAULTS.bodyAlpha)),
    grain: Math.max(0, readNumber(s, "--odo-grain", DEFAULTS.grain)),
    tooth: Math.max(0, readNumber(s, "--odo-tooth", DEFAULTS.tooth)),
    sheen: Math.max(0, readNumber(s, "--odo-sheen", DEFAULTS.sheen)),
    sheenSpread: Math.min(1, Math.max(0.1, readNumber(s, "--odo-sheen-spread", DEFAULTS.sheenSpread))),
    shade: readNumber(s, "--odo-shade", DEFAULTS.shade),
    shadeStart: Math.min(0.9, Math.max(0, readNumber(s, "--odo-shade-start", DEFAULTS.shadeStart))),
    shadeGamma: Math.max(0.2, readNumber(s, "--odo-shade-gamma", DEFAULTS.shadeGamma)),
    shadeTop: readNumber(s, "--odo-shade-top", DEFAULTS.shadeTop),
    lip: readNumber(s, "--odo-lip", DEFAULTS.lip),
    lipStart: readNumber(s, "--odo-lip-start", DEFAULTS.lipStart),
    lipLine: Math.max(0, readNumber(s, "--odo-lip-line", DEFAULTS.lipLine)),
    lipCatch: Math.max(0, readNumber(s, "--odo-lip-catch", DEFAULTS.lipCatch)),
    seam: readNumber(s, "--odo-seam", DEFAULTS.seam),
    seamSoft: Math.max(0.002, readNumber(s, "--odo-seam-soft", DEFAULTS.seamSoft)),
    seamLand: Math.max(0, readNumber(s, "--odo-seam-land", DEFAULTS.seamLand)),
  };
}

function smoothstep(edge0: number, edge1: number, value: number) {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Offset from the aperture centre, in device px, of the surface point at angle
 *  `angle` from the front of the drum. Magnification is exactly 1 at angle 0. */
function projectY(angle: number, radius: number, eye: number) {
  return radius * Math.sin(angle) * (eye / (eye + radius * (1 - Math.cos(angle))));
}

function magnify(angle: number, radius: number, eye: number) {
  return eye / (eye + radius * (1 - Math.cos(angle)));
}

/** Inverse of projectY. The projection is monotonic on (-PI/2, PI/2), so
 *  bisection converges without the overshoot a Newton step risks near the lips. */
function angleForY(y: number, radius: number, eye: number) {
  const limit = Math.PI / 2 - 1e-4;
  const target = Math.abs(y);
  const sign = y < 0 ? -1 : 1;
  if (projectY(limit, radius, eye) <= target) return sign * limit;
  let lo = 0;
  let hi = limit;
  for (let i = 0; i < 48; i += 1) {
    const mid = (lo + hi) * 0.5;
    if (projectY(mid, radius, eye) < target) lo = mid;
    else hi = mid;
  }
  return (sign * (lo + hi)) / 2;
}

function buildGeometry(
  widthCss: number,
  heightCss: number,
  dpr: number,
  t: Tunables
): Geometry | undefined {
  const width = Math.round(widthCss * dpr);
  const height = Math.round(heightCss * dpr);
  if (!(width > 1) || !(height > 1)) return undefined;

  // An even slot arc keeps halfSlot integral, so at rest every band samples the
  // texture at a whole-pixel offset and the indexed phrase is a 1:1 pixel copy.
  const slotArc = Math.max(2, 2 * Math.round((t.slotRatio * height) / 2));
  const slots = Math.max(2, 2 * Math.round(t.slots / 2));
  const radius = (slots * slotArc) / (2 * Math.PI);
  const eye = t.depth * radius;
  // The aperture has to stay inside the drum's visible half, or the projection
  // would have to show surface that has already rotated out of sight.
  if (projectY(Math.PI / 2 - 1e-4, radius, eye) <= height / 2) return undefined;

  const bandPx = Math.max(1, Math.round(dpr), Math.ceil(height / MAX_BANDS));
  const bands = Math.ceil(height / bandPx);
  const bandTop = new Int32Array(bands + 1);
  const bandArc = new Int32Array(bands + 1);
  const bandLeft = new Float64Array(bands);
  const bandWidth = new Float64Array(bands);
  const centre = height / 2;

  for (let i = 0; i <= bands; i += 1) {
    const top = Math.min(height, i * bandPx);
    bandTop[i] = top;
    // One source pixel maps to one destination pixel at the drum front, so
    // rounding the arc offsets is lossless there and keeps resting ink crisp.
    const arc = Math.round(radius * angleForY(top - centre, radius, eye));
    bandArc[i] = i > 0 && arc <= bandArc[i - 1] ? bandArc[i - 1] + 1 : arc;
  }
  for (let i = 0; i < bands; i += 1) {
    const midY = (bandTop[i] + bandTop[i + 1]) * 0.5 - centre;
    const scale = magnify(angleForY(midY, radius, eye), radius, eye);
    // Horizontal narrowing is damped. Full perspective waisting is geometrically
    // right but, against left-aligned type this wide, it shifts glyph tops
    // inward enough to read as an italic shear rather than as depth.
    const scaled = width * (1 - t.waist * (1 - scale));
    bandWidth[i] = scaled;
    bandLeft[i] = (width - scaled) * 0.5;
  }

  return {
    dpr,
    width,
    height,
    radius,
    eye,
    slotArc,
    halfSlot: slotArc / 2,
    period: slotArc * 2,
    // Three slots, so a band sampled anywhere inside the two-slot period always
    // has a full slot of valid texture beneath it and never wraps mid-band.
    textureHeight: slotArc * 3,
    bandTop,
    bandArc,
    bandLeft,
    bandWidth,
  };
}

/** Deterministic value noise. Seeded so a rebuild reproduces the same grain
 *  exactly: the material must not crawl when the aperture is re-measured. */
function noise2(x: number, y: number, seed: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 362437);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The drum's material, one period tall so it tiles in phase with the surface.
 *  Horizontal machining grain plus a fine isotropic tooth over a bone wash:
 *  the grain runs along the axis of rotation, which is both what a turned drum
 *  looks like and what resamples cleanly when the surface moves vertically. */
function buildSurfaceStrip(lane: Lane, geometry: Geometry, t: Tunables) {
  const { width, period } = geometry;
  const strip = lane.strip ?? document.createElement("canvas");
  strip.width = width;
  strip.height = period;
  const sx = strip.getContext("2d");
  if (!sx) return undefined;

  const image = sx.createImageData(width, period);
  const data = image.data;
  const [r, g, b] = t.body.split(",").map((v) => Number.parseFloat(v));
  for (let y = 0; y < period; y += 1) {
    // One grain value per row: constant across the lane, so it reads as a
    // turned surface rather than as noise.
    const grain = (noise2(0, y, 11) - 0.5) * t.grain;
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      // Tooth sampled at half resolution: low frequency enamel, and it keeps
      // the strip cheap enough to rebuild inside one frame.
      const tooth = (noise2(x >> 1, y >> 1, 29) - 0.5) * t.tooth;
      const alpha = Math.min(1, Math.max(0, t.bodyAlpha + grain + tooth));
      const i = rowStart + x * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  sx.putImageData(image, 0, 0);
  return strip;
}

/** Unrolls the drum: material, sheen, scribed seams and the two phrases mounted
 *  in alternating slots. Rebuilt only on layout changes, never per frame. */
function buildTexture(lane: Lane, geometry: Geometry, t: Tunables) {
  const { width, slotArc, textureHeight, dpr } = geometry;

  // Repainting the drum means regenerating the material strip pixel by pixel.
  // Layout passes fire far more often than the texture actually changes (every
  // aperture resize observation, every font-readiness callback), so derive a
  // key first and reuse the existing drum whenever nothing it depends on moved.
  const inkStyles = window.getComputedStyle(lane.phraseEl);
  const key = [
    width, textureHeight, slotArc, dpr,
    inkStyles.fontSize, inkStyles.fontWeight, inkStyles.fontStyle,
    inkStyles.fontFamily, inkStyles.letterSpacing, inkStyles.color,
    inkStyles.paddingLeft, inkStyles.paddingRight,
    lane.phrases[0], lane.phrases[1],
    t.body, t.bodyAlpha, t.grain, t.tooth, t.sheen, t.sheenSpread,
    t.surface, t.seam, t.seamSoft, t.seamLand,
  ].join("|");
  if (lane.texture && lane.textureKey === key) return lane.texture;

  const texture = lane.texture ?? document.createElement("canvas");
  texture.width = width;
  texture.height = textureHeight;
  const tx = texture.getContext("2d");
  if (!tx) return undefined;
  tx.clearRect(0, 0, width, textureHeight);

  // 1. Material. The strip is exactly one period tall, so tiling it keeps the
  //    grain in phase with the drum: nothing jumps at the sampling wrap.
  //    With body, grain and tooth all zero (the glass material) there is no
  //    wash to lay down, so the per-pixel strip is skipped entirely.
  const strip =
    t.bodyAlpha + t.grain + t.tooth > 0 ? buildSurfaceStrip(lane, geometry, t) : undefined;
  if (strip) {
    lane.strip = strip;
    for (let y = 0; y < textureHeight; y += geometry.period) tx.drawImage(strip, 0, y);
  }

  // 2. Sheen: a broad gloss anchored to each slot, so it sweeps through the
  //    aperture as the drum turns. This is the surface catching the light,
  //    and it is the one cue that only exists while the mechanism is moving.
  if (t.sheen > 0) {
    const half = Math.max(2, (t.sheenSpread * slotArc) / 2);
    for (let slot = 0; slot < 3; slot += 1) {
      const centre = (slot + 0.5) * slotArc;
      const gloss = tx.createLinearGradient(0, centre - half, 0, centre + half);
      gloss.addColorStop(0, "rgba(255, 255, 255, 0)");
      gloss.addColorStop(0.5, `rgba(255, 255, 255, ${t.sheen})`);
      gloss.addColorStop(1, "rgba(255, 255, 255, 0)");
      tx.fillStyle = gloss;
      tx.fillRect(0, centre - half, width, half * 2);
    }
  }

  const styles = inkStyles;
  const fontSize = Number.parseFloat(styles.fontSize) * dpr;
  if (!(fontSize > 0)) return undefined;
  const padLeft = (Number.parseFloat(styles.paddingLeft) || 0) * dpr;
  const padRight = (Number.parseFloat(styles.paddingRight) || 0) * dpr;
  const inkWidth = Math.max(1, width - padLeft - padRight);

  tx.font = `${styles.fontStyle} ${styles.fontWeight} ${fontSize}px ${styles.fontFamily}`;
  tx.fillStyle = styles.color;
  tx.textAlign = "left";
  tx.textBaseline = "alphabetic";
  const spacing = Number.parseFloat(styles.letterSpacing);
  if (Number.isFinite(spacing) && spacing !== 0 && "letterSpacing" in tx) {
    (tx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${
      spacing * dpr
    }px`;
  }

  // 3. Scribed slot seams: a cut groove with the lit land riding above it. They
  //    travel with the drum, which is why the mechanism reads as a drum even
  //    while it is stationary.
  const soft = Math.max(1, t.seamSoft * slotArc);
  const seams = t.seam > 0 || t.seamLand > 0 ? 3 : -1;
  for (let edge = 0; edge <= seams; edge += 1) {
    const y = edge * slotArc;
    const groove = tx.createLinearGradient(0, y - soft, 0, y + soft);
    groove.addColorStop(0, `rgba(${t.surface}, 0)`);
    groove.addColorStop(0.5, `rgba(${t.surface}, ${t.seam})`);
    groove.addColorStop(1, `rgba(${t.surface}, 0)`);
    tx.fillStyle = groove;
    tx.fillRect(0, y - soft, width, soft * 2);
    if (t.seamLand > 0) {
      const landCentre = y - soft * 0.95;
      const landHalf = Math.max(1, soft * 0.7);
      const land = tx.createLinearGradient(0, landCentre - landHalf, 0, landCentre + landHalf);
      land.addColorStop(0, "rgba(255, 255, 255, 0)");
      land.addColorStop(0.5, `rgba(255, 255, 255, ${t.seamLand})`);
      land.addColorStop(1, "rgba(255, 255, 255, 0)");
      tx.fillStyle = land;
      tx.fillRect(0, landCentre - landHalf, width, landHalf * 2);
    }
  }

  // 4. Ink last, so the phrases sit on the material instead of under it.
  tx.save();
  // Clip rather than condense, so over-long type is cut by the aperture exactly
  // as the flat specimen would be instead of being optically distorted.
  tx.beginPath();
  tx.rect(padLeft, 0, inkWidth, textureHeight);
  tx.clip();
  tx.fillStyle = styles.color;
  for (let slot = 0; slot < 3; slot += 1) {
    const phrase = lane.phrases[slot % 2 === 0 ? 0 : 1].toUpperCase();
    const metrics = tx.measureText(phrase);
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
    // Centre the real ink box, not the em box, so caps sit optically dead
    // centre in the slot when the drum is on its index.
    const inkCentre =
      Number.isFinite(ascent) && Number.isFinite(descent)
        ? (ascent - descent) * 0.5
        : fontSize * 0.35;
    tx.fillText(phrase, padLeft, (slot + 0.5) * slotArc + inkCentre);
  }
  tx.restore();

  lane.textureKey = key;
  return texture;
}

/** Shading depends only on the surface angle, which depends only on the
 *  aperture row, so it is baked once and painted in a single fill per frame. */
function buildShading(ctx: CanvasRenderingContext2D, geometry: Geometry, t: Tunables) {
  const { height, radius, eye } = geometry;
  const centre = height / 2;
  const lipAngle = Math.abs(angleForY(centre, radius, eye)) || 1;
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  for (let i = 0; i <= SHADE_STOPS; i += 1) {
    const stop = i / SHADE_STOPS;
    const y = stop * height - centre;
    const ratio = Math.min(1, Math.abs(angleForY(y, radius, eye)) / lipAngle);
    // Surface turning away from the viewer, plus the tighter shadow cast by the
    // recessed lip itself. Light falls from above, so the top lip stays lighter.
    // The falloff runs continuously from the crown and is shaped by a gamma, so
    // the drum reads as one curved body rather than a flat face with grey edges.
    const reach = t.shadeStart >= 1 ? 0 : Math.max(0, (ratio - t.shadeStart) / (1 - t.shadeStart));
    const cylinder = t.shade * Math.pow(reach, t.shadeGamma);
    const lip = t.lip * smoothstep(t.lipStart, 1, ratio);
    const alpha = Math.min(0.6, (cylinder + lip) * (y < 0 ? t.shadeTop : 1));
    gradient.addColorStop(stop, `rgba(${t.surface}, ${alpha.toFixed(4)})`);
  }
  return gradient;
}

/** Angular position for normalised turn progress, as a fraction of one slot. */
function easeIndex(u: number, bias: number) {
  // Smooth monotonic time warp. w' = 1 + bias*(1 - 2u) stays positive for
  // bias < 1, so the drum only ever rotates forward, and the velocity peak
  // moves early: firm mechanical engagement, long progressive braking.
  const w = u + bias * u * (1 - u);
  // Quintic smoothstep has zero velocity AND zero acceleration at both ends, so
  // engagement is jerk-free and the indexed stop lands dead with no bounce,
  // no recoil and no residual float.
  return w * w * w * (w * (w * 6 - 15) + 10);
}

function drawLane(lane: Lane, baseArc: number, t: Tunables) {
  const geometry = lane.geometry;
  const texture = lane.texture;
  const shading = lane.shading;
  if (!geometry || !texture || !shading) return;
  const { ctx } = lane;
  const { width, height, period, halfSlot, bandTop, bandArc, bandLeft, bandWidth } = geometry;

  ctx.clearRect(0, 0, width, height);
  for (let i = 0; i < bandWidth.length; i += 1) {
    const destTop = bandTop[i];
    const destHeight = bandTop[i + 1] - destTop;
    const srcHeight = bandArc[i + 1] - bandArc[i];
    if (destHeight <= 0 || srcHeight <= 0) continue;
    let srcTop = (bandArc[i] + baseArc + halfSlot) % period;
    if (srcTop < 0) srcTop += period;
    ctx.drawImage(
      texture,
      0,
      srcTop,
      width,
      srcHeight,
      bandLeft[i],
      destTop,
      bandWidth[i],
      destHeight
    );
  }
  // Cylindrical falloff, composited source-atop: it darkens only what the drum
  // already put down (the ink as it rolls toward a lip) and leaves the clear
  // glass untouched. save/restore returns the context to source-over, so the
  // next frame's clearRect and texture bands composite normally.
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = shading;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  // The milled aperture edge: a hard contact line where the lip meets the drum,
  // and a chamfer catch just inside the top lip. Both are aperture-space, so
  // they stay dead still while the surface moves behind them.
  const edge = Math.max(1, Math.round(geometry.dpr));
  if (t.lipLine > 0) {
    ctx.fillStyle = `rgba(${t.surface}, ${t.lipLine})`;
    ctx.fillRect(0, 0, width, edge);
    ctx.fillRect(0, height - edge, width, edge);
  }
  if (t.lipCatch > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${t.lipCatch})`;
    ctx.fillRect(0, edge, width, edge);
  }
}

function initializeOdometer(headline: OdometerElement) {
  if (headline.__odometerController) return headline.__odometerController;

  const laneEls = Array.from(headline.querySelectorAll<HTMLElement>("[data-odometer-lane]"));
  if (laneEls.length === 0) return undefined;

  const lanes: Lane[] = [];
  for (const laneEl of laneEls) {
    const windowEl = laneEl.querySelector<HTMLElement>(".odometer__window");
    const phraseEl = laneEl.querySelector<HTMLElement>(".odometer__phrase");
    const canvas = laneEl.querySelector<HTMLCanvasElement>("[data-odometer-surface]");
    const phrases = (laneEl.dataset.odometerPhrases ?? "")
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);
    if (!windowEl || !phraseEl || !canvas || phrases.length < 2) return undefined;
    const ctx = canvas.getContext("2d");
    // Without a context there is no mechanism; the flat specimen stays in place.
    if (!ctx) return undefined;
    lanes.push({
      laneEl,
      windowEl,
      phraseEl,
      canvas,
      ctx,
      phrases: [phrases[0], phrases[1]] as const,
    });
  }

  // Re-read on every layout pass, so a breakpoint may retune the mechanism and
  // styles.css stays the single source of truth for the whole choreography.
  let tunables = readTunables(headline);
  const hero = headline.closest<HTMLElement>(".hero");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /** Monotonically increasing slot index. The drum never decreases it, so there
   *  is no reverse sweep and no angle reset to flash through. */
  let index = 0;
  let turning = false;
  let turnStart = 0;
  let live = false;
  let destroyed = false;
  let clockStarted = false;
  let heroVisible = true;
  let pageVisible = !document.hidden;
  let frameId: number | undefined;
  let layoutId: number | undefined;
  let layoutRetries = 0;
  let holdTimer: number | undefined;
  let entranceTimer: number | undefined;
  let loaderTimer: number | undefined;

  const canRun = () => !destroyed && live && !reducedMotion.matches && heroVisible && pageVisible;

  const clearHold = () => {
    if (holdTimer !== undefined) window.clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  const cancelFrame = () => {
    if (frameId !== undefined) window.cancelAnimationFrame(frameId);
    frameId = undefined;
  };

  const setLive = (next: boolean) => {
    live = next;
    headline.classList.toggle("is-live", next);
  };

  /** Draws every lane for the current angular position. Returns true while any
   *  lane is still short of its index. */
  const render = (now?: number) => {
    let active = false;
    for (let i = 0; i < lanes.length; i += 1) {
      const lane = lanes[i];
      const geometry = lane.geometry;
      if (!geometry) continue;
      let steps = index;
      if (turning && now !== undefined) {
        const elapsed = now - (turnStart + i * tunables.laneOffsetMs);
        const progress = Math.min(1, Math.max(0, elapsed / tunables.turnMs));
        if (progress < 1) active = true;
        steps = index - 1 + easeIndex(progress, tunables.bias);
      }
      drawLane(lane, steps * geometry.slotArc, tunables);
    }
    return active;
  };

  /** Arms the single hold timer. A deadline that is already pending is kept:
   *  layout passes (resize, font readiness) must never postpone a scheduled
   *  turn. Only clearHold — on hide, leave or motion-preference change — drops
   *  it, so a resume always starts a fresh, full readable hold. */
  function scheduleHold(delay = tunables.cycleMs) {
    if (holdTimer !== undefined) return;
    if (!clockStarted || turning || !canRun()) return;
    holdTimer = window.setTimeout(() => {
      holdTimer = undefined;
      startTurn();
    }, Math.max(MIN_HOLD_MS, delay));
  }

  const finishTurn = () => {
    cancelFrame();
    const completed = turning;
    turning = false;
    headline.classList.remove("is-turning");
    // Dead stop on the index: an integral arc offset, so the new phrase lands
    // as a 1:1 copy of the texture with no resampling softness.
    render();
    // Anchored to this turn's start, so starts land one cycle apart whatever
    // the lane count, turn length, stagger or frame timing actually were.
    if (completed) scheduleHold(turnStart + tunables.cycleMs - performance.now());
  };

  const frame = (now: number) => {
    frameId = undefined;
    if (!turning) return;
    if (!canRun()) {
      finishTurn();
      return;
    }
    if (render(now)) frameId = window.requestAnimationFrame(frame);
    else finishTurn();
  };

  function startTurn() {
    if (!canRun() || turning) return;
    turning = true;
    index += 1;
    turnStart = performance.now();
    headline.classList.add("is-turning");
    headline.dataset.headlinePhase = index % 2 === 0 ? "base" : "alternate";
    cancelFrame();
    frameId = window.requestAnimationFrame(frame);
  }

  /** Never park a half-turned drum: snap straight to the destination index.
   *  Forward-only, so this can never read as a return sweep. */
  const snapToIndex = () => {
    if (!turning) return;
    cancelFrame();
    turning = false;
    headline.classList.remove("is-turning");
    render();
  };

  /** Fits the widest phrase to the hero column. Width-driven and idempotent, so
   *  the resize observer it feeds cannot oscillate. */
  const applyFit = () => {
    const baseSize = Number.parseFloat(window.getComputedStyle(headline).fontSize);
    if (!(baseSize > 0)) return;
    const reference = lanes[0];
    const styles = window.getComputedStyle(reference.phraseEl);
    const padLeft = Number.parseFloat(styles.paddingLeft) || 0;
    const padRight = Number.parseFloat(styles.paddingRight) || 0;
    const available = reference.phraseEl.clientWidth - padLeft - padRight;
    if (!(available > 0)) return;
    const probe = document.createElement("canvas").getContext("2d");
    if (!probe) return;
    probe.font = `${styles.fontStyle} ${styles.fontWeight} ${baseSize}px ${styles.fontFamily}`;
    let widest = 0;
    for (const lane of lanes) {
      for (const phrase of lane.phrases) {
        widest = Math.max(widest, probe.measureText(phrase.toUpperCase()).width);
      }
    }
    if (!(widest > 0)) return;
    const size = Math.min(baseSize, ((baseSize * available) / widest) * 0.975);
    // Only rewrite the size when it actually moves. The fitted size changes the
    // heading's height, which can bring a scrollbar in or out and nudge the
    // available width back; without this dead band the observer that watches
    // the apertures and this fit can chase each other frame after frame.
    for (const lane of lanes) {
      const current = Number.parseFloat(lane.laneEl.style.fontSize);
      if (Number.isFinite(current) && Math.abs(current - size) < 0.25) continue;
      lane.laneEl.style.fontSize = `${size.toFixed(2)}px`;
    }
  };

  /** A layout pass can land while the aperture is mid-reflow — a viewport
   *  change, an emulated device swap, a late scrollbar — and measure a box the
   *  drum cannot be built from. That is transient, so retry instead of leaving
   *  the mechanism dead with the flat specimen showing. */
  const retryLayout = () => {
    if (destroyed || layoutRetries >= MAX_LAYOUT_RETRIES) return;
    layoutRetries += 1;
    window.setTimeout(requestLayout, 120);
  };

  const rebuild = () => {
    tunables = readTunables(headline);
    const dpr = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    for (const lane of lanes) {
      const rect = lane.windowEl.getBoundingClientRect();
      const geometry = buildGeometry(rect.width, rect.height, dpr, tunables);
      if (!geometry) {
        setLive(false);
        retryLayout();
        return;
      }
      lane.canvas.width = geometry.width;
      lane.canvas.height = geometry.height;
      // Pin the element to the backing store's exact CSS size. The aperture box
      // is fractional while a bitmap is not, so letting width/height:100% stretch
      // it would resample every band and soften the indexed ink.
      lane.canvas.style.width = `${geometry.width / dpr}px`;
      lane.canvas.style.height = `${geometry.height / dpr}px`;
      lane.ctx.imageSmoothingEnabled = true;
      lane.ctx.imageSmoothingQuality = "high";
      const texture = buildTexture(lane, geometry, tunables);
      if (!texture) {
        setLive(false);
        retryLayout();
        return;
      }
      lane.texture = texture;
      lane.geometry = geometry;
      lane.shading = buildShading(lane.ctx, geometry, tunables);
    }
    layoutRetries = 0;
    setLive(true);
    render(turning ? performance.now() : undefined);
  };

  const requestLayout = () => {
    if (layoutId !== undefined || destroyed) return;
    layoutId = window.requestAnimationFrame(() => {
      layoutId = undefined;
      if (destroyed) return;
      if (reducedMotion.matches) {
        clearHold();
        snapToIndex();
        setLive(false);
        return;
      }
      applyFit();
      rebuild();
      scheduleHold();
    });
  };

  const clearEntranceWait = () => {
    if (entranceTimer !== undefined) window.clearTimeout(entranceTimer);
    entranceTimer = undefined;
    headline.removeEventListener("animationend", onHeroEntranceEnd);
  };

  const clearLoaderWait = () => {
    if (loaderTimer !== undefined) window.clearTimeout(loaderTimer);
    loaderTimer = undefined;
    window.removeEventListener(LOADER_COMPLETE_EVENT, onLoaderComplete);
  };

  const startClock = () => {
    if (clockStarted || destroyed) return;
    clearEntranceWait();
    clockStarted = true;
    scheduleHold();
  };

  function onHeroEntranceEnd(event: AnimationEvent) {
    if (event.target !== headline || event.animationName !== HERO_ENTRANCE_ANIMATION) return;
    startClock();
  }

  // Readiness contract, unchanged: the first phrase only starts its hold once the
  // loader has handed the page over AND the hero entrance has settled. Both
  // waits are bounded, so a CDN failure cannot strand the mechanism.
  const awaitHeroEntrance = () => {
    if (clockStarted || destroyed) return;
    headline.addEventListener("animationend", onHeroEntranceEnd);
    entranceTimer = window.setTimeout(startClock, ENTRANCE_FALLBACK_MS);
  };

  function onLoaderComplete() {
    clearLoaderWait();
    awaitHeroEntrance();
  }

  const handleVisibility = () => {
    pageVisible = !document.hidden;
    if (pageVisible) {
      scheduleHold();
      return;
    }
    clearHold();
    snapToIndex();
  };

  const handleMotionPreference = () => {
    clearHold();
    snapToIndex();
    requestLayout();
  };

  const observer =
    hero && "IntersectionObserver" in window
      ? new IntersectionObserver((entries) => {
          heroVisible = entries[0]?.isIntersecting ?? true;
          if (heroVisible) {
            scheduleHold();
            return;
          }
          clearHold();
          snapToIndex();
        })
      : undefined;
  if (hero) observer?.observe(hero);

  const resizeObserver =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(requestLayout) : undefined;
  resizeObserver?.observe(headline);
  // Also watch each aperture: a late scrollbar or a font swap can move the box by
  // a pixel without resizing the heading, and the backing store has to follow it.
  for (const lane of lanes) resizeObserver?.observe(lane.windowEl);
  window.addEventListener("resize", requestLayout);
  document.fonts?.ready.then(() => {
    if (!destroyed) requestLayout();
  });
  document.addEventListener("visibilitychange", handleVisibility);
  reducedMotion.addEventListener("change", handleMotionPreference);
  headline.dataset.headlinePhase = "base";
  requestLayout();

  if (window.__bigMamaLoaderComplete) {
    awaitHeroEntrance();
  } else {
    window.addEventListener(LOADER_COMPLETE_EVENT, onLoaderComplete);
    loaderTimer = window.setTimeout(() => {
      clearLoaderWait();
      awaitHeroEntrance();
    }, LOADER_FALLBACK_MS);
  }

  const controller: OdometerController = {
    destroy: () => {
      destroyed = true;
      cancelFrame();
      clearHold();
      clearEntranceWait();
      clearLoaderWait();
      if (layoutId !== undefined) window.cancelAnimationFrame(layoutId);
      layoutId = undefined;
      resizeObserver?.disconnect();
      observer?.disconnect();
      window.removeEventListener("resize", requestLayout);
      document.removeEventListener("visibilitychange", handleVisibility);
      reducedMotion.removeEventListener("change", handleMotionPreference);
      turning = false;
      headline.classList.remove("is-live", "is-turning");
      for (const lane of lanes) {
        lane.laneEl.style.removeProperty("font-size");
        lane.canvas.style.removeProperty("width");
        lane.canvas.style.removeProperty("height");
        lane.strip = undefined;
        lane.texture = undefined;
        lane.textureKey = undefined;
        lane.geometry = undefined;
        lane.shading = undefined;
      }
      if (headline.__odometerController === controller) delete headline.__odometerController;
    },
  };
  headline.__odometerController = controller;
  return controller;
}

export function HeroMotion() {
  useEffect(() => {
    const hero = document.querySelector<HTMLElement>(".hero");
    const visual = hero?.querySelector<HTMLElement>(".hero__visual");
    if (!hero || !visual) return;

    let root: Root | undefined;

    visual.replaceChildren();
    root = createRoot(visual);
    root.render(<KineticBrandmark heroElement={hero} />);

    return () => root?.unmount();
  }, []);

  useEffect(() => {
    const headline = document.querySelector<OdometerElement>("[data-odometer]");
    const controller = headline ? initializeOdometer(headline) : undefined;
    return () => controller?.destroy();
  }, []);

  return null;
}
