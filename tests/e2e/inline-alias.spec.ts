import { expect, test, type Page } from "@playwright/test";
import { cell, login, mockState, newRule, openRule, resetMock, tab } from "./helpers.ts";

/**
 * The core acceptance test from the project book (§10): build a rule and
 * create its destination alias without leaving the rule form.
 */
test.describe("inline alias creation (rule form)", () => {
  test.beforeEach(async () => {
    await resetMock();
  });

  /** Fill the new-rule form: description, TCP/443 and a destination alias created on the spot. */
  async function buildWebRule(page: Page) {
    await cell(page, "Allow web to DMZ", "action").click();
    const dialog = await newRule(page);
    await dialog.getByLabel("Description").fill("Allow HTTPS to web servers");

    await tab(dialog, "Service");
    await dialog.getByLabel("Protocol").selectOption("TCP");
    await dialog.getByLabel("Destination port").fill("443");
    await dialog.getByLabel("Destination port").press("Enter");
    await expect(dialog.getByLabel("Destination port")).toHaveValue("443");

    // Destination: type a new alias name; the picker offers to create it.
    await tab(dialog, "Destination");
    const picker = dialog.getByRole("combobox", { name: "Destination address" });
    await picker.fill("WEB_SERVERS");
    const create = dialog.getByRole("button", { name: /Create new alias "WEB_SERVERS"/ });
    await expect(create).toBeVisible();
    await create.click();

    // The alias form opens right there, name prefilled; paste two networks.
    const aliasForm = page.getByRole("dialog", { name: "Create alias" });
    await expect(aliasForm).toBeVisible();
    await expect(aliasForm.getByLabel("Name")).toHaveValue("WEB_SERVERS");
    await aliasForm.getByLabel("Entries").fill("192.168.1.10\n192.168.1.0/28");
    await expect(aliasForm.getByText("2 entries")).toBeVisible();
    await aliasForm.getByRole("button", { name: "Create & use" }).click();
    await expect(aliasForm).toBeHidden();

    // The new alias is already in the destination field.
    await expect(dialog.locator(".picker-box .chip-alias", { hasText: "WEB_SERVERS" })).toBeVisible();
    return dialog;
  }

  test("create a rule and its destination alias inside the form, review the diff", async ({ page }) => {
    await login(page);
    const before = await mockState();
    const dialog = await buildWebRule(page);
    await dialog.getByRole("button", { name: "OK", exact: true }).click();
    await expect(dialog).toBeHidden();

    const row = page.getByRole("row").filter({ hasText: "Allow HTTPS to web servers" });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("+ NEW")).toBeVisible();
    await expect(row.locator("td.col-destination .chip-alias")).toHaveText(/WEB_SERVERS/);
    await expect(row.locator("td.col-destinationPort")).toHaveText("443");

    // Both objects are pending, with a readable diff.
    await page.getByRole("button", { name: /pending/ }).click();
    const drawer = page.getByRole("region", { name: "Pending changes" });
    await expect(drawer.getByRole("tab", { name: "Changes (2)" })).toBeVisible();
    await expect(drawer.getByRole("tab", { name: "Problems (0)" })).toBeVisible();
    const aliasChange = drawer.locator(".change-create").filter({ has: page.locator(".change-type", { hasText: "Alias" }) });
    const ruleChange = drawer.locator(".change-create").filter({ has: page.locator(".change-type", { hasText: "Rule" }) });
    await expect(aliasChange).toContainText("+ 192.168.1.10");
    await expect(aliasChange).toContainText("+ 192.168.1.0/28");
    await expect(ruleChange).toContainText("WEB_SERVERS");

    // Nothing has reached the firewall.
    const after = await mockState();
    expect(after.rules.length).toBe(before.rules.length);
    expect(after.aliases.length).toBe(before.aliases.length);

    // The new alias is offered immediately when editing another rule.
    await page.getByRole("button", { name: /pending/ }).click();
    const other = await openRule(page, "Block DMZ to LAN");
    await tab(other, "Source");
    await other.getByRole("combobox", { name: "Source address" }).fill("WEB");
    await expect(other.getByRole("option", { name: /WEB_SERVERS.*pending/ })).toBeVisible();
    await page.keyboard.press("Escape"); // closes the suggestions
    await other.getByRole("button", { name: "Cancel" }).click();

    // A reload keeps the staged work.
    await page.reload();
    await expect(page.getByRole("grid")).toBeVisible();
    await expect(page.getByText(/Restored 2 staged changes/)).toBeVisible();
  });

  test("Cancel undoes everything done in the form, including an alias created there", async ({ page }) => {
    await login(page);
    const dialog = await buildWebRule(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("row").filter({ hasText: "Allow HTTPS to web servers" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /0 pending/ })).toBeVisible();
    // The alias is gone too: it isn't offered any more.
    const other = await openRule(page, "Block DMZ to LAN");
    await tab(other, "Source");
    await other.getByRole("combobox", { name: "Source address" }).fill("WEB_SERVERS");
    await expect(other.getByRole("option", { name: /WEB_SERVERS/ })).toHaveCount(0);
    await other.getByRole("button", { name: "Cancel" }).click();
  });

  test("the create box sits under a scrolling list of existing aliases", async ({ page }) => {
    await login(page);
    const dialog = await openRule(page, "Block DMZ to LAN");
    await tab(dialog, "Destination");
    await dialog.getByRole("combobox", { name: "Destination address" }).click();
    const list = dialog.locator(".suggestion-panel .suggestions");
    await expect(list.getByRole("option", { name: /ADMIN_HOSTS/ })).toBeVisible();
    await expect(list.getByRole("option", { name: /RFC1918/ })).toBeVisible();
    const box = dialog.getByRole("button", { name: /Create new alias/ });
    await expect(box).toBeVisible();
    const [lb, bb] = await Promise.all([list.boundingBox(), box.boundingBox()]);
    expect(bb!.y).toBeGreaterThanOrEqual(lb!.y + lb!.height - 1); // below the list, not inside it

    // Really on screen and clickable (not clipped by a scrolling parent): the topmost element at its centre is the box.
    for (const target of [list.getByRole("option", { name: /RFC1918/ }), box]) {
      const hit = await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && el.contains(top);
      });
      expect(hit, "dropdown entry is clipped or covered").toBe(true);
    }
  });

  test("logging is on the Advanced tab", async ({ page }) => {
    await login(page);
    const dialog = await openRule(page, "Block DMZ to LAN");
    await tab(dialog, "Actions");
    await expect(dialog.getByLabel("Log packets that match this rule")).toHaveCount(0);
    await tab(dialog, "Advanced");
    await expect(dialog.getByLabel("Log packets that match this rule")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("there is no separate details panel any more", async ({ page }) => {
    await login(page);
    await expect(page.getByRole("complementary", { name: "Rule details" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /details/i })).toHaveCount(0);
  });

  test("a literal address needs no alias, and invalid input is flagged on its tab", async ({ page }) => {
    await login(page);
    const dialog = await openRule(page, "Block DMZ to LAN");
    await tab(dialog, "Source");
    const picker = dialog.getByRole("combobox", { name: "Source address" });
    await picker.fill("10.20.0.0/16");
    await picker.press("Enter");
    await expect(dialog.locator(".picker-box .chip-literal", { hasText: "10.20.0.0/16" })).toBeVisible();

    // A destination port on a rule without TCP/UDP is a problem, shown on the Service tab.
    await tab(dialog, "Service");
    await dialog.getByLabel("Protocol").selectOption("ICMP");
    await tab(dialog, "General");
    await dialog.getByRole("button", { name: "OK", exact: true }).click();
    await expect(dialog).toBeHidden(); // no port set, so this is valid

    const row = page.getByRole("row").filter({ hasText: "Block DMZ to LAN" });
    await expect(row.locator("td.col-source")).toContainText("10.20.0.0/16");
    await expect(row.locator("td.col-source")).toHaveClass(/cell-modified/);
    expect(page.url()).not.toContain("aliases");
  });

  test("columns are as wide as their content (nothing cut off)", async ({ page }) => {
    await login(page);
    const cells = page.locator("td.cell .cell-content");
    const n = await cells.count();
    for (let i = 0; i < n; i++) {
      const clipped = await cells.nth(i).evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(clipped, `cell ${i} is clipped`).toBe(false);
    }
  });
});
