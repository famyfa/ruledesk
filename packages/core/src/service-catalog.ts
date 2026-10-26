/**
 * Catalogue of the OPNsense services RuleDeck can manage besides firewall rules.
 *
 * Every endpoint here was read in the OPNsense 26.7 source (controllers) and its read
 * side was checked on a live 26.7 firewall; see docs/api-compatibility.md. They all use
 * the standard OPNsense MVC pattern:
 *   settings tree:  <get> / <set>           {"<root>": {...}}
 *   table:          search / get / add / set / del   (+ toggle)  {"<root>": {...item}}
 *   activate:       <reconfigure> (POST)
 */

export interface GridDef {
  id: string;
  label: string;
  /** Key of the item in get/add/set bodies, e.g. `subnet4`. */
  root: string;
  search: string;
  get: string;
  add: string;
  set: string;
  del: string;
  /** Columns shown in the table (field names of the item). */
  columns: string[];
  /** Fields that form the item's name in lists and change summaries. */
  nameFields: string[];
  /** Fields that identify "the same item" at another site. */
  keyFields: string[];
  /** Option fields that allow several values (checkbox list instead of a drop-down). */
  multi?: string[];
}

export interface SettingsDef {
  get: string;
  set: string;
  root: string;
}

export interface ServiceDef {
  id: string;
  label: string;
  group: "Network" | "DHCP & DNS" | "System" | "Security";
  description: string;
  settings?: SettingsDef;
  grids: GridDef[];
  /** POST that activates the saved configuration. */
  reconfigure?: string;
  /** Read-only in RuleDeck (no writes). */
  readOnly?: boolean;
  /** Shown in the review before applying. */
  warning?: string;
  /** Option fields of the settings tree that allow several values. */
  multi?: string[];
}

function grid(
  id: string,
  label: string,
  base: string,
  action: string,
  root: string,
  cols: { columns: string[]; name: string[]; key?: string[]; multi?: string[]; search?: string; plural?: boolean },
): GridDef {
  return {
    id,
    label,
    root,
    search: `${base}/${cols.search ?? `search_${action}`}`,
    get: `${base}/get_${action}`,
    add: `${base}/add_${action}`,
    set: `${base}/set_${action}`,
    del: `${base}/del_${action}`,
    columns: cols.columns,
    nameFields: cols.name,
    keyFields: cols.key ?? cols.name,
    multi: cols.multi,
  };
}

export const SERVICES: ServiceDef[] = [
  {
    id: "kea4",
    label: "DHCPv4 (Kea)",
    group: "DHCP & DNS",
    description: "Kea DHCPv4 server: general settings, subnets, reservations, options and HA peers.",
    settings: { get: "kea/dhcpv4/get", set: "kea/dhcpv4/set", root: "dhcpv4" },
    reconfigure: "kea/service/reconfigure",
    multi: ["general.interfaces"],
    grids: [
      grid("subnets", "Subnets", "kea/dhcpv4", "subnet", "subnet4", { columns: ["subnet", "pools", "description"], name: ["subnet"] }),
      grid("reservations", "Reservations", "kea/dhcpv4", "reservation", "reservation", { columns: ["ip_address", "hw_address", "hostname", "description"], name: ["hw_address"], key: ["hw_address", "subnet"] }),
      grid("options", "Options", "kea/dhcpv4", "option", "option", { columns: ["option", "value", "description"], name: ["option"] }),
      grid("peers", "HA peers", "kea/dhcpv4", "peer", "peer", { columns: ["name", "role", "url"], name: ["name"] }),
    ],
  },
  {
    id: "kea6",
    label: "DHCPv6 (Kea)",
    group: "DHCP & DNS",
    description: "Kea DHCPv6 server: general settings, subnets, reservations, options, prefix delegation pools and HA peers.",
    settings: { get: "kea/dhcpv6/get", set: "kea/dhcpv6/set", root: "dhcpv6" },
    reconfigure: "kea/service/reconfigure",
    multi: ["general.interfaces"],
    grids: [
      grid("subnets", "Subnets", "kea/dhcpv6", "subnet", "subnet6", { columns: ["subnet", "pools", "description"], name: ["subnet"] }),
      grid("reservations", "Reservations", "kea/dhcpv6", "reservation", "reservation", { columns: ["ip_address", "duid", "hostname", "description"], name: ["duid"], key: ["duid", "subnet"] }),
      grid("options", "Options", "kea/dhcpv6", "option", "option", { columns: ["option", "value", "description"], name: ["option"] }),
      grid("pd_pools", "PD pools", "kea/dhcpv6", "pd_pool", "pd_pool", { columns: ["prefix", "prefix_len", "delegated_len"], name: ["prefix"] }),
      grid("peers", "HA peers", "kea/dhcpv6", "peer", "peer", { columns: ["name", "role", "url"], name: ["name"] }),
    ],
  },
  {
    id: "dnsmasq",
    label: "Dnsmasq (DNS / DHCP)",
    group: "DHCP & DNS",
    description: "Dnsmasq: DNS forwarder and DHCP server with hosts, domain overrides, ranges, tags, options and boot settings.",
    settings: { get: "dnsmasq/settings/get", set: "dnsmasq/settings/set", root: "dnsmasq" },
    reconfigure: "dnsmasq/service/reconfigure",
    multi: ["interface"],
    grids: [
      grid("hosts", "Hosts", "dnsmasq/settings", "host", "host", { columns: ["host", "domain", "ip", "hwaddr", "descr"], name: ["host", "domain"] }),
      grid("domains", "Domain overrides", "dnsmasq/settings", "domain", "domainoverride", { columns: ["domain", "ip", "port", "descr"], name: ["domain"] }),
      grid("ranges", "DHCP ranges", "dnsmasq/settings", "range", "range", { columns: ["interface", "start_addr", "end_addr", "domain", "description"], name: ["start_addr", "end_addr"] }),
      grid("tags", "DHCP tags", "dnsmasq/settings", "tag", "tag", { columns: ["tag"], name: ["tag"] }),
      grid("options", "DHCP options", "dnsmasq/settings", "option", "option", { columns: ["type", "option", "value", "tag", "descr"], name: ["option", "value"] }),
      grid("boot", "DHCP boot", "dnsmasq/settings", "boot", "boot", { columns: ["tag", "filename", "servername", "serveraddress", "description"], name: ["filename"] }),
    ],
  },
  {
    id: "unbound",
    label: "Unbound DNS",
    group: "DHCP & DNS",
    description: "Unbound resolver: general settings, host overrides and aliases, DNS-over-TLS forwarders, access lists and blocklists.",
    settings: { get: "unbound/settings/get", set: "unbound/settings/set", root: "unbound" },
    reconfigure: "unbound/service/reconfigure",
    multi: ["general.active_interface", "general.outgoing_interface"],
    grids: [
      grid("host_overrides", "Host overrides", "unbound/settings", "host_override", "host", { columns: ["enabled", "hostname", "domain", "rr", "server", "description"], name: ["hostname", "domain"] }),
      grid("host_aliases", "Host aliases", "unbound/settings", "host_alias", "alias", { columns: ["enabled", "hostname", "domain", "description"], name: ["hostname", "domain"] }),
      grid("forwards", "DNS over TLS", "unbound/settings", "forward", "dot", { columns: ["enabled", "domain", "server", "port", "verify"], name: ["domain", "server"] }),
      grid("acls", "Access lists", "unbound/settings", "acl", "acl", { columns: ["enabled", "name", "action", "networks", "description"], name: ["name"] }),
      grid("blocklists", "DNS blocklists", "unbound/settings", "dnsbl", "blocklist", { columns: ["enabled", "description", "list", "source_net"], name: ["description"] }),
    ],
  },
  {
    id: "gateways",
    label: "Gateways",
    group: "Network",
    description: "Gateways used for routing and failover.",
    reconfigure: "routing/settings/reconfigure",
    warning: "Changing a gateway can cut connections, including your own access to the firewall.",
    grids: [grid("gateways", "Gateways", "routing/settings", "gateway", "gateway_item", { columns: ["disabled", "name", "interface", "gateway", "priority", "descr"], name: ["name"] })],
  },
  {
    id: "routes",
    label: "Static routes",
    group: "Network",
    description: "Static routes.",
    reconfigure: "routes/routes/reconfigure",
    warning: "Routes change where traffic goes immediately. A wrong route can cut connections, including your own access to the firewall.",
    grids: [grid("routes", "Routes", "routes/routes", "route", "route", { columns: ["disabled", "network", "gateway", "descr"], name: ["network"] })],
  },
  {
    id: "vlans",
    label: "VLANs",
    group: "Network",
    description: "VLAN devices on top of physical interfaces.",
    reconfigure: "interfaces/vlan_settings/reconfigure",
    warning: "Changing or removing a VLAN device interrupts everything running over it.",
    grids: [grid("vlans", "VLANs", "interfaces/vlan_settings", "item", "vlan", { columns: ["vlanif", "if", "tag", "pcp", "descr"], name: ["vlanif"], key: ["if", "tag"], search: "search_item" })],
  },
  {
    id: "vips",
    label: "Virtual IPs",
    group: "Network",
    description: "Virtual IPs: CARP, IP alias and proxy ARP.",
    reconfigure: "interfaces/vip_settings/reconfigure",
    warning: "Virtual IPs carry traffic and CARP failover. Changing them at the HA primary also affects the peer; check VHIDs and passwords.",
    grids: [grid("vips", "Virtual IPs", "interfaces/vip_settings", "item", "vip", { columns: ["interface", "mode", "subnet", "vhid", "descr"], name: ["interface", "subnet"], key: ["interface", "subnet"], search: "search_item" })],
  },
  {
    id: "syslog",
    label: "Syslog",
    group: "System",
    description: "Syslog general settings and remote destinations.",
    settings: { get: "syslog/settings/get", set: "syslog/settings/set", root: "syslog" },
    reconfigure: "syslog/service/reconfigure",
    grids: [grid("destinations", "Destinations", "syslog/settings", "destination", "destination", { columns: ["enabled", "transport", "hostname", "port", "description"], name: ["hostname", "port"], search: "search_destinations" })],
  },
  {
    id: "cron",
    label: "Cron jobs",
    group: "System",
    description: "Scheduled jobs.",
    reconfigure: "cron/service/reconfigure",
    grids: [grid("jobs", "Jobs", "cron/settings", "job", "job", { columns: ["enabled", "minutes", "hours", "days", "command", "description"], name: ["description", "command"], key: ["command", "parameters"], search: "search_jobs" })],
  },
];

export function serviceById(id: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === id);
}

export function gridById(svc: ServiceDef, id: string): GridDef | undefined {
  return svc.grids.find((g) => g.id === id);
}

/**
 * Fields that must never reach the browser, the logs or a change list:
 * passwords, keys, secrets. They are shown as write-only inputs.
 */
const SECRET_RE = /(password|passwd|passphrase|secret|psk|prv|private_?key|privkey|token|community|api_?key|pre_?shared)|(^|_)pass$/i;
export function isSecretField(name: string): boolean {
  const last = name.split(".").pop() ?? name;
  return SECRET_RE.test(last);
}
