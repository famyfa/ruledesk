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

export const FirmwareInfo = z.object({ product_id: z.string(), product_version: z.string() }).loose();

const LabelledItems = z.object({ label: z.string(), items: z.record(z.string(), z.string()).or(z.array(z.unknown())).optional() }).loose();
export const NetworkSelectOptions = z.object({ aliases: LabelledItems, networks: LabelledItems }).loose();
export const PortSelectOptions = z.object({ aliases: LabelledItems, ports: LabelledItems }).loose();

const InterfaceItem = z.object({ value: z.string(), label: z.string(), type: z.string() }).loose();
export const InterfaceList = z.record(z.string(), z.object({ label: z.string(), items: z.array(InterfaceItem) }).loose());

export const GetItemResponse = (key: string) => z.object({ [key]: z.record(z.string(), RawFieldValue) }).loose();

export const SaveResponse = z.object({ result: z.string(), uuid: z.string().optional() }).loose();
export const StatusResponse = z.object({ status: z.string() }).loose();

export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, endpoint: string): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new OpnsenseError("protocol", `Unexpected response shape from ${endpoint}.`, { endpoint });
  return r.data;
}
