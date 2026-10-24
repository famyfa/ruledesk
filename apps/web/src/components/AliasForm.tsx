import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { checkAliasEntries, parseEntryList, validateAliasName } from "@ruledeck/core";

export interface AliasDraft {
  name: string;
  type: string;
  entries: string[];
  description: string;
}

/** Alias types whose content is resolved at runtime (tables), not static config entries. */
export const RUNTIME_TYPES = new Set(["url", "urltable", "urljson", "geoip", "asn", "dynipv6host", "authgroup", "external"]);
const LOCALLY_CHECKED = new Set(["host", "network", "port", "networkgroup", "mac", "asn"]);

export interface AliasFormProps {
  initial: AliasDraft;
  types: { value: string; label: string }[];
  existingNames: string[];
  /** Name of the alias being edited (so it doesn't count as a duplicate). */
  ownName?: string;
  submitLabel: string;
  referenceNote?: string;
  onSave: (draft: AliasDraft) => void;
  onCancel: () => void;
}

export function AliasForm({ initial, types, existingNames, ownName, submitLabel, referenceNote, onSave, onCancel }: AliasFormProps) {
  const id = useId();
  const [name, setName] = useState(initial.name);
  const [type, setType] = useState(initial.type || types[0]?.value || "host");
  const [entriesText, setEntriesText] = useState(initial.entries.join("\n"));
  const [description, setDescription] = useState(initial.description);
  const [touched, setTouched] = useState(false);

  const entries = useMemo(() => parseEntryList(entriesText), [entriesText]);
  const nameIssues = validateAliasName(name, existingNames, ownName);
  const aliasNames = useMemo(() => new Set(existingNames), [existingNames]);
  const checks = useMemo(() => checkAliasEntries(type, entries, aliasNames), [type, entries, aliasNames]);
  const invalid = checks.filter((c) => c.error);
  const dupes = checks.filter((c) => c.duplicate);
  const needsEntries = LOCALLY_CHECKED.has(type) && entries.length === 0;
  const canSave = nameIssues.length === 0 && invalid.length === 0 && dupes.length === 0 && !needsEntries;

  const submit = () => {
    setTouched(true);
    if (canSave) onSave({ name: name.trim(), type, entries, description: description.trim() });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (e.target as HTMLElement).tagName !== "TEXTAREA")) {
      e.preventDefault();
      submit();
    }
  };

  const removeDuplicates = () => setEntriesText([...new Set(entries)].join("\n"));

  return (
    <div className="alias-form" onKeyDown={onKeyDown} role="group" aria-label={submitLabel}>
      <div className="form-row">
        <label htmlFor={`${id}-name`}>Name</label>
        <input
          id={`${id}-name`}
          value={name}
          autoFocus={!initial.name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={nameIssues.length > 0 && (touched || name.length > 0)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {nameIssues.length > 0 && (touched || name.length > 0) && <p className="field-error">{nameIssues[0]}</p>}

      <div className="form-row">
        <label htmlFor={`${id}-type`}>Type</label>
        <select id={`${id}-type`} value={type} onChange={(e) => setType(e.target.value)}>
          {types.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      {RUNTIME_TYPES.has(type) && (
        <p className="hint">Content of this type is resolved by the firewall at runtime (a table), not a fixed list. RuleDeck can't validate it locally.</p>
      )}

      <div className="form-row form-row-top">
        <label htmlFor={`${id}-entries`}>Entries</label>
        <textarea
          id={`${id}-entries`}
          value={entriesText}
          autoFocus={!!initial.name}
          onChange={(e) => setEntriesText(e.target.value)}
          rows={Math.min(8, Math.max(3, entries.length + 1))}
          placeholder={type === "port" ? "443\n8000-8080" : "192.168.1.10\n10.0.0.0/24"}
          spellCheck={false}
          aria-describedby={`${id}-entries-status`}
        />
      </div>
      <div id={`${id}-entries-status`} className="entry-status" aria-live="polite">
        <span>{entries.length} {entries.length === 1 ? "entry" : "entries"}</span>
        {invalid.length > 0 && <span className="text-error"> · {invalid.length} invalid</span>}
        {dupes.length > 0 && (
          <span className="text-warn">
            {" "}· {dupes.length} duplicate{dupes.length > 1 ? "s" : ""}{" "}
            <button type="button" className="link-button" onClick={removeDuplicates}>
              Remove duplicates
            </button>
          </span>
        )}
        {needsEntries && touched && <span className="text-error"> · add at least one entry</span>}
      </div>
      {invalid.length > 0 && (
        <ul className="entry-errors">
          {invalid.slice(0, 5).map((c, i) => (
            <li key={i}>⚠ {c.error}</li>
          ))}
          {invalid.length > 5 && <li>…and {invalid.length - 5} more</li>}
        </ul>
      )}

      <div className="form-row">
        <label htmlFor={`${id}-desc`}>Description</label>
        <input id={`${id}-desc`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
      </div>

      {referenceNote && <p className="hint">{referenceNote}</p>}

      <div className="form-actions">
        <span className="hint">Staged locally only.</span>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={submit} disabled={touched && !canSave}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
