import { z } from "zod";

/** Validation for working copies sent by the browser. Strings are length-limited. */

const Str = (max = 1024) => z.string().max(max);
const Id = z.string().min(1).max(80).regex(/^[A-Za-z0-9:._-]+$/);

const AddressItem = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("self") }),
  z.object({ kind: z.literal("interfaceNet"), iface: Str(64) }),
  z.object({ kind: z.literal("interfaceAddr"), iface: Str(64) }),
  z.object({ kind: z.literal("alias"), name: Str(64) }),
  z.object({ kind: z.literal("literal"), value: Str(128) }),
]);
const AddressSpec = z.object({ negate: z.boolean(), items: z.array(AddressItem).max(256) });
const PortSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }),
  z.object({ kind: z.literal("literal"), value: Str(64) }),
  z.object({ kind: z.literal("alias"), name: Str(64) }),
]);
const Extra = z.record(Str(128), Str(4096)).refine((o) => Object.keys(o).length <= 200, "too many fields");

export const RuleSchema = z.object({
  id: Id,
  origin: z.enum(["mvc", "legacy"]),
  enabled: z.boolean(),
  action: z.enum(["pass", "block", "reject", "match"]),
  quick: z.boolean(),
  interfaces: z.array(Str(64)).max(64),
  interfaceNot: z.boolean(),
  direction: z.enum(["in", "out", "any"]),
  ipProtocol: z.enum(["inet", "inet6", "inet46"]),
  protocol: Str(32),
  source: AddressSpec,
  sourcePort: PortSpec,
  destination: AddressSpec,
  destinationPort: PortSpec,
  description: Str(1024),
  log: z.boolean(),
  categories: z.array(Str(64)).max(64),
  sequence: z.number().int().min(0).max(999999),
  prioGroup: Str(16).optional(),
  sortOrder: Str(32).optional(),
  extra: Extra,
});

export const AliasSchema = z.object({
  id: Id,
  name: Str(64),
  type: Str(32),
  enabled: z.boolean(),
  entries: z.array(Str(512)).max(20000),
  description: Str(1024),
  categories: z.array(Str(64)).max(64),
  extra: Extra,
});

const InterfaceInfo = z.object({ key: Str(64), label: Str(128), kind: z.enum(["interface", "group", "floating", "any"]) });
const Option = z.object({ value: Str(128), label: Str(256) });

export const SnapshotSchema = z.object({
  firewallId: Str(64),
  loadedAt: Str(64),
  rules: z.array(RuleSchema).max(20000),
  aliases: z.array(AliasSchema).max(20000),
  options: z.object({
    interfaces: z.array(InterfaceInfo).max(1000),
    aliasTypes: z.array(Option).max(100),
    protocols: z.array(Str(64)).max(500),
    wellKnownPorts: z.array(Option).max(2000),
  }),
  fingerprints: z.record(Str(80), Str(64)),
});

export const ApplyRequestSchema = z.object({
  baseline: SnapshotSchema,
  current: z.object({
    rules: z.array(RuleSchema).max(20000),
    aliases: z.array(AliasSchema).max(20000),
    nextLocalId: z.number().int().min(0),
  }),
  confirm: z.literal(true),
  acknowledgeRisks: z.boolean().default(false),
});

export type ApplyRequest = z.infer<typeof ApplyRequestSchema>;

const WorkingStateSchema = z.object({
  rules: z.array(RuleSchema).max(20000),
  aliases: z.array(AliasSchema).max(20000),
  nextLocalId: z.number().int().min(0),
});

export const SharedRequestSchema = z.object({
  shared: z.object({ baseline: SnapshotSchema, current: WorkingStateSchema }),
  sites: z.record(Str(32), z.object({ baseline: SnapshotSchema })),
  acknowledgeRisks: z.record(Str(32), z.boolean()).default({}),
  haSync: z.record(Str(32), z.boolean()).default({}),
  confirm: z.boolean().optional(),
});

export const HaSwitchSchema = z.object({ enter: z.boolean() }).strict();

// ---------------------------------------------------------------------------
// Services (DHCP, DNS, gateways, ...)

const FieldName = z.string().regex(/^[A-Za-z0-9_.\-]{1,100}$/);
const ServiceItem = z.record(FieldName, z.string().max(8192));
const ServiceRow = z.object({ id: z.string().min(1).max(80), item: ServiceItem });
const ServiceGrids = z.record(z.string().max(40), z.array(ServiceRow).max(500));

export const ServiceApplySchema = z
  .object({
    baseline: z.object({
      serviceId: z.string().max(40),
      siteId: z.string().max(64),
      loadedAt: z.string().max(40),
      settings: ServiceItem.nullable(),
      grids: ServiceGrids,
      options: z.record(z.string(), z.unknown()).default({}),
      defaults: z.record(z.string(), z.unknown()).default({}),
      secrets: z.array(z.string().max(100)).max(200),
      fingerprints: z.record(z.string().max(160), z.string().max(64)),
    }),
    current: z.object({ settings: ServiceItem.nullable(), grids: ServiceGrids }),
  })
  .strict();
