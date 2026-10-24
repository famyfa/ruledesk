import { useState } from "react";
import { ChangesPanel } from "../components/ChangesPanel.tsx";
import { useWorkspace } from "../workspace.tsx";

/**
 * Pending changes + review. Applying to the firewall is Phase 4; until then this
 * page shows exactly what would be sent and says so plainly.
 */
export function ChangesPage({ onShowRule }: { onShowRule: (id: string) => void }) {
  const { changeSet, validation, connection } = useWorkspace();
  const [reviewing, setReviewing] = useState(false);
  const pending = changeSet?.changes.length ?? 0;
  const problems = validation?.errorCount ?? 0;
  const canWrite = connection.status === "connected" && connection.info.features.rulesWrite;

  return (
    <div className="changes-page">
      <ChangesPanel onShowRule={onShowRule} onReview={() => setReviewing(true)} />
      {reviewing && pending > 0 && (
        <section className="review-box" aria-label="Apply">
          <h2>Apply to firewall</h2>
          {problems > 0 ? (
            <p className="text-error">Fix the {problems} problem(s) above first.</p>
          ) : !canWrite ? (
            <p className="text-warn">Editing is disabled for this firewall version. See Settings for details.</p>
          ) : (
            <p className="text-warn">
              Applying changes to OPNsense is not enabled in this build yet (Phase 4). Your changes stay staged locally and are kept across reloads.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
