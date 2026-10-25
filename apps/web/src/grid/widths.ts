import { addressItemToken, type AddressSpec, type FirewallRule, type PortSpec } from "@ruledeck/core";
import type { Column } from "./columns.tsx";
import { itemLabel, type ObjectContext } from "./objects.ts";

/**
 * Column widths from content: each column is as wide as its longest value
 * (and its header), so nothing gets truncated. Measured with a canvas using the
 * grid's font; chips add their badge and padding.
 */

const CELL_PADDING = 14; // td padding left+right + a little air
const CHIP_EXTRA = 30; // badge (15) + gap + chip padding
const CHIP_GAP = 3;
const NOT_TAG = 34;
const ISSUE_ICON = 18;

let canvas: HTMLCanvasElement | null = null;
function measurer(font: string): (text: string) => number {
  if (typeof document === "undefined") return (t) => t.length * 7.5; // tests / no DOM
  canvas ??= document.createElement("canvas");
  const c2d = canvas.getContext("2d");
  if (!c2d) return (t) => t.length * 7.5;
  c2d.font = font;
  return (t) => c2d.measureText(t).width;
}

function gridFont(weight = "400"): string {
  const family = typeof document !== "undefined" ? getComputedStyle(document.body).fontFamily : "sans-serif";
  return `${weight} 13px ${family || "sans-serif"}`;
}

function addressWidth(spec: AddressSpec, ctx: ObjectContext, m: (t: string) => number, chipM: (t: string) => number): number {
  if (spec.items.length === 0) return m(spec.negate ? "NOT any" : "any");
  let w = spec.negate ? NOT_TAG : 0;
  spec.items.forEach((i, idx) => {
    w += chipM(i.kind === "alias" ? i.name : itemLabel(i, ctx) || addressItemToken(i)) + CHIP_EXTRA + (idx > 0 ? CHIP_GAP : 0);
  });
  return w;
}

function portWidth(p: PortSpec, m: (t: string) => number, chipM: (t: string) => number): number {
  if (p.kind === "any") return m("any");
  if (p.kind === "alias") return chipM(p.name) + CHIP_EXTRA;
  return m(p.value);
}

export function measureColumnWidths(columns: Column[], rows: FirewallRule[], ctx: ObjectContext): number[] {
  const m = measurer(gridFont());
  const bold = measurer(gridFont("600"));
  const chip = measurer(gridFont("600").replace("13px", "12px"));
  return columns.map((col) => {
    let max = bold(col.label) + 16;
    for (const r of rows) {
      let w: number;
      switch (col.key) {
        case "source":
          w = addressWidth(r.source, ctx, m, chip);
          break;
        case "destination":
          w = addressWidth(r.destination, ctx, m, chip);
          break;
        case "sourcePort":
          w = portWidth(r.sourcePort, m, chip);
          break;
        case "destinationPort":
          w = portWidth(r.destinationPort, m, chip);
          break;
        case "action":
          w = bold(col.copy(r, ctx)) + 14; // colored marker
          break;
        case "interfaces":
          w = m(r.interfaces.length ? r.interfaces.map((k) => ctx.options.interfaces.find((i) => i.key === k)?.label ?? k).join(", ") : "any (floating)") + (r.interfaceNot ? NOT_TAG : 0);
          break;
        default:
          w = m(col.copy(r, ctx));
      }
      max = Math.max(max, w + ISSUE_ICON);
    }
    return Math.max(col.width >= 60 ? 48 : col.width, Math.ceil(max + CELL_PADDING));
  });
}
