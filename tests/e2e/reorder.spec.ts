import { expect, test } from "@playwright/test";
import { login, resetMock } from "./helpers.ts";

test("drag a rule by its position cell to reorder it within its group", async ({ page }) => {
  await resetMock();
  await login(page);
  const rows = page.getByRole("row");
  const names = async () => (await page.locator("tbody td.cell-name").allTextContents()).map((t) => t.trim());
  const before = await names();
  const a = before.indexOf("Allow web to DMZ");
  const b = before.indexOf("Block DMZ to LAN");
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBe(a + 1); // both on DMZ, next to each other

  // The whole "#" cell is the handle (not only the small grip).
  const handle = rows.filter({ hasText: "Block DMZ to LAN" }).locator("td.pos-cell");
  await expect(handle).toHaveAttribute("draggable", "true");
  const box = await handle.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(60);
  await handle.dragTo(rows.filter({ hasText: "Allow web to DMZ" }).locator("td.pos-cell"));

  await expect.poll(names).toContain("Block DMZ to LAN");
  const after = await names();
  expect(after.indexOf("Block DMZ to LAN")).toBe(a);
  expect(after.indexOf("Allow web to DMZ")).toBe(a + 1);
  await expect(page.getByRole("button", { name: /^1 pending/ })).toBeVisible();

  // Read-only rules can't be dragged.
  await page.getByLabel("Hide default read-only rules").uncheck();
  const ro = page.locator("tbody td.pos-cell.drag-disabled").first();
  if (await ro.count()) await expect(ro).toHaveAttribute("draggable", "false");
});
