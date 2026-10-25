import { expect, test } from "@playwright/test";
import { login, resetMock, turnLogOn } from "./helpers.ts";

/** Panorama-style navigation: tabs along the top, a tree on the left for sections with sub-pages. */
test.describe("navigation", () => {
  test.beforeEach(async () => {
    await resetMock();
  });

  test("top tabs open the pages; the left tree shows sub-pages for Policies and Objects", async ({ page }) => {
    await login(page);
    const tabs = page.getByRole("navigation", { name: "Main" });
    for (const name of ["Dashboard", "Monitor", "Policies", "Objects", "Sites", "Changes", "History", "Settings"]) {
      await expect(tabs.getByRole("button", { name })).toBeVisible();
    }

    // Policies is the landing tab: its tree lists Firewall Rules (with a count) and the grid is shown.
    await expect(tabs.getByRole("button", { name: "Policies" })).toHaveAttribute("aria-current", "page");
    const tree = page.getByRole("navigation", { name: "Policies sections" });
    await expect(tree.getByRole("button", { name: /Firewall Rules/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("grid")).toBeVisible();

    await tabs.getByRole("button", { name: "Objects" }).click();
    await expect(page.getByRole("navigation", { name: "Objects sections" }).getByRole("button", { name: /Aliases/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New alias" })).toBeVisible();

    // Tabs with a single page have no tree.
    await tabs.getByRole("button", { name: "Sites" }).click();
    await expect(page.getByRole("row", { name: /Berlin/ })).toBeVisible();
    await expect(page.locator("nav.tree")).toHaveCount(0);

    await tabs.getByRole("button", { name: "Dashboard" }).click();
    await expect(page.getByText("pending changes")).toBeVisible();
  });

  test("the apply controls and site switcher stay reachable on every tab", async ({ page }) => {
    await login(page);
    for (const name of ["Dashboard", "Objects", "History", "Settings"]) {
      await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name }).click();
      const bar = page.locator(".topbar-right");
      await expect(bar.getByRole("button", { name: /\d+ pending/ })).toBeVisible();
      await expect(bar.getByRole("button", { name: "Review & apply", exact: true })).toBeVisible();
    }
    await expect(page.getByRole("combobox", { name: "Site" })).toBeVisible();
  });

  test("the Changes tab shows a badge with the number of staged changes", async ({ page }) => {
    await login(page);
    await turnLogOn(page, "Block DMZ to LAN");
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /Changes/ }).locator(".badge")).toHaveText("1");
  });
});
