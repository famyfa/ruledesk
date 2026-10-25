import { expect, test, type Page } from "@playwright/test";
import { login, MOCK, MOCK_MUC, resetMock } from "./helpers.ts";

const inject = (base: string, rows: object[]) =>
  fetch(`${base}/__mock/log`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rows) });

async function openMonitor(page: Page) {
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Monitor" }).click();
  await expect(page.getByRole("navigation", { name: "Monitor sections" }).getByRole("button", { name: "Firewall Log" })).toBeVisible();
}

test.describe("Monitor: firewall log", () => {
  test.beforeEach(async () => {
    await resetMock();
  });

  test("shows the firewall's recent log, newest first, with pass/block as text", async ({ page }) => {
    await login(page);
    await openMonitor(page);
    const table = page.locator("table.log-table");
    await expect(table.locator("tbody tr")).toHaveCount(30);
    await expect(page.getByRole("status").filter({ hasText: "Live" })).toBeVisible();
    await expect(table.locator("tbody tr").first().locator(".action")).toHaveText(/^(pass|block)$/);
    // Each line says which rule matched.
    await expect(table.getByText("Block DMZ to LAN").first()).toBeVisible();
  });

  test("new lines show up on their own", async ({ page }) => {
    await login(page);
    await openMonitor(page);
    await expect(page.locator("table.log-table tbody tr")).toHaveCount(30);
    await inject(MOCK, [{ src: "198.51.100.77", dst: "192.168.1.10", dstport: "8443", action: "block", label: "Injected test rule" }]);
    const row = page.locator("table.log-table tbody tr").filter({ hasText: "198.51.100.77" });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row).toContainText("192.168.1.10:8443");
    await expect(page.locator("table.log-table tbody tr").first()).toContainText("198.51.100.77"); // on top
    await expect(page.locator("table.log-table tbody tr")).toHaveCount(31); // nothing duplicated
  });

  test("Pause stops updates, Resume catches up", async ({ page }) => {
    await login(page);
    await openMonitor(page);
    await expect(page.locator("table.log-table tbody tr")).toHaveCount(30);
    await page.getByRole("button", { name: /Pause/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Paused" })).toBeVisible();
    await inject(MOCK, [{ src: "198.51.100.88" }]);
    await page.waitForTimeout(4500); // longer than one polling interval
    await expect(page.locator("table.log-table tbody tr").filter({ hasText: "198.51.100.88" })).toHaveCount(0);
    await page.getByRole("button", { name: /Resume/ }).click();
    await expect(page.locator("table.log-table tbody tr").filter({ hasText: "198.51.100.88" })).toHaveCount(1, { timeout: 10_000 });
    await expect(page.locator("table.log-table tbody tr")).toHaveCount(31);
  });

  test("filters by action and by text; Clear starts again", async ({ page }) => {
    await login(page);
    await openMonitor(page);
    const rows = page.locator("table.log-table tbody tr");
    await expect(rows).toHaveCount(30);
    await page.getByRole("combobox", { name: "Action filter" }).selectOption("block");
    const blocked = await rows.count();
    expect(blocked).toBeGreaterThan(0);
    expect(blocked).toBeLessThan(30);
    await expect(rows.locator(".action-pass")).toHaveCount(0);
    await page.getByRole("combobox", { name: "Action filter" }).selectOption("");
    await page.getByRole("searchbox", { name: "Filter log" }).fill("Block DMZ");
    await expect(rows.first()).toContainText("Block DMZ to LAN");
    await expect(page.locator(".monitor-page .count")).toContainText(/ of 30 lines/);
    await page.getByRole("searchbox", { name: "Filter log" }).fill("zzz-no-such-thing");
    await expect(page.getByText("No lines match the filter.")).toBeVisible();
    await page.getByRole("searchbox", { name: "Filter log" }).fill("");
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(rows).toHaveCount(30); // reloaded from the newest lines
  });

  test("a log line links to its rule in Policies", async ({ page }) => {
    await login(page);
    await openMonitor(page);
    await page.locator("table.log-table").getByRole("button", { name: "Block DMZ to LAN" }).first().click();
    await expect(page).toHaveURL(/#\/rules/);
    await expect(page.getByRole("grid")).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: "Block DMZ to LAN" });
    await expect(row.locator("td.cell-active")).toHaveCount(1);
  });

  test("each site shows its own log", async ({ page }) => {
    await login(page);
    await inject(MOCK_MUC, [{ src: "198.51.100.99", label: "only at Munich" }]);
    await openMonitor(page);
    await expect(page.locator("table.log-table tbody tr")).toHaveCount(30);
    await expect(page.locator("table.log-table").getByText("198.51.100.99")).toHaveCount(0);
    await page.getByRole("combobox", { name: "Site" }).selectOption("muc");
    await expect(page.locator("table.log-table tbody tr").filter({ hasText: "198.51.100.99" })).toHaveCount(1, { timeout: 10_000 });
  });

  test("a user without access to the log gets a clear message", async ({ page }) => {
    await login(page, "nolog", "nolog-pass");
    await openMonitor(page);
    await expect(page.getByRole("alert")).toContainText("isn't allowed to read the firewall log");
    await expect(page.locator("table.log-table tbody tr")).toHaveCount(0);
  });
});
