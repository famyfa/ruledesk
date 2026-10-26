import { expect, test } from "@playwright/test";
import { login, MOCK, resetMock } from "./helpers.ts";

test.describe("HA: graceful switchover", () => {
  test.beforeEach(async () => {
    await resetMock();
  });

  test("switch over a site, see the banner, switch back", async ({ page }) => {
    await login(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Sites" }).click();
    const row = page.getByRole("row").filter({ hasText: "Berlin" });
    await expect(row.getByText("master", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: "Switch over…" }).click();
    const dialog = page.getByRole("dialog", { name: /Switch over/ });
    await expect(dialog.getByRole("list", { name: "Checks" }).locator("li.bad")).toHaveCount(0);
    const go = dialog.getByRole("button", { name: "Switch over now" });
    await expect(go).toBeDisabled(); // needs the confirmation first
    await dialog.getByLabel(/I understand/).check();
    await go.click();
    await expect(dialog.getByRole("region", { name: "Switch result" })).toContainText("Switched over");
    await dialog.getByRole("button", { name: "Close" }).click();

    await expect(row.getByText("maintenance", { exact: true })).toBeVisible();
    await expect(page.getByText(/is in CARP maintenance mode/).first()).toBeVisible();
    const carp = (await (await fetch(`${MOCK}/__mock/state`)).json()) as { carp?: { maintenance: boolean } };
    if (carp.carp) expect(carp.carp.maintenance).toBe(true);

    await row.getByRole("button", { name: "Switch back…" }).click();
    const back = page.getByRole("dialog", { name: /Switch back/ });
    await back.getByLabel(/I understand/).check();
    await back.getByRole("button", { name: "Switch back now" }).click();
    await expect(back.getByRole("region", { name: "Switch result" })).toContainText("master again");
    await back.getByRole("button", { name: "Close" }).click();
    await expect(row.getByText("master", { exact: true })).toBeVisible();
    await expect(page.getByText(/is in CARP maintenance mode/)).toHaveCount(0);
  });
});
