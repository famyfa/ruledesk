import { z } from "zod";
import { OpnsenseError } from "./errors.ts";

/**
 * Schemas for the raw OPNsense responses we consume. They are deliberately
 * loose about extra keys (OPNsense adds fields between releases) but strict
 * about the shapes we rely on.
 */

/** A scalar field value, or an option map `{key: {value, selected}}`. */
const OptionEntry = z.object({ value: z.unknown(), selected: z.union([z.number(), z.boolean(), z.string()]).optional() }).loose();
export const RawFieldValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.record(z.string(), OptionEntry), z.array(z.unknown())]);

export const SearchResponse = z
  .object({
    total: z.coerce.number(),
    rowCount: z.coerce.number(),
    current: z.coerce.number(),
    rows: z.array(z.record(z.string(), z.unknown())),
  })
  .loose();
export type SearchResponse = z.infer<typeof SearchResponse>;

export const FirmwareInfo = z
  .object({
    product_version: z.string().optional(),
    product: z.object({ product_version: z.string().optional() }).loose().optional(),
  })
  .loose();

const LabelledItems = z.object({ label: z.string(), items: z.record(z.string(), z.string()).or(z.array(z.unknown())).optional() }).loose();
export const NetworkSelectOptions = z.object({ aliases: LabelledItems, networks: LabelledItems }).loose();
export const PortSelectOptions = z.object({ aliases: LabelledItems, ports: LabelledItems }).loose();

const InterfaceItem = z.object({ value: z.string(), label: z.string(), type: z.string() }).loose();
export const InterfaceList = z.record(z.string(), z.object({ label: z.string(), items: z.array(InterfaceItem) }).loose());

/**
 * get_rule / get_item with no uuid: model defaults. Field shapes vary by field
 * type and release (option maps, option groups, key/value stores), so only the
 * outer structure is checked here; callers read the one field they need.
 */
export const GetItemResponse = (key: string) => z.object({ [key]: z.record(z.string(), z.unknown()) }).loose();

/**
 * Keys + labels of an OPNsense option map: `{key: {value, selected}}`, or grouped
 * as `{group: {key: {value, selected}}}`.
 */
export function optionKeys(field: unknown): { value: string; label: string }[] {
  if (!field || typeof field !== "object" || Array.isArray(field)) return [];
  const out: { value: string; label: string }[] = [];
  for (const [k, v] of Object.entries(field as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v) && "value" in v) {
      out.push({ value: k, label: String((v as { value: unknown }).value ?? k) });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...optionKeys(v)); // option group
    } else if (typeof v === "string") {
      out.push({ value: k, label: v });
    }
  }
  return out;
}

export const SaveResponse = z.object({ result: z.string(), uuid: z.string().optional() }).loose();
export const StatusResponse = z.object({ status: z.string() }).loose();

/** Field names only (never values), to explain a shape mismatch without leaking data. */
export function describeShape(data: unknown): string {
  if (Array.isArray(data)) return `array(${data.length})`;
  if (data && typeof data === "object") return `{${Object.keys(data).slice(0, 12).join(", ")}${Object.keys(data).length > 12 ? ", …" : ""}}`;
  return typeof data;
}

export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, endpoint: string): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const where = r.error.issues[0]?.path.join(".") || "(top level)";
    throw new OpnsenseError("protocol", `Unexpected response shape from ${endpoint}: got ${describeShape(data)}, problem at ${where}.`, { endpoint });
  }
  return r.data;
}
