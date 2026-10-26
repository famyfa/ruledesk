import { expect, test, type Page } from "@playwright/test";
import { login, MOCK, resetMock } from "./helpers.ts";

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

async function openService(page: Page, label: RegExp | string) {
  await nav(page).getByRole("button", { name: "Services" }).click();
  await page.getByRole("navigation", { name: "Services sections" }).getByRole("button", { name: label }).click();
}

const external = (body: object) => fetch(`${MOCK}/__mock/service-edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test.describe("Services", () => {
  test.beforeEach(async () => {
    await resetMock();
  });

  test("the Services tab lists the services in groups", async ({ page }) => {
    await login(page);
    await nav(page).getByRole("button", { name: "Services" }).click();
    const tree = page.getByRole("navigation", { name: "Services sections" });
    for (const name of ["DHCPv4 (Kea)", "Dnsmasq (DNS / DHCP)", "Unbound DNS", "Gateways", "Static routes", "VLANs", "Virtual IPs", "Syslog", "Cron jobs", "Certificates", "NAT", "WireGuard", "Users & groups"]) {
      await expect(tree.getByRole("button", { name })).toBeVisible();
    }
    for (const group of ["DHCP & DNS", "Network", "Firewall", "System", "Security"]) await expect(tree.getByText(group, { exact: true })).toBeVisible();
  });

  test("edit, add and delete entries, review, apply, and see the verified result", async ({ page }) => {
    await login(page);
    await openService(page, /Dnsmasq/);
    await page.getByRole("tab", { name: /^Hosts/ }).click();
    const table = page.locator(".svc-grid table");
    await expect(table.getByRole("row").filter({ hasText: "nas" })).toBeVisible();

    // edit: click the name
    await table.getByRole("row").filter({ hasText: "nas" }).locator("td.cell-name").click();
    const dialog = page.getByRole("dialog", { name: /Edit Hosts/ });
    await dialog.getByLabel("Ip", { exact: true }).fill("192.168.1.50");
    await dialog.getByRole("button", { name: "OK" }).click();
    await expect(table.getByRole("row").filter({ hasText: "nas" }).getByText("MOD")).toBeVisible();

    // delete
    await table.getByRole("row").filter({ hasText: "printer" }).getByRole("button", { name: /Delete/ }).click();
    await expect(table.getByRole("row").filter({ hasText: "printer" }).getByText("DEL")).toBeVisible();

    // add
    await page.getByRole("button", { name: "+ Add" }).click();
    const add = page.getByRole("dialog", { name: /New Hosts/ });
    await add.getByLabel("Host", { exact: true }).fill("cam");
    await add.getByLabel("Domain", { exact: true }).fill("lan");
    await add.getByLabel("Ip", { exact: true }).fill("192.168.1.9");
    await add.getByRole("button", { name: "OK" }).click();
    await expect(table.getByRole("row").filter({ hasText: "cam" }).getByText("NEW")).toBeVisible();

    await expect(page.getByRole("status").filter({ hasText: "3 staged changes" })).toBeVisible();
    await page.getByRole("button", { name: "Review & apply…" }).click();
    const review = page.getByRole("region", { name: /Apply to/ });
    await expect(review).toContainText("192.168.1.50");
    await expect(review).toContainText("DELETE");
    await review.getByLabel("I reviewed the changes listed above.").check();
    await review.getByRole("button", { name: /^Apply 3 changes/ }).click();

    const result = page.getByRole("region", { name: "Apply result" });
    await expect(result).toContainText("Applied and verified");
    await expect(result.getByText("Read back from the firewall and compare")).toBeVisible();
    await result.getByRole("button", { name: "Done" }).click();

    // reloaded from the firewall: new state, nothing staged
    await expect(table.getByRole("row").filter({ hasText: "cam" })).toBeVisible();
    await expect(table.getByRole("row").filter({ hasText: "printer" })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "No staged changes" })).toBeVisible();
    const state = (await (await fetch(`${MOCK}/__mock/services`)).json()) as { dnsmasq: { reconfigureCount: number } };
    expect(state.dnsmasq.reconfigureCount).toBe(1);
  });

  test("a change made on the firewall in the meantime stops the apply", async ({ page }) => {
    await login(page);
    await openService(page, /Dnsmasq/);
    await page.getByRole("tab", { name: /^Hosts/ }).click();
    await page.locator(".svc-grid table").getByRole("row").filter({ hasText: "nas" }).locator("td.cell-name").click();
    const dialog = page.getByRole("dialog", { name: /Edit Hosts/ });
    await dialog.getByLabel("Ip", { exact: true }).fill("192.168.1.50");
    await dialog.getByRole("button", { name: "OK" }).click();
    await external({ service: "dnsmasq", grid: "hosts", match: { host: "nas" }, fields: { ip: "192.168.1.77" } });
    await page.getByRole("button", { name: "Review & apply…" }).click();
    const review = page.getByRole("region", { name: /Apply to/ });
    await review.getByLabel("I reviewed the changes listed above.").check();
    await review.getByRole("button", { name: /^Apply 1 change/ }).click();
    await expect(page.getByRole("region", { name: "Apply result" })).toContainText("something changed on the firewall");
    const state = (await (await fetch(`${MOCK}/__mock/services`)).json()) as { dnsmasq: { grids: { hosts: Record<string, { host: string; ip: string }> } } };
    expect(Object.values(state.dnsmasq.grids.hosts).find((h) => h.host === "nas")!.ip).toBe("192.168.1.77"); // not overwritten
  });

  test("a value the firewall refuses is reported and nothing is changed", async ({ page }) => {
    await login(page);
    await openService(page, /Dnsmasq/);
    await page.getByRole("tab", { name: /^Hosts/ }).click();
    await page.locator(".svc-grid table").getByRole("row").filter({ hasText: "nas" }).locator("td.cell-name").click();
    const dialog = page.getByRole("dialog", { name: /Edit Hosts/ });
    await dialog.getByLabel("Ip", { exact: true }).fill("INVALID");
    await dialog.getByRole("button", { name: "OK" }).click();
    await page.getByRole("button", { name: "Review & apply…" }).click();
    const review = page.getByRole("region", { name: /Apply to/ });
    await review.getByLabel("I reviewed the changes listed above.").check();
    await review.getByRole("button", { name: /^Apply 1 change/ }).click();
    const result = page.getByRole("region", { name: "Apply result" });
    await expect(result).toContainText("Not applied");
    await expect(result).toContainText("not allowed");
    await expect(result.getByRole("button", { name: "Back to editing" })).toBeVisible();
  });

  test("general settings: edit a setting; secrets are write-only and never shown", async ({ page }) => {
    await login(page);
    await openService(page, /DHCPv4/);
    const secret = page.getByLabel("Ddns domain key secret");
    await expect(secret).toHaveAttribute("type", "password");
    await expect(secret).toHaveValue("");
    expect(await page.content()).not.toContain("mock-secret-do-not-leak");

    await page.getByLabel("Valid lifetime").fill("5000");
    await expect(page.getByRole("status").filter({ hasText: "1 staged change" })).toBeVisible();
    await page.getByRole("button", { name: "Review & apply…" }).click();
    const review = page.getByRole("region", { name: /Apply to/ });
    await review.getByLabel("I reviewed the changes listed above.").check();
    await review.getByRole("button", { name: /^Apply 1 change/ }).click();
    await expect(page.getByRole("region", { name: "Apply result" })).toContainText("Applied and verified");
    const state = (await (await fetch(`${MOCK}/__mock/services`)).json()) as { kea4: { settings: Record<string, string> } };
    expect(state.kea4.settings["general.valid_lifetime"]).toBe("5000");
    expect(state.kea4.settings["general.ddns_domain_key_secret"]).toBe("mock-secret-do-not-leak"); // untouched
  });

  test("staged service changes survive a reload of the page", async ({ page }) => {
    await login(page);
    await openService(page, /Gateways/);
    await page.locator(".svc-grid table").getByRole("row").filter({ hasText: "WAN_GW" }).locator("td.cell-name").click();
    const dialog = page.getByRole("dialog", { name: /Edit Gateways/ });
    await dialog.getByLabel("Priority").fill("100");
    await dialog.getByRole("button", { name: "OK" }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 staged change" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: "1 staged change" })).toBeVisible();
    await page.getByRole("button", { name: "Discard all" }).click();
    await expect(page.getByRole("status").filter({ hasText: "No staged changes" })).toBeVisible();
  });

  test("read-only services can be viewed but not changed, and show no secrets", async ({ page }) => {
    await login(page);
    await openService(page, "Users & groups");
    await expect(page.getByText("Read-only: RuleDeck shows this service")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Add" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review & apply…" })).toHaveCount(0);
    const table = page.locator(".svc-grid table");
    await expect(table.getByRole("row").filter({ hasText: "admin" })).toBeVisible();
    await table.getByRole("row").filter({ hasText: "admin" }).locator("td.cell-name").click();
    const dialog = page.getByRole("dialog", { name: /Edit Users/ });
    await expect(dialog.getByRole("button", { name: "OK" })).toHaveCount(0);
    await expect(dialog.getByLabel("Name", { exact: true })).toBeDisabled();
    const html = await page.content();
    for (const s of ["mock-hash-do-not-leak", "MOCKOTPSEED"]) expect(html).not.toContain(s);
    await dialog.getByRole("button", { name: "Close" }).click();

    await openService(page, "WireGuard");
    await expect(page.locator(".svc-grid table").getByRole("row").filter({ hasText: "wg0" })).toBeVisible();
    const wg = await page.content();
    for (const s of ["mock-wg-private-do-not-leak", "mock-psk-do-not-leak"]) expect(wg).not.toContain(s);
    await openService(page, "NAT");
    await expect(page.locator(".svc-grid table").getByRole("row").filter({ hasText: "HTTPS to web" })).toBeVisible();
  });

  test("certificates of all sites with expiry, and no key material anywhere", async ({ page }) => {
    await login(page);
    await openService(page, "Certificates");
    const rows = page.locator(".certs-page tbody tr");
    await expect(rows).toHaveCount(8); // 4 per site
    await expect(rows.first()).toContainText("expired"); // soonest first
    await expect(page.locator(".certs-page").getByText("expires soon").first()).toBeVisible();
    await page.getByLabel(/Only expired or expiring/).check();
    await expect(rows).toHaveCount(4);
    const html = await page.content();
    expect(html).not.toContain("MOCKPRIVATEKEY");
    expect(html).not.toContain("BEGIN");
  });
});
