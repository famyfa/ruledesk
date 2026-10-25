import { expect, test, type Page } from "@playwright/test";
import { login, MOCK, MOCK_MUC, resetMock } from "./helpers.ts";

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

async function openGlobal(page: Page, name: "Rules, all sites" | "Aliases, all sites") {
  await nav(page).getByRole("button", { name: "Global" }).click();
  await page.getByRole("navigation", { name: "Global sections" }).getByRole("button", { name }).click();
}

test.describe("Global view and sync", () => {
  test.beforeEach(async () => {
    await resetMock();
  });

  test("the rule name is first and opens the rule form with one click", async ({ page }) => {
    await login(page);
    const firstHeader = page.getByRole("grid").locator("thead th").nth(3);
    await expect(firstHeader).toHaveText("Name");
    await page.getByRole("row").filter({ hasText: "Block DMZ to LAN" }).locator("td.cell-name").click();
    await expect(page.getByRole("dialog", { name: "Edit rule" })).toBeVisible();
  });

  test("rules of all sites side by side; a rule that differs can be synced to the other site", async ({ page }) => {
    // Berlin's first rule is renamed; both sites know it under the same uuid, so Munich has the old name.
    await fetch(`${MOCK}/__mock/external-edit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fields: { description: "Berlin only rule" } }) });
    await login(page);
    await openGlobal(page, "Rules, all sites");
    const row = page.getByRole("row").filter({ hasText: "Berlin only rule" });
    await expect(row).toBeVisible();
    await expect(row.locator("td").nth(2)).toContainText("reference");
    await expect(row.locator("td").nth(3)).toContainText("differs");
    // an identical rule is the same at both
    await expect(page.getByRole("row").filter({ hasText: "Block DMZ to LAN" }).locator("td").nth(3)).toContainText("same");

    // filter expression works across sites
    await page.getByRole("searchbox", { name: "Filter rules across sites" }).fill("site contains Berlin and rule contains only");
    await expect(page.locator("table.global-table tbody tr")).toHaveCount(1);
    await page.getByRole("checkbox", { name: "Select Berlin only rule" }).check();
    await page.getByRole("button", { name: /^Sync 1 from Berlin/ }).click();

    const dialog = page.getByRole("dialog", { name: "Sync rules" });
    await expect(dialog.getByRole("checkbox", { name: "Berlin only rule" })).toBeChecked();
    await expect(dialog.getByText(/1 changed/)).toBeVisible();
    await dialog.getByRole("button", { name: /^Stage 1 change/ }).click();
    await expect(dialog.getByRole("status")).toContainText("Nothing has been sent to the firewall yet");
    await dialog.getByRole("button", { name: /^Open .* to review/ }).click();

    // at Munich the rename is now a pending change; the firewall itself is untouched
    await nav(page).getByRole("button", { name: "Changes" }).click();
    await expect(page.getByText("Berlin only rule").first()).toBeVisible();
    const muc = (await (await fetch(`${MOCK_MUC}/__mock/state`)).json()) as { rules: Record<string, string>[] };
    expect(muc.rules.some((r) => r.description === "Berlin only rule")).toBe(false);
    await expect(page.getByRole("button", { name: /^1 pending/ })).toBeVisible();
  });

  test("aliases of all sites are compared", async ({ page }) => {
    await login(page);
    await openGlobal(page, "Aliases, all sites");
    const rows = page.locator("table.global-table tbody tr");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().locator("td").nth(2)).toContainText("reference");
    await expect(rows.first().locator("td").nth(3)).toContainText(/same|differs|missing/);
  });

  test("global monitor merges the logs of all sites", async ({ page }) => {
    await login(page);
    const post = (base: string, row: object) => fetch(`${base}/__mock/log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify([row]) });
    await post(MOCK, { src: "198.51.100.1", label: "at berlin" });
    await post(MOCK_MUC, { src: "198.51.100.2", label: "at munich" });
    await nav(page).getByRole("button", { name: "Monitor" }).click();
    await page.getByRole("combobox", { name: "Log scope" }).selectOption("all");
    const table = page.locator("table.log-table");
    await expect(table.getByRole("columnheader", { name: "Site" })).toBeVisible();
    await expect(table.locator("tbody tr").filter({ hasText: "198.51.100.1" })).toHaveCount(1, { timeout: 15_000 });
    await expect(table.locator("tbody tr").filter({ hasText: "198.51.100.2" })).toHaveCount(1, { timeout: 15_000 });
    // filter by site name
    await page.getByRole("searchbox", { name: "Filter log" }).fill("site contains Munich");
    await expect(table.locator("tbody tr").filter({ hasText: "198.51.100.1" })).toHaveCount(0);
    await expect(table.locator("tbody tr").filter({ hasText: "198.51.100.2" })).toHaveCount(1);
  });
});
