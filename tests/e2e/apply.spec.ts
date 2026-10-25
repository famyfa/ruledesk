import { expect, test } from "@playwright/test";
import { cell, login, MOCK, mockState, newRule, resetMock, tab, turnLogOn } from "./helpers.ts";

/**
 * Full acceptance flow from the project book (§10), including apply,
 * reload and verification against the (mock) firewall.
 */
test.describe("apply to firewall", () => {
  test.beforeEach(async () => {
    await resetMock();
  });

  test("add rule + inline alias → review → apply → reload → still linked", async ({ page }) => {
    await login(page);

    // Add a rule in the form: description, TCP/443, destination alias created on the spot.
    await cell(page, "Allow web to DMZ", "action").click();
    const form = await newRule(page);
    await form.getByLabel("Description").fill("Allow HTTPS to web servers");
    await tab(form, "Service");
    await form.getByLabel("Protocol").selectOption("TCP");
    await form.getByLabel("Destination port").fill("443");
    await form.getByLabel("Destination port").press("Enter");
    await tab(form, "Destination");
    await form.getByRole("combobox", { name: "Destination address" }).fill("WEB_SERVERS");
    await form.getByRole("button", { name: /Create new alias "WEB_SERVERS"/ }).click();
    const dialog = page.getByRole("dialog", { name: "Create alias" });
    await dialog.getByLabel("Entries").fill("192.168.1.10\n192.168.1.11");
    await dialog.getByRole("button", { name: "Create & use" }).click();
    await form.getByRole("button", { name: "OK", exact: true }).click();
    await expect(form).toBeHidden();
    const row = page.getByRole("row").filter({ hasText: "Allow HTTPS to web servers" });
    await expect(row).toHaveCount(1);

    // Review and apply.
    await page.getByRole("button", { name: "Review & apply", exact: true }).click();
    const review = page.getByRole("region", { name: /Apply to/ });
    await expect(review).toContainText("2 to create");
    const applyButton = review.getByRole("button", { name: /Apply 2 changes/ });
    await expect(applyButton).toBeDisabled(); // needs explicit confirmation
    await review.getByLabel("I reviewed the changes listed above.").check();
    await applyButton.click();

    await expect(page.getByText("Changes applied and verified on the firewall.")).toBeVisible();
    await expect(page.getByRole("button", { name: /0 pending/ })).toBeVisible();

    // The (mock) firewall really has both, linked by name, and activated.
    const state = await mockState();
    const alias = state.aliases.find((a) => a.name === "WEB_SERVERS");
    expect(alias?.content).toBe("192.168.1.10\n192.168.1.11");
    const rule = state.rules.find((r) => r.description === "Allow HTTPS to web servers");
    expect(rule?.destination_net).toBe("WEB_SERVERS");
    expect(rule?.destination_port).toBe("443");
    expect(state.pendingApply).toBe(false);

    // RuleDeck itself keeps only an in-memory list for this tab (gone after a reload).
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByRole("cell", { name: "success" })).toBeVisible();

    // Reload the app: rule and alias come from the firewall and are still linked.
    await page.reload();
    await page.getByRole("button", { name: "Policies" }).click();
    await expect(page.getByRole("grid")).toBeVisible();
    const reloaded = page.getByRole("row").filter({ hasText: "Allow HTTPS to web servers" });
    await expect(reloaded.locator("td.col-destination .chip-alias")).toHaveText(/WEB_SERVERS/);
    await expect(reloaded.getByText("+ NEW")).toHaveCount(0);
    await expect(reloaded.locator("td.col-destination .chip-alias")).toHaveAttribute("title", /192\.168\.1\.10/);

    // The firewall recorded the change under the OPNsense user (its config history).
    const history = (await (await fetch(`${MOCK}/__mock/history`)).json()) as { history: { user: string }[] };
    expect(history.history.length).toBeGreaterThan(0);
    expect(history.history.every((h) => h.user === "admin")).toBe(true);
  });

  test("a change made elsewhere is detected and nothing is overwritten", async ({ page }) => {
    await login(page);
    const row = page.getByRole("row").filter({ hasText: "Block DMZ to LAN" });
    await turnLogOn(page, "Block DMZ to LAN");
    await expect(row.locator("td.col-log")).toHaveClass(/cell-modified/);

    // Another admin edits the same rule in the native UI.
    const st = await mockState();
    const uuid = st.rules.find((r) => r.description === "Block DMZ to LAN")!.uuid;
    await fetch(`${MOCK}/__mock/external-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uuid, fields: { description: "Block DMZ to LAN (by colleague)" } }),
    });

    await page.getByRole("button", { name: "Review & apply", exact: true }).click();
    const review = page.getByRole("region", { name: /Apply to/ });
    await review.getByLabel("I reviewed the changes listed above.").check();
    await review.getByRole("button", { name: /Apply 1 change/ }).click();

    const result = page.getByRole("region", { name: "Apply result" });
    await expect(result).toContainText("the firewall changed since you loaded it");
    await expect(result).toContainText("Block DMZ to LAN (by colleague)");
    expect((await mockState()).rules.find((r) => r.uuid === uuid)!.log).toBe("0");

    // Reconcile: keep my change on top of theirs, then apply.
    await result.getByRole("button", { name: /Keep my changes/ }).click();
    await expect(page.getByText(/Your staged changes now sit on top/)).toBeVisible();
    await review.getByLabel("I reviewed the changes listed above.").check();
    await review.getByRole("button", { name: /Apply 1 change/ }).click();
    await expect(page.getByText("Changes applied and verified on the firewall.")).toBeVisible();
    const final = (await mockState()).rules.find((r) => r.uuid === uuid)!;
    expect(final.log).toBe("1");
    expect(final.description).toBe("Block DMZ to LAN (by colleague)");
  });
});
