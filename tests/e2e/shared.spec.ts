import { expect, test, type Page } from "@playwright/test";
import { login, MOCK, MOCK_MUC, newRule, resetMock, tab } from "./helpers.ts";

const MARKER = "b6f1c2d4-7e3a-4f20-9c41-2a8d0e6b13f7";
const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const tree = (page: Page) => page.getByRole("navigation", { name: "Global sections" });

interface MockDump {
  rules: { uuid: string; description: string; interface: string; categories: string; destination_port: string }[];
  aliases: { uuid: string; name: string; content: string; categories: string }[];
}
const dump = async (base: string) => (await (await fetch(`${base}/__mock/state`)).json()) as MockDump;

async function openShared(page: Page, name: "Shared rules" | "Shared aliases" | "Apply to all sites" | "Drift") {
  await nav(page).getByRole("button", { name: "Global" }).click();
  await tree(page).getByRole("button", { name }).click();
}

async function createSharedRule(page: Page, description: string) {
  await openShared(page, "Shared rules");
  await expect(page.getByText("Shared policy", { exact: true })).toBeVisible(); // the toolbar names the scope
  const form = await newRule(page);
  await form.getByLabel("Description").fill(description);
  await form.getByLabel(/^DMZ/).check(); // a logical interface
  await tab(form, "Service");
  await form.getByLabel("Protocol").selectOption("UDP");
  await form.getByLabel("Destination port").fill("53");
  await form.getByLabel("Destination port").press("Enter");
  await form.getByRole("button", { name: "OK", exact: true }).click();
  await expect(form).toBeHidden();
}

test.describe("Shared policy: create once, apply to all sites", () => {
  test.beforeEach(async () => {
    await resetMock();
  });

  test("a rule created once ends up on every site, with the same identity and the right interface", async ({ page }) => {
    await login(page);
    await createSharedRule(page, "Shared: allow DNS from DMZ");

    await page.getByRole("button", { name: /Review & apply to all/ }).click();
    const berlin = page.getByRole("region", { name: /Plan for Berlin/ });
    const munich = page.getByRole("region", { name: /Plan for Munich/ });
    await expect(berlin).toContainText("ready");
    await expect(munich).toContainText("ready");
    await expect(berlin).toContainText("1 new");
    const apply = page.getByRole("button", { name: /^Apply to all 2 sites/ });
    await expect(apply).toBeDisabled(); // needs the confirmation
    await page.getByLabel("I reviewed what changes at each site.").check();
    await apply.click();

    const result = page.getByRole("region", { name: "Apply result" });
    await expect(result).toContainText("Applied and verified on every site");
    await expect(result.locator(".site-card").filter({ hasText: "applied and verified" })).toHaveCount(2);

    const [a, b] = [await dump(MOCK), await dump(MOCK_MUC)];
    const ra = a.rules.find((r) => r.description === "Shared: allow DNS from DMZ")!;
    const rb = b.rules.find((r) => r.description === "Shared: allow DNS from DMZ")!;
    expect(ra).toBeTruthy();
    expect(rb).toBeTruthy();
    expect(ra.uuid).toBe(rb.uuid); // same identity everywhere
    expect(ra.interface).toBe("opt1"); // DMZ at both sites
    expect(rb.interface).toBe("opt1");
    expect(ra.categories).toContain(MARKER);
    expect(rb.categories).toContain(MARKER);

    // reload: the shared policy now shows the rule, nothing staged, no drift
    await result.getByRole("button", { name: /Done: reload the shared view/ }).click();
    await tree(page).getByRole("button", { name: "Shared rules" }).click();
    await expect(page.getByRole("row").filter({ hasText: "Shared: allow DNS from DMZ" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^0 pending/ })).toBeVisible();
    await tree(page).getByRole("button", { name: "Drift" }).click();
    await expect(page.getByText("No drift")).toBeVisible();
  });

  test("a shared alias is created once and exists on every site", async ({ page }) => {
    await login(page);
    await openShared(page, "Shared aliases");
    await page.getByRole("button", { name: "+ New alias" }).click();
    const dialog = page.getByRole("dialog", { name: "New alias" });
    await dialog.getByLabel("Name", { exact: true }).fill("SHARED_NETS");
    await dialog.getByLabel("Type").selectOption("network");
    await dialog.getByLabel("Entries").fill("10.50.0.0/16");
    await dialog.getByRole("button", { name: "OK", exact: true }).click();
    await page.getByRole("button", { name: /Review & apply to all/ }).click();
    await page.getByLabel("I reviewed what changes at each site.").check();
    await page.getByRole("button", { name: /^Apply to all 2 sites/ }).click();
    await expect(page.getByRole("region", { name: "Apply result" })).toContainText("Applied and verified on every site");
    const [a, b] = [await dump(MOCK), await dump(MOCK_MUC)];
    const aa = a.aliases.find((x) => x.name === "SHARED_NETS")!;
    const ab = b.aliases.find((x) => x.name === "SHARED_NETS")!;
    expect(aa.uuid).toBe(ab.uuid);
    expect(aa.categories).toContain(MARKER);
  });

  test("if the second site fails, the first keeps the change and the result says exactly that", async ({ page }) => {
    await login(page);
    await createSharedRule(page, "Shared: second site fails");
    await fetch(`${MOCK_MUC}/__mock/faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ match: "firewall/filter/set_rule", type: "http500", count: 5 }]) });
    await page.getByRole("button", { name: /Review & apply to all/ }).click();
    await page.getByLabel("I reviewed what changes at each site.").check();
    await page.getByRole("button", { name: /^Apply to all 2 sites/ }).click();
    const result = page.getByRole("region", { name: "Apply result" });
    await expect(result).toContainText("Stopped: some sites have the change, the rest do not");
    await expect(result.getByRole("listitem").filter({ hasText: "Berlin" }).first()).toContainText("applied and verified");
    await expect(result.getByRole("listitem").filter({ hasText: "Munich" }).first()).toContainText("failed");
    expect((await dump(MOCK)).rules.some((r) => r.description === "Shared: second site fails")).toBe(true);
    expect((await dump(MOCK_MUC)).rules.some((r) => r.description === "Shared: second site fails")).toBe(false);
    await expect(result.getByText(/no automatic rollback/i)).toBeVisible();
  });

  test("if the first site fails, the second is not touched", async ({ page }) => {
    await login(page);
    await createSharedRule(page, "Shared: first site fails");
    await fetch(`${MOCK}/__mock/faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([{ match: "firewall/filter/set_rule", type: "http500", count: 5 }]) });
    await page.getByRole("button", { name: /Review & apply to all/ }).click();
    await page.getByLabel("I reviewed what changes at each site.").check();
    await page.getByRole("button", { name: /^Apply to all 2 sites/ }).click();
    const result = page.getByRole("region", { name: "Apply result" });
    await expect(result).toContainText("the first site failed");
    await expect(result.getByRole("listitem").filter({ hasText: "Munich" }).first()).toContainText("not attempted");
    expect((await dump(MOCK_MUC)).rules.some((r) => r.description === "Shared: first site fails")).toBe(false);
  });

  test("a site that isn't signed in blocks the apply before anything is written", async ({ page }) => {
    await login(page);
    await createSharedRule(page, "Shared: needs every site");
    await nav(page).getByRole("button", { name: "Sites" }).click();
    await page.getByRole("row").filter({ hasText: "Munich" }).getByRole("button", { name: "Sign out" }).click();
    await openShared(page, "Apply to all sites");
    await expect(page.getByText(/Not signed in to: Munich/)).toBeVisible();
    await expect(page.locator(".apply-box button.primary")).toBeDisabled();
    expect((await dump(MOCK)).rules.some((r) => r.description === "Shared: needs every site")).toBe(false);
  });
});
