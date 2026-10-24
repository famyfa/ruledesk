import { expect, test } from "@playwright/test";
import { cell, login, mockState, resetMock } from "./helpers.ts";

/**
 * The core acceptance test from the project book (§10): build a rule and
 * create its destination alias without leaving the rule grid.
 */
test.describe("inline alias creation", () => {
  test.beforeEach(async () => {
    await resetMock();
  });

  test("add a rule and create its destination alias inside the cell", async ({ page }) => {
    await login(page);
    const before = await mockState();

    // 1. Add a rule below "Allow web to DMZ".
    await cell(page, "Allow web to DMZ", "description").click();
    await page.getByRole("button", { name: "+ Add rule" }).click();
    const newRow = page.getByRole("row").filter({ has: page.getByText("+ NEW") });
    await expect(newRow).toHaveCount(1);

    // Give it a description (active cell moved to Description; typing starts editing).
    await page.keyboard.type("Allow HTTPS to web servers");
    await page.keyboard.press("Enter");
    const row = page.getByRole("row").filter({ hasText: "Allow HTTPS to web servers" });
    await expect(row).toHaveCount(1);

    // Protocol TCP so a port is allowed.
    await row.locator("td.col-protocol").click();
    await row.locator("td.col-protocol").click();
    await page.getByRole("combobox", { name: "Choose value" }).selectOption("TCP");
    await page.keyboard.press("Enter");

    // 2. Click the destination cell and type a new alias name.
    await row.locator("td.col-destination").click();
    await row.locator("td.col-destination").click();
    const picker = page.getByRole("combobox", { name: "Address, network, interface or alias" });
    await picker.fill("WEB_SERVERS");

    // 3. Autocomplete offers to create the alias.
    const create = page.getByRole("option", { name: /Create alias "WEB_SERVERS"/ });
    await expect(create).toBeVisible();
    await create.click();

    // 4. The inline popover: name prefilled, add two networks (pasted as lines).
    const dialog = page.getByRole("dialog", { name: "Create alias" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Name")).toHaveValue("WEB_SERVERS");
    await dialog.getByLabel("Entries").fill("192.168.1.10\n192.168.1.0/28");
    await expect(dialog.getByText("2 entries")).toBeVisible();
    await dialog.getByRole("button", { name: "Create & use" }).click();
    await expect(dialog).toBeHidden();

    // The cell editor now references the new alias immediately.
    await expect(page.locator(".picker .chip-alias", { hasText: "WEB_SERVERS" })).toBeVisible();

    // 5. Finish editing the cell (Enter on the empty input commits).
    await page.keyboard.press("Enter");
    await expect(row.locator("td.col-destination .chip-alias")).toHaveText(/WEB_SERVERS/);

    // Port 443.
    await row.locator("td.col-destinationPort").click();
    await page.keyboard.type("443");
    await page.keyboard.press("Enter");
    await expect(row.locator("td.col-destinationPort")).toHaveText("443");

    // 6. Both objects are in the pending changes list.
    await page.getByRole("button", { name: /pending/ }).click();
    const drawer = page.getByRole("region", { name: "Pending changes" });
    await expect(drawer.getByRole("tab", { name: "Changes (2)" })).toBeVisible();
    const aliasChange = drawer.locator(".change-create").filter({ has: page.locator(".change-type", { hasText: "Alias" }) });
    const ruleChange = drawer.locator(".change-create").filter({ has: page.locator(".change-type", { hasText: "Rule" }) });
    await expect(aliasChange).toContainText("WEB_SERVERS");
    await expect(ruleChange).toContainText("Allow HTTPS to web servers");
    await expect(drawer.getByRole("tab", { name: "Problems (0)" })).toBeVisible();

    // 7. Review the diff: alias entries and rule destination are readable.
    await expect(aliasChange).toContainText("+ 192.168.1.10");
    await expect(aliasChange).toContainText("+ 192.168.1.0/28");
    await expect(ruleChange).toContainText("WEB_SERVERS");
    await expect(ruleChange).toContainText("443");

    // Nothing has been sent to the firewall.
    const after = await mockState();
    expect(after.rules.length).toBe(before.rules.length);
    expect(after.aliases.length).toBe(before.aliases.length);

    // The new alias shows up in autocomplete for another rule right away.
    await page.getByRole("button", { name: /pending/ }).click();
    const other = page.getByRole("row").filter({ hasText: "Block DMZ to LAN" });
    await other.locator("td.col-source").click();
    await page.keyboard.type("WEB");
    await expect(page.getByRole("option", { name: /WEB_SERVERS.*pending/ })).toBeVisible();
    await page.keyboard.press("Escape");

    // A reload keeps the staged work (local working copy).
    await page.reload();
    await expect(page.getByRole("grid")).toBeVisible();
    await expect(page.getByText(/Restored 2 staged changes/)).toBeVisible();
    const reloaded = page.getByRole("row").filter({ hasText: "Allow HTTPS to web servers" });
    await expect(reloaded.locator("td.col-destination .chip-alias")).toHaveText(/WEB_SERVERS/);
  });

  test("the user never needs the alias page during this workflow", async ({ page }) => {
    await login(page);
    // Typing an IP straight into a cell works too, no alias needed.
    const row = page.getByRole("row").filter({ hasText: "Block DMZ to LAN" });
    await row.locator("td.col-source").click();
    await page.keyboard.type("10.20.0.0/16");
    await page.keyboard.press("Enter"); // pick literal
    await page.keyboard.press("Enter"); // finish
    await expect(row.locator("td.col-source")).toContainText("10.20.0.0/16");
    await expect(row.locator("td.col-source")).toHaveClass(/cell-modified/);
    expect(page.url()).not.toContain("aliases");
  });
});
