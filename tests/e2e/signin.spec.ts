import { expect, test } from "@playwright/test";
import { MOCK, resetMock, turnLogOn } from "./helpers.ts";

test.describe("signing in with OPNsense accounts", () => {
  test.beforeEach(async () => {
    await resetMock();
  });

  test("signs in to both sites with one account and switches between them", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Use the same sign-in for all 2 sites")).toBeVisible();
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("ruledeck-dev");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("grid")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "admin · OPNsense 26.7.7" })).toBeVisible();
    await page.getByRole("combobox", { name: "Site" }).selectOption("muc");
    await expect(page.getByRole("grid")).toBeVisible();
    await page.getByRole("button", { name: "Sites" }).click();
    await expect(page.getByRole("row", { name: /Munich/ })).toContainText("admin");
  });

  test("a wrong password is shown per site and nothing is stored", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Berlin (mock)");
    await expect(page.getByRole("alert")).toContainText("Wrong username or password");
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(storage).not.toContain("not-the-password");
  });

  test("when the firewall session ends, re-sign-in keeps staged work", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("ruledeck-dev");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const row = page.getByRole("row").filter({ hasText: "Block DMZ to LAN" });
    await turnLogOn(page, "Block DMZ to LAN");
    await expect(row.locator("td.col-log")).toHaveClass(/cell-modified/);

    await fetch(`${MOCK}/__mock/expire-sessions`, { method: "POST" });
    await page.getByRole("button", { name: "⟳ Refresh" }).click();
    await page.getByRole("button", { name: "Only check for changes" }).click();
    const dialog = page.getByRole("dialog", { name: "Sign in to Berlin (mock)" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Username").fill("admin");
    await dialog.getByLabel("Password").fill("ruledeck-dev");
    await dialog.getByRole("button", { name: "Sign in" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /1 pending/ })).toBeVisible();
  });

  test("signing out clears staged drafts from the browser", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("ruledeck-dev");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await turnLogOn(page, "Block DMZ to LAN");
    expect(await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith("ruledeck.wc.")))).toBe(true);
    await page.getByRole("button", { name: "Sign out" }).click();
    // Staged work exists, so RuleDeck asks first.
    await page.locator(".confirm-inline").getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("ruledeck.")))).toEqual([]);
  });

  test("when RuleDeck's own session expires, signing in again brings back staged work", async ({ page, context }) => {
    await page.goto("/");
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("ruledeck-dev");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await turnLogOn(page, "Block DMZ to LAN");
    await expect(page.getByRole("button", { name: /1 pending/ })).toBeVisible();

    await context.clearCookies(); // same effect as the server forgetting the session
    await page.getByRole("button", { name: "⟳ Refresh" }).click();
    await page.getByRole("button", { name: "Only check for changes" }).click();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("ruledeck-dev");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("button", { name: /1 pending/ })).toBeVisible();
  });
});
